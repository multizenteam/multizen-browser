import { EventEmitter } from "node:events";
import { resolveEngine } from "@multizen/types";
import type { BrowserEngine, LaunchedProfile, ProfileId } from "@multizen/types";
import type { BrowserDriver } from "@multizen/mcp-server";
import type { ProfileManager } from "@multizen/profile-manager";
import type { EngineRegistry } from "./engineRegistry.ts";
import { isChromiumEngine } from "./engineRegistry.ts";
import {
  browserDataDirForEngine,
  type ChromiumBrowserDriver,
  type RunningStateChange,
} from "./ChromiumBrowserDriver.ts";
// Type-only: the concrete module (which statically imports camoufox-js +
// playwright-core) is loaded lazily, so Chromium-only sessions never pull it in.
import type { FirefoxBrowserDriver } from "./FirefoxBrowserDriver.ts";

interface EngineRouterEvents {
  "running-changed": (change: RunningStateChange) => void;
}

export interface EngineRouterOptions {
  profileManager: ProfileManager;
  engineRegistry: EngineRegistry;
  /** The app-wide default engine for profiles that haven't pinned one. */
  getDefaultEngine: () => BrowserEngine;
  /** The already-constructed Chromium driver (owns companion-install wiring). */
  chromiumDriver: ChromiumBrowserDriver;
}

/**
 * The BrowserDriver the app and MCP server talk to. It resolves each profile's
 * engine and delegates to that engine's driver — Chromium (CloakBrowser) or
 * Firefox (Camoufox). A profile is BOUND to the driver it launched on, so every
 * later verb (and close) goes to that same driver even if the profile's stored
 * engine field later changes — a running profile is never orphaned. Because the
 * Firefox driver isn't constructed until a Camoufox profile first launches,
 * camoufox-js + playwright-core stay out of the Chromium-only startup path.
 */
export class EngineRouter extends EventEmitter implements BrowserDriver {
  private readonly profileManager: ProfileManager;
  private readonly engineRegistry: EngineRegistry;
  private readonly getDefaultEngine: () => BrowserEngine;
  private readonly chromiumDriver: ChromiumBrowserDriver;
  private firefoxDriver: FirefoxBrowserDriver | null = null;
  /** profileId → the driver it launched on (bound at launch, cleared on close). */
  private readonly bindings = new Map<ProfileId, BrowserDriver>();

  constructor(opts: EngineRouterOptions) {
    super();
    this.profileManager = opts.profileManager;
    this.engineRegistry = opts.engineRegistry;
    this.getDefaultEngine = opts.getDefaultEngine;
    this.chromiumDriver = opts.chromiumDriver;
    this.chromiumDriver.on("running-changed", (c) => this.onSubEvent(c));
  }

  override on<K extends keyof EngineRouterEvents>(event: K, listener: EngineRouterEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof EngineRouterEvents>(
    event: K,
    ...args: Parameters<EngineRouterEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  private onSubEvent(change: RunningStateChange): void {
    if (change.kind === "closed") this.bindings.delete(change.profileId);
    this.emit("running-changed", change);
  }

  /** The engine a not-yet-running profile would launch on. */
  private engineFor(profileId: ProfileId): BrowserEngine {
    const profile = this.profileManager.get(profileId);
    return resolveEngine(profile?.engine, this.getDefaultEngine());
  }

  /** Lazily construct the Firefox driver on first Camoufox launch. */
  private async firefox(): Promise<BrowserDriver> {
    if (!this.firefoxDriver) {
      const { FirefoxBrowserDriver } = await import("./FirefoxBrowserDriver.ts");
      this.firefoxDriver = new FirefoxBrowserDriver({
        profileManager: this.profileManager,
        resolveExecutablePath: () => this.engineRegistry.get("camoufox").resolveBinaryPath(),
        browserDataDir: (profile) => browserDataDirForEngine(profile.dataDir, "camoufox"),
        // Fingerprint mapping (T20) is injected here once implemented.
      });
      this.firefoxDriver.on("running-changed", (c) => this.onSubEvent(c));
    }
    return this.firefoxDriver;
  }

  private async driverForEngine(engine: BrowserEngine): Promise<BrowserDriver> {
    if (isChromiumEngine(engine)) return this.chromiumDriver;
    if (engine === "camoufox") return this.firefox();
    throw new Error(`No driver for engine "${engine}"`);
  }

  /** The driver a RUNNING profile is bound to; throws if it isn't running. */
  private require(profileId: ProfileId): BrowserDriver {
    const driver = this.bindings.get(profileId);
    if (!driver) throw new Error(`Profile ${profileId} is not running`);
    return driver;
  }

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    const bound = this.bindings.get(profileId);
    if (bound) return bound.launch(profileId); // idempotent — already running

    const engine = this.engineFor(profileId);
    // Binary-gate the launch on this engine (idempotent; the Chromium driver
    // also self-gates, the Firefox driver relies on this).
    await this.engineRegistry.get(engine).ensure();

    const driver = await this.driverForEngine(engine);
    const result = await driver.launch(profileId);
    this.bindings.set(profileId, driver);
    return result;
  }

  async close(profileId: ProfileId): Promise<void> {
    const driver = this.bindings.get(profileId);
    if (!driver) return;
    await driver.close(profileId);
    this.bindings.delete(profileId);
  }

  isRunning(profileId: ProfileId): boolean {
    const driver = this.bindings.get(profileId);
    return driver ? driver.isRunning(profileId) : false;
  }

  navigate(profileId: ProfileId, url: string): Promise<{ url: string }> {
    return this.require(profileId).navigate(profileId, url);
  }
  click(profileId: ProfileId, selector: string): Promise<{ ok: true }> {
    return this.require(profileId).click(profileId, selector);
  }
  type(profileId: ProfileId, selector: string, text: string): Promise<{ ok: true }> {
    return this.require(profileId).type(profileId, selector, text);
  }
  extract(profileId: ProfileId): Promise<{ result: unknown }> {
    return this.require(profileId).extract(profileId);
  }
  screenshot(profileId: ProfileId): Promise<{ pngBase64: string }> {
    return this.require(profileId).screenshot(profileId);
  }
  cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown> {
    // Delegates to the bound driver: on a Camoufox profile that's the Firefox
    // driver, whose cdpSend throws "unsupported on this engine" (AC6).
    return this.require(profileId).cdpSend(profileId, method, params, sessionId, opts);
  }
  evaluateJs(profileId: ProfileId, expression: string, sessionId?: string): Promise<unknown> {
    return this.require(profileId).evaluateJs(profileId, expression, sessionId);
  }
  getCookies(profileId: ProfileId, urls: string[], sessionId?: string): Promise<unknown> {
    return this.require(profileId).getCookies(profileId, urls, sessionId);
  }
  setCookies(profileId: ProfileId, cookies: unknown[], sessionId?: string): Promise<unknown> {
    return this.require(profileId).setCookies(profileId, cookies, sessionId);
  }
  listTabs(profileId: ProfileId, sessionId?: string): Promise<unknown> {
    return this.require(profileId).listTabs(profileId, sessionId);
  }
  newTab(profileId: ProfileId, url?: string, sessionId?: string): Promise<unknown> {
    return this.require(profileId).newTab(profileId, url, sessionId);
  }
  activateTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.require(profileId).activateTab(profileId, targetId, sessionId);
  }
  closeTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.require(profileId).closeTab(profileId, targetId, sessionId);
  }

  async closeAll(): Promise<void> {
    await this.chromiumDriver.closeAll();
    if (this.firefoxDriver) await this.firefoxDriver.closeAll();
    this.bindings.clear();
  }
}
