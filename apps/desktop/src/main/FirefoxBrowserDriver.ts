import { EventEmitter } from "node:events";
import { firefox, type BrowserContext, type Page } from "playwright-core";
import { launchOptions } from "camoufox-js";
import type { BrowserDriver } from "@multizen/mcp-server";
import type { LaunchedProfile, Profile, ProfileId } from "@multizen/types";
import type { ProfileManager } from "@multizen/profile-manager";
import { startBridgeForProfile, stopBridgeForProfile } from "./socks5Bridge";
import { sanitizeStartUrl } from "./startPage";
import type { RunningStateChange } from "./ChromiumBrowserDriver.ts";

/**
 * BrowserDriver for the Firefox-family engine (Camoufox). Drives the browser
 * through playwright-core's Firefox and configures its anti-detect fingerprint
 * via camoufox-js. There is NO CDP here, so `cdpSend` is rejected — the curated
 * tools work because T16 promoted them to first-class BrowserDriver verbs, which
 * this driver implements natively via Playwright.
 *
 * Security hardening baked in (from the Camoufox review):
 *   - The binary is app-vendored: CamoufoxBootstrap downloads it into
 *     CAMOUFOX_INSTALL_DIR before launch, and camoufox-js resolves it from there
 *     (launchPath), so it never lazy-downloads a ~600MB browser at launch. (We
 *     do NOT pass executable_path — that would break camoufox-js's
 *     properties.json lookup; see the launch() comment.)
 *   - `exclude_addons: ["UBO"]` disables camoufox-js's runtime uBlock XPI fetch.
 *   - the child gets an explicit MINIMAL env (allowlist), never the whole
 *     process.env — so the main process's secrets can't leak into the browser.
 *   - proxies go through the same local SOCKS5 bridge as the Chromium engine
 *     (upstream auth + remote DNS), not raw credentials on the command line.
 */

interface RunningFirefox {
  context: BrowserContext;
  startedAt: string;
  pid: number;
  hasProxyBridge: boolean;
  /** True once close() was called, so the close event reports user-close. */
  closingByRequest: boolean;
  /** Stable per-tab ids (Firefox has no CDP targetId). */
  pageIds: Map<Page, string>;
  nextPageId: number;
  /** Polls for zero open windows and closes the context when the user shuts the
   *  last window (macOS keeps the browser alive otherwise). Set after launch. */
  windowWatcher?: NodeJS.Timeout;
}

interface FirefoxDriverEvents {
  "running-changed": (change: RunningStateChange) => void;
}

export interface FirefoxBrowserDriverOptions {
  profileManager: ProfileManager;
  /** The persistent user-data-dir for a profile on this engine
   *  (e.g. `<profile.dataDir>/engines/camoufox`). */
  browserDataDir: (profile: Profile) => string;
  /** T20 seam: map the profile's fingerprint to a Camoufox `launchOptions`
   *  config. When absent, Camoufox generates its own coherent fingerprint. */
  buildFingerprintConfig?: (profile: Profile) => Record<string, unknown>;
}

/** Only these env vars are forwarded to the browser child — deliberately NOT
 *  the whole process.env, which would leak the main process's secrets/tokens.
 *  The list mirrors what the Chromium driver forwards (plus Firefox/Playwright
 *  specifics): without the Windows HOME-equivalents Playwright's Firefox
 *  amendEnvironment throws (it requires an absolute os.homedir()), and without
 *  the Wayland/DBus vars Firefox can't reach the display on Linux. */
const ENV_ALLOWLIST = [
  // POSIX + locale
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  // Linux display / session (parity with ChromiumBrowserDriver)
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
  "DBUS_SESSION_BUS_ADDRESS",
  // macOS app-bundle framework lookup
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  // Windows: paths Firefox needs + the HOME-equivalents Playwright requires
  "SystemRoot",
  "WINDIR",
  "SystemDrive",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PATHEXT",
];

function minimalChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

export class FirefoxBrowserDriver extends EventEmitter implements BrowserDriver {
  private readonly running = new Map<ProfileId, RunningFirefox>();
  private readonly profileManager: ProfileManager;
  private readonly browserDataDir: (profile: Profile) => string;
  private readonly buildFingerprintConfig?: (profile: Profile) => Record<string, unknown>;

  constructor(opts: FirefoxBrowserDriverOptions) {
    super();
    this.profileManager = opts.profileManager;
    this.browserDataDir = opts.browserDataDir;
    this.buildFingerprintConfig = opts.buildFingerprintConfig;
  }

  override on<K extends keyof FirefoxDriverEvents>(event: K, listener: FirefoxDriverEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof FirefoxDriverEvents>(
    event: K,
    ...args: Parameters<FirefoxDriverEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    const existing = this.running.get(profileId);
    if (existing) {
      return { id: profileId, cdpEndpoint: "", pid: existing.pid, startedAt: existing.startedAt };
    }

    const profile = this.profileManager.get(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);
    this.profileManager.markOpened(profileId);

    const userDataDir = this.browserDataDir(profile);

    // Route a configured proxy through the local SOCKS5 bridge (handles upstream
    // auth + keeps DNS remote), exactly like the Chromium engine. The browser
    // then talks to a credential-free localhost endpoint.
    let proxy: { server: string } | undefined;
    let hasProxyBridge = false;
    if (profile.proxy) {
      const localProxyUrl = await startBridgeForProfile(profileId, profile.proxy);
      proxy = { server: localProxyUrl };
      hasProxyBridge = true;
    }

    // We deliberately do NOT pass executable_path. camoufox-js's launchOptions
    // resolves the binary via launchPath() — which respects our
    // CAMOUFOX_INSTALL_DIR (set in CamoufoxBootstrap, and the binary is already
    // downloaded there before we get here) — and, crucially, only then finds
    // properties.json via getPath() in Contents/Resources/. Passing
    // executable_path makes camoufox-js look for properties.json next to the
    // executable (Contents/MacOS/), where Camoufox 152+ no longer ships it → ENOENT.
    // exclude_addons (no runtime uBO fetch) + the explicit minimal env stay
    // app-controlled; the fingerprint config is the T20 seam.
    //
    // We deliberately do NOT hand the proxy to camoufox-js. Its getProxyUrl runs
    // the server URL through `new URL(...).origin`, and `socks5://` is a
    // non-special scheme whose origin is the literal string "null" — Firefox
    // then proxies through a host named "null": the socks5 scheme is lost
    // (defeating the bridge's remote-DNS, no-leak guarantee) and the proxy no
    // longer points at the bridge. Instead we set the proxy directly on the
    // Playwright launch options below, which handles socks5 natively.
    //
    // When a proxy IS active we also block WebRTC (media.peerconnection.enabled
    // = false). camoufox only spoofs the WebRTC IP when `geoip` is set, and
    // geoip auto-detection would run from the HOST (not through the proxy) and
    // pin the real IP — so the safe move is to disable WebRTC on proxied
    // profiles, matching the Chromium engine's non-proxied-UDP hardening. A page
    // otherwise leaks the operator's real address via STUN outside the proxy.
    const config: Record<string, unknown> = {
      headless: false,
      exclude_addons: ["UBO"],
      env: minimalChildEnv(),
      ...(proxy ? { block_webrtc: true } : {}),
      ...(this.buildFingerprintConfig ? this.buildFingerprintConfig(profile) : {}),
    };

    let context: BrowserContext;
    try {
      const opts = (await launchOptions(
        config as Parameters<typeof launchOptions>[0],
      )) as NonNullable<Parameters<typeof firefox.launchPersistentContext>[1]>;
      // Hand the credential-free bridge URL straight to Playwright, overriding
      // whatever camoufox produced. Keeps the socks5 scheme intact end-to-end.
      if (proxy) opts.proxy = proxy;
      context = await firefox.launchPersistentContext(userDataDir, opts);
    } catch (e) {
      if (hasProxyBridge) stopBridgeForProfile(profileId);
      throw e;
    }

    const startedAt = new Date().toISOString();
    const pageIds = new Map<Page, string>();
    let nextPageId = 1;
    const initial = context.pages();
    if (initial.length === 0) initial.push(await context.newPage());
    for (const p of initial) pageIds.set(p, String(nextPageId++));

    // Open the profile's start page on EVERY launch. Unlike Chromium (which
    // restores the previous tabs via --restore-last-session), Playwright-driven
    // Firefox doesn't restore the session, so a relaunch would otherwise come up
    // on a blank page. Navigating to the start page each time gives a consistent
    // landing instead. sanitizeStartUrl rejects non-http(s)/about URLs and falls
    // back to the app default, like the Chromium path. Fire-and-forget: a nav
    // failure (bad proxy/network) must not throw out of launch().
    const startUrl = sanitizeStartUrl(profile.startUrl);
    void initial[0]?.goto(startUrl).catch(() => {});

    const record: RunningFirefox = {
      context,
      startedAt,
      // Firefox/Playwright exposes no stable child pid for a persistent context;
      // pid is informational only, so 0 = unknown.
      pid: 0,
      hasProxyBridge,
      closingByRequest: false,
      pageIds,
      nextPageId,
    };
    this.running.set(profileId, record);

    // Track tabs opened later so list/activate/close_tab can address them.
    context.on("page", (p: Page) => {
      const r = this.running.get(profileId);
      if (r && !r.pageIds.has(p)) r.pageIds.set(p, String(r.nextPageId++));
    });
    context.on("close", () => {
      if (record.windowWatcher) clearInterval(record.windowWatcher);
      if (hasProxyBridge) stopBridgeForProfile(profileId);
      const wasByRequest = record.closingByRequest;
      this.running.delete(profileId);
      this.emit("running-changed", {
        kind: "closed",
        profileId,
        reason: wasByRequest ? "user-close" : "external-exit",
      });
    });

    // macOS keeps Firefox alive after its last window closes (standard app
    // lifecycle), so closing the window never closes the persistent context —
    // the profile would look stuck "running" and linger in the Dock. Mirror the
    // Chromium windowWatcher: once there are no open pages for >1.5s, close the
    // context ourselves, which quits Firefox and fires the "close" handler above
    // as an external-exit. The 2s launch grace + 1.5s debounce avoid firing
    // during startup or a quick close-then-open.
    let zeroSinceMs: number | null = null;
    record.windowWatcher = setInterval(() => {
      const r = this.running.get(profileId);
      if (!r || r.closingByRequest) return;
      if (Date.now() - new Date(r.startedAt).getTime() < 2000) return;
      if (r.context.pages().length === 0) {
        if (zeroSinceMs === null) zeroSinceMs = Date.now();
        else if (Date.now() - zeroSinceMs > 1500) {
          if (r.windowWatcher) clearInterval(r.windowWatcher);
          void r.context.close().catch(() => {});
        }
      } else {
        zeroSinceMs = null;
      }
    }, 1000);

    this.emit("running-changed", { kind: "launched", profileId });
    return { id: profileId, cdpEndpoint: "", pid: record.pid, startedAt };
  }

  async close(profileId: ProfileId): Promise<void> {
    const r = this.running.get(profileId);
    if (!r) return;
    r.closingByRequest = true;
    // The "close" handler clears the map entry, stops the bridge, and emits the
    // running-changed "closed" event.
    await r.context.close().catch(() => {});
  }

  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }

  private require(profileId: ProfileId): RunningFirefox {
    const r = this.running.get(profileId);
    if (!r) throw new Error(`Profile ${profileId} is not running`);
    return r;
  }

  /** The page a driving command targets: the last opened, else the first. */
  private activePage(profileId: ProfileId): Page {
    const r = this.require(profileId);
    const pages = r.context.pages();
    if (pages.length === 0) throw new Error(`Profile ${profileId} has no open page`);
    return pages[pages.length - 1]!;
  }

  async navigate(profileId: ProfileId, url: string): Promise<{ url: string }> {
    const page = this.activePage(profileId);
    await page.goto(url);
    return { url: page.url() };
  }

  async click(profileId: ProfileId, selector: string): Promise<{ ok: true }> {
    await this.activePage(profileId).click(selector);
    return { ok: true };
  }

  async type(profileId: ProfileId, selector: string, text: string): Promise<{ ok: true }> {
    await this.activePage(profileId).fill(selector, text);
    return { ok: true };
  }

  async extract(profileId: ProfileId): Promise<{ result: unknown }> {
    const page = this.activePage(profileId);
    const result = {
      url: page.url(),
      title: await page.title(),
      text: await page.evaluate("document.body ? document.body.innerText : ''"),
    };
    return { result };
  }

  async screenshot(profileId: ProfileId): Promise<{ pngBase64: string }> {
    const buf = await this.activePage(profileId).screenshot({ type: "png" });
    return { pngBase64: Buffer.from(buf).toString("base64") };
  }

  // ── Engine-neutral curated verbs, implemented natively (no CDP). ────────────
  async evaluateJs(profileId: ProfileId, expression: string): Promise<unknown> {
    const value = await this.activePage(profileId).evaluate(expression);
    // Mirror the Chromium shape so shared consumers (e.g. the wait_for_* polls
    // that read `result.value`) work identically across engines.
    return { result: { value } };
  }

  async getCookies(profileId: ProfileId, urls: string[]): Promise<unknown> {
    const cookies = await this.require(profileId).context.cookies(urls);
    return { cookies };
  }

  async setCookies(profileId: ProfileId, cookies: unknown[]): Promise<unknown> {
    await this.require(profileId).context.addCookies(
      cookies as Parameters<BrowserContext["addCookies"]>[0],
    );
    return { ok: true };
  }

  async listTabs(profileId: ProfileId): Promise<unknown> {
    const r = this.require(profileId);
    const targetInfos = r.context.pages().map((p) => ({
      targetId: r.pageIds.get(p) ?? "",
      type: "page",
      url: p.url(),
    }));
    return { targetInfos };
  }

  async newTab(profileId: ProfileId, url?: string): Promise<unknown> {
    const r = this.require(profileId);
    const page = await r.context.newPage();
    if (url) await page.goto(url);
    const targetId = r.pageIds.get(page) ?? String(r.nextPageId++);
    r.pageIds.set(page, targetId);
    return { targetId };
  }

  async activateTab(profileId: ProfileId, targetId: string): Promise<unknown> {
    const page = this.pageById(profileId, targetId);
    await page.bringToFront();
    return { ok: true };
  }

  async closeTab(profileId: ProfileId, targetId: string): Promise<unknown> {
    const page = this.pageById(profileId, targetId);
    await page.close();
    return { ok: true };
  }

  private pageById(profileId: ProfileId, targetId: string): Page {
    const r = this.require(profileId);
    for (const [page, id] of r.pageIds) {
      if (id === targetId && !page.isClosed()) return page;
    }
    throw new Error(`No tab ${targetId} on profile ${profileId}`);
  }

  /** Raw CDP is Chromium-only; Camoufox speaks the Firefox protocol (AC6). */
  async cdpSend(): Promise<unknown> {
    throw new Error("cdp_send is unsupported on the Firefox (Camoufox) engine");
  }

  async closeAll(): Promise<void> {
    const ids = [...this.running.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }
}
