import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { PreviewFrame, PreviewInputEvent, ProfileId } from "@multizen/types";

/**
 * Live-preview engine for a running Chromium (CloakBrowser) profile.
 *
 * The browser is an EXTERNAL process, so Electron cannot embed it in a
 * `WebContentsView`. The only viable route is a CDP screencast: JPEG frames
 * are streamed from the browser to the host and drawn on a `<canvas>` in the
 * renderer.
 *
 * Why a BROWSER-level socket (not the page-level one {@link CdpSession}
 * uses): `Target.setAutoAttach` is only honoured on a browser-level
 * connection — a page-level connection never delivers the
 * `Target.attachedToTarget` event for newly opened tabs. So this class owns
 * ONE browser-level websocket per profile and does its own target management.
 *
 * Empirical facts about the patched CloakBrowser binary that shape this
 * implementation (do not "fix" them):
 *  - The GPU process crashes a few times per launch. The compositor dies with
 *    it and the screencast STALLS (0 frames) for ~4-6s, then recovers on its
 *    own — no restart, no recovery logic.
 *  - ONLY THE ACTIVE TAB PAINTS. A background tab's screencast freezes, so
 *    we screencast the tab the user is actually looking at (found via
 *    `document.visibilityState`) and follow it when they switch tabs.
 *  - Frames MUST be acked promptly (`Page.screencastFrameAck`), otherwise
 *    the stream stalls after a handful of frames.
 *
 * ── ONE window, parked ──────────────────────────────────────────────────────
 * The profile owns exactly ONE browser window. It is either VISIBLE (the
 * user's window, with their tabs) or PARKED (the SAME window, moved
 * off-screen at (-32000,-32000), holding the profile open and driving the
 * preview).
 *
 * The window is never destroyed and re-created. When the user closes it, a
 * replacement is RACED into existence (Chromium exits ~60ms after its last
 * target is destroyed) and the full tab set is RESTORED into it. When the
 * user opens it again, that same window is UN-PARKED — the tabs are still
 * loaded, nothing reloads, no state is lost.
 *
 *  - The race: the moment the user's last page target is destroyed,
 *    `Target.createTarget` is fired with NO intervening await, because the
 *    browser processes the request while it is still tearing the old window
 *    down. `background: true` is REQUIRED — without it the create races the
 *    shutdown and the browser exits anyway (measured).
 *  - Parking is `Browser.setWindowBounds` to (-32000,-32000). NEVER minimize:
 *    a minimized window stops painting, and the parked window has to paint
 *    (it is the preview's source). Under the X11 backend the position sticks
 *    and the window keeps painting — measured.
 *  - `Target.createTarget`'s `windowId` parameter is IGNORED by this build
 *    (measured): a new tab ALWAYS lands in the ACTIVE window. To put a tab
 *    in a specific window the window must be ACTIVATED first.
 *  - The browser saves its session per WINDOW, so the profile must end with
 *    exactly ONE window or the next launch restores several.
 *
 * Parking off-screen only works when the browser honours CDP's
 * `Browser.setWindowBounds`. On Wayland the compositor owns window placement
 * and ignores it (the window pops up at (0,0)), so the browser has to be
 * launched with `--ozone-platform=x11` — see ChromiumBrowserDriver.
 */

export interface PreviewStreamOptions {
  /** The profile this stream belongs to (stamped on every emitted frame). */
  profileId: ProfileId;
  /** Port the Chromium instance is listening on. */
  port: number;
  /** Optional host override, defaults to 127.0.0.1. */
  host?: string;
  /** JPEG quality (1-100). Defaults to 60. */
  quality?: number;
  /** Max width of the streamed image, in CSS px. Defaults to 480. */
  maxWidth?: number;
  /** Max height of the streamed image, in CSS px. Defaults to 360. */
  maxHeight?: number;
  /** Emit one screencast frame every N source frames. Defaults to 3. */
  everyNthFrame?: number;
  /**
   * Keep the browser alive when the user closes their window. Defaults to
   * true. When the survivor cannot be armed the stream degrades to today's
   * behaviour: the preview shows the user's window and the profile dies with
   * it.
   */
  keepalive?: boolean;
  /**
   * Engine runs on a private Xvfb display: park its window at (0,0) INSIDE
   * that display instead of off-screen, so the compositor keeps painting.
   */
  virtualDisplay?: boolean;
  /** Window size from the profile fingerprint, used on the Xvfb display. */
  virtualWindowSize?: { width: number; height: number };
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
  sessionId?: string;
}

interface ScreencastFrameParams {
  data?: string;
  sessionId?: number;
  metadata?: {
    deviceWidth?: number;
    deviceHeight?: number;
  };
}

interface TargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
}

/** A CDP command awaiting its response. */
interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const DEFAULT_QUALITY = 60;
const DEFAULT_MAX_WIDTH = 480;
const DEFAULT_MAX_HEIGHT = 360;

/**
 * Off-screen position for the parked window. Negative coordinates park it
 * outside every display while it keeps painting.
 */
const PARKED_LEFT = -32000;
const PARKED_TOP = -32000;
/** Requested window size. The WM clamps the width, but the position sticks
 *  — that is what matters. */
const PARKED_WIDTH = 1280;
const PARKED_HEIGHT = 800;

/** On-screen position used when the window is un-parked. */
const VISIBLE_LEFT = 60;
const VISIBLE_TOP = 60;

/** Safety-net poll interval for the user's current URL. */
const URL_POLL_MS = 2000;
/** How often the preview checks which tab the user is looking at. */
const ACTIVE_POLL_MS = 1500;

/**
 * How often the parked window's off-screen position is re-asserted. The
 * window manager drifts it back to (0,0) a few seconds after the user's
 * window closes (measured ~6-8s on CloakBrowser 146), so the guard has to be
 * tight enough that the window is never visibly on the user's screen for
 * long: measured on CloakBrowser 146, a 250ms guard kept it off-screen
 * 99.2% of the time (1s: 95.6%).
 */
const PARKED_BOUNDS_GUARD_MS = 250;

/**
 * How long a captured "the window is closing" tab set is kept before it is
 * considered stale. Closing a window destroys its tabs one event at a
 * time, so the burst needs a moment to finish before the window can be
 * declared still-open.
 */
const CLOSING_SNAPSHOT_RESET_MS = 500;

/**
 * Default per-command timeout. A CDP reply that never arrives must not
 * strand a caller forever — the app's Stop button hung on exactly that
 * (8 passes of sends with no timeout).
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 8000;

/**
 * The survivor race needs a SHORT timeout: the browser exits ~60ms after
 * its last target is destroyed, so a lost reply must never stall the race.
 */
const RACE_COMMAND_TIMEOUT_MS = 1500;

/** Read an optional string field off an unknown CDP result object. */
function readOptionalString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

/** Read an optional number field off an unknown CDP result object. */
function readOptionalNumber(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

/** Read the `targetInfos` array off an unknown `Target.getTargets` result. */
function readTargetInfos(value: unknown): TargetInfo[] {
  if (value === null || typeof value !== "object") return [];
  const list = (value as Record<string, unknown>).targetInfos;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is TargetInfo => entry !== null && typeof entry === "object");
}

/** Read the `targetInfo` object off an unknown CDP event params. */
function readTargetInfo(value: unknown): TargetInfo {
  if (value === null || typeof value !== "object") return {};
  return {
    targetId: readOptionalString(value, "targetId"),
    type: readOptionalString(value, "type"),
    url: readOptionalString(value, "url"),
  };
}

/** Read the `result.value` of a `Runtime.evaluate` reply. */
function readEvaluateValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const result = (value as Record<string, unknown>)["result"];
  if (result === null || typeof result !== "object") return undefined;
  return (result as Record<string, unknown>)["value"];
}

export class PreviewStream extends EventEmitter {
  /** Mutable so setQuality can swap in new settings for the next screencast. */
  private opts: PreviewStreamOptions;
  private readonly host: string;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  /** Flattened CDP sessionId → the target it is attached to. */
  private readonly sessions = new Map<string, string>();
  /** targetId → the flattened sessionId we screencast it through. */
  private readonly streamingByTarget = new Map<string, string>();
  /** Sessions we already started a screencast on. */
  private readonly screencasting = new Set<string>();
  /** Set once {@link close} ran — the stream can never be revived. */
  private disposed = false;
  /** The socket is live and the screencast is running. */
  private live = false;
  /** The browser-level socket is open (the race needs it on its own). */
  private connected = false;
  /** True while the websocket is actually usable. A command sent after the
   *  browser died must REJECT, not hang: the pending map is only drained
   *  once, when the socket closes, so a command issued afterwards would
   *  wait for a response that can never arrive. */
  private socketOpen = false;
  /** True while frames are being produced for the renderer. */
  private streaming = false;
  /** In-flight connect attempt, so concurrent start() calls share it. */
  private connecting: Promise<void> | null = null;
  /** Monotonic per-profile frame counter. */
  private seq = 0;

  /**
   * The parked window's PRIMARY tab — the one the user was last looking at.
   * It is the tab the preview streams while the window is parked.
   */
  private parkedPrimaryTargetId: string | null = null;
  /** Every tab that belongs to the parked window (primary + restored). */
  private readonly parkedTargetIds = new Set<string>();
  /** URL of every parked tab, so the tab set can be restored/reported. */
  private readonly parkedUrls = new Map<string, string>();
  /** The parked window's id, so its off-screen position can be re-asserted. */
  private parkedWindowId: number | null = null;
  /** True while the profile's window is parked off-screen. */
  private parked = false;
  /** True while the race's `Target.createTarget` is in flight. */
  private raceInFlight = false;
  /** Resolves when the in-flight race settled (success or failure). */
  private racePromise: Promise<void> | null = null;
  /**
   * Which window a tab set is being restored into: "parked" (the raced
   * replacement window) or "visible" (a brand-new user window). `null`
   * when no restore is running. Pages that attach during a restore belong
   * to THAT window — they must never be mistaken for the user's window
   * coming back.
   */
  private restoreMode: "parked" | "visible" | null = null;
  /** Page targets that belong to the USER (everything except the parked
   *  window's tabs). */
  private readonly userTargets = new Set<string>();
  /** The last URL seen on any user page target — the page the parked
   *  window takes over when the user's window goes away. */
  private lastVisibleUrl: string | null = null;
  /** Per-user-target URL + when it was last seen changing. The tab that
   *  changed most recently is the one the user is looking at, so its URL is
   *  the one the parked window must take over. */
  private readonly userUrls = new Map<string, { url: string; at: number }>();
  /**
   * The user's tab set captured when their window STARTED closing.
   *
   * Closing a window destroys its tabs one event at a time, so the set has
   * to be captured on the FIRST destruction — by the last one, every other
   * tab's URL would already be gone.
   */
  private closingUserUrls: string[] | null = null;
  /** Timer that decides whether the window closed or only ONE tab did. */
  private closingUserUrlsTimer: NodeJS.Timeout | undefined;
  /** Low-frequency poll that refreshes {@link lastVisibleUrl}. The
   *  `Target.targetInfoChanged` event is the fast path; this is the safety
   *  net for navigations the event misses. */
  private urlPoll: NodeJS.Timeout | undefined;
  /** Re-asserts the parked window's off-screen position. The window manager
   *  re-maps the window to (0,0) once the user's own window is gone
   *  (measured: it drifts ~8s after the close and then stays at (0,0),
   *  putting a stray window on the user's screen for the rest of the
   *  profile's life). Re-asserting keeps it parked off-screen. */
  private parkedBoundsTimer: NodeJS.Timeout | undefined;
  /** The tab the preview streams from right now. */
  private activeTargetId: string | null = null;
  /** The flattened session we screencast the active tab through. */
  private activeSessionId: string | null = null;
  /** Polls which tab the user is looking at (tab switches change it). */
  private activePoll: NodeJS.Timeout | undefined;

  constructor(opts: PreviewStreamOptions) {
    super();
    this.opts = opts;
    this.host = opts.host ?? "127.0.0.1";
  }

  override on<K extends keyof PreviewStreamEvents>(
    event: K,
    listener: PreviewStreamEvents[K],
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof PreviewStreamEvents>(
    event: K,
    ...args: Parameters<PreviewStreamEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  /** True while the socket is connected and the screencast is running. */
  get isLive(): boolean {
    return this.live && !this.disposed;
  }

  /**
   * The parked window's primary target, or null when nothing is parked.
   * Callers that pick a target to act on (e.g. "focus the browser") MUST
   * skip it while it is parked — activating the off-screen window would
   * raise a window the user never asked for.
   */
  get keepaliveTarget(): string | null {
    return this.parked ? this.parkedPrimaryTargetId : null;
  }

  /**
   * The URL the user's window was showing when it closed — the page the
   * parked window takes over.
   */
  get lastUserUrl(): string | null {
    let best: { url: string; at: number } | null = null;
    for (const entry of this.userUrls.values()) {
      if (!best || entry.at > best.at) best = entry;
    }
    return best?.url ?? this.lastVisibleUrl;
  }

  /**
   * True when the profile's window exists but is parked off-screen (the
   * user's window was closed and the replacement took over).
   */
  get windowParked(): boolean {
    return this.parked;
  }

  /**
   * The user's tab URLs, most-recently-active first, deduped.
   *
   * This is the tab set that is restored into the parked window when the
   * user's window is closed, and into a fresh window when the profile has
   * no window at all.
   */
  get userTabUrls(): string[] {
    const entries = [...this.userUrls.values()].sort((a, b) => b.at - a.at);
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      // `about:blank` is what a tab shows before its first navigation — it
      // is not a tab the user cares about, and restoring it would put a
      // blank tab in front of the real ones.
      if (!entry.url || entry.url === "about:blank") continue;
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      urls.push(entry.url);
    }
    return urls;
  }

  /**
   * Connect, make sure the keepalive exists and start streaming.
   */
  async start(): Promise<void> {
    if (this.disposed) throw new Error("PreviewStream was closed");
    if (this.live) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.bringUp();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Arm the survivor: the browser process must never reach zero windows, or
   * the profile dies when the user closes their window. The survivor is
   * created by a race against that shutdown, so all this has to do is open
   * the browser-level socket and listen for the destruction — no window is
   * created here, and none exists until the user closes theirs.
   *
   * Safe to call without a preview: the socket is only used for target
   * bookkeeping, no frames are produced.
   */
  async ensureKeepalive(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.opts.keepalive === false) return false;
    if (this.connected) return true;
    if (this.connecting) {
      await this.connecting;
      return this.connected;
    }
    this.connecting = (async () => {
      await this.connect();
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
    return this.connected;
  }

  /**
   * Reconfigure the screencast at runtime. The merged settings apply to the
   * next start; live screencasts are stopped and restarted so the change is
   * visible immediately. Never touches the socket, tab set or parked state.
   */
  async setQuality(opts: {
    quality: number;
    maxWidth: number;
    maxHeight: number;
    everyNthFrame: number;
  }): Promise<void> {
    this.opts = { ...this.opts, ...opts };
    if (this.screencasting.size === 0) return;

    for (const sessionId of [...this.screencasting]) {
      await this.send("Page.stopScreencast", undefined, { sessionId, timeoutMs: 2000 }).catch(
        (e: unknown) => this.log(`setQuality stop failed: ${String(e)}`),
      );
    }
    this.screencasting.clear();

    // Bring the active tab back first, then the other attached sessions.
    const restart = new Set<string>();
    if (this.activeSessionId !== null) restart.add(this.activeSessionId);
    for (const sessionId of this.streamingByTarget.values()) restart.add(sessionId);
    for (const sessionId of restart) {
      if (!this.screencasting.has(sessionId)) await this.startScreencast(sessionId);
    }
  }

  /**
   * Stop producing frames but keep the browser-level socket AND the parked
   * window alive.
   *
   * The parked window's lifetime is the PROFILE's lifetime, not the
   * preview's: dropping it would let the browser exit the moment the user
   * closes their window. It is only torn down by {@link close}.
   */
  async stop(): Promise<void> {
    this.streaming = false;
    for (const sessionId of [...this.screencasting]) {
      await this.send("Page.stopScreencast", undefined, { sessionId, timeoutMs: 2000 }).catch(
        () => {},
      );
    }
    this.screencasting.clear();
    this.live = false;
  }

  /**
   * Tear the stream down: stop every screencast, close the parked window
   * (so Chromium exits and saves ONE window's session), clear the timers,
   * reject the pending commands and close the socket.
   *
   * Every await here is bounded — a lost CDP reply must never strand the
   * app's Stop button.
   */
  /**
   * Ask the browser to quit — the browser-level equivalent of ⌘Q.
   *
   * `Browser.close` is what makes Chromium FLUSH its session file
   * (`Default/Sessions/Session_*` + `Tabs_*`), which is the mechanism
   * behind "the tabs come back after a restart". It has to be sent on a
   * BROWSER-level connection: the page-level session the driver holds is
   * dead once the user closed their window, and a dead session cannot ask
   * the browser to quit.
   *
   * The websocket disconnects mid-call, so a rejection is expected and
   * not an error.
   */
  async closeBrowserGracefully(): Promise<boolean> {
    if (this.disposed || !this.socketOpen) return false;
    try {
      await this.send("Browser.close", {}, { timeoutMs: 3000 });
      return true;
    } catch {
      // The connection drops as Chromium shuts down — expected.
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.streaming = false;

    clearInterval(this.urlPoll);
    this.urlPoll = undefined;
    clearInterval(this.activePoll);
    this.activePoll = undefined;
    clearTimeout(this.closingUserUrlsTimer);
    this.closingUserUrlsTimer = undefined;
    this.closingUserUrls = null;
    this.stopParkedBoundsGuard();

    const ws = this.ws;
    // Stop the screencasts FIRST — while their sessions are still alive. A
    // screencast whose target is already gone can no longer be stopped, and
    // it would keep pushing frames at a torn-down stream.
    await withTimeout(
      (async () => {
        for (const sessionId of [...this.screencasting]) {
          await this.send("Page.stopScreencast", undefined, { sessionId, timeoutMs: 2000 }).catch(
            () => {},
          );
        }
      })(),
      3000,
    );
    this.screencasting.clear();

    // The parked window goes next: Chromium writes one session file PER
    // WINDOW, so leaving it open would restore two windows on the next
    // launch.
    await withTimeout(this.closeParkedWindow(), 4000);

    this.streamingByTarget.clear();
    this.sessions.clear();
    this.live = false;
    this.connected = false;
    this.socketOpen = false;

    for (const [, cmd] of this.pending) {
      cmd.reject(new Error("PreviewStream closed"));
    }
    this.pending.clear();

    this.ws = null;
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {
        // Socket already gone — nothing to do.
      }
    }
  }

  /** Connect and start streaming. */
  private async bringUp(): Promise<void> {
    // Re-arming after a window close: attachExistingPages() may re-park a
    // window that is still off-screen. Clear a stale flag left by stop() so
    // the freshly attached window's state is reflected from the start.
    this.parked = false;
    await this.connect();
    this.streaming = true;
    await this.attachExistingPages();
    this.live = true;
  }

  /** Open the socket and set up target discovery. */
  private async connect(): Promise<void> {
    if (this.connected) return;
    const wsUrl = await this.resolveBrowserWebSocketUrl();
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.ws = ws;

    try {
      await new Promise<void>((resolve, reject) => {
        // The handshake MUST be bounded too: a TCP connection to a port that
        // never completes the WebSocket upgrade would otherwise hang the
        // caller forever.
        const timer = setTimeout(() => {
          ws.off("open", onOpen);
          ws.off("error", onError);
          reject(new Error(`CDP websocket handshake timed out after ${DEFAULT_COMMAND_TIMEOUT_MS}ms`));
        }, DEFAULT_COMMAND_TIMEOUT_MS);
        timer.unref?.();
        const onOpen = (): void => {
          clearTimeout(timer);
          ws.off("error", onError);
          this.socketOpen = true;
          resolve();
        };
        const onError = (err: Error): void => {
          clearTimeout(timer);
          ws.off("open", onOpen);
          reject(err);
        };
        ws.once("open", onOpen);
        ws.once("error", onError);
      });
    } catch (e) {
      this.ws = null;
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {
        // already gone
      }
      throw e;
    }

    ws.on("message", (raw: WebSocket.RawData) => this.onMessage(raw));
    ws.on("close", () => this.onSocketClosed());
    ws.on("error", (err: Error) => {
      // Never emit "error" — an unhandled EventEmitter "error" throws. The
      // browser dying is a normal lifecycle event, not an exception.
      this.log(`websocket error: ${err.message}`);
    });

    // Auto-attach MUST be set on the browser-level connection: a page-level
    // connection never delivers new-tab events.
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    // Target discovery is how we learn the user's current URL
    // (`Target.targetInfoChanged`) — the parked window takes it over.
    await this.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    this.connected = true;

    // Safety-net poll for the user's current URL.
    this.urlPoll = setInterval(() => void this.pollUserUrl(), URL_POLL_MS);
    // Safety-net poll for the ACTIVE tab: switching tabs in the browser
    // changes which target paints, and the preview has to follow it.
    this.activePoll = setInterval(() => void this.followActiveTab(), ACTIVE_POLL_MS);
    this.urlPoll.unref?.();
    this.activePoll.unref?.();
  }

  /** Resolve the browser-level DevTools websocket URL for this port. */
  private async resolveBrowserWebSocketUrl(): Promise<string> {
    // The fetch MUST be bounded: an unresponsive engine (a half-dead
    // browser, a port that accepts the TCP connection but never answers)
    // would otherwise hang the caller forever — and the caller is the
    // driver's launch path, which the renderer's Launch button awaits. That
    // is the "the app froze" failure.
    const res = await withTimeoutOrThrow(
      fetch(`http://${this.host}:${this.opts.port}/json/version`),
      DEFAULT_COMMAND_TIMEOUT_MS,
      `CDP /json/version on port ${this.opts.port}`,
    );
    if (!res.ok) throw new Error(`CDP /json/version failed: HTTP ${res.status}`);
    const body: unknown = await res.json();
    const url = readOptionalString(body, "webSocketDebuggerUrl");
    if (!url) throw new Error("CDP /json/version has no webSocketDebuggerUrl");
    return url;
  }

  /**
   * RACE for the replacement window.
   *
   * Called the instant the user's last page target is destroyed. The browser
   * tears itself down a few tens of milliseconds later (measured: exit code
   * 0 about 60ms after the last `Target.targetDestroyed`), so the create
   * request has to leave in THIS tick — not after an await, not in a
   * follow-up task.
   *
   * `background: true` is what makes the race winnable: without it the
   * create races the shutdown and the browser exits anyway (measured).
   *
   * The race is NEVER blocked by a stale id: once a parked window is
   * UN-parked it is the user's window again, so the next close has to race a
   * FRESH replacement.
   */
  private raceSurvivor(knownUrls?: string[]): void {
    if (this.disposed) return;
    if (this.raceInFlight) return;
    // A parked window already exists — there is nothing to race for.
    if (this.parkedWindowId !== null) return;
    if (!this.socketOpen) return;
    if (this.opts.keepalive === false) return;

    // A fresh window is being created. Clear any stale parked flag left by a
    // previous close/open cycle (e.g. stop() kept the parked window alive) so
    // the park below is a genuine false -> true transition and the
    // windowParked / keepaliveTarget getters stay accurate.
    this.parked = false;

    this.raceInFlight = true;
    // From here until the restore finishes, every page that attaches belongs
    // to the PARKED window — it must not be mistaken for the user's window
    // coming back.
    this.restoreMode = "parked";
    // The tab set the replacement window takes over — read now, the user's
    // tabs are already gone.
    const urls = knownUrls ?? this.userTabUrls;
    // Create the primary tab AT the URL it must show. Chromium destroys a
    // tab together with its window and CDP exposes no pre-close hook, so the
    // original target and its JS heap are already gone when this fires. What
    // we CAN avoid is the EXTRA fresh load: creating at the URL directly
    // means restoreTabSet does not have to issue a second `Page.navigate`
    // (about:blank -> URL), which is the reload that invalidated
    // single-session sites.
    const firstUrl = urls[0];
    const createUrl =
      firstUrl !== undefined && firstUrl !== "about:blank" ? firstUrl : "about:blank";
    // `send` writes to the socket synchronously, so the request is on the
    // wire before this method returns.
    this.racePromise = this.send(
      "Target.createTarget",
      {
        url: createUrl,
        newWindow: true,
        background: true,
      },
      { timeoutMs: RACE_COMMAND_TIMEOUT_MS },
    )
      .then(async (res: unknown) => {
        const targetId = readOptionalString(res, "targetId");
        if (!targetId) {
          this.raceInFlight = false;
          this.restoreMode = null;
          this.log(
            "survivor: window could not be created — the profile dies with the user's window",
          );
          this.emit("visible-window-closed", {
            lastUrl: urls[0] ?? this.lastUserUrl,
            ok: false,
          });
          return;
        }
        await this.onParkedWindowCreated(targetId, urls);
      })
      .catch((e: unknown) => {
        this.raceInFlight = false;
        this.restoreMode = null;
        this.closingUserUrls = null;
        this.log(`survivor: Target.createTarget failed: ${String(e)}`);
        // The profile must not hang: tell the caller to tear it down.
        this.emit("visible-window-closed", { lastUrl: urls[0] ?? this.lastUserUrl, ok: false });
      })
      .finally(() => {
        this.racePromise = null;
      });
  }

  /**
   * The replacement window exists: park it off every display, restore the
   * user's tab set into it and stream it.
   */
  private async onParkedWindowCreated(targetId: string, urls: string[]): Promise<void> {
    this.raceInFlight = false;
    this.closingUserUrls = null;
    this.parkedPrimaryTargetId = targetId;
    this.parkedTargetIds.add(targetId);

    // Park the window off every display. NOT minimized: a minimized window
    // stops painting, and the parked window must paint once it takes over.
    const windowId = await this.windowIdFor(targetId);
    if (windowId !== null) await this.parkWindow(windowId);
    else {
      this.log("survivor: could not resolve the window id — the window may be on screen");
      this.setParkedState(true);
    }

    // The tab set is restored INTO the parked window.
    const restored = await this.restoreTabSet(targetId, urls, "parked");
    // The restore is over: from here on a page that attaches belongs to the
    // USER (the parked window's own tabs are already registered).
    this.restoreMode = null;

    // The parked window is now the preview's source.
    await this.followActiveTab();

    this.emit("visible-window-closed", { lastUrl: urls[0] ?? this.lastUserUrl, ok: restored });
  }

  /**
   * Restore a tab set into a window.
   *
   * The PRIMARY tab is created AT the first URL by both callers
   * ({@link raceSurvivor} and {@link openVisibleWindow}); it is never
   * navigated here. A second `Page.navigate` would be a fresh page load that
   * throws away the initial navigation's state.
   *
   * `Target.createTarget`'s `windowId` parameter is IGNORED by this build
   * (measured): a new tab ALWAYS lands in the ACTIVE window. So the target
   * window is activated before each create, and the first target is
   * re-activated between creates to keep every tab in the same window.
   */
  private async restoreTabSet(
    primaryTargetId: string,
    urls: string[],
    mode: "parked" | "visible",
  ): Promise<boolean> {
    const previousMode = this.restoreMode;
    this.restoreMode = mode;
    try {
      // The window has to be the ACTIVE one before any tab is created.
      await this.send("Target.activateTarget", { targetId: primaryTargetId }).catch(() => {});

      const first = urls[0];
      if (first !== undefined && first !== "about:blank") {
        // Both callers create the primary target AT `first` — see createUrl
        // in raceSurvivor and the createTarget in openVisibleWindow. Do NOT
        // navigate it again: that was a second, fresh load of the user's
        // page, the extra reload a single-session site treats as a new tab.
        if (mode === "parked") this.parkedUrls.set(primaryTargetId, first);
        else this.noteUserUrl(primaryTargetId, first);
      }

      for (const url of urls.slice(1)) {
        const created: unknown = await this.send("Target.createTarget", {
          url,
          newWindow: false,
        }).catch(() => null);
        const newTargetId = created !== null ? readOptionalString(created, "targetId") : undefined;
        if (newTargetId !== undefined) {
          if (mode === "parked") {
            this.parkedTargetIds.add(newTargetId);
            this.parkedUrls.set(newTargetId, url);
          } else {
            this.userTargets.add(newTargetId);
            this.noteUserUrl(newTargetId, url);
          }
        }
        // Keep the window active for the NEXT tab.
        await this.send("Target.activateTarget", { targetId: primaryTargetId }).catch(() => {});
      }
      return true;
    } finally {
      this.restoreMode = previousMode;
    }
  }

  /** Bounds for the survivor window: off-screen, or on the virtual display. */
  private get parkedBounds(): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    if (this.opts.virtualDisplay) {
      const size = this.opts.virtualWindowSize;
      return {
        left: 0,
        top: 0,
        width: size?.width ?? PARKED_WIDTH,
        height: size?.height ?? PARKED_HEIGHT,
      };
    }
    return {
      left: PARKED_LEFT,
      top: PARKED_TOP,
      width: PARKED_WIDTH,
      height: PARKED_HEIGHT,
    };
  }

  /**
   * Park the survivor window (off-screen, or at (0,0) on the private Xvfb
   * display) and mark it parked.
   *
   * NEVER minimize: a minimized window stops painting and the parked window
   * IS the preview's source.
   */
  private async parkWindow(windowId: number): Promise<void> {
    this.parkedWindowId = windowId;
    await this.send(
      "Browser.setWindowBounds",
      {
        windowId,
        bounds: this.parkedBounds,
      },
      { timeoutMs: 3000 },
    ).catch((e: unknown) => {
      this.log(`park: setWindowBounds failed: ${String(e)}`);
    });
    this.setParkedState(true);
    this.startParkedBoundsGuard();
  }

  /**
   * Move the window back on-screen and clear the parked state.
   *
   * The tabs keep their loaded state — nothing reloads, no state is lost.
   */
  private async unparkWindow(windowId: number): Promise<void> {
    this.stopParkedBoundsGuard();
    await this.send(
      "Browser.setWindowBounds",
      {
        windowId,
        bounds: this.opts.virtualDisplay
          ? this.parkedBounds
          : {
              left: VISIBLE_LEFT,
              top: VISIBLE_TOP,
              width: PARKED_WIDTH,
              height: PARKED_HEIGHT,
            },
      },
      { timeoutMs: 3000 },
    ).catch((e: unknown) => {
      this.log(`unpark: setWindowBounds failed: ${String(e)}`);
    });
    this.setParkedState(false);
  }

  /** Flip the parked flag and tell the driver (it owns the taskbar).
   *
   * Emit on EVERY call, even when the flag is unchanged. The old
   * `parked === value` guard swallowed legitimate re-parks: `stop()` keeps
   * the parked window (and the `parked === true` flag) alive, and a later
   * re-arm re-parks that same off-screen window while `parked` is still
   * true — no event reached the driver, so the taskbar entry stayed. The
   * driver's taskbar helper is idempotent, so duplicate emits are harmless.
   */
  private setParkedState(parked: boolean): void {
    this.parked = parked;
    this.emit("window-parked", { parked });
  }

  /**
   * Park the window a target lives in, off every display. Used when the
   * replacement window's own `Target.createTarget` response has not come
   * back yet — the window is on the user's screen until it is moved.
   */
  private async parkWindowOf(targetId: string): Promise<void> {
    const windowId = await this.windowIdFor(targetId);
    if (windowId === null) return;
    await this.parkWindow(windowId);
  }

  /**
   * Re-assert the parked window's off-screen position.
   *
   * The window manager re-maps a window to (0,0) a few seconds after the
   * user's own window closes — measured: it drifts back to the top-left
   * corner within ~6s, which would leave a stray window on the user's
   * screen. Re-asserting the bounds keeps it off-screen for good. The guard
   * only acts while the window is PARKED.
   */
  private startParkedBoundsGuard(): void {
    if (this.parkedBoundsTimer) return;
    this.parkedBoundsTimer = setInterval(() => {
      if (this.disposed || !this.parked) return;
      const windowId = this.parkedWindowId;
      if (windowId === null) return;
      void this.send(
        "Browser.setWindowBounds",
        {
          windowId,
          bounds: this.parkedBounds,
        },
        { timeoutMs: 1500 },
      ).catch(() => {});
    }, PARKED_BOUNDS_GUARD_MS);
    this.parkedBoundsTimer.unref?.();
  }

  /** Stop the off-screen guard. */
  private stopParkedBoundsGuard(): void {
    clearInterval(this.parkedBoundsTimer);
    this.parkedBoundsTimer = undefined;
  }

  /** The window id a target lives in, or null when unknown. */
  private async windowIdFor(targetId: string): Promise<number | null> {
    try {
      const win: unknown = await this.send("Browser.getWindowForTarget", { targetId });
      return readOptionalNumber(win, "windowId") ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Refresh {@link lastVisibleUrl} from the live target list.
   *
   * The `Target.targetInfoChanged` event is the fast path, but it only fires
   * for DISCOVERED targets and can miss a navigation that happened before
   * discovery was enabled. The poll is the safety net — 2s is slow enough
   * to be free and fast enough that the parked window is never stale for
   * long.
   */
  private async pollUserUrl(): Promise<void> {
    if (this.disposed || !this.connected) return;
    let infos: TargetInfo[] = [];
    try {
      const res: unknown = await this.send("Target.getTargets", {});
      infos = readTargetInfos(res);
    } catch {
      return;
    }
    for (const info of infos) {
      if (info.type !== "page" || !info.targetId) continue;
      if (this.parkedTargetIds.has(info.targetId)) {
        if (info.url) this.parkedUrls.set(info.targetId, info.url);
        continue;
      }
      if (!info.url) continue;
      // Only a URL that CHANGED moves the "most recent" marker — a poll
      // must not make a stale tab look like the active one.
      const known = this.userUrls.get(info.targetId);
      if (known && known.url === info.url) continue;
      this.noteUserUrl(info.targetId, info.url);
    }
  }

  /**
   * Forget the captured tab set again — the window turned out to be still
   * open (only ONE tab was closed).
   *
   * The reset is delayed: closing a window destroys its tabs one event at a
   * time, so the window is only proven open again once the destruction
   * burst is over.
   */
  private scheduleClosingSnapshotReset(): void {
    clearTimeout(this.closingUserUrlsTimer);
    this.closingUserUrlsTimer = setTimeout(() => {
      this.closingUserUrlsTimer = undefined;
      this.closingUserUrls = null;
    }, CLOSING_SNAPSHOT_RESET_MS);
    this.closingUserUrlsTimer.unref?.();
  }

  /** Record a user target's URL and mark it as the most recently seen. */
  private noteUserUrl(targetId: string, url: string): void {
    this.userUrls.set(targetId, { url, at: Date.now() });
    this.lastVisibleUrl = url;
  }

  /**
   * The user's tab set, captured while the window is closing.
   *
   * The destroyed tab's own URL is read from the map BEFORE it is dropped,
   * and the rest of the set is read while those tabs are still registered.
   * The result is deduped, most-recently-active first.
   */
  private captureClosingTabSet(destroyedTargetId: string): string[] {
    const entries = [...this.userUrls.entries()].map(([targetId, entry]) => ({
      targetId,
      url: entry.url,
      at: entry.at,
    }));
    const destroyed = entries.find((entry) => entry.targetId === destroyedTargetId);
    // The destroyed tab is the one the user was looking at (it went first),
    // so it leads the set.
    const ordered = destroyed
      ? [destroyed, ...entries.filter((entry) => entry.targetId !== destroyedTargetId)]
      : entries;
    ordered.sort((a, b) => b.at - a.at);
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const entry of ordered) {
      if (!entry.url || entry.url === "about:blank") continue;
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      urls.push(entry.url);
    }
    return urls;
  }

  /**
   * In-flight consolidation, shared by the two callers: the launch path
   * fires `consolidateWindows()` and forgets it, while the close path awaits
   * it right before `Browser.close`. Without this guard the two passes
   * interleave and copy the same source tabs TWICE into the kept window
   * (measured: 3 tabs became 6 after a Stop/Launch cycle). A concurrent
   * caller joins the run already in flight instead of starting another.
   */
  private consolidating: Promise<number> | null = null;

  /**
   * Merge every extra browser window into ONE, so a profile shows exactly
   * ONE browser window.
   *
   * Chromium writes one `Tabs_*` session file PER WINDOW and restores each
   * of them as its own window (measured: a profile whose saved session had
   * two windows came up with two visible windows, each restoring its own
   * tabs). The extra windows' tabs are moved into the main window and the
   * redundant windows are closed.
   *
   * The tab lands in the ACTIVE window — `Target.createTarget`'s `windowId`
   * parameter is IGNORED by this build (measured) — so the target window is
   * activated before each tab is created.
   */
  async consolidateWindows(): Promise<number> {
    if (this.disposed || !this.socketOpen) return 0;
    if (this.consolidating) return this.consolidating;
    const run = this.consolidateAll();
    this.consolidating = run;
    try {
      return await run;
    } finally {
      if (this.consolidating === run) this.consolidating = null;
    }
  }

  /** The whole guarded merge, including the per-pass de-duplication. */
  private async consolidateAll(): Promise<number> {
    // Merge until only ONE visible window is left: each merge removes one
    // window, so a single pass is not enough when the session restored
    // several tabs (each its own window).
    let total = 0;
    for (let pass = 0; pass < 8; pass++) {
      const merged = await this.consolidateOnce();
      total += merged;
      // Belt-and-suspenders: after EVERY pass re-read the live target list
      // and close any two visible tabs that share a URL. Even if a race
      // leaves a duplicate, the session Chromium writes on exit then holds
      // exactly one tab per URL (measured: 3 tabs came back as 6).
      await this.dedupeVisibleWindowTabs();
      if (merged === 0) break;
    }
    if (total > 0) {
      this.log(`consolidated ${total} extra window(s) into the profile's main window`);
    }
    return total;
  }

  /**
   * Close every duplicate of a URL in the visible windows, keeping the FIRST
   * target found for that URL (lowest discovery order / targetId).
   *
   * Never touches the parked window — it holds the profile's saved tab set
   * and its primary tab is the one the preview streams. Only IDENTICAL URLs
   * are collapsed; tabs with different URLs are left alone, including
   * `chrome://newtab/` duplicates (measured: those came back doubled too).
   */
  private async dedupeVisibleWindowTabs(): Promise<void> {
    if (this.disposed || !this.socketOpen) return;
    const infos = readTargetInfos(await this.send("Target.getTargets", {}).catch(() => []));
    // One entry per visible, non-parked page, grouped by the window it lives
    // in. `windowInfoFor` returns the id AND bounds in one reply.
    const byWindow = new Map<number, { targetId: string; url: string }[]>();
    for (const page of infos) {
      const targetId = page.targetId;
      const url = page.url;
      if (page.type !== "page" || !targetId || !url) continue;
      if (this.parkedTargetIds.has(targetId) || targetId === this.parkedPrimaryTargetId) continue;
      const win = await this.windowInfoFor(targetId);
      if (!win) continue;
      // An off-screen/parked window is never deduped.
      if (win.left < -1000 || win.top < -1000) continue;
      const existing = byWindow.get(win.windowId);
      const list: { targetId: string; url: string }[] = existing ?? [];
      list.push({ targetId, url });
      byWindow.set(win.windowId, list);
    }

    for (const list of byWindow.values()) {
      const firstByUrl = new Map<string, string>();
      const duplicates: string[] = [];
      for (const tab of list) {
        if (firstByUrl.has(tab.url)) {
          // Keep the first tab for this URL; close the later one.
          duplicates.push(tab.targetId);
        } else {
          firstByUrl.set(tab.url, tab.targetId);
        }
      }
      for (const targetId of duplicates) {
        await this.send("Target.closeTarget", { targetId }, { timeoutMs: 2000 }).catch(() => {});
      }
    }
  }

  /** One merge pass: move every extra visible window into the kept window.
   *  Returns how many windows were merged. */
  private async consolidateOnce(): Promise<number> {
    if (this.disposed || !this.socketOpen) return 0;
    const infos = readTargetInfos(await this.send("Target.getTargets", {}).catch(() => []));
    // The parked window is NEVER a merge candidate: it holds the profile's
    // tab set and merging it away would leave a stray blank tab in the
    // user's window.
    const pages = infos.filter(
      (t) => t.type === "page" && !!t.targetId && !this.parkedTargetIds.has(t.targetId),
    );
    if (pages.length < 2) return 0;

    // Group every page by the window it lives in ONCE — a window is merged
    // at most once, so no source window is ever revisited on a later pass.
    // Mark the off-screen ones so they are never touched. `windowInfoFor`
    // gives id and bounds in one reply (a separate getWindowBounds can fail).
    const tabsByWindow = new Map<number, { targetId: string; url: string }[]>();
    const offScreenWindows = new Set<number>();
    for (const page of pages) {
      const targetId = page.targetId;
      if (!targetId) continue;
      const win = await this.windowInfoFor(targetId);
      if (!win) continue;
      const existing = tabsByWindow.get(win.windowId);
      const list: { targetId: string; url: string }[] = existing ?? [];
      list.push({ targetId, url: page.url ?? "about:blank" });
      tabsByWindow.set(win.windowId, list);
      if (win.left < -1000 || win.top < -1000) offScreenWindows.add(win.windowId);
    }

    // The window to keep: the VISIBLE one with the MOST tabs — that is the
    // profile's main window (the session restore opens each restored tab in
    // its own window, so the main window is the one holding several tabs).
    // The parked window is never a candidate.
    const visibleWindows = [...tabsByWindow.keys()].filter((w) => !offScreenWindows.has(w));
    if (visibleWindows.length < 2) return 0;
    let keep = visibleWindows[0] as number;
    for (const windowId of visibleWindows) {
      if ((tabsByWindow.get(windowId)?.length ?? 0) > (tabsByWindow.get(keep)?.length ?? 0)) {
        keep = windowId;
      }
    }
    const keepTabs = tabsByWindow.get(keep) ?? [];
    const keepTarget = keepTabs[0]?.targetId;
    if (!keepTarget) return 0;

    // The tab lands in the ACTIVE window — `Target.createTarget`'s
    // `windowId` parameter is IGNORED by this Chromium build (measured: the
    // tab went to the active window, not the requested one). So we activate
    // the window we want to keep before creating tabs there.
    await this.send("Target.activateTarget", { targetId: keepTarget }).catch(() => {});
    await sleep(400);

    let merged = 0;
    for (const [windowId, tabs] of tabsByWindow) {
      if (windowId === keep || offScreenWindows.has(windowId)) continue;
      // Copy EVERY tab of this extra window into the kept window first ...
      for (const tab of tabs) {
        await this.send("Target.activateTarget", { targetId: keepTarget }).catch(() => {});
        await this.send("Target.createTarget", { url: tab.url, newWindow: false }).catch(() => {});
      }
      // ... then close ALL of the source window's targets in ONE batch. A
      // single per-page close (the old code) left the other tabs alive, so
      // the next pass found them again and copied them AGAIN — one duplicate
      // per pass. Closing them together destroys the window outright.
      await Promise.all(
        tabs.map((tab) =>
          this.send("Target.closeTarget", { targetId: tab.targetId }, { timeoutMs: 2000 }).catch(
            () => {},
          ),
        ),
      );
      merged += 1;
      // Re-activate the kept window before the next source window.
      await this.send("Target.activateTarget", { targetId: keepTarget }).catch(() => {});
      await sleep(300);
    }
    return merged;
  }

  /**
   * The page target of the browser's VISIBLE window (the one the user sees).
   *
   * Returns null when the profile's window is parked — the parked window is
   * never the user's, and raising it would show a window the user never
   * asked for. Used by the "click the preview" action.
   */
  async findVisibleWindow(): Promise<string | null> {
    if (this.disposed || !this.socketOpen) return null;
    const infos = readTargetInfos(await this.send("Target.getTargets", {}).catch(() => []));
    for (const page of infos) {
      const targetId = page.targetId;
      if (!targetId || page.type !== "page") continue;
      if (this.parkedTargetIds.has(targetId)) continue;
      const bounds = await this.windowBounds(targetId);
      if (!bounds) continue;
      // A window parked off-screen is never the user's.
      if (bounds.left < -1000 || bounds.top < -1000) continue;
      return targetId;
    }
    return null;
  }

  /**
   * Raise a target's window (bring it to the front).
   *
   * A PARKED target is never raised here: the parked window is off-screen
   * by design and the user did not ask for it. Un-parking goes through
   * {@link openVisibleWindow}.
   */
  async activateWindow(targetId: string): Promise<void> {
    if (this.disposed || !this.socketOpen) return;
    if (this.parkedTargetIds.has(targetId)) {
      this.log("activateWindow: target belongs to the parked window — not raising it");
      return;
    }
    await this.send("Target.activateTarget", { targetId }).catch(() => {});
  }

  /** Park the profile's visible browser window off-screen so the card is the only surface. */
  async parkForPreview(): Promise<boolean> {
    if (this.disposed || !this.socketOpen || this.parked) return false;
    try {
      const infos = readTargetInfos(await this.send("Target.getTargets", {}));
      for (const page of infos) {
        const targetId = page.targetId;
        if (!targetId || page.type !== "page") continue;
        if (this.parkedTargetIds.has(targetId)) continue;
        const win = await this.windowInfoFor(targetId);
        if (win === null) continue;
        if (win.left < -1000 || win.top < -1000) continue;
        await this.parkWindow(win.windowId);
        return true;
      }
    } catch (e) {
      this.log(`parkForPreview failed: ${String(e)}`);
    }
    return false;
  }

  /** Forward one input event into the page currently producing screencast frames. */
  async dispatchInput(event: PreviewInputEvent): Promise<void> {
    if (this.disposed || !this.socketOpen || !this.connected) return;
    try {
      // The remembered session can be stale after a tab switch or a
      // setQuality restart — only dispatch through a live screencast.
      let sessionId = this.activeSessionId;
      if (sessionId !== null && !this.screencasting.has(sessionId)) sessionId = null;
      if (sessionId === null && this.activeTargetId !== null) {
        const candidate = this.streamingByTarget.get(this.activeTargetId) ?? null;
        if (candidate !== null && this.screencasting.has(candidate)) sessionId = candidate;
      }
      if (sessionId === null) {
        const candidates = [...this.userTargets];
        for (const targetId of candidates) await this.ensureSession(targetId);
        const targetId = await this.pickActiveTarget(candidates);
        if (targetId !== null) {
          const candidate = this.streamingByTarget.get(targetId) ?? null;
          if (candidate !== null && this.screencasting.has(candidate)) sessionId = candidate;
        }
      }
      if (sessionId === null) {
        // A mapped session may have been stopped; prefer any live one.
        for (const candidate of this.streamingByTarget.values()) {
          if (this.screencasting.has(candidate)) {
            sessionId = candidate;
            break;
          }
        }
      }
      if (sessionId === null) return;

      switch (event.kind) {
        case "mouseMoved": {
          await this.send(
            "Input.dispatchMouseEvent",
            {
              type: "mouseMoved",
              x: event.x,
              y: event.y,
              modifiers: event.modifiers,
              buttons: event.buttons,
              button: "none",
            },
            { sessionId },
          );
          return;
        }
        case "mousePressed":
        case "mouseReleased": {
          const params: Record<string, unknown> = {
            type: event.kind,
            x: event.x,
            y: event.y,
            modifiers: event.modifiers,
            buttons: event.buttons,
          };
          if (event.button !== undefined) params.button = event.button;
          if (event.clickCount !== undefined) params.clickCount = event.clickCount;
          await this.send("Input.dispatchMouseEvent", params, { sessionId });
          return;
        }
        case "mouseWheel": {
          const params: Record<string, unknown> = {
            type: "mouseWheel",
            x: event.x,
            y: event.y,
            modifiers: event.modifiers,
            buttons: event.buttons,
            button: "none",
          };
          if (event.deltaX !== undefined) params.deltaX = event.deltaX;
          if (event.deltaY !== undefined) params.deltaY = event.deltaY;
          await this.send("Input.dispatchMouseEvent", params, { sessionId });
          return;
        }
        case "keyDown":
        case "rawKeyDown":
        case "keyUp":
        case "char": {
          const params: Record<string, unknown> = {
            type: event.kind,
            key: event.key,
            code: event.code,
            windowsVirtualKeyCode: event.windowsVirtualKeyCode,
            modifiers: event.modifiers,
          };
          if (event.nativeVirtualKeyCode !== undefined) {
            params.nativeVirtualKeyCode = event.nativeVirtualKeyCode;
          }
          if (event.text !== undefined) params.text = event.text;
          if (event.unmodifiedText !== undefined) params.unmodifiedText = event.unmodifiedText;
          await this.send("Input.dispatchKeyEvent", params, { sessionId });
          return;
        }
        case "insertText": {
          await this.send("Input.insertText", { text: event.text }, { sessionId });
          return;
        }
      }
    } catch (e) {
      this.log(`dispatchInput failed: ${String(e)}`);
    }
  }

  /** The bounds of the window a target lives in, or null when unknown. */
  private async windowBounds(targetId: string): Promise<{ left: number; top: number } | null> {
    const info = await this.windowInfoFor(targetId);
    if (!info) return null;
    return { left: info.left, top: info.top };
  }

  /**
   * The window a target lives in: its id AND its bounds in ONE reply.
   *
   * `Browser.getWindowForTarget` returns both — a separate
   * `Browser.getWindowBounds` call is not needed (and on this build it can
   * fail outright).
   */
  private async windowInfoFor(
    targetId: string,
  ): Promise<{ windowId: number; left: number; top: number } | null> {
    const win: unknown = await this.send("Browser.getWindowForTarget", { targetId }).catch(
      () => null,
    );
    if (win === null || typeof win !== "object") return null;
    const windowId = readOptionalNumber(win, "windowId");
    const bounds = (win as Record<string, unknown>)["bounds"];
    if (bounds === null || typeof bounds !== "object") return null;
    const left = readOptionalNumber(bounds, "left");
    const top = readOptionalNumber(bounds, "top");
    if (windowId === undefined || left === undefined || top === undefined) return null;
    return { windowId, left, top };
  }

  /**
   * Make the profile's browser window VISIBLE again.
   *
   * If a parked window exists it is UN-PARKED: moved on-screen, activated,
   * and its tabs are left exactly as they are — nothing reloads, no state is
   * lost. The parked tabs become the user's tabs again and the preview is
   * re-pointed at the now-active user tab.
   *
   * If no window exists at all (the profile has none), a new one is created
   * and the recorded tab set is restored into it.
   *
   * `url` is a FALLBACK only — the parked window's own tabs win.
   */
  async openVisibleWindow(url?: string | null): Promise<string | null> {
    if (this.disposed || !this.socketOpen) return null;

    // The race may still be in flight (the user closed their window and
    // clicked the preview right away). Un-parking before it settled would
    // race the two — wait for the replacement window to exist first.
    if (this.racePromise !== null) {
      await withTimeout(this.racePromise, 5000);
    }
    if (this.disposed || !this.socketOpen) return null;

    const parkedPrimary = this.parkedPrimaryTargetId;
    if (parkedPrimary !== null) {
      const windowId = this.parkedWindowId ?? (await this.windowIdFor(parkedPrimary));
      if (windowId !== null) await this.unparkWindow(windowId);
      else {
        this.stopParkedBoundsGuard();
        this.setParkedState(false);
      }

      // The parked tabs become the USER's tabs again. They keep their
      // loaded state — nothing is navigated or reloaded here.
      const restored = [...this.parkedTargetIds];
      const primaryUrl = this.parkedUrls.get(parkedPrimary);
      for (const targetId of restored) {
        this.userTargets.add(targetId);
        const parkedUrl = this.parkedUrls.get(targetId);
        if (parkedUrl !== undefined) this.noteUserUrl(targetId, parkedUrl);
      }
      // The primary tab is the one the user was last looking at — it must
      // stay the MOST RECENT one, so `lastUserUrl` keeps pointing at it.
      if (primaryUrl !== undefined) this.noteUserUrl(parkedPrimary, primaryUrl);
      this.parkedTargetIds.clear();
      this.parkedUrls.clear();
      this.parkedPrimaryTargetId = null;
      this.parkedWindowId = null;

      // The window is on screen again — make the primary tab the active one
      // so the user lands on the page they were last on.
      await this.send("Target.activateTarget", { targetId: parkedPrimary }).catch(() => {});
      for (const targetId of restored) await this.ensureSession(targetId);

      // Re-point the preview at the now-active user tab.
      const active = await this.pickActiveTarget([...this.userTargets]);
      if (active !== null) {
        const sessionId = this.streamingByTarget.get(active);
        if (sessionId !== undefined) {
          this.activeTargetId = active;
          this.activeSessionId = sessionId;
          if (this.streaming) await this.switchActiveTab(active, sessionId);
        }
      }
      return active ?? parkedPrimary;
    }

    // No window at all: create one and restore the recorded tab set into it.
    const urls = this.userTabUrls;
    const first = urls[0] ?? url ?? "about:blank";
    const created: unknown = await this.send("Target.createTarget", {
      url: first,
      newWindow: true,
    }).catch(() => null);
    const targetId = created !== null ? readOptionalString(created, "targetId") : undefined;
    if (targetId === undefined) {
      this.log("openVisibleWindow: createTarget failed");
      return null;
    }
    this.userTargets.add(targetId);
    this.noteUserUrl(targetId, first);

    const windowId = await this.windowIdFor(targetId);
    if (windowId !== null) {
      await this.send(
        "Browser.setWindowBounds",
        {
          windowId,
          bounds: {
            left: VISIBLE_LEFT,
            top: VISIBLE_TOP,
            width: PARKED_WIDTH,
            height: PARKED_HEIGHT,
          },
        },
        { timeoutMs: 3000 },
      ).catch(() => {});
    }
    if (urls.length > 1) await this.restoreTabSet(targetId, urls, "visible");
    await this.send("Target.activateTarget", { targetId }).catch(() => {});
    return targetId;
  }

  /** Close the parked window (best effort) — one window, one session file. */
  private async closeParkedWindow(): Promise<void> {
    const targets = [...this.parkedTargetIds];
    const primary = this.parkedPrimaryTargetId;
    this.parkedTargetIds.clear();
    this.parkedUrls.clear();
    this.parkedPrimaryTargetId = null;
    this.parkedWindowId = null;
    this.stopParkedBoundsGuard();
    this.setParkedState(false);
    for (const targetId of targets) {
      if (targetId === primary) continue;
      await this.send("Target.closeTarget", { targetId }, { timeoutMs: 2000 }).catch(() => {});
    }
    if (primary !== null) {
      await this.send("Target.closeTarget", { targetId: primary }, { timeoutMs: 3000 }).catch(
        () => {},
      );
    }
  }

  /** Attach to the page targets that already exist and start their screencast. */
  private async attachExistingPages(): Promise<void> {
    let infos: TargetInfo[] = [];
    try {
      const res: unknown = await this.send("Target.getTargets", {});
      infos = readTargetInfos(res);
    } catch (e) {
      this.log(`Target.getTargets failed: ${String(e)}`);
      return;
    }
    // Resolve every page's window FIRST: the parked set is decided per
    // WINDOW, not per tab — a parked window with three tabs is three parked
    // tabs.
    const windowOf = new Map<string, { windowId: number; left: number; top: number }>();
    for (const info of infos) {
      if (info.type !== "page" || !info.targetId) continue;
      const win = await this.windowInfoFor(info.targetId);
      if (win !== null) windowOf.set(info.targetId, win);
    }
    // A window that is ALREADY parked off-screen belongs to the parked set
    // even when this stream did not create it (the preview was restarted
    // while the profile's window was parked). Its position is re-asserted —
    // the WM drifts it back to (0,0) over time.
    const parkedWindows = new Set<number>();
    for (const info of infos) {
      if (info.type !== "page" || !info.targetId) continue;
      const targetId = info.targetId;
      // The parked window's tabs are never user tabs.
      if (this.parkedTargetIds.has(targetId)) {
        if (info.url) this.parkedUrls.set(targetId, info.url);
        await this.ensureSession(targetId);
        continue;
      }
      const win = windowOf.get(targetId);
      if (win !== undefined && (win.left < -1000 || win.top < -1000)) {
        this.parkedTargetIds.add(targetId);
        if (this.parkedPrimaryTargetId === null) this.parkedPrimaryTargetId = targetId;
        if (info.url) this.parkedUrls.set(targetId, info.url);
        await this.ensureSession(targetId);
        if (!parkedWindows.has(win.windowId)) {
          parkedWindows.add(win.windowId);
          await this.parkWindow(win.windowId);
        }
        continue;
      }
      this.userTargets.add(targetId);
      if (info.url) this.noteUserUrl(targetId, info.url);
      await this.ensureSession(targetId);
    }
    // Pick the tab the user is actually looking at and stream that one.
    await this.followActiveTab();
  }

  /**
   * Stream the tab that is ACTUALLY visible.
   *
   * While the window is PARKED that is the parked window's active tab; while
   * it is VISIBLE it is the user's active tab.
   *
   * Only the visible tab paints — a background tab's screencast freezes
   * after a frame or two (measured). A profile with several tabs (the app
   * launches with --restore-last-session, so tabs come back) therefore
   * produced a nearly dead preview when the stream sat on the wrong tab.
   *
   * The active tab is found by asking each page target for its
   * `document.visibilityState`; "visible" is the one Chromium paints.
   */
  private async followActiveTab(): Promise<void> {
    if (this.disposed || !this.streaming) return;
    const candidates = this.parked ? [...this.parkedTargetIds] : [...this.userTargets];
    if (candidates.length === 0) return;
    // Every candidate needs a session before it can be queried for its
    // visibility — the auto-attach event may not have arrived yet for a
    // tab that was just restored.
    for (const targetId of candidates) await this.ensureSession(targetId);
    const targetId = await this.pickActiveTarget(candidates);
    if (targetId === null) return;
    const sessionId = this.streamingByTarget.get(targetId);
    if (sessionId === undefined) return;
    // The screencast must be RUNNING, not just pointed at the right tab:
    // stop() clears the screencasts but keeps the pointers, and a later
    // start() has to bring the frames back.
    if (
      this.activeTargetId === targetId &&
      this.activeSessionId === sessionId &&
      this.screencasting.has(sessionId)
    ) {
      return;
    }
    await this.switchActiveTab(targetId, sessionId);
  }

  /**
   * The visible tab among the candidates.
   *
   * Falls back to the current source, then to the parked window's primary
   * tab (the one the user was last looking at), then to any candidate that
   * has a session — a tab that is not the active one still renders
   * something, a dead source renders nothing.
   */
  private async pickActiveTarget(candidates: string[]): Promise<string | null> {
    if (candidates.length === 0) return null;
    for (const targetId of candidates) {
      const sessionId = this.streamingByTarget.get(targetId);
      if (sessionId === undefined) continue;
      if (await this.isTabVisible(sessionId)) return targetId;
    }
    if (this.activeTargetId !== null && candidates.includes(this.activeTargetId)) {
      return this.activeTargetId;
    }
    if (
      this.parked &&
      this.parkedPrimaryTargetId !== null &&
      candidates.includes(this.parkedPrimaryTargetId)
    ) {
      return this.parkedPrimaryTargetId;
    }
    return candidates.find((targetId) => this.streamingByTarget.has(targetId)) ?? null;
  }

  /** Is this tab the one Chromium paints? */
  private async isTabVisible(sessionId: string): Promise<boolean> {
    try {
      const res: unknown = await this.send(
        "Runtime.evaluate",
        { expression: "document.visibilityState", returnByValue: true },
        { sessionId },
      );
      const value = readEvaluateValue(res);
      return value === "visible";
    } catch {
      // The target may be gone — try the next one.
      return false;
    }
  }

  /** Point the screencast at a different tab and stop the previous one. */
  private async switchActiveTab(targetId: string, sessionId: string): Promise<void> {
    const previous = this.activeSessionId;
    this.activeTargetId = targetId;
    this.activeSessionId = sessionId;
    if (previous && previous !== sessionId) {
      await this.send("Page.stopScreencast", undefined, { sessionId: previous }).catch(() => {});
      this.screencasting.delete(previous);
    }
    if (this.streaming) await this.startScreencast(sessionId);
  }

  /**
   * The session attached to a target, attaching on demand.
   *
   * No-op when another session already streams that target (the auto-attach
   * path can win the race — we must never screencast the same page twice,
   * that would double the frame rate and the payload).
   */
  private async ensureSession(targetId: string): Promise<string | null> {
    if (this.disposed) return null;
    const existing = this.streamingByTarget.get(targetId);
    if (existing !== undefined) return existing;
    try {
      const res: unknown = await this.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const sid = readOptionalString(res, "sessionId");
      if (!sid) return null;
      if (this.adoptSession(targetId, sid)) return sid;
      // The auto-attach path got there first — use ITS session, the
      // duplicate was detached.
      return this.streamingByTarget.get(targetId) ?? null;
    } catch {
      // Already attached (or gone) — the auto-attach path handles it.
      return this.streamingByTarget.get(targetId) ?? null;
    }
  }

  /**
   * Register an attached session for a target.
   *
   * Returns false when a DIFFERENT session already owns the target — the
   * duplicate is detached instead of double-streaming the page.
   */
  private adoptSession(targetId: string, sessionId: string): boolean {
    const owner = this.streamingByTarget.get(targetId);
    if (owner !== undefined) {
      if (owner !== sessionId) {
        void this.send("Target.detachFromTarget", undefined, { sessionId }).catch(() => {});
      }
      return owner === sessionId;
    }
    this.sessions.set(sessionId, targetId);
    this.streamingByTarget.set(targetId, sessionId);
    return true;
  }

  /** Enable the Page domain and start the screencast on a session. */
  private async startScreencast(sessionId: string): Promise<boolean> {
    if (this.disposed) return false;
    if (this.screencasting.has(sessionId)) return true;
    try {
      await this.send("Page.enable", undefined, { sessionId });
      await this.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: this.opts.quality ?? DEFAULT_QUALITY,
          maxWidth: this.opts.maxWidth ?? DEFAULT_MAX_WIDTH,
          maxHeight: this.opts.maxHeight ?? DEFAULT_MAX_HEIGHT,
          everyNthFrame: this.opts.everyNthFrame ?? 3,
        },
        { sessionId },
      );
      this.screencasting.add(sessionId);
      return true;
    } catch (e) {
      this.log(`startScreencast failed: ${String(e)}`);
      return false;
    }
  }

  private onMessage(raw: WebSocket.RawData): void {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(raw.toString()) as CdpMessage;
    } catch {
      return;
    }

    if (msg.id !== undefined && msg.method === undefined) {
      const cmd = this.pending.get(msg.id);
      if (!cmd) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        cmd.reject(new Error(msg.error.message ?? `CDP error ${msg.error.code ?? "?"}`));
      } else {
        cmd.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;
    switch (msg.method) {
      case "Target.attachedToTarget": {
        const sessionId = readOptionalString(msg.params, "sessionId");
        const targetInfo = readTargetInfo(msg.params?.["targetInfo"]);
        const targetId = targetInfo.targetId;
        const type = targetInfo.type;
        const url = targetInfo.url;
        if (!sessionId || !targetId || type !== "page") return;

        // A tab of the PARKED window is never a user tab.
        if (this.parkedTargetIds.has(targetId)) {
          this.adoptSession(targetId, sessionId);
          if (url) this.parkedUrls.set(targetId, url);
          return;
        }

        // The parked window is being created/restored right now: the attach
        // event can beat the createTarget response, so these pages belong to
        // the parked window — NOT to the user's window coming back.
        const mode = this.restoreMode ?? (this.raceInFlight ? "parked" : null);
        if (mode === "parked") {
          this.parkedTargetIds.add(targetId);
          this.adoptSession(targetId, sessionId);
          if (url) this.parkedUrls.set(targetId, url);
          // Park the window from HERE: it is on the user's screen until it
          // is moved, and the createTarget response may never arrive.
          if (this.raceInFlight && this.parkedWindowId === null) {
            void this.parkWindowOf(targetId);
          }
          return;
        }

        // A USER tab.
        this.userTargets.add(targetId);
        if (url) this.noteUserUrl(targetId, url);
        // A user tab exists again — the window was NOT closing (a single
        // tab was closed), so the captured tab set is stale.
        this.closingUserUrls = null;
        this.adoptSession(targetId, sessionId);
        // Do NOT screencast every new tab: only the ACTIVE tab paints, so a
        // background tab's screencast would freeze after a frame or two.
        // The active tab is picked by followActiveTab().
        if (this.streaming) void this.followActiveTab();
        return;
      }
      case "Target.detachedFromTarget": {
        const sessionId = readOptionalString(msg.params, "sessionId");
        if (!sessionId) return;
        this.screencasting.delete(sessionId);
        const targetId = this.sessions.get(sessionId);
        if (targetId !== undefined) this.streamingByTarget.delete(targetId);
        this.sessions.delete(sessionId);
        return;
      }
      case "Target.targetDestroyed": {
        const targetId = readOptionalString(msg.params, "targetId");
        if (!targetId) return;
        if (this.parkedTargetIds.delete(targetId)) {
          this.parkedUrls.delete(targetId);
          if (this.activeTargetId === targetId) {
            this.activeTargetId = null;
            this.activeSessionId = null;
          }
          if (targetId === this.parkedPrimaryTargetId) {
            // The parked window is gone — the profile cannot be kept alive.
            this.parkedPrimaryTargetId = null;
            this.parkedWindowId = null;
            this.stopParkedBoundsGuard();
            this.setParkedState(false);
            if (!this.disposed) {
              this.emit("visible-window-closed", { lastUrl: this.lastUserUrl, ok: false });
            }
          }
          return;
        }
        const sessionId = this.streamingByTarget.get(targetId);
        if (sessionId !== undefined) {
          this.screencasting.delete(sessionId);
          this.sessions.delete(sessionId);
          this.streamingByTarget.delete(targetId);
        }
        if (this.activeTargetId === targetId) {
          this.activeTargetId = null;
          this.activeSessionId = null;
        }
        if (!this.userTargets.delete(targetId)) return;
        // The FIRST destruction of a user tab means the window is closing:
        // capture the whole tab set NOW — the other tabs are still
        // registered, and by the last destruction they would be gone.
        if (this.closingUserUrls === null) {
          this.closingUserUrls = this.captureClosingTabSet(targetId);
        }
        this.userUrls.delete(targetId);
        // The user's window is gone once its last tab is destroyed. The
        // replacement has to be created NOW — the browser starts tearing
        // itself down a few tens of milliseconds later (measured).
        if (this.userTargets.size === 0) {
          const urls = this.closingUserUrls ?? [];
          if (urls[0] !== undefined) this.lastVisibleUrl = urls[0];
          this.raceSurvivor(urls);
          return;
        }
        // The window is still open — only ONE tab was closed. The captured
        // set is stale: it has to be re-taken when the window really goes.
        this.scheduleClosingSnapshotReset();
        return;
      }
      case "Target.targetInfoChanged": {
        const targetInfo = readTargetInfo(msg.params?.["targetInfo"]);
        const targetId = targetInfo.targetId;
        if (!targetId) return;
        if (targetInfo.type !== undefined && targetInfo.type !== "page") return;
        if (this.parkedTargetIds.has(targetId)) {
          if (targetInfo.url) this.parkedUrls.set(targetId, targetInfo.url);
          return;
        }
        if (targetInfo.url) this.noteUserUrl(targetId, targetInfo.url);
        return;
      }
      case "Page.screencastFrame": {
        this.onScreencastFrame(msg);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Handle one screencast frame: ACK it FIRST (a late ack stalls the whole
   * stream), then emit it.
   */
  private onScreencastFrame(msg: CdpMessage): void {
    // A frame that arrives after close() must not reach the renderer — the
    // profile is gone and the canvas is being torn down.
    if (this.disposed) return;
    const params = msg.params as ScreencastFrameParams | undefined;
    const data = params?.data;
    if (!data) return;

    // The ack carries the frame's own screencast session id in its PARAMS
    // and the flattened CDP session in the MESSAGE-level sessionId field.
    const ackParams: Record<string, unknown> = {};
    if (params?.sessionId !== undefined) ackParams.sessionId = params.sessionId;
    void this.send("Page.screencastFrameAck", ackParams, { sessionId: msg.sessionId }).catch(
      () => {},
    );

    const meta = params?.metadata;
    const width =
      typeof meta?.deviceWidth === "number" && meta.deviceWidth > 0
        ? meta.deviceWidth
        : (this.opts.maxWidth ?? DEFAULT_MAX_WIDTH);
    const height =
      typeof meta?.deviceHeight === "number" && meta.deviceHeight > 0
        ? meta.deviceHeight
        : (this.opts.maxHeight ?? DEFAULT_MAX_HEIGHT);

    this.seq += 1;
    const frame: PreviewFrame = {
      profileId: this.opts.profileId,
      data,
      width,
      height,
      seq: this.seq,
    };
    this.emit("frame", frame);
  }

  private onSocketClosed(): void {
    this.live = false;
    this.connected = false;
    this.socketOpen = false;
    for (const [, cmd] of this.pending) {
      cmd.reject(new Error("PreviewStream socket closed"));
    }
    this.pending.clear();
    this.screencasting.clear();
    this.streamingByTarget.clear();
    this.sessions.clear();
    this.parkedTargetIds.clear();
    this.parkedUrls.clear();
    this.parkedPrimaryTargetId = null;
    this.parkedWindowId = null;
    this.raceInFlight = false;
    this.restoreMode = null;
    this.stopParkedBoundsGuard();
    this.setParkedState(false);
  }

  /**
   * Send a CDP command. `opts.sessionId` routes it to a flattened session.
   *
   * Every command is bounded: a reply that never arrives rejects the
   * promise instead of hanging the caller forever. A command sent on a
   * closed socket REJECTS straight away (the pending map is only drained
   * once, when the socket closes).
   */
  private send(
    method: string,
    params?: Record<string, unknown>,
    opts?: { sessionId?: string; timeoutMs?: number },
  ): Promise<unknown> {
    const ws = this.ws;
    if (!ws || !this.socketOpen) {
      return Promise.reject(new Error("PreviewStream not connected"));
    }
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const payload: Record<string, unknown> = { id, method };
    if (params) payload.params = params;
    if (opts?.sessionId) payload.sessionId = opts.sessionId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private log(message: string): void {
    process.stderr.write(`[multizen] preview ${this.opts.profileId}: ${message}\n`);
  }
}

/** Sleep helper for the few places that must wait between CDP commands. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bound a promise so a lost CDP reply can never strand a teardown path.
 * Resolves with undefined when the deadline passes.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, ms);
    timer.unref?.();
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/**
 * Bound a promise that MUST produce a value, REJECTING when the deadline
 * passes.
 *
 * The sibling {@link withTimeout} resolves with `undefined` — right for
 * teardown paths where a missing value is harmless, wrong for a path whose
 * result is used (a `fetch` whose `undefined` would flow into
 * `res.ok`). A hung engine must FAIL LOUDLY there, not silently.
 */
function withTimeoutOrThrow<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${what} timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface PreviewStreamEvents {
  /** A new viewport frame (base64 JPEG, no data: prefix). */
  frame: (frame: PreviewFrame) => void;
  /**
   * The user closed their browser window. The replacement window took over
   * the preview, so the profile is STILL RUNNING. `ok` is false when the
   * replacement could NOT take over (the race failed or the tab set could
   * not be restored) — the caller should then tear the profile down
   * instead of leaving it in a half-dead state.
   */
  "visible-window-closed": (info: { lastUrl: string | null; ok: boolean }) => void;
  /**
   * The profile's window was parked off-screen (or un-parked). The stream
   * has no PID, so it cannot hide the window from the system taskbar
   * itself — the driver owns the engine PID and subscribes to this event.
   */
  "window-parked": (info: { parked: boolean }) => void;
}
