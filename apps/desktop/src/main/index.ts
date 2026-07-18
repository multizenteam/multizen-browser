import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  ProfileManager,
  exportProfile,
  importProfile,
  generateFingerprint,
  reconcileFingerprint,
  FingerprintReconcileError,
  deviceCatalog,
  localeCatalog,
  findLocaleIdByCountry,
} from "@multizen/profile-manager";
import {
  HttpTransport,
  createMultizenMcpServer,
  type ActivityEvent,
  type ActivityLog,
} from "@multizen/mcp-server";
import { SettingsStore, defaultSettingsPath, type AppSettings } from "@multizen/settings-store";
import type { ChromiumStatus, ExtensionConfig, ProxyConfig, UpdateStatus } from "@multizen/types";
import { ChromiumBrowserDriver } from "./ChromiumBrowserDriver.ts";
import { ChromiumBootstrap } from "./ChromiumBootstrap.ts";
import { UpdaterService } from "./UpdaterService.ts";
import { UsageReporting } from "./UsageReporting.ts";
import { loadOrCreateMcpToken } from "./mcpToken.ts";
import { ExtensionsService } from "./extensions/ExtensionsService.ts";
import {
  sweepOrphans,
  storeEntryDir,
  resolveLoadDir,
  readManifestIcon,
} from "./extensions/extensionStore.ts";
import { probeProxyGeo, type ProxyGeoResult } from "./proxyGeo.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Resolve the master 1024×1024 brand icon. In packaged builds Electron picks
 * the bundled icon based on platform (.icns on Mac, the .ico/.png on Win/Linux).
 * In dev we fall back to the source PNG so the dock / taskbar / window icons
 * are not the default Electron logo.
 */
function resolveAppIcon(): string | null {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, "icon.png"),
        join(process.resourcesPath, "..", "icon.png"),
      ]
    : [
        join(__dirname, "../../../../build/icon.png"),
        join(__dirname, "../../../build/icon.png"),
        join(__dirname, "../../build/icon.png"),
      ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

let mainWindow: BrowserWindow | null = null;
let profileManager: ProfileManager;
let browserDriver: ChromiumBrowserDriver;
let chromiumBootstrap: ChromiumBootstrap;
let updater: UpdaterService;
let usageReporting: UsageReporting;
let extensionsService: ExtensionsService;
/** Recent companion installs, to de-dupe the marker's retry logs. */
const recentCompanionInstalls = new Set<string>();
let activityLog: ActivityLog;
let settingsStore: SettingsStore;
let httpTransport: HttpTransport | null = null;
let mcpAuthToken: string | null = null;
let cachedSettings: AppSettings | null = null;

function createWindow(): void {
  const iconPath = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0b0f",
    icon: iconPath ?? undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.webContents.on("did-fail-load", (_e, code, description, url) => {
    process.stderr.write(`Renderer failed to load (${code} ${description}): ${url}\n`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    process.stderr.write(`Renderer process gone: ${JSON.stringify(details)}\n`);
  });
}

// Name must be set BEFORE app.whenReady() so the dock and menu bar pick
// it up — otherwise macOS shows "Electron" until app fully loads.
app.setName("MultiZen");
app.setAboutPanelOptions({
  applicationName: "MultiZen",
  applicationVersion: app.getVersion(),
});

app.whenReady().then(async () => {
  // macOS: explicitly set the dock icon. In packaged .app bundles macOS
  // picks the .icns automatically, but in dev (running ./node_modules/.bin/electron)
  // the dock shows the generic Electron icon unless we override it here.
  if (process.platform === "darwin" && !app.isPackaged) {
    const iconPath = resolveAppIcon();
    if (iconPath) {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) app.dock?.setIcon(img);
    }
  }

  const userData = app.getPath("userData");
  const dataRoot = join(userData, "data");
  // Shared extension store (deduped extension files loaded into many profiles).
  const extensionStoreRoot = join(dataRoot, "extension-store");

  settingsStore = new SettingsStore(defaultSettingsPath(userData));
  cachedSettings = await settingsStore.load();

  profileManager = new ProfileManager({
    dbPath: join(dataRoot, "profiles.db"),
    profilesRoot: join(dataRoot, "profiles"),
  });

  // Reclaim shared store entries no profile references any more (e.g. left by a
  // crash mid-delete) plus stale staging dirs. Best-effort; never blocks startup.
  void sweepOrphans(
    extensionStoreRoot,
    profileManager.allExtensionRefs().map((r) => r.ext),
  )
    .then((res) => {
      if (res.removed > 0) {
        process.stdout.write(`[multizen] extension-store sweep reclaimed ${res.removed} orphan(s)\n`);
      }
    })
    .catch(() => {});

  // Chromium bootstrap — picks the engine from user settings (CFT default,
  // CloakBrowser opt-in for stronger anti-detect), downloads it on first
  // run, and reports progress to the renderer.
  chromiumBootstrap = new ChromiumBootstrap({
    engine: cachedSettings.browserEngine,
  });
  chromiumBootstrap.on("status", (status: ChromiumStatus) => {
    mainWindow?.webContents.send("chromium:status", status);
  });
  // Kick off the ensure() in the background so the UI can render immediately
  // and show download progress. Profile launches will wait until ready.
  void chromiumBootstrap.ensure().catch((e) => {
    process.stderr.write(`Chromium bootstrap failed: ${String(e)}\n`);
  });

  // App self-update (electron-updater). No-op in dev / non-packaged. Reads
  // settings live so the autoUpdate toggle takes effect without restart.
  updater = new UpdaterService({ getSettings: () => cachedSettings as AppSettings });
  updater.on("status", (status: UpdateStatus) => {
    mainWindow?.webContents.send("update:status", status);
  });
  updater.init();

  // Opt-in anonymous usage heartbeat. OFF by default; dormant until the user
  // enables it in Settings. Reads settings live so the toggle takes effect
  // without restart. See docs/TELEMETRY.md.
  usageReporting = new UsageReporting({
    getSettings: () => cachedSettings as AppSettings,
    statePath: join(dataRoot, "usage-state.json"),
  });
  usageReporting.start();

  // Per-profile extension management. Engine version feeds the Web Store CRX
  // endpoint's prodversion (falls back to a sane default before the runtime is
  // ready).
  extensionsService = new ExtensionsService({
    profileManager,
    extensionStoreRoot,
    engineVersion: () => {
      const s = chromiumBootstrap.getStatus();
      return s.kind === "ready" ? s.version : "145.0.0.0";
    },
  });

  browserDriver = new ChromiumBrowserDriver({
    profileManager,
    chromiumBootstrap,
    extensionStoreRoot,
    // The companion's "Add to MultiZen" button routes here (profile-scoped).
    // Confirm natively first: any script on the store page could trigger the
    // channel, so an explicit OS dialog makes a drive-by install impossible.
    onCompanionInstall: (profileId, extensionId) => {
      // De-dupe: the companion logs the marker a few times to beat a race, so
      // ignore repeats of the same {profile,extension} within a short window.
      const dedupeKey = `${profileId}:${extensionId}`;
      if (recentCompanionInstalls.has(dedupeKey)) return;
      recentCompanionInstalls.add(dedupeKey);
      setTimeout(() => recentCompanionInstalls.delete(dedupeKey), 15000);
      void (async () => {
        const profile = profileManager.get(profileId);
        const choice = await dialog.showMessageBox(mainWindow!, {
          type: "question",
          buttons: ["Add to MultiZen", "Cancel"],
          defaultId: 0,
          cancelId: 1,
          message: "Add this extension to the profile?",
          detail: `Extension ${extensionId} will be installed into "${profile?.name ?? profileId}" and load on the next launch.`,
        });
        if (choice.response !== 0) return;
        try {
          const extension = await extensionsService.installFromWebStore(profileId, extensionId);
          mainWindow?.webContents.send("extensions:installed", { ok: true, profileId, extension });
          // Apply immediately: Chromium only reads --load-extension at startup,
          // so relaunch the profile (session restore brings tabs back) instead
          // of making the user close + reopen it by hand.
          if (browserDriver.isRunning(profileId)) {
            await browserDriver.close(profileId).catch(() => {});
            await browserDriver.launch(profileId).catch((e: unknown) => {
              // The profile is now closed and didn't reopen — tell the user so
              // they're not left wondering where their browser went.
              mainWindow?.webContents.send("extensions:installed", {
                ok: false,
                profileId,
                error: `Added it, but the profile didn't reopen — launch it again. (${(e as Error).message})`,
              });
            });
          }
        } catch (e) {
          mainWindow?.webContents.send("extensions:installed", {
            ok: false,
            profileId,
            error: (e as Error).message,
          });
        }
      })();
    },
  });

  const mcp = createMultizenMcpServer({ profileManager, browserDriver });
  activityLog = mcp.activityLog;

  // Forward activity events to renderer
  activityLog.on("event", (e: ActivityEvent) => {
    mainWindow?.webContents.send("activity:event", e);
  });

  // Forward profile running-state changes (manual launch, manual close,
  // and — most importantly — external Chromium close where the user quits
  // the browser window directly).
  browserDriver.on("running-changed", (change) => {
    mainWindow?.webContents.send("profiles:running-changed", change);
  });

  // Background-probe proxies for profiles missing a cached country code
  // (existing rows from before the proxy_country migration, or rows where
  // the user changed proxy and we cleared the stale value). Runs once at
  // startup so the GUI flag chip reflects the proxy egress without forcing
  // the user to click "Test proxy" or relaunch.
  void backfillProxyCountries();

  // Optional embedded HTTP+SSE transport so external Cursor/Claude can connect
  if (cachedSettings.mcpHttpEnabled) {
    try {
      // Require a bearer token so only clients that hold the locally-stored
      // secret (not a random local process, not a DNS-rebinding web page) can
      // drive the browser-control tools. Generated + persisted 0600 on first run.
      mcpAuthToken = loadOrCreateMcpToken(userData);
      httpTransport = new HttpTransport({
        port: cachedSettings.mcpHttpPort,
        authToken: mcpAuthToken,
      });
      // Streamable HTTP builds a fresh MCP server per request; give it a factory
      // that reuses the same profileManager/browserDriver AND the shared
      // activityLog, so every transport's tool calls land in the one live feed.
      await httpTransport.start(
        () => createMultizenMcpServer({ profileManager, browserDriver, activityLog }).server,
      );
    } catch (e) {
      // Port collision is non-fatal — log and continue
      process.stderr.write(`MCP HTTP transport failed to start: ${String(e)}\n`);
      httpTransport = null;
    }
  }

  // Profile IPC
  ipcMain.handle("profiles:list", () =>
    profileManager.list().map((p) => ({ ...p, isRunning: browserDriver.isRunning(p.id) })),
  );
  ipcMain.handle("profiles:get", (_e, id: string) => profileManager.get(id));
  ipcMain.handle("profiles:create", (_e, input: Parameters<ProfileManager["create"]>[0]) =>
    profileManager.create(input),
  );
  ipcMain.handle(
    "profiles:update",
    (_e, id: string, patch: Parameters<ProfileManager["update"]>[1]) =>
      profileManager.update(id, patch),
  );
  ipcMain.handle("profiles:delete", (_e, id: string) => {
    void browserDriver.close(id).catch(() => {});
    profileManager.delete(id);
    // Reclaim shared store entries this profile referenced that no other profile
    // still uses (delete() only removed the profile's own dataDir). Best-effort.
    void sweepOrphans(
      extensionStoreRoot,
      profileManager.allExtensionRefs().map((r) => r.ext),
    ).catch(() => {});
  });
  ipcMain.handle("profiles:launch", (_e, id: string) => browserDriver.launch(id));
  ipcMain.handle("profiles:close", (_e, id: string) => browserDriver.close(id));

  // Settings IPC
  ipcMain.handle("settings:get", () => settingsStore.load());
  ipcMain.handle("settings:update", async (_e, patch: Partial<AppSettings>) => {
    cachedSettings = await settingsStore.update(patch);
    // Let the updater react to an autoUpdate toggle without an app restart.
    updater?.onSettingsChanged();
    return cachedSettings;
  });

  // Activity IPC
  ipcMain.handle("activity:recent", () => activityLog.recent());

  // Chromium bootstrap IPC
  ipcMain.handle("chromium:status", () => chromiumBootstrap.getStatus());
  ipcMain.handle("chromium:retry", () => chromiumBootstrap.ensure());

  // Extensions IPC (per-profile)
  ipcMain.handle("extensions:list", (_e, profileId: string) =>
    extensionsService.list(profileId),
  );
  ipcMain.handle("extensions:addFromFile", async (_e, profileId: string) => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: "Add extension (.crx or .zip)",
      properties: ["openFile"],
      filters: [{ name: "Chrome extension", extensions: ["crx", "zip"] }],
    });
    if (r.canceled || !r.filePaths[0]) return extensionsService.list(profileId);
    await extensionsService.installFromFile(profileId, r.filePaths[0]);
    return extensionsService.list(profileId);
  });
  ipcMain.handle("extensions:addFromFolder", async (_e, profileId: string) => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: "Add unpacked extension folder",
      properties: ["openDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return extensionsService.list(profileId);
    await extensionsService.installFromFile(profileId, r.filePaths[0]);
    return extensionsService.list(profileId);
  });
  ipcMain.handle("extensions:addFromWebStore", async (_e, profileId: string, urlOrId: string) => {
    try {
      await extensionsService.installFromWebStore(profileId, urlOrId);
    } catch (e) {
      process.stderr.write(`[extensions] addFromWebStore FAILED: ${(e as Error).stack ?? (e as Error).message}\n`);
      throw e;
    }
    return extensionsService.list(profileId);
  });
  ipcMain.handle("extensions:remove", async (_e, profileId: string, extId: string) => {
    await extensionsService.remove(profileId, extId);
    return extensionsService.list(profileId);
  });
  ipcMain.handle(
    "extensions:toggle",
    (_e, profileId: string, extId: string, enabled: boolean) => {
      extensionsService.setEnabled(profileId, extId, enabled);
      return extensionsService.list(profileId);
    },
  );

  // Staging IPC (no profile id yet) — used by the create sheet to attach or
  // install extensions before the profile exists. `prepare*` unpack into the
  // shared store and return the single ref; the renderer holds the staged list
  // and passes it to profiles:create as `extensions`.
  // Shared staging helper: unpack a local source into the store, logging
  // failures like prepareFromWebStore does (the dialogs above call this).
  const prepareStaged = async (sourcePath: string): Promise<ExtensionConfig | null> => {
    try {
      return await extensionsService.prepareFromFile(sourcePath);
    } catch (e) {
      process.stderr.write(
        `[extensions] prepareFromFile FAILED: ${(e as Error).stack ?? (e as Error).message}\n`,
      );
      throw e;
    }
  };

  ipcMain.handle("extensions:storeEntries", () => extensionsService.storeEntries());
  // Real icon from an extension's own manifest, as a data URI (or null → the
  // renderer shows the generic glyph). Lets non-catalog extensions show their
  // actual icon. Shared entries resolve from the store; profile-scoped ones
  // need the owning profile's dataDir.
  ipcMain.handle(
    "extensions:icon",
    async (_e, ext: ExtensionConfig, profileId: string | null): Promise<string | null> => {
      const dataDir = profileId ? profileManager.get(profileId)?.dataDir : undefined;
      if (ext.scope !== "shared" && !dataDir) return null;
      const dir = resolveLoadDir(ext, dataDir ?? "", extensionStoreRoot);
      // Defense-in-depth: a crafted archive could carry a profile-scope ext.dir
      // that escapes the profile. Keep the resolved dir inside its expected root
      // before reading any file from it.
      const root = resolve(ext.scope === "shared" ? extensionStoreRoot : (dataDir ?? ""));
      const abs = resolve(dir);
      if (abs !== root && !abs.startsWith(root + sep)) return null;
      return readManifestIcon(abs);
    },
  );
  ipcMain.handle("extensions:prepareFromWebStore", async (_e, urlOrId: string) => {
    try {
      return await extensionsService.prepareFromWebStore(urlOrId);
    } catch (e) {
      process.stderr.write(
        `[extensions] prepareFromWebStore FAILED: ${(e as Error).stack ?? (e as Error).message}\n`,
      );
      throw e;
    }
  });
  ipcMain.handle("extensions:prepareFromFile", async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: "Add extension (.crx or .zip)",
      properties: ["openFile"],
      filters: [{ name: "Chrome extension", extensions: ["crx", "zip"] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return prepareStaged(r.filePaths[0]);
  });
  ipcMain.handle("extensions:prepareFromFolder", async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: "Add unpacked extension folder",
      properties: ["openDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return prepareStaged(r.filePaths[0]);
  });

  // App self-update IPC
  ipcMain.handle("update:status", () => updater.getStatus());
  ipcMain.handle("update:lastChecked", () => updater.getLastCheckedAt());
  ipcMain.handle("update:check", () => updater.checkForUpdates({ manual: true }));
  ipcMain.handle("update:install", () => updater.installAndRestart());
  ipcMain.handle("update:download", (_e, version: string) =>
    shell.openExternal(updater.downloadUrlFor(version)),
  );

  // Fingerprint generator IPC — called from create + edit forms when the
  // user hits Regen. Returns a fresh, internally-consistent preset.
  ipcMain.handle("fingerprint:generate", () => generateFingerprint());
  ipcMain.handle("fingerprint:devices", () => deviceCatalog());
  ipcMain.handle("fingerprint:locales", () => localeCatalog());
  ipcMain.handle("fingerprint:localeForCountry", (_e, cc: string) =>
    findLocaleIdByCountry(cc),
  );
  ipcMain.handle(
    "fingerprint:reconcile",
    (
      _e,
      current: Parameters<typeof reconcileFingerprint>[0],
      patch: Parameters<typeof reconcileFingerprint>[1],
    ) => {
      // reconcileFingerprint now throws on invalid input (the honest contract
      // for MCP). GUI patches are all catalog-sourced so this "can't happen"
      // in normal use, but the renderer calls this as `void reconcile(...)`,
      // so a throw would surface as an unhandled rejection and silently no-op
      // the edit. Degrade gracefully: on a reconcile rejection (e.g. a corrupt
      // or legacy persisted fingerprint) return `current` unchanged; rethrow
      // anything else.
      try {
        return reconcileFingerprint(current, patch);
      } catch (e) {
        if (e instanceof FingerprintReconcileError) {
          console.warn("[multizen] fingerprint reconcile rejected:", e.message);
          return current;
        }
        throw e;
      }
    },
  );

  // Proxy geo-IP probe — verifies that the profile's locale + timezone are
  // coherent with the proxy IP's country. Detection vendors flag mismatches
  // like "Accept-Language: ru-RU + IP in US" as suspicious.
  ipcMain.handle(
    "proxy:detectGeo",
    async (
      _e,
      proxy: ProxyConfig,
      profileId?: string,
    ): Promise<{ ok: true; geo: ProxyGeoResult } | { ok: false; error: string }> => {
      try {
        const geo = await probeProxyGeo(proxy);
        // Persist the resolved country onto the profile (if one was given)
        // so the GUI flag chip can render it without waiting for next
        // launch. Lower-cased for the flag-icons CSS class.
        if (profileId && geo.country) {
          profileManager.setProxyCountry(profileId, geo.country.toLowerCase());
        }
        return { ok: true, geo };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  // Profile import / export
  ipcMain.handle(
    "profiles:export",
    async (_e, id: string, passphrase: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
      const profile = profileManager.get(id);
      if (!profile) return { ok: false, reason: "not_found" };
      const result = await dialog.showSaveDialog(mainWindow ?? undefined!, {
        title: "Export profile",
        defaultPath: `${profile.name.replace(/[^a-z0-9-_]+/gi, "_")}.mzar`,
        filters: [{ name: "MultiZen archive", extensions: ["mzar"] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, reason: "cancelled" };
      // Bundle the profile's shared-store extensions so importing on another
      // machine restores the extension code too, not just a dangling reference.
      const extensions = (profile.extensions ?? [])
        .filter((e) => e.scope === "shared")
        .map((e) => ({
          id: e.id,
          version: e.version,
          dir: storeEntryDir(extensionStoreRoot, e.id, e.version),
        }));
      await exportProfile(profile, passphrase, result.filePath, { extensions });
      return { ok: true, path: result.filePath };
    },
  );

  ipcMain.handle(
    "profiles:import",
    async (_e, passphrase: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> => {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: "Import profile",
        filters: [{ name: "MultiZen archive", extensions: ["mzar"] }],
        properties: ["openFile"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, reason: "cancelled" };
      }
      const archivePath = result.filePaths[0];
      if (!archivePath) return { ok: false, reason: "cancelled" };
      try {
        // Restore the full user-data-dir to disk. If the archive's id already
        // exists here, importProfile mints a fresh id + dataDir so it never
        // overwrites the existing profile. The returned Profile carries every
        // field (extensions, icon, startUrl, searchProvider, fingerprint,
        // proxy) and its dataDir points at the restored files.
        const restored = await importProfile(archivePath, passphrase, join(dataRoot, "profiles"), {
          idTaken: (id) => Boolean(profileManager.get(id)),
          // Restore bundled (v2) extensions into the shared store so they work
          // on this machine without the user re-adding them.
          extensionStoreRoot,
        });
        // Insert the row verbatim so the DB entry points at the restored files
        // (the old create()-based path minted a new id/dataDir and orphaned the
        // cookies/logins that were just restored).
        const inserted = profileManager.insertImported(restored);
        return { ok: true, id: inserted.id };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  );

  // System info
  ipcMain.handle("system:info", () => ({
    mcpHttpUrl: httpTransport ? `http://127.0.0.1:${cachedSettings?.mcpHttpPort}` : null,
    // Bearer token an MCP client must send as `Authorization: Bearer <token>`.
    // Surfaced so the in-app panel can show a ready-to-paste client config.
    mcpAuthToken: httpTransport ? mcpAuthToken : null,
    appVersion: app.getVersion(),
    platform: process.platform,
  }));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((e: unknown) => {
  // A failure anywhere in the async startup would otherwise reject SILENTLY:
  // createWindow() is the last step, so the dock icon appears but no window and
  // no error ever shows. The known trigger is the native better-sqlite3 binding
  // failing to load when a wrong-arch .node ships (an arm64 binary in the x64
  // build → crashes on Intel Macs). Surface it as a visible dialog and quit
  // cleanly instead of a mystery no-window.
  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
  process.stderr.write(`[multizen] fatal startup error:\n${detail}\n`);
  dialog.showErrorBox(
    "MultiZen failed to start",
    `A startup step failed:\n\n${e instanceof Error ? e.message : String(e)}\n\n` +
      "Please report this on Discord/GitHub with this message.",
  );
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * Probe geo for every profile that has a proxy but no cached country code
 * yet. Each probe takes ~1-3s; we run them sequentially so we don't hammer
 * the same upstream proxy with parallel requests, and emit a renderer
 * event after each one so the flag chip updates as soon as the result
 * lands. Failures are non-fatal — the next launch will re-probe.
 */
async function backfillProxyCountries(): Promise<void> {
  if (!profileManager) return;
  const profiles = profileManager.list();
  for (const summary of profiles) {
    if (!summary.proxy || summary.proxyCountry) continue;
    try {
      const geo = await probeProxyGeo(summary.proxy, { timeoutMs: 6000 });
      if (geo.country) {
        profileManager.setProxyCountry(summary.id, geo.country.toLowerCase());
        // Nudge the renderer so it refetches the list and re-renders flags.
        mainWindow?.webContents.send("profiles:proxy-country-updated", {
          id: summary.id,
          country: geo.country.toLowerCase(),
        });
      }
    } catch {
      // Proxy down / probe service rate-limited — skip silently.
    }
  }
}

app.on("before-quit", async (e) => {
  e.preventDefault();
  try {
    await browserDriver?.closeAll();
    await httpTransport?.stop();
    profileManager?.close();
  } finally {
    app.exit(0);
  }
});
