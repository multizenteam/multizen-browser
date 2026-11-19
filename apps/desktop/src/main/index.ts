import { BRAND } from "./brand";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, powerMonitor, safeStorage, shell } from "electron";
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
import { LinuxSandboxManager, describeSandboxReason } from "./linuxSandbox";
import type {
  EngineUpdateStatus,
  ExtensionConfig,
  ProxyConfig,
  SandboxStatus,
  UpdateStatus,
} from "@multizen/types";
import { isBrowserEngine, resolveEngine } from "@multizen/types";
import { ChromiumBrowserDriver } from "./ChromiumBrowserDriver.ts";
import { EngineRegistry } from "./engineRegistry.ts";
import { EngineRouter } from "./engineRouter.ts";
import { UpdaterService } from "./UpdaterService.ts";
import { EngineUpdateService } from "./EngineUpdateService.ts";
import { migrateLegacyDeviceDisplayName } from "./deviceDisplayName.ts";
import { loadOrCreateMcpToken } from "./mcpToken.ts";
import { ExtensionsService } from "./extensions/ExtensionsService.ts";
import {
  sweepOrphans,
  storeEntryDir,
  resolveLoadDir,
  readManifestIcon,
} from "./extensions/extensionStore.ts";
import { probeProxyGeo, type ProxyGeoResult } from "./proxyGeo.ts";
import { SyncController } from "./sync/SyncController.ts";
import { SafeStorageCredentialVault } from "./sync/CredentialVault.ts";
import { registerSyncIpc, SYNC_PROGRESS_CHANNEL } from "./sync/registerSyncIpc.ts";
import { GatewayService } from "./mcp-gateway/GatewayService.ts";
import { GatewayController } from "./mcp-gateway/GatewayController.ts";
import { registerGatewayIpc } from "./mcp-gateway/registerGatewayIpc.ts";
import { SettingsSync } from "./mcp-gateway/SettingsSync.ts";
import { BindingsSync } from "./mcp-gateway/BindingsSync.ts";
import { CredentialSync } from "./mcp-gateway/CredentialSync.ts";
import { reconcileCredentialBackupAtStartup } from "./mcp-gateway/CredentialSyncStartup.ts";
import { DeviceSetup } from "./mcp-gateway/DeviceSetup.ts";
import { GATEWAY_SETUP_PROGRESS_CHANNEL } from "./mcp-gateway/gatewayIpcChannels.ts";
import type { SyncProgressEvent } from "./sync/types.ts";
import { isAllowedExternalUrl } from "./sync/externalLinks.ts";

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
/** Settings mirror over the synced-document layer; null until sync composes. */
let settingsSync: SettingsSync | null = null;
/** Per-device backup of folder/agent bindings; null until sync composes. */
let bindingsSync: BindingsSync | null = null;
let credentialSync: CredentialSync | null = null;
let credentialPushQueue: Promise<void> = Promise.resolve();
let credentialSyncTimer: ReturnType<typeof setInterval> | null = null;
let deviceSetup: DeviceSetup | null = null;

/**
 * Send an IPC message to the renderer, but only if the window and its
 * webContents are still alive. During app teardown a still-running profile's
 * child-process exit fires `running-changed` AFTER the window is destroyed; a
 * plain `mainWindow?.` guards only null, not a destroyed webContents, so calling
 * `.send` on it throws "Object has been destroyed" as an uncaught exception on
 * quit. This guard makes every renderer send teardown-safe.
 */
function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

let profileManager: ProfileManager;
let browserDriver: EngineRouter;
let engineRegistry: EngineRegistry;
let updater: UpdaterService;
let engineUpdater: EngineUpdateService;
let extensionsService: ExtensionsService;
/** Recent companion installs, to de-dupe the marker's retry logs. */
const recentCompanionInstalls = new Set<string>();
let activityLog: ActivityLog;
let settingsStore: SettingsStore;
let httpTransport: HttpTransport | null = null;
let mcpAuthToken: string | null = null;
let cachedSettings: AppSettings | null = null;
let syncController: SyncController | null = null;
let gatewayService: GatewayService | null = null;

/**
 * Native directory chooser for associating a local workspace with a gateway
 * project. Returns the chosen absolute path, or null when cancelled. The main
 * process canonicalizes and validates the path before it is stored.
 */
async function pickWorkspaceDirectory(): Promise<string | null> {
  const r = await dialog.showOpenDialog(mainWindow!, {
    title: "Choose a project directory",
    message: "Sekvona will write this project's MCP endpoints into the agents you select.",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
}

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

  // Open external links (target="_blank" / window.open) in the user's real
  // browser instead of a new Electron window, and never let the app window
  // itself navigate away. Only http(s) is handed to the OS.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
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

  // Coming back to the window is the moment the operator is most likely to care
  // about another device's changes, so take the opportunity to re-sync. The
  // service applies its own minimum interval, so refocusing repeatedly is cheap,
  // and it re-attempts composition — which is how Cloud Sync configured after
  // launch starts working without an explicit Retry.
  mainWindow.on("focus", () => {
    void gatewayService?.maybeSync("focus");
  });
}

// Electron captures this name for Safe Storage before ready. Keep existing
// Keychain credentials and profile data accessible across the display rename.
app.setName(BRAND.compatibility.storageName);
app.setPath("userData", app.commandLine.getSwitchValue("user-data-dir") ||
  join(app.getPath("appData"), BRAND.compatibility.storageName));
app.setAboutPanelOptions({
  applicationName: BRAND.name,
  applicationVersion: app.getVersion(),
});

app.whenReady().then(async () => {
  app.setName(BRAND.name);
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
  const deviceDisplayName = migrateLegacyDeviceDisplayName(cachedSettings.sync.deviceDisplayName);
  if (deviceDisplayName !== cachedSettings.sync.deviceDisplayName) {
    cachedSettings = await settingsStore.update({
      sync: { ...cachedSettings.sync, deviceDisplayName },
    });
  }

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

  // Engine registry — owns one Chromium bootstrap per engine, replacing the
  // former single global bootstrap. It downloads each engine's binary on first
  // use and re-emits its download/verify status tagged with the engine.
  // CloakBrowser is the only Chromium engine in this phase; Camoufox arrives
  // with its own bootstrap later.
  engineRegistry = new EngineRegistry();
  engineRegistry.on("status", (engine, status) => {
    // The renderer's chromium:status channel drives the CloakBrowser first-run
    // bootstrap UI (single-engine), so keep forwarding that stream.
    if (engine === "cloakbrowser") {
      sendToRenderer("chromium:status", status);
    }
    // Per-engine stream for the on-demand engine-download banner. Camoufox
    // fetches its browser the first time a Camoufox profile launches; without
    // this the launch blocks with only a "Launching…" tile and no progress.
    sendToRenderer("engine:status", { engine, status });
  });
  // Kick off the default engine's download in the background so the UI can
  // render immediately and show progress. Profile launches wait until their
  // engine is ready.
  void engineRegistry.ensure("cloakbrowser").catch((e) => {
    process.stderr.write(`Chromium bootstrap failed: ${String(e)}\n`);
  });

  // Browser-ENGINE update manager. Keeps the downloaded Chromium runtime
  // (CloakBrowser) fresh — background check + side-by-side stage that applies
  // on the next profile launch, never interrupting a running browser. Reads
  // settings live so the engineAutoUpdate toggle takes effect without restart.
  // Best-effort: a failed check never blocks a launch. Bound to CloakBrowser,
  // the only Chromium engine in this phase.
  engineUpdater = new EngineUpdateService({
    bootstrap: engineRegistry.getChromiumBootstrap("cloakbrowser"),
    getSettings: () => cachedSettings as AppSettings,
  });
  engineUpdater.on("status", (status: EngineUpdateStatus) => {
    sendToRenderer("engine-update:status", status);
  });
  engineUpdater.init();

  // App self-update (electron-updater). No-op in dev / non-packaged. Reads
  // settings live so the autoUpdate toggle takes effect without restart.
  updater = new UpdaterService({ getSettings: () => cachedSettings as AppSettings });
  updater.on("status", (status: UpdateStatus) => {
    sendToRenderer("update:status", status);
  });
  updater.init();

  // Per-profile extension management. Engine version feeds the Web Store CRX
  // endpoint's prodversion (falls back to a sane default before the runtime is
  // ready).
  extensionsService = new ExtensionsService({
    profileManager,
    extensionStoreRoot,
    engineVersion: () => {
      // Extensions are Chromium-only, so the Web Store prodversion comes from
      // the CloakBrowser bootstrap.
      const s = engineRegistry.get("cloakbrowser").getStatus();
      return s.kind === "ready" ? s.version : "145.0.0.0";
    },
  });

  // Linux AppArmor sandbox manager. Owns detection + the one-time secure-setup
  // flow; the driver calls resolveForLaunch per launch. Prompting + persistence
  // are injected here so the module stays UI-free. All no-ops off Linux.
  const linuxSandbox = new LinuxSandboxManager({
    getState: () => cachedSettings?.linuxSandboxState ?? "unset",
    setState: async (s) => {
      cachedSettings = await settingsStore.update({ linuxSandboxState: s });
    },
    hasWindow: () => mainWindow !== null && !mainWindow.isDestroyed(),
    promptSetup: async () => {
      const choice = await dialog.showMessageBox(mainWindow!, {
        type: "warning",
        buttons: ["Set up secure sandbox", "Launch without sandbox"],
        defaultId: 0,
        cancelId: 1,
        message: "Enable the secure browser sandbox?",
        detail:
          "This Linux kernel blocks the browser's sandbox. Sekvona can re-enable it for " +
          "just this browser with a one-time system authorization (you will be asked for " +
          "your password). Otherwise the browser launches without its sandbox.",
      });
      return choice.response === 0 ? "setup" : "no-sandbox";
    },
    showNotice: async (notice) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      await dialog.showMessageBox(mainWindow, {
        type: "info",
        buttons: ["OK"],
        message: "Secure sandbox not enabled",
        detail: `${describeSandboxReason(notice.reason)}\n\nTo enable it manually, run:\n\n${notice.manualCommand}`,
      });
    },
  });

  const chromiumDriver = new ChromiumBrowserDriver({
    profileManager,
    engineRegistry,
    getDefaultEngine: () => cachedSettings?.browserEngine ?? "cloakbrowser",
    extensionStoreRoot,
    resolveSandboxDecision: (ctx) => linuxSandbox.resolveForLaunch(ctx),
    onSandboxInactive: (binaryPath) => linuxSandbox.markBinaryInactive(binaryPath),
    // The companion's "Add to Sekvona" button routes here (profile-scoped).
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
          buttons: ["Add to Sekvona", "Cancel"],
          defaultId: 0,
          cancelId: 1,
          message: "Add this extension to the profile?",
          detail: `Extension ${extensionId} will be installed into "${profile?.name ?? profileId}" and load on the next launch.`,
        });
        if (choice.response !== 0) return;
        try {
          const extension = await extensionsService.installFromWebStore(profileId, extensionId);
          profileManager.markSyncDirty(profileId, true);
          sendToRenderer("extensions:installed", { ok: true, profileId, extension });
          // Apply immediately: Chromium only reads --load-extension at startup,
          // so relaunch the profile (session restore brings tabs back) instead
          // of making the user close + reopen it by hand.
          if (browserDriver.isRunning(profileId)) {
            await browserDriver.close(profileId).catch(() => {});
            await launchProfile(profileId).catch((e: unknown) => {
              // The profile is now closed and didn't reopen — tell the user so
              // they're not left wondering where their browser went.
              sendToRenderer("extensions:installed", {
                ok: false,
                profileId,
                error: `Added it, but the profile didn't reopen — launch it again. (${(e as Error).message})`,
              });
            });
          }
        } catch (e) {
          sendToRenderer("extensions:installed", {
            ok: false,
            profileId,
            error: (e as Error).message,
          });
        }
      })();
    },
  });

  // Route each profile to its engine's driver. The Chromium driver is built
  // above (it owns the companion-install wiring); the Firefox driver is created
  // lazily on the first Camoufox launch, keeping camoufox-js out of startup.
  browserDriver = new EngineRouter({
    profileManager,
    engineRegistry,
    getDefaultEngine: () => cachedSettings?.browserEngine ?? "cloakbrowser",
    chromiumDriver,
  });

  // OS-secure credential vault, shared by Cloud Sync and the MCP gateway. If
  // secure storage is unavailable (rare on macOS/Windows; some headless Linux),
  // BOTH sync and the gateway's signed-config/token features stay disabled and
  // everything else works unchanged.
  let secureVault: SafeStorageCredentialVault | null = null;
  try {
    secureVault = new SafeStorageCredentialVault(
      join(dataRoot, "sync", "credentials.vault"),
      safeStorage,
    );
  } catch (e) {
    process.stderr.write(`[multizen] Secure storage unavailable: ${String(e)}\n`);
    secureVault = null;
  }

  // Cloud Sync controller. Instantiated best-effort: if OS secure storage is
  // unavailable (rare on macOS/Windows; some headless Linux), sync stays
  // disabled and everything else works unchanged. Only synced profiles are
  // coupled to coordination — unsynced/MCP behavior is untouched.
  try {
    if (!secureVault) throw new Error("secure storage unavailable");
    const vault = secureVault;
    syncController = new SyncController({
      settingsStore,
      getSettings: () => cachedSettings as AppSettings,
      onSyncMaterialsChanged: () => {
        void gatewayService?.composeSyncIfReady().catch(() => {});
      },
      onSettingsUpdated: (next) => {
        cachedSettings = next;
      },
      profileManager,
      vault,
      driver: browserDriver,
      profilesRoot: join(dataRoot, "profiles"),
      kopiaConfigDefault: join(dataRoot, "sync", "kopia.config"),
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      appVersion: app.getVersion(),
      emit: (event: SyncProgressEvent) => sendToRenderer(SYNC_PROGRESS_CHANNEL, event),
    });
    registerSyncIpc(syncController);

    // Whole-library automatic sync: probe + bootstrap at startup. It no-ops
    // until Cloud Sync has the global switch, bucket, S3 keys, and encryption
    // password; once present it performs a single-flight capability test,
    // restores every missing remote profile, and uploads local dirty ones,
    // deferring running profiles to close. Fire-and-forget and non-blocking.
    void syncController.autoBootstrap().catch(() => undefined);
    syncController.startAutoSync();

    // Export a sanitized diagnostics bundle through the native save dialog.
    // The controller guarantees the payload is secret-free; here we only pick a
    // destination and write the JSON. Returns a serializable result envelope.
    ipcMain.handle(
      "sync:exportDiagnosticsToFile",
      async (_e, profileId?: string): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> => {
        try {
          const diagnostics = await syncController!.exportDiagnostics(profileId);
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const r = await dialog.showSaveDialog(mainWindow!, {
            title: "Export Cloud Sync diagnostics",
            defaultPath: `multizen-sync-diagnostics-${stamp}.json`,
            filters: [{ name: "JSON", extensions: ["json"] }],
          });
          if (r.canceled || !r.filePath) return { ok: false, canceled: true };
          const { writeFile } = await import("node:fs/promises");
          await writeFile(r.filePath, JSON.stringify(diagnostics, null, 2), "utf8");
          return { ok: true, path: r.filePath };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    );

    // Conservatively close synced owned profiles + invalidate leases on power
    // suspend/resume so a stale owner can never publish after sleeping.
    const onSuspend = (): void => {
      void syncController?.onPowerSuspend();
    };
    powerMonitor.on("suspend", onSuspend);
    powerMonitor.on("resume", onSuspend);
  } catch (e) {
    process.stderr.write(`[multizen] Cloud Sync disabled: ${String(e)}\n`);
    syncController = null;
  }

  const assertProfileNotBound = (profileId: string): void => {
    const boundProject = gatewayService?.projectBoundTo(profileId);
    if (boundProject) {
      throw new Error(
        `This profile is bound to the MCP project “${boundProject}”. ` +
          `Open Projects → ${boundProject} and unbind the profile first, then delete it.`,
      );
    }
  };

  function launchProfile(id: string) {
    const start = () => browserDriver.launch(id);
    return syncController ? syncController.launch(id, start) : start();
  }

  const profileSyncLifecycle = {
    launch: launchProfile,
    onCreated: (profileId: string): void => {
      profileManager.seedSyncEnabled(profileId);
      // force: a new/dirty profile does not move the readiness fingerprint, so a
      // non-forced bootstrap would be gated out and the change never published.
      // Still single-flight-bounded, so this cannot stack concurrent runs.
      void syncController?.autoBootstrap({ force: true }).catch(() => undefined);
    },
    onUpdated: (profileId: string): void => {
      const state = profileManager.getSyncState(profileId);
      if (!state) profileManager.seedSyncEnabled(profileId);
      else if (state.syncEnabled) profileManager.markSyncDirty(profileId, true);
      // force for the same reason as onCreated: the dirty flag is not part of the
      // readiness fingerprint. See SyncController.startAutoSync for the rationale.
      void syncController?.autoBootstrap({ force: true }).catch(() => undefined);
    },
    beforeDelete: (profileId: string): void => {
      // A profile bound to a gateway project is load-bearing for that project's
      // browser endpoint. Refuse the delete and tell the operator where to
      // unbind it — never silently unbind, and never delete either side.
      assertProfileNotBound(profileId);
      if (profileManager.getSyncState(profileId)?.syncEnabled) {
        throw new Error(
          "This profile is synced. First disable ‘Sync this profile’ and confirm cloud-backup deletion, then delete the local profile.",
        );
      }
    },
  };

  const mcp = createMultizenMcpServer({
    profileManager,
    browserDriver,
    profileLifecycle: profileSyncLifecycle,
  });
  activityLog = mcp.activityLog;
  // Forward activity events to renderer
  activityLog.on("event", (e: ActivityEvent) => {
    sendToRenderer("activity:event", e);
  });

  // Forward profile running-state changes (manual launch, manual close,
  // and — most importantly — external Chromium close where the user quits
  // the browser window directly).
  browserDriver.on("running-changed", (change) => {
    sendToRenderer("profiles:running-changed", change);
    // Automatic backup after the browser closes. Both a planned Stop and an
    // external window/⌘Q exit surface as `closed`; `closing` (the transitional
    // "Terminating…" state) must NOT trigger a backup. The controller guards
    // every other precondition (global/profile sync on, dirty, unexpired lease,
    // process gone, not suppressed/disposed) and its promise never rejects, but
    // we still `.catch` defensively so a rejection can never bubble out of this
    // synchronous EventEmitter listener as an unhandled rejection. App shutdown
    // (`before-quit`) runs closeAll() before controller.shutdown(), so the
    // backup task is started here and shutdown() awaits it.
    if (change.kind === "closed") {
      void syncController?.onBrowserClosed(change.profileId).catch(() => {});
    }
  });

  // Background-probe proxies for profiles missing a cached country code
  // (existing rows from before the proxy_country migration, or rows where
  // the user changed proxy and we cleared the stale value). Runs once at
  // startup so the GUI flag chip reflects the proxy egress without forcing
  // the user to click "Test proxy" or relaunch.
  void backfillProxyCountries();

  // ── MCP gateway service ───────────────────────────────────────────────
  //
  // Composes signed project configs, stdio/http upstream reconciliation,
  // profile-bound browser routes, per-directory agent configuration, and
  // optional S3 config sync. Constructed UNCONDITIONALLY (not gated on
  // `mcpHttpEnabled`) so the Projects UI can always manage projects,
  // directories, and agent files; only the HTTP ROUTES below are conditional.
  // Endpoint URLs are computed from the configured port either way, and the
  // controller reports whether they are actually being served.
  //
  // Best-effort: requires the OS secure vault for device signing keys and
  // per-project tokens. Without it the gateway stays unavailable and the global
  // /mcp behaviour is unchanged.
  const gatewayHost = "127.0.0.1";
  const gatewayPort = cachedSettings.mcpHttpPort;
  const gatewayAllowedHosts = [
    `${gatewayHost}:${gatewayPort}`,
    `127.0.0.1:${gatewayPort}`,
    `localhost:${gatewayPort}`,
  ];
  if (secureVault) {
    try {
      gatewayService = new GatewayService({
        dataDir: userData,
        vault: secureVault,
        appVersion: app.getVersion(),
        deviceName: cachedSettings.sync.deviceDisplayName,
        onDeviceNameChanged: async (name) => {
          cachedSettings = await settingsStore.update({
            sync: { ...cachedSettings!.sync, deviceDisplayName: name },
          });
        },
        // Refresh the per-device bindings backup whenever they change. Read
        // lazily so the (later-constructed) backup is picked up.
        onBindingsChanged: () => {
          void bindingsSync?.push().catch(() => undefined);
        },
        // Refresh the opt-in credential backup when a secret changes. A no-op
        // unless the operator has set a bundle passphrase on this device.
        onSecretsChanged: (change) => {
          credentialPushQueue = credentialPushQueue
            .then(async () => {
              const result = await credentialSync?.push(change ?? {});
              if (result?.reason === "conflict") await credentialSync?.push(change ?? {});
            })
            .catch(() => undefined);
        },
        allowedHosts: gatewayAllowedHosts,
        baseUrl: `http://${gatewayHost}:${gatewayPort}`,
        listProfiles: () =>
          profileManager.list().map((p) => ({ id: p.id, name: p.name })),
        openOAuthUrl: async (profileId, url) => {
          await launchProfile(profileId);
          await browserDriver.openTab(profileId, url);
        },
        makeBoundServer: (_projectId, _boundProfileId) => ({
          profileManager,
          browserDriver,
          activityLog,
          profileLifecycle: profileSyncLifecycle,
        }),
        // Compose S3 config sync only when Cloud Sync is ready. The password
        // never leaves the returned object's use inside the sync bridge.
        ...(syncController
          ? { syncTarget: () => syncController!.gatewayTargetId(), syncMaterials: () => syncController!.gatewaySyncMaterials() }
          : {}),
      });
      await gatewayService.start();
      const gatewayController = new GatewayController(gatewayService, {
        baseUrl: gatewayService.baseUrl,
        // Routes are only served when the HTTP transport comes up below.
        routesServed: () => httpTransport !== null,
        // Read lazily: the credential backup is constructed further down, on top
        // of this same service.
        credentials: () => credentialSync,
        deviceSetup: () => deviceSetup,
      });
      // Mirror the shared subset of app settings through the same signed,
      // encrypted document channel the projects use. Device-local fields
      // (engine, port, identity, bucket coordinates) are never published.
      settingsSync = new SettingsSync({
        service: gatewayService,
        // cachedSettings is loaded before the gateway is constructed, so it is
        // non-null here; the assertion keeps the accessor honest rather than
        // widening SettingsSync's contract to accept null.
        getSettings: () => cachedSettings!,
        applyPatch: async (patch) => {
          cachedSettings = await settingsStore.update(patch);
          updater?.onSettingsChanged();
          engineUpdater?.onSettingsChanged();
          return cachedSettings;
        },
      });
      await settingsSync.reconcile().catch(() => undefined);

      // Back up this device's folder/agent bindings. Device-scoped: the paths
      // belong to this machine, so they are restorable here and offered only as
      // proposals anywhere else.
      bindingsSync = new BindingsSync({ service: gatewayService });
      await bindingsSync.push().catch(() => undefined);

      // Opt-in credential backup. Off unless a bundle passphrase is stored, so
      // constructing it here costs nothing and changes no behaviour by itself.
      // The excluded names are read live from settings because the Kopia/S3
      // credential refs are operator-configurable strings, and whatever guards
      // the bucket must never be backed up into that bucket.
      credentialSync = new CredentialSync({
        service: gatewayService,
        vault: gatewayService.vaultAdapter,
        excludedNames: () => {
          const sync = cachedSettings!.sync;
          return [sync.kopiaPasswordRef, sync.s3AccessKeyIdRef, sync.s3SecretAccessKeyRef];
        },
      });
      if (syncController) {
        const startup = await reconcileCredentialBackupAtStartup({
          credentials: credentialSync,
          gateway: gatewayService,
          cloud: syncController,
        });
        void startup.retry;
      } else {
        await credentialSync.reconcile().catch(() => undefined);
      }
      // Keep OAuth grants and other opted-in credentials current on devices
      // that remain open while another device signs in or refreshes a token.
      credentialSyncTimer = setInterval(() => {
        credentialPushQueue = credentialPushQueue
          .then(async () => { await credentialSync?.reconcile(); })
          .catch(() => undefined);
      }, 30_000);
      credentialSyncTimer.unref?.();

      // One ordered pass that rebuilds this device from the bucket. Assembled
      // last because it drives every channel above; composed only when Cloud Sync
      // exists, since storage is its first and fatal stage.
      if (syncController) {
        deviceSetup = new DeviceSetup({
          cloud: syncController,
          service: gatewayService,
          settings: settingsSync,
          bindings: bindingsSync,
          credentials: credentialSync,
          onStage: (state) => sendToRenderer(GATEWAY_SETUP_PROGRESS_CHANNEL, state),
        });
      }

      registerGatewayIpc(gatewayController, {
        pickDirectory: () => pickWorkspaceDirectory(),
        revealPath: (target: string) => {
          shell.showItemInFolder(target);
        },
      });
    } catch (e) {
      process.stderr.write(`[multizen] MCP gateway disabled: ${String(e)}\n`);
      gatewayService = null;
    }
  }

  // Optional embedded HTTP+SSE transport so external Cursor/Claude can connect
  if (cachedSettings.mcpHttpEnabled) {
    try {
      // Require a bearer token so only clients that hold the locally-stored
      // secret (not a random local process, not a DNS-rebinding web page) can
      // drive the browser-control tools. Generated + persisted 0600 on first run.
      mcpAuthToken = loadOrCreateMcpToken(userData);
      const port = gatewayPort;

      httpTransport = new HttpTransport({
        port,
        authToken: mcpAuthToken,
        // Gateway project routes are delegated on the SAME port, BEFORE the
        // global bearer auth and broad /mcp. Returns false for non-gateway paths
        // so /mcp, /sse, /messages, /healthz are unchanged.
        ...(gatewayService ? { gatewayHandler: gatewayService.gatewayHandler } : {}),
      });
      // Streamable HTTP builds a fresh MCP server per request; give it a factory
      // that reuses the same profileManager/browserDriver AND the shared
      // activityLog, so every transport's tool calls land in the one live feed.
      await httpTransport.start(
        () =>
          createMultizenMcpServer({
            profileManager,
            browserDriver,
            activityLog,
            profileLifecycle: profileSyncLifecycle,
          }).server,
      );
    } catch (e) {
      // Port collision is non-fatal — log and continue
      process.stderr.write(`MCP HTTP transport failed to start: ${String(e)}\n`);
      httpTransport = null;
    }
  }

  // Profile IPC
  ipcMain.handle("profiles:list", () =>
    profileManager.list().map((p) => ({
      ...p,
      isRunning: browserDriver.isRunning(p.id),
      engine: resolveEngine(p.engine, cachedSettings?.browserEngine ?? "cloakbrowser"),
    })),
  );
  ipcMain.handle("profiles:get", (_e, id: string) => profileManager.get(id));
  ipcMain.handle("profiles:deleteStatus", (_e, id: string) => {
    if (!profileManager.get(id)) throw new Error("Profile not found.");
    return {
      syncEnabled: profileManager.getSyncState(id)?.syncEnabled ?? false,
      globalEnabled: syncController?.status(id).globalEnabled ?? false,
      cloudAvailable: syncController !== null,
    };
  });
  ipcMain.handle("profiles:create", (_e, input: Parameters<ProfileManager["create"]>[0]) => {
    const profile = profileManager.create({
      ...input,
      engine: input.engine ?? cachedSettings?.browserEngine ?? "cloakbrowser",
    });
    profileSyncLifecycle.onCreated(profile.id);
    return profile;
  });
  ipcMain.handle(
    "profiles:update",
    (_e, id: string, patch: Parameters<ProfileManager["update"]>[1]) => {
      // A profile's engine can't change while it's running — the live browser
      // is tied to the current engine's binary + user-data-dir. Reject only a
      // real change (the edit sheet autosaves the whole form, so an unrelated
      // edit re-sends the unchanged engine, which must still save).
      if (patch.engine !== undefined && browserDriver.isRunning(id)) {
        const current = profileManager.get(id);
        const defaultEngine = cachedSettings?.browserEngine ?? "cloakbrowser";
        if (resolveEngine(current?.engine, defaultEngine) !== resolveEngine(patch.engine, defaultEngine)) {
          throw new Error("Stop the profile before changing its engine.");
        }
      }
      const updated = profileManager.update(id, patch);
      profileSyncLifecycle.onUpdated(id);
      return updated;
    },
  );
  ipcMain.handle("profiles:delete", async (_e, id: string, deleteCloudBackup = false) => {
    assertProfileNotBound(id);
    if (!deleteCloudBackup) profileSyncLifecycle.beforeDelete(id);
    await browserDriver.close(id);
    if (deleteCloudBackup && profileManager.getSyncState(id)?.syncEnabled) {
      if (!syncController) throw new Error("Cloud Sync is unavailable on this device.");
      await syncController.disableProfileSyncAndDeleteRemote(id);
    }
    profileSyncLifecycle.beforeDelete(id);
    profileManager.delete(id);
    // Reclaim shared store entries this profile referenced that no other profile
    // still uses (delete() only removed the profile's own dataDir). Best-effort.
    void sweepOrphans(
      extensionStoreRoot,
      profileManager.allExtensionRefs().map((r) => r.ext),
    ).catch(() => {});
  });
  ipcMain.handle("profiles:launch", async (_e, id: string) => {
    // Synced profiles must satisfy coordination before a writable launch;
    // unsynced profiles pass straight through (beforeLaunch no-ops for them),
    // preserving existing behavior exactly. beforeLaunch also marks the
    // sync-enabled profile dirty (writable session incoming).
    return launchProfile(id);
  });
  ipcMain.handle("profiles:close", (_e, id: string) => browserDriver.close(id));

  // Settings IPC
  ipcMain.handle("settings:get", () => settingsStore.load());
  ipcMain.handle("settings:update", async (_e, patch: Partial<AppSettings>) => {
    cachedSettings = await settingsStore.update(patch);
    // Let the updaters react to their auto-update toggles without a restart.
    updater?.onSettingsChanged();
    engineUpdater?.onSettingsChanged();
    // Share the change with the operator's other devices. Best-effort: a bucket
    // problem must never block a preference change.
    void settingsSync?.push().catch(() => undefined);
    return cachedSettings;
  });

  // Activity IPC
  ipcMain.handle("activity:recent", () => activityLog.recent());

  // Chromium bootstrap IPC
  ipcMain.handle("chromium:status", () => engineRegistry.get("cloakbrowser").getStatus());
  ipcMain.handle("chromium:retry", () => engineRegistry.get("cloakbrowser").ensure());

  // Linux sandbox IPC. `status` drives the Settings row (live-computed, hidden
  // off affected systems); `setup` runs the one-time secure setup on demand.
  const resolveEngineBinaryPath = (): string | null => {
    try {
      const b = engineRegistry.get("cloakbrowser");
      const kind = b.getStatus().kind;
      return kind === "ready" || kind === "dev-system" ? b.resolveBinaryPath() : null;
    } catch {
      return null;
    }
  };
  ipcMain.handle("sandbox:status", () => linuxSandbox.getStatus(resolveEngineBinaryPath()));
  ipcMain.handle("sandbox:setup", async () => {
    try {
      const b = engineRegistry.get("cloakbrowser");
      await b.ensure();
      return await linuxSandbox.setupFromSettings(b.resolveBinaryPath());
    } catch (e) {
      // The engine must be downloaded before we can target its binary; surface
      // that as a status instead of rejecting the invoke (unhandled in renderer).
      console.warn("[multizen] sandbox:setup failed:", (e as Error).message);
      return {
        state: "needs-setup",
        reasonText: "The browser engine needs to finish downloading before secure setup can run.",
      } satisfies SandboxStatus;
    }
  });

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
    profileSyncLifecycle.onUpdated(profileId);
    return extensionsService.list(profileId);
  });
  ipcMain.handle("extensions:addFromFolder", async (_e, profileId: string) => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: "Add unpacked extension folder",
      properties: ["openDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return extensionsService.list(profileId);
    await extensionsService.installFromFile(profileId, r.filePaths[0]);
    profileSyncLifecycle.onUpdated(profileId);
    return extensionsService.list(profileId);
  });
  ipcMain.handle("extensions:addFromWebStore", async (_e, profileId: string, urlOrId: string) => {
    try {
      await extensionsService.installFromWebStore(profileId, urlOrId);
      profileSyncLifecycle.onUpdated(profileId);
    } catch (e) {
      process.stderr.write(`[extensions] addFromWebStore FAILED: ${(e as Error).stack ?? (e as Error).message}\n`);
      throw e;
    }
    return extensionsService.list(profileId);
  });
  ipcMain.handle("extensions:remove", async (_e, profileId: string, extId: string) => {
    await extensionsService.remove(profileId, extId);
    profileSyncLifecycle.onUpdated(profileId);
    return extensionsService.list(profileId);
  });
  ipcMain.handle(
    "extensions:toggle",
    (_e, profileId: string, extId: string, enabled: boolean) => {
      extensionsService.setEnabled(profileId, extId, enabled);
      profileSyncLifecycle.onUpdated(profileId);
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

  // Browser-engine update IPC (distinct from the app self-update above).
  ipcMain.handle("engine-update:status", () => engineUpdater.getStatus());
  ipcMain.handle("engine-update:check", () => engineUpdater.checkOnly());
  ipcMain.handle("engine-update:install", () => engineUpdater.updateNow());

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
        filters: [{ name: "Sekvona archive", extensions: ["mzar"] }],
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
        filters: [{ name: "Sekvona archive", extensions: ["mzar"] }],
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
        // If the archive recorded an engine this build can't run (a legacy
        // "cft" export, or a newer engine), clear it so the profile resolves to
        // the app default at launch instead of handing the registry an unknown
        // engine. Tell the user rather than silently changing their setup.
        const recordedEngine: unknown = restored.engine;
        if (recordedEngine !== undefined && !isBrowserEngine(recordedEngine)) {
          restored.engine = undefined;
          void dialog.showMessageBox(mainWindow ?? undefined!, {
            type: "info",
            message: "Engine not available",
            detail: `This profile was exported with an engine this version of Sekvona doesn't have (${String(recordedEngine)}). It will run on your default engine instead.`,
          });
        }
        // Insert the row verbatim so the DB entry points at the restored files
        // (the old create()-based path minted a new id/dataDir and orphaned the
        // cookies/logins that were just restored).
        const inserted = profileManager.insertImported(restored);
        profileSyncLifecycle.onCreated(inserted.id);
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

  // Open an external link in the OS default browser. STRICTLY allowlisted to
  // the single attribution URL (https://irensaltali.com) — the renderer can
  // never open arbitrary schemes/hosts through this channel.
  ipcMain.handle("system:openExternal", async (_e, url: string): Promise<{ ok: boolean }> => {
    if (typeof url !== "string" || !isAllowedExternalUrl(url)) {
      return { ok: false };
    }
    await shell.openExternal(url);
    return { ok: true };
  });

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
    "Sekvona failed to start",
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
        sendToRenderer("profiles:proxy-country-updated", {
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
    if (credentialSyncTimer) clearInterval(credentialSyncTimer);
    await syncController?.prepareToQuit();
    await browserDriver?.closeAll();
    await syncController?.shutdown();
    await credentialPushQueue;
    await gatewayService?.shutdown();
    await httpTransport?.stop();
    profileManager?.close();
  } finally {
    app.exit(0);
  }
});
