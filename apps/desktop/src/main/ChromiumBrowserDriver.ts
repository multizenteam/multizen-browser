import { app } from "electron";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import type { BrowserDriver } from "@multizen/mcp-server";
import type { ProfileManager } from "@multizen/profile-manager";
import type {
  ClientHints,
  FingerprintConfig,
  LaunchedProfile,
  PreviewFrame,
  PreviewInputEvent,
  ProfileId,
} from "@multizen/types";
import { waitForCdpSessionReady } from "./cdpReadiness";
import { resolveEngine, type BrowserEngine } from "@multizen/types";
import { CdpSession, PreviewStream } from "@multizen/cdp-driver";
import { EngineRegistry } from "./engineRegistry.ts";
import { setEngineTaskbarHidden } from "./x11Taskbar.ts";
import { virtualDisplay } from "./virtualDisplay.ts";
import { startBridgeForProfile, stopBridgeForProfile } from "./socks5Bridge";
import { probeProxyGeo } from "./proxyGeo";
import { companionDir } from "./extensions/companion";
import { resolveLoadDir } from "./extensions/extensionStore.ts";
import { sanitizeStartUrl } from "./startPage";

function readSysctl(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null; // file absent (kernel doesn't expose this knob)
  }
}

/** Chromium stderr signatures that mean the user-namespace sandbox could not
 *  start (so a relaunch with --no-sandbox is warranted). Kept to failure-only
 *  phrases — a generic token like CLONE_NEWUSER could appear on a healthy
 *  launch and must NOT trigger the backstop. The backstop also requires the
 *  child to have actually exited, so a stray match alone can't disable the
 *  sandbox. */
const SANDBOX_FAILURE_RE = /No usable sandbox|Failed to move to new (?:user )?namespace/i;

/**
 * Retry delays (ms) for the taskbar update.
 *
 * A Chrome window registers in `_NET_CLIENT_LIST` ~190ms after it is
 * created (MEASURED), and the stream emits "window-parked" as soon as the
 * window is parked — inside that window. The first attempts therefore find
 * no window to update; these delays cover the gap without hammering X.
 */
/** Re-apply delays (ms): the replacement window registers ~190ms after
 *  the old one is destroyed, and KWin can reset its state on map, so the
 *  final one at 2.6s lands after the window has definitely mapped. */
const TASKBAR_REAPPLY_DELAYS = [400, 1200, 2600] as const;

/** Thrown by the spawn attempt when the sandbox failed to start, so the caller
 *  can relaunch once with --no-sandbox (never re-prompting). */
class SandboxStartupError extends Error {}

/**
 * Sync fallback used ONLY when the async sandbox resolver is absent or throws:
 * whether the spawned Chromium child must run with `--no-sandbox` on Linux.
 *
 * Chromium's sandbox needs unprivileged user namespaces, which modern distros
 * restrict by default (Ubuntu 24.04+ via `apparmor_restrict_unprivileged_userns`,
 * older Debian via `unprivileged_userns_clone`). When restricted, the child dies
 * with "No usable sandbox!" and never exposes its CDP port. The richer path that
 * keeps the sandbox ON via a per-binary AppArmor profile lives in
 * `linuxSandbox.ts`; this is just the degrade-to-today's-behavior safety net.
 */
function fallbackNeedsNoSandbox(): boolean {
  if (process.platform !== "linux") return false;
  // A --no-sandbox on the HOST process (e.g. the AppImage boot flag on Ubuntu
  // 24.04) is deliberately NOT forwarded here: the engine decision is driven by
  // the actual kernel restriction below, and the crash backstop is the net.
  return (
    readSysctl("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1" ||
    readSysctl("/proc/sys/kernel/unprivileged_userns_clone") === "0"
  );
}

/** Screencast presets: compact card stream vs. sharp Expand modal. */
const QUALITY = {
  card: { quality: 62, maxWidth: 640, maxHeight: 360, everyNthFrame: 2 },
  expanded: { quality: 86, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 },
} as const;

interface RunningProcess {
  child: ChildProcess;
  cdpEndpoint: string;
  port: number;
  pid: number;
  startedAt: string;
  session: CdpSession;
  /** The engine's `--user-data-dir`. Used to sweep any lingering browser
   *  process that still holds this profile's data dir on shutdown. */
  browserDataDir: string;
  /** Polls /json/list and kills the child when no page targets remain. */
  windowWatcher: NodeJS.Timeout;
  /**
   * The profile's CDP stream: it owns the off-screen SURVIVOR window that
   * keeps the browser alive when the user closes their own window, and
   * (once a preview is started) the screencast that feeds the renderer.
   */
  stream: PreviewStream | null;
  /** Last requested preset, replayed whenever the screencast restarts. */
  qualityMode: "card" | "expanded";
  /** Profile-sized parked window on the private Xvfb display. */
  virtualWindowSize?: { width: number; height: number };
}

export interface ChromiumBrowserDriverOptions {
  profileManager: ProfileManager;
  /** Registry that owns the per-engine bootstraps. The driver resolves each
   *  profile's engine at launch and pulls that engine's binary from here. */
  engineRegistry: EngineRegistry;
  /** The app-wide default engine (settings.browserEngine) for profiles that
   *  haven't pinned one. Read live so a settings change takes effect. */
  getDefaultEngine: () => BrowserEngine;
  /**
   * Called when the companion extension's "Add to MultiZen" button is clicked
   * inside a running profile. `profileId` is the profile that made the call
   * (the CDP session is profile-scoped). The host installs the extension.
   */
  onCompanionInstall?: (profileId: ProfileId, extensionId: string) => void;
  /** Root of the shared extension store, e.g. `<userData>/data/extension-store`.
   *  Used to resolve shared extension references to their on-disk load dir. */
  extensionStoreRoot: string;
  /**
   * Decide, per launch, whether to pass `--no-sandbox` to the engine child
   * (the Linux AppArmor flow — detect restriction, verify/offer the secure
   * setup, else fall back). Injected from the host so the driver stays UI-free.
   * Omitted or throwing → the sync `fallbackNeedsNoSandbox()` is used instead.
   */
  resolveSandboxDecision?: (ctx: {
    engine: BrowserEngine;
    binaryPath: string;
  }) => Promise<{ noSandbox: boolean }>;
  /**
   * Called with the engine binary path when the crash-detection backstop had to
   * relaunch with `--no-sandbox` because the sandbox failed despite us expecting
   * it to work, so the host can mark that binary's AppArmor profile inactive for
   * the session and re-offer setup (instead of optimistically retrying it every
   * launch).
   */
  onSandboxInactive?: (binaryPath: string) => void;
}

export type RunningStateChange =
  | { kind: "launched"; profileId: ProfileId }
  // Shutdown has begun (window closed / Stop pressed) but the process hasn't
  // fully exited yet — the GUI shows a "Terminating…" transitional state.
  | { kind: "closing"; profileId: ProfileId }
  | { kind: "closed"; profileId: ProfileId; reason: "user-close" | "external-exit" };

interface DriverEvents {
  "running-changed": (change: RunningStateChange) => void;
  /** A live-preview frame from a running profile's browser. */
  "preview-frame": (frame: PreviewFrame) => void;
}

/**
 * Real driver: spawns Chromium per profile with --user-data-dir + --remote-debugging-port,
 * connects to its CDP endpoint, and routes navigate / click / type / extract / screenshot
 * through the CdpSession.
 *
 * `click` and `type` accept CSS selectors only. Natural-language target resolution is
 * intentionally not built in — the MCP client (Claude in Cursor / Claude Desktop / etc.)
 * is responsible for parsing the page snapshot and producing selectors. MultiZen never
 * calls any external API.
 */
export class ChromiumBrowserDriver extends EventEmitter implements BrowserDriver {
  private readonly running = new Map<ProfileId, RunningProcess>();
  /** Streams whose "window-parked" event is already wired to the taskbar
   *  helper — guards against a double subscription for the same stream. */
  private readonly taskbarWired = new WeakSet<PreviewStream>();
  private nextPort = 9222;
  private readonly profileManager: ProfileManager;
  private readonly engineRegistry: EngineRegistry;
  private readonly getDefaultEngine: () => BrowserEngine;
  private readonly onCompanionInstall?: (profileId: ProfileId, extensionId: string) => void;
  private readonly extensionStoreRoot: string;
  private readonly resolveSandboxDecision?: (ctx: {
    engine: BrowserEngine;
    binaryPath: string;
  }) => Promise<{ noSandbox: boolean }>;
  private readonly onSandboxInactive?: (binaryPath: string) => void;

  constructor(opts: ChromiumBrowserDriverOptions) {
    super();
    this.profileManager = opts.profileManager;
    this.engineRegistry = opts.engineRegistry;
    this.getDefaultEngine = opts.getDefaultEngine;
    this.onCompanionInstall = opts.onCompanionInstall;
    this.extensionStoreRoot = opts.extensionStoreRoot;
    this.resolveSandboxDecision = opts.resolveSandboxDecision;
    this.onSandboxInactive = opts.onSandboxInactive;
  }

  override on<K extends keyof DriverEvents>(event: K, listener: DriverEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof DriverEvents>(
    event: K,
    ...args: Parameters<DriverEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    const existing = this.running.get(profileId);
    if (existing) {
      // The profile is already running, but its window may be PARKED (the
      // user closed it — the replacement window lives off-screen). Returning
      // silently here made the Launch button look frozen: the browser was
      // there, just not on the screen. Un-park it instead — the tabs stay
      // loaded, nothing reloads.
      const stream = existing.stream;
      if (stream && stream.windowParked) {
        try {
          // Bounded: the renderer's Launch button awaits this call, so a
          // lost CDP reply must never freeze the app.
          await withTimeout(stream.openVisibleWindow(), 5000);
        } catch (e) {
          process.stderr.write(
            `[multizen] could not re-open the parked window profile=${profileId}: ${String(e)}\n`,
          );
        }
      }
      return {
        id: profileId,
        cdpEndpoint: existing.cdpEndpoint,
        pid: existing.pid,
        startedAt: existing.startedAt,
      };
    }

    const profile = this.profileManager.get(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);

    // Update `last_opened_at` for every launch, regardless of trigger
    // (UI button, MCP tool, command palette). Done early so even a
    // failed-to-spawn launch counts — the user pressed Launch.
    this.profileManager.markOpened(profileId);

    const port = this.allocatePort();
    // Resolve the profile's engine (its own pin, else the app default, else
    // CloakBrowser) and drive it from that engine's bootstrap binary.
    const engine = resolveEngine(profile.engine, this.getDefaultEngine());
    const bootstrap = this.engineRegistry.get(engine);
    // Binary-gate the launch on THIS profile's engine: download/verify it if it
    // isn't cached yet. Idempotent and fast once installed. A not-ready engine
    // therefore blocks only its own profiles — a different engine's profiles
    // (and the rest of the app) are unaffected.
    const engineStatus = await bootstrap.ensure();
    if (engineStatus.kind !== "ready" && engineStatus.kind !== "dev-system") {
      throw new Error(`Engine "${engine}" is not ready to launch (status: ${engineStatus.kind}).`);
    }
    const chromiumPath = bootstrap.resolveBinaryPath();
    const browserDataDir = browserDataDirForEngine(profile.dataDir, engine);
    // Read the actual Chromium binary's version and reconcile the
    // profile's spoofed UA against it. Detection vendors fingerprint the
    // JS engine and compare against the claimed UA — claiming Chrome
    // 148 while running 147 is an instant flag.
    const actualVersion = await detectChromiumVersion(chromiumPath);
    // Reconcile the claimed Chrome version to the actual binary version on
    // every launch, so legacy profiles auto-fix after an engine update.
    // CloakBrowser is built for cross-platform spoofing — claiming Windows
    // on a Mac binary is exactly its job (--fingerprint-platform=windows
    // patches V8/CSS/Blink at C++ level), so we respect the persona's
    // platform choice as-is.
    let fp = profile.fingerprint;
    if (actualVersion) fp = reconcileVersionInFingerprint(fp, actualVersion);

    // Timezone handling BEFORE we build CLI args (CloakBrowser's
    // --fingerprint-timezone= is set at spawn time and reads fp.timezone
    // at that moment).
    //
    // With a proxy: align fp.timezone to the egress IP's timezone. Detection
    // vendors run an "IP timezone vs JS timezone" check, and attaching a proxy
    // is an explicit "appear from here" signal, so aligning to the egress is
    // the intended behavior.
    //
    // Without a proxy: honor the profile's persona timezone as configured. We
    // deliberately do NOT snap it to the host timezone — doing so silently
    // discarded the user's timezone selection (issue #13), leaving a persona
    // whose locale/country said one thing and whose clock said another. Running
    // over a naked host IP is not a genuine evasion mode anyway (the real IP is
    // already exposed), and the one no-proxy workflow people do run — testing a
    // persona on webbrowsertools/browserscan — is exactly the case where they
    // want to see the persona timezone, not the host's.
    //
    // Known debt: the with-proxy branch below also overrides an explicitly
    // chosen fp.timezone with the proxy geo TZ, so a deliberate persona TZ is
    // silently replaced there too. Fixing that consistently (honor an explicit
    // user choice on both paths) needs a "user-set" flag on FingerprintConfig
    // and is out of scope for #13.
    let geoCoords: { latitude: number; longitude: number } | null = null;
    if (profile.proxy) {
      try {
        const geo = await probeProxyGeo(profile.proxy, { timeoutMs: 4000 });
        if (typeof geo.latitude === "number" && typeof geo.longitude === "number") {
          geoCoords = { latitude: geo.latitude, longitude: geo.longitude };
        }
        // Cache the resolved country on the profile so the GUI flag chip
        // matches the proxy's egress (Luxembourg proxy → LU flag, not the
        // fingerprint's timezone-derived country).
        if (geo.country) {
          this.profileManager.setProxyCountry(profileId, geo.country.toLowerCase());
        }
        if (geo.timezone && geo.timezone !== fp.timezone) {
          console.log(
            `[multizen] aligning fingerprint timezone ${fp.timezone} → ${geo.timezone} (proxy geo)`,
          );
          fp = { ...fp, timezone: geo.timezone };
        }
      } catch (e) {
        console.warn(
          "[multizen] proxy IP probe failed; continuing without geo alignment:",
          (e as Error).message,
        );
      }
    }
    // No-proxy: fp.timezone is left as the profile configured it (issue #13).

    // Clean up stale SingletonLock left behind by a Chromium that
    // crashed without unlinking its own lock. Without this, the next
    // launch sees `SingletonLock -> hostname-PID` pointing to a dead
    // PID and silently exits (the "socket hang up" the user sees: CDP
    // briefly opens, profile-in-use check fires, process bails).
    await cleanStaleSingletonLocks(browserDataDir).catch((e: unknown) => {
      console.warn("[multizen] failed to clean Singleton locks:", (e as Error).message);
    });

    // macOS records app crashes and on next launch shows
    // "Reopen windows from previous crash?" modal via NSPersistentUIRestorer.
    // CloakBrowser's stealth patches DCHECK on unexpected modal dialogs
    // and the binary crashes mid-dialog (EXC_BREAKPOINT). Both layers
    // need to be defused: delete the saved-state bundle for the binary's
    // bundle id, and turn off persistence in user defaults.
    if (process.platform === "darwin") {
      await disableMacOsPersistentStateRestore().catch((e: unknown) => {
        console.warn("[multizen] persistent-state cleanup skipped:", (e as Error).message);
      });
    }

    // Reopen last-session tabs on every launch — what Multilogin / AdsPower /
    // GoLogin do by default. Restore itself is forced by the
    // --restore-last-session CLI flag below; here we only mark the previous exit
    // as clean in the Default profile's Preferences (exit_type=Normal) so
    // Chromium doesn't skip restore or show a crash infobar. Mutated before
    // spawn (Chrome must be off to avoid corrupting the pref file).
    await ensureSessionRestore(browserDataDir).catch((e: unknown) => {
      console.warn("[multizen] failed to write session restore preference:", (e as Error).message);
    });

    // Chromium's --accept-lang flag expects a PLAIN comma-separated list
    // of language tags ("en-US,en"). It then computes q-values itself for
    // the HTTP Accept-Language header AND for `navigator.languages`. If
    // we pass a pre-formatted string with q-values ("en-US,en;q=0.9"),
    // Chromium parses it as ["en-US", "en;q=0.9"] and then re-adds q's,
    // producing the malformed "en-US,en;q=0.9;q=0.9" we saw on browserscan.
    // Linux sandbox decision. Prefer the injected resolver (AppArmor flow:
    // detect restriction, verify/offer the one-time secure setup, else fall
    // back). If it's absent or throws, degrade to the sync fallback so a
    // resolver failure can never dead-launch. `--no-sandbox` is NOT added to the
    // args literal below; it's applied at spawn time so the crash backstop can
    // relaunch with it without rebuilding the args.
    let noSandbox: boolean;
    try {
      noSandbox = this.resolveSandboxDecision
        ? (await this.resolveSandboxDecision({ engine, binaryPath: chromiumPath })).noSandbox
        : fallbackNeedsNoSandbox();
    } catch (e) {
      console.warn("[multizen] sandbox resolver failed; using fallback:", (e as Error).message);
      noSandbox = fallbackNeedsNoSandbox();
    }

    const acceptLangPlain = fp.languages.join(",");
    const args = [
      `--user-data-dir=${browserDataDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Force-restore the previous session's tabs at startup. This flag is what
      // actually drives restore (writing the protected restore_on_startup pref
      // just gets reset by Chromium); combined with ensureSessionRestore marking
      // a clean exit and our CDP graceful shutdown, tabs come back reliably
      // across stop/launch even after a crash.
      "--restore-last-session",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion",
      // Don't back Chromium's "Safe Storage" key with the OS keychain/keyring.
      // Two reasons: (1) our engine bundle is ad-hoc signed, so on macOS the
      // keychain ACL never matches and every launch pops a "Chromium wants to
      // use your keychain" password prompt (TouchID doesn't apply). (2) A
      // keychain-derived key is MACHINE-BOUND, which breaks profile portability
      // — the whole point of .mzar export/import — because cookies/passwords
      // encrypted on one Mac can't be decrypted after moving. Instead Chromium
      // uses a profile-local key (the Puppeteer/Playwright default: a fixed
      // "mock_password"). Trade-off, stated honestly: at-rest cookie/password
      // encryption becomes obfuscation (a public constant key), not keychain-
      // protected. This DOES lower the bar for a passive file-read attacker
      // (an infostealer that can read the profile dir now decrypts without the
      // keychain-ACL prompt or a memory dump). Accepted here because portability
      // is the product (.mzar export is useless with a machine-bound key), the
      // whole anti-detect category does this, and the real threats are covered
      // elsewhere: FileVault for offline disk theft, .mzar's AES-256-GCM +
      // passphrase for exports. Rely on disk encryption for at-rest safety.
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      // Linux: force the X11 backend instead of the native Wayland one.
      // On a Wayland session the compositor OWNS window placement and
      // IGNORES CDP's `Browser.setWindowBounds`, so a window parked at
      // (-32000,-32000) pops up at (0,0) — a stray window on the user's
      // screen. As an X11 client Chrome positions ITSELF and honours the
      // CDP bounds, which is what keeps the off-screen survivor invisible.
      // macOS/Windows keep their default: there the compositor already
      // honours CDP bounds.
      ...(process.platform === "linux" ? ["--password-store=basic", "--ozone-platform=x11"] : []),
      // On Xvfb the default Mesa software GL path burns ~6 cores in the GPU
      // process. The disabled-GL fallback paints the same frames at 30 fps
      // with ~0.5 core, so prefer it when the engine runs on the virtual
      // display.
      ...(process.platform === "linux" && virtualDisplay() ? ["--use-gl=disabled"] : []),
      // UI language for the Chromium chrome itself
      `--lang=${fp.locale}`,
      // Accept-Language: plain list, Chromium adds q-values.
      `--accept-lang=${acceptLangPlain}`,
      // Initial window size
      `--window-size=${fp.screen.width},${fp.screen.height}`,
    ];
    // CloakBrowser implements fingerprint patches in C++. Feed it native
    // flags and avoid CDP/JS overrides later; those are exactly the
    // automation surfaces it hardens against.
    args.push(...buildCloakBrowserFingerprintArgs(profileId, fp));
    if (profile.proxy) {
      args.push("--fingerprint-webrtc-ip=auto");
    }
    if (geoCoords) {
      // Make navigator.geolocation report coordinates that match the
      // proxy IP — without this, fingerprint-scan.com fires the "Check
      // Geo API" warning when the location grant is exercised.
      args.push(`--fingerprint-location=${geoCoords.latitude},${geoCoords.longitude}`);
    }
    if (profile.proxy) {
      // Chromium's --proxy-server= does NOT accept embedded credentials,
      // and an HTTP-CONNECT relay leaks DNS (Chromium prefetch / DoH /
      // background networking all hit the OS resolver before any proxy
      // negotiation). The fix: spin up a localhost SOCKS5 bridge that
      // forwards to the user's upstream proxy (HTTP CONNECT or SOCKS5
      // chained). Chromium with --proxy-server=socks5://… does *remote*
      // DNS by spec, so the egress IP becomes the only resolver test
      // sites observe.
      const localProxyUrl = await startBridgeForProfile(profileId, profile.proxy);
      args.push(`--proxy-server=${localProxyUrl}`);
      // WebRTC leaks the *real* public IP via STUN even when HTTP traffic
      // is proxied — STUN uses UDP and bypasses HTTP proxies by default.
      // `disable_non_proxied_udp` forces WebRTC to either go through a
      // SOCKS proxy that supports UDP, or fall back to TCP through the
      // configured proxy. Without this flag, browserscan / browserleaks /
      // ipleak.net all show the user's real IP next to the proxy IP.
      // Only set when a proxy is configured — direct profiles intentionally
      // expose their real IP.
      args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
      args.push("--enforce-webrtc-ip-permission-check");
      // ── DNS leak prevention ─────────────────────────────────────────
      // Chromium does *remote* DNS for socks5:// proxies natively — our
      // local SOCKS5 bridge gets the hostname (not an IP) and forwards
      // it to the upstream proxy, which resolves remotely. So URL-load
      // DNS is already covered.
      //
      // What still leaks bypassing --proxy-server (per Chromium net/docs):
      //   • DoH (DNS-over-HTTPS) — talks straight to Cloudflare/Google
      //   • DNS prefetcher / predictor
      //   • Background networking (component updater, GCM, safe-browsing)
      //   • Domain Reliability beacons
      //
      // Disabling these via features+switches plugs every leak we can
      // close without source-patching Chromium. We deliberately do NOT
      // use --host-resolver-rules: it triggers the "unsupported flag"
      // infobar (visible to the user, even though JS can't probe it),
      // and a SOCKS5 upstream makes it redundant anyway. Real anti-
      // detect products (Multilogin Mimic) solve the residual leak
      // with a custom DNS-resolver source patch — a Phase-1 item for
      // multizen-pro, not the open-source build.
      args.push("--disable-features=DnsOverHttps,DnsOverHttpsUpgrade,EncryptedClientHello,AsyncDns,DnsHttpsSvcb,DnsHttpsSvcbAlpn,NetworkPrediction");
      args.push("--dns-over-https-mode=off");
      args.push("--dns-prefetch-disable");
      args.push("--disable-async-dns");
      args.push("--no-prerender");
      args.push("--no-pings");
      args.push("--disable-background-networking");
      args.push("--disable-component-update");
      args.push("--disable-domain-reliability");
      args.push("--disable-client-side-phishing-detection");
    }

    // Browser extensions: load this profile's enabled extensions plus the
    // bundled companion (the "Add to MultiZen" injector). Same flag pair
    // CloakBrowser's own `extension_paths` emits; requires the persistent
    // user-data-dir we already use. Extensions live under the profile dir
    // (shared across engines), so we pass absolute paths.
    const extensionDirs: string[] = [];
    const companion = companionDir();
    if (companion) extensionDirs.push(companion);
    for (const ext of profile.extensions ?? []) {
      if (!ext.enabled) continue;
      // Resolve both shared store entries and legacy per-profile copies.
      const dir = resolveLoadDir(ext, profile.dataDir, this.extensionStoreRoot);
      // Skip a missing dir: a single bad path makes Chromium drop the ENTIRE
      // --load-extension list (the companion too), silently disabling all
      // extensions for the launch.
      if (existsSync(dir)) extensionDirs.push(dir);
    }
    if (extensionDirs.length > 0) {
      const joined = extensionDirs.join(",");
      args.push(`--load-extension=${joined}`);
      args.push(`--disable-extensions-except=${joined}`);
    }

    // NOTE on Sec-CH-UA: The Client Hints headers (`Sec-CH-UA`,
    // `Sec-CH-UA-Platform`, `Sec-CH-UA-Platform-Version`, `Sec-CH-UA-Arch`,
    // `Sec-CH-UA-Bitness`, etc.) and `navigator.userAgentData` are NOT
    // overridable via CLI flags. They are baked into the compiled Chromium
    // binary at build time. To make them coherent with our chosen `userAgent`
    // we need our patched Chromium build (multizen-pro) which applies native
    // overrides. Until that ships, system Chrome will emit its real Client
    // Hints and detection vendors will see a UA-vs-CH mismatch.
    //
    // The full ClientHints object is stored in `profile.fingerprint.clientHints`
    // and will be picked up by the patched binary's launch wrapper when present.

    // Build a minimal env for the child — Electron's main process
    // accumulates a pile of ELECTRON_*, CHROME_*, V8_*, DYLD_* env vars
    // that some stealth Chromium forks (CloakBrowser) interpret as
    // "I'm running inside an Electron host" and SIGTRAP early to prevent
    // automation. Pass only the strict minimum a desktop browser needs.
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME ?? "",
      USER: process.env.USER ?? "",
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
      SHELL: process.env.SHELL ?? "/bin/sh",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      // macOS app bundles need this to find their frameworks.
      DYLD_FALLBACK_FRAMEWORK_PATH: process.env.DYLD_FALLBACK_FRAMEWORK_PATH ?? "",
    };

    // Linux GUI clients must inherit the active desktop session. Without
    // these values a headful Chromium process cannot connect to X11/Wayland
    // even though the Electron host window is already running successfully.
    if (process.platform === "linux") {
      for (const key of [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
        "DESKTOP_SESSION",
        "DBUS_SESSION_BUS_ADDRESS",
      ]) {
        const value = process.env[key];
        if (value !== undefined) cleanEnv[key] = value;
      }
    }
    // Virtual-display mode: the engine lives on its own X server. Drop the
    // Wayland vars so Chromium cannot try to connect to the user's session.
    const virtual = virtualDisplay();
    if (virtual) {
      cleanEnv.DISPLAY = virtual;
      delete cleanEnv.WAYLAND_DISPLAY;
      cleanEnv.XDG_SESSION_TYPE = "x11";
    }
    // Start page (positional URL) — only on first run, i.e. when there is no
    // restorable session. With `--restore-last-session` a returning profile
    // reopens its real tabs, so we must NOT stack an extra tab; on first launch
    // there's nothing to restore, so the command-line URL becomes the initial
    // tab (verified on CloakBrowser 145 — pref `startup_urls` is ignored there,
    // a positional URL works). Defaults to DuckDuckGo when the profile has no
    // explicit start page. Must be the LAST argv entry (positional).
    if (!(await hasRestorableSession(browserDataDir))) {
      // sanitizeStartUrl rejects non-http(s)/about (incl. `-`-prefixed tokens
      // Chromium would treat as switches) → falls back to the default.
      args.push(sanitizeStartUrl(profile.startUrl));
    }

    // Spawn + readiness, with a one-shot crash backstop: if the child dies from
    // a user-namespace sandbox failure while we launched WITHOUT --no-sandbox
    // (the AppArmor profile turned out not to be active), relaunch once WITH
    // --no-sandbox so the profile still launches (AC16/B1). `--no-sandbox` is
    // applied here, not in the args literal, so no arg rebuild is needed.
    const attemptSpawn = async (
      useNoSandbox: boolean,
    ): Promise<{ child: ChildProcess; session: CdpSession }> => {
      const spawnArgs = useNoSandbox ? ["--no-sandbox", ...args] : args;
      const child = spawn(chromiumPath, spawnArgs, {
        detached: false,
        stdio: ["ignore", "ignore", "pipe"],
        env: cleanEnv,
      });
      const pid = child.pid;
      if (!pid) throw new Error("Failed to spawn Chromium");
      // Treat as a sandbox crash ONLY when the FATAL signature appeared on
      // stderr AND the child actually exited (either event may land first). A
      // bare early exit, or a stray signature on a healthy child, is NOT a
      // sandbox crash.
      let sawSandboxCrash = false;
      let crashReject: ((e: Error) => void) | undefined;
      const signalCrashIfConfirmed = (): void => {
        if (sawSandboxCrash && (child.exitCode !== null || child.signalCode !== null)) {
          crashReject?.(new SandboxStartupError());
        }
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").trim();
        if (!line) return;
        if (SANDBOX_FAILURE_RE.test(line)) {
          sawSandboxCrash = true;
          signalCrashIfConfirmed();
        }
        process.stderr.write(`[chromium ${pid}] ${line}\n`);
      });
      child.on("exit", (code, signal) => {
        // First-line breadcrumb — the record's child.on("exit") below also
        // handles running-changed teardown.
        if (code !== 0 && code !== null) {
          process.stderr.write(
            `[multizen] Chromium pid ${pid} exited code=${code} signal=${signal ?? "-"}\n`,
          );
        }
        signalCrashIfConfirmed();
      });

      const session = new CdpSession({ port, engine });
      // Staged readiness: /json/version -> a page target exists -> connect+attach,
      // all within one budget. Raced against a confirmed sandbox-crash signal so
      // a failed sandbox aborts at once instead of waiting out the full budget.
      const crashSignal = new Promise<never>((_, reject) => {
        crashReject = reject;
      });
      try {
        await Promise.race([waitForCdpSessionReady(port, session, 15000), crashSignal]);
      } catch (e) {
        killPid(pid, "SIGKILL");
        // Wait for the process to actually die so a retry on the same
        // user-data-dir doesn't collide with its still-held SingletonLock.
        await waitForPidDeath(pid, 2000);
        await session.close().catch(() => {});
        throw e;
      }
      return { child, session };
    };

    let child: ChildProcess;
    let session: CdpSession;
    try {
      try {
        ({ child, session } = await attemptSpawn(noSandbox));
      } catch (e) {
        if (e instanceof SandboxStartupError && !noSandbox) {
          console.warn("[multizen] sandbox failed to start; relaunching with --no-sandbox");
          // Profile was expected active but isn't — let the host re-offer setup.
          this.onSandboxInactive?.(chromiumPath);
          // The crashed child is dead (attemptSpawn awaited it); clear its stale
          // SingletonLock before reusing the data dir, or the retry silently
          // exits on the dead lock.
          await cleanStaleSingletonLocks(browserDataDir).catch(() => {});
          ({ child, session } = await attemptSpawn(true));
        } else {
          throw e;
        }
      }
    } catch (e) {
      // Spawn/readiness failed for good — don't leak this profile's socks5
      // bridge (only the record's exit/close paths stop it, and no record
      // exists yet).
      await stopBridgeForProfile(profileId).catch(() => {});
      throw e;
    }

    // attemptSpawn guarantees a live pid (it throws otherwise); capture it so
    // the record/return don't re-widen to number | undefined.
    const pid = child.pid;
    if (pid === undefined) throw new Error("Chromium exited before readiness");

    const startedAt = new Date().toISOString();
    const cdpEndpoint = `http://127.0.0.1:${port}`;

    // Per-target CDP bootstrap. CloakBrowser applies fingerprint / timezone
    // / UA / UA-CH / WebRTC / screen patches natively in C++ via its
    // --fingerprint-* flags, so we deliberately do NOT layer CDP Emulation
    // or JS preloads on top — double-patching produces cross-layer
    // disagreements (e.g. a CDP UA string vs the native UA-CH brand list)
    // that composite scorers flag as "Masking detected".
    //
    // LOCALE is the one exception: CloakBrowser ships no native locale switch
    // (its --fingerprint-* set has timezone but no locale/language, verified
    // against the binary) and macOS ignores --lang, so without this nothing
    // sets the renderer's ICU default locale and Intl.*.resolvedOptions()
    // .locale leaks the host locale (a th-TH persona reports en-US). This
    // fills a gap rather than shadowing a patch. navigator.language(s) come
    // from --accept-lang and stay untouched.
    await session
      .bootstrapTargets(async (send) => {
        try {
          await send("Emulation.setLocaleOverride", { locale: fp.locale });
        } catch (e) {
          const msg = (e as Error).message;
          if (!/already in effect/i.test(msg)) {
            console.error("[multizen] setLocaleOverride (cloakbrowser) failed:", e);
          }
        }
        // Diagnostic: capture what the page actually sees AFTER overrides.
        // Logs once per session — if browserscan reports "Different browser
        // name", these values tell us whether our override landed.
        try {
          const probe = await send<{
            result?: { value?: string };
          }>("Runtime.evaluate", {
            expression: `JSON.stringify({
              ua: navigator.userAgent,
              brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
              platform: navigator.platform,
              tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
              icuLocale: Intl.DateTimeFormat().resolvedOptions().locale,
              calendar: Intl.DateTimeFormat().resolvedOptions().calendar,
              lang: navigator.language,
              langs: navigator.languages,
              deviceMemory: navigator.deviceMemory,
              hardwareConcurrency: navigator.hardwareConcurrency,
              hasRTCPC: typeof window.RTCPeerConnection !== "undefined",
            })`,
            returnByValue: true,
          });
          const value = probe?.result?.value;
          // Diagnostic only — gated behind MULTIZEN_DEBUG so it doesn't spam the
          // console on every launch (it also fires a few times as the context settles).
          if (value && process.env.MULTIZEN_DEBUG)
            console.log("[multizen] post-bootstrap probe:", value);
        } catch (e) {
          // Non-fatal — diagnostic only.
          void e;
        }
      })
      .catch((e: unknown) => {
        console.error("[multizen] CDP bootstrap failed:", e);
      });
    // On Xvfb the window frame is counted by Browser.setWindowBounds but not
    // by the page viewport. Compensate for it so the page gets the FULL
    // fingerprint height — otherwise the bottom ~120px never renders.
    const chromeHeight = virtualDisplay()
      ? Math.max(
          0,
          await session
            .evaluate<number>("window.outerHeight - window.innerHeight")
            .catch(() => 0),
        )
      : 0;
    const virtualWindowSize = {
      width: fp.screen.width,
      height: fp.screen.height + chromeHeight,
    };

    // Wire the companion's "Add to MultiZen" channel for this profile — scoped
    // to Web Store pages only (the host polls a DOM attribute there, never on
    // the user's normal browsing). The CDP session is profile-scoped, so any
    // signal belongs to this profileId — no cross-profile ambiguity.
    if (this.onCompanionInstall) {
      void session.watchUrlForBinding({
        urlIncludes: "chromewebstore.google.com",
        onPayload: (payload) => {
          try {
            const parsed = JSON.parse(payload) as { id?: string };
            if (parsed.id) this.onCompanionInstall?.(profileId, parsed.id);
          } catch {
            // ignore malformed payloads
          }
        },
      });
    }

    // Arm the SURVIVOR right away. Closing the last window makes
    // CloakBrowser EXIT (measured: exit code 0), which would kill the profile
    // the moment the user closes their own window.
    //
    // The survivor is NOT a window we open now — that used to leave a second
    // window on the user's desktop. Instead the preview stream RACES the
    // browser's shutdown: the moment the user's last tab is destroyed it
    // creates the survivor, which only ever exists after the user closed
    // their window. Arming it here (not when the preview starts) means the
    // profile survives that even if no preview was ever opened.
    const stream = new PreviewStream({
      profileId,
      port,
      virtualDisplay: virtualDisplay() !== null,
      virtualWindowSize,
    });

    // Watch for "no more page targets" via CDP. On macOS Chrome stays alive
    // after the last window closes (standard Mac app lifecycle) — the spawned
    // process keeps running with zero windows. We poll /json/list and force-
    // kill the child when that happens, which then fires child.on('exit') and
    // emits the running-changed event.
    // Latch so the 1s watcher signals termination + shuts down exactly once,
    // not on every tick while pages stay at zero during the ~1.5–4s wind-down.
    let signalledClose = false;
    const windowWatcher = createWindowWatcher(port, startedAt, () => {
      if (signalledClose) return;
      signalledClose = true;
      // Window closed but the process lingers (mac app lifecycle) — tell the GUI
      // we're terminating so the card stops showing "Stop" while it winds down.
      this.emit("running-changed", { kind: "closing", profileId });
      // Graceful CDP shutdown — preserves session-restore.
      void gracefulShutdown(r);
    });

    const record: RunningProcess = {
      child,
      cdpEndpoint,
      port,
      pid,
      startedAt,
      session,
      browserDataDir,
      windowWatcher,
      stream,
      qualityMode: "card",
      virtualWindowSize,
    };
    const r = record;
    this.running.set(profileId, record);
    this.wireTaskbar(r, stream);

    stream.on("frame", (frame: PreviewFrame) => {
      this.emit("preview-frame", frame);
    });
    stream.on("visible-window-closed", (info) => {
      if (info.ok) {
        // The survivor window kept the browser alive and took over the
        // preview — the profile is STILL RUNNING, so the card must not show
        // "Terminating…".
        return;
      }
      // The survivor could not take over (navigation/painting failed): tear
      // the profile down cleanly instead of leaving it half-dead.
      this.emit("running-changed", { kind: "closing", profileId });
      void gracefulShutdown(r);
    });
    void stream
      .ensureKeepalive()
      .then((ok) => {
        if (!ok) {
          process.stderr.write(
            `[multizen] survivor unavailable profile=${profileId} — closing the browser window will end the profile\n`,
          );
        }
      })
      .catch((e) => {
        process.stderr.write(
          `[multizen] survivor arming failed profile=${profileId}: ${String(e)}\n`,
        );
      });

    child.on("exit", () => {
      const wasTracked = this.running.has(profileId);
      clearInterval(record.windowWatcher);
      // The engine is gone — its windows are gone too, but the WM may still
      // hold the SKIP_TASKBAR atom we set. Restore the taskbar state so no
      // stale entry survives a crash (the helper is a no-op if the windows
      // are already gone).
      setEngineTaskbarHidden(pid, false);
      void session.close().catch(() => {});
      void stopBridgeForProfile(profileId).catch(() => {});
      // The preview socket dies with the browser — tear it down so no timer /
      // socket survives the profile.
      void this.destroyPreview(record);
      this.running.delete(profileId);
      if (wasTracked) {
        // close() removes from the map first so wasTracked is false there;
        // this path covers (a) user quit Chrome directly with ⌘Q, and (b)
        // our own kill() from the windowWatcher when the last window closed.
        this.emit("running-changed", { kind: "closed", profileId, reason: "external-exit" });
      }
    });

    this.emit("running-changed", { kind: "launched", profileId });
    // A profile must show exactly ONE browser window. Chromium's session
    // restore opens every restored TAB as its own window, so a profile with
    // two restored tabs came up with two visible windows. Merge them into
    // the profile's main window once the browser has settled.
    void this.consolidateProfileWindows(record);
    return { id: profileId, cdpEndpoint, pid, startedAt };
  }

  /**
   * Merge the browser's extra windows into one, so the profile shows a
   * single browser window.
   *
   * Chromium restores each saved TAB as its own window, so a profile whose
   * session had two tabs comes up with two visible windows — and closing
   * one of them looked like closing the profile. The browser needs a moment
   * to restore before we can see (and merge) them, hence the short delay.
   */
  private async consolidateProfileWindows(record: RunningProcess): Promise<void> {
    // Give Chromium time to restore its session.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      const stream = record.stream;
      if (!stream) return;
      await stream.consolidateWindows();
    } catch (e) {
      // Best-effort: extra windows are cosmetic, not fatal.
      process.stderr.write(
        `[multizen] could not consolidate windows: ${String(e)}\n`,
      );
    }
  }

  async close(profileId: ProfileId): Promise<void> {
    const r = this.running.get(profileId);
    if (!r) return;
    console.log(`[multizen] close() profile=${profileId} pid=${r.pid}`);
    // Signal the terminating phase up front (covers MCP/external callers that
    // don't drive the button's local "Stopping…" state).
    this.emit("running-changed", { kind: "closing", profileId });
    // Remove from map first so the child.on('exit') handler treats this as
    // a planned close (no event emitted from there).
    this.running.delete(profileId);
    clearInterval(r.windowWatcher);
    // Consolidate the windows BEFORE the browser saves its session: Chromium
    // writes one session file per window, so a profile that still had two
    // windows would restore two windows on the next launch.
    //
    // Timeout-bounded: `consolidateWindows` is a batch of CDP sends and a
    // LOST CDP REPLY used to hang the Stop button forever (the preview
    // stream's send() had no timeout). The browser is killed right after
    // anyway, so a stuck consolidation must never block the teardown.
    await withTimeout(r.stream?.consolidateWindows() ?? Promise.resolve(), 5000);
    // Always emit "closed" — even if shutdown throws — so the GUI's terminating
    // state can never get stranded.
    try {
      // ORDER MATTERS — the browser must be asked to quit BEFORE the parked
      // window is destroyed.
      //
      // `Browser.close` is what makes Chromium flush its session file
      // (`Default/Sessions/Session_*` + `Tabs_*`) — the mechanism behind
      // "the tabs come back after a restart". Tearing the preview stream
      // down first closes the PARKED window, which is the browser's LAST
      // window: Chromium then starts tearing itself down (measured: it
      // exits ~60ms later), and the `Browser.close` that follows arrives
      // too late — the process is killed by a signal and NEVER writes the
      // session. The result is a relaunch that restores a STALE tab set and
      // then opens the profile's start URL as an extra tab — the duplicate
      // tab the user reported.
      //
      // So: ask the browser to quit first (it flushes the session on the
      // way out), and tear the preview socket down afterwards.
      //
      // The quit is asked on the PREVIEW STREAM's browser-level socket, not
      // the driver's page-level one: the page session dies with the user's
      // window, so after a window close it cannot ask the browser to quit
      // — and the session would never be flushed (a signalled browser never
      // writes it). The stream's socket is browser-level and stays alive.
      await gracefulShutdown(r, r.stream);
      // The preview socket lives on the browser's CDP port — tear it down
      // after the browser died, so no socket survives the profile. Bounded
      // for the same reason: the stream's close() waits on CDP replies
      // that a dead browser will never send.
      await withTimeout(this.destroyPreview(r), 5000);
      // Belt-and-suspenders: after the PID-based shutdown, sweep for ANY
      // process still holding this profile's user-data-dir and SIGKILL it.
      // Catches re-parented/forked survivors (or leftover helpers) that the
      // single tracked PID could miss.
      await killBrowsersUsingDataDir(r.browserDataDir);
      // Browser is gone now, so the bridge closes immediately. Timeout-bounded
      // anyway so a stuck socket can never strand Stop.
      await withTimeout(stopBridgeForProfile(profileId), 2000);
    } finally {
      // Restore the taskbar state: the profile is going away, so its window
      // must not stay flagged as SKIP_TASKBAR. Done AFTER the browser died
      // (never while the parked window is still on screen — that would pop a
      // dying window back into the taskbar) and in the `finally` so a
      // throwing shutdown still restores it.
      setEngineTaskbarHidden(r.pid, false);
      console.log(`[multizen] close() done profile=${profileId} pid=${r.pid} alive=${isPidAlive(r.pid)}`);
      this.emit("running-changed", { kind: "closed", profileId, reason: "user-close" });
    }
  }

  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }

  async navigate(profileId: ProfileId, url: string): Promise<{ url: string }> {
    const session = this.requireSession(profileId);
    const result = await session.navigate(url);
    return { url: result.url };
  }

  async click(profileId: ProfileId, selector: string): Promise<{ ok: true }> {
    const session = this.requireSession(profileId);
    await session.click(selector);
    return { ok: true };
  }

  async type(profileId: ProfileId, selector: string, text: string): Promise<{ ok: true }> {
    const session = this.requireSession(profileId);
    await session.type(selector, text);
    return { ok: true };
  }

  async extract(profileId: ProfileId): Promise<{ result: unknown }> {
    const session = this.requireSession(profileId);
    return session.extract();
  }

  async screenshot(profileId: ProfileId): Promise<{ pngBase64: string }> {
    const session = this.requireSession(profileId);
    return session.screenshot();
  }

  async cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown> {
    const session = this.requireSession(profileId);
    return session.cdpSend(method, params, sessionId, opts);
  }

  // ── Engine-neutral curated verbs. These CDP compositions were moved down
  //    from the MCP dispatch layer (server.ts) so the same tools can run on a
  //    non-CDP engine. Each needs no domain enable, preserving the stealth
  //    baseline. ────────────────────────────────────────────────────────────
  async evaluateJs(profileId: ProfileId, expression: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(
      profileId,
      "Runtime.evaluate",
      { expression, returnByValue: true },
      sessionId,
      { safe: true },
    );
  }

  async getCookies(profileId: ProfileId, urls: string[], sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Network.getCookies", { urls }, sessionId, { safe: true });
  }

  async setCookies(profileId: ProfileId, cookies: unknown[], sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Network.setCookies", { cookies }, sessionId, { safe: true });
  }

  async listTabs(profileId: ProfileId, sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Target.getTargets", {}, sessionId, { safe: true });
  }

  async newTab(profileId: ProfileId, url?: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(
      profileId,
      "Target.createTarget",
      { url: url ?? "about:blank" },
      sessionId,
      { safe: true },
    );
  }

  async activateTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Target.activateTarget", { targetId }, sessionId, { safe: true });
  }

  async closeTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Target.closeTarget", { targetId }, sessionId, { safe: true });
  }

  async closeAll(): Promise<void> {
    const ids = [...this.running.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }

  // ── Live preview ──────────────────────────────────────────────────────────
  // The browser is an EXTERNAL process, so the only way to show it inside the
  // app is a CDP screencast: JPEG frames stream from the browser to the
  // renderer, which paints them on a canvas. The screencast needs its OWN
  // browser-level websocket (auto-attach of new tabs only works there), so it
  // lives in {@link PreviewStream} and never touches the page-level
  // {@link CdpSession}.
  //
  // The same websocket also owns the off-screen SURVIVOR window: closing
  // the last window makes CloakBrowser exit, which would kill the profile.
  // The survivor is armed at LAUNCH (so the profile survives the user
  // closing their window even before a preview was ever opened), but the
  // window itself is only created by the race that wins the browser's
  // shutdown — so a profile the user never touched shows exactly ONE
  // window. It is NEVER streamed while the user's window is alive: the
  // preview shows the user's real target, the very page the MCP tools drive.

  /**
   * Start the live preview for a running profile. Returns false (never
   * throws) when the profile isn't running or the engine has no CDP
   * (Camoufox/Firefox).
   */
  async startPreview(profileId: ProfileId): Promise<boolean> {
    const r = this.running.get(profileId);
    if (!r) return false;
    const stream = await this.ensureStream(r, profileId);
    if (!stream) return false;
    if (stream.isLive) return true;
    try {
      // Bounded: the renderer awaits this IPC, and a hung engine must
      // never freeze the app.
      await withTimeout(stream.start(), 15000);
    } catch (e) {
      process.stderr.write(
        `[multizen] preview start failed profile=${profileId}: ${String(e)}\n`,
      );
      return false;
    }
    // Park the user's visible window off-screen so the interactive card is the
    // only surface. Non-fatal: a park failure must not fail the preview.
    try {
      await withTimeout(stream.parkForPreview(), 8000);
    } catch (e) {
      process.stderr.write(
        `[multizen] preview park failed profile=${profileId}: ${String(e)}\n`,
      );
    }
    // Match the renderer's current mode (card by default, Expand when open).
    try {
      await withTimeout(stream.setQuality(QUALITY[r.qualityMode]), 8000);
    } catch (e) {
      process.stderr.write(
        `[multizen] preview quality apply failed profile=${profileId}: ${String(e)}\n`,
      );
    }
    return stream.isLive;
  }

  /**
   * Switch the live screencast between the compact card preset and the sharp
   * Expand preset. Bounded and non-throwing — it runs behind an IPC call.
   */
  async setPreviewQuality(profileId: ProfileId, expanded: boolean): Promise<void> {
    const r = this.running.get(profileId);
    if (!r) return;
    r.qualityMode = expanded ? "expanded" : "card";
    if (!r.stream?.isLive) return;
    try {
      await withTimeout(r.stream.setQuality(QUALITY[r.qualityMode]), 8000);
    } catch (e) {
      process.stderr.write(
        `[multizen] preview quality failed profile=${profileId}: ${String(e)}\n`,
      );
    }
  }

  /**
   * Stop the live preview for a profile (no-op when it isn't streaming).
   * The survivor window STAYS: it is what keeps the browser alive, and
   * the profile must survive the user closing their own window.
   */
  async stopPreview(profileId: ProfileId): Promise<void> {
    const r = this.running.get(profileId);
    if (!r) return;
    await r.stream?.stop().catch(() => {});
  }

  /**
   * Forward one pointer/keyboard input event into the page that owns the
   * screencast. Bounded and non-throwing — it runs behind an IPC call from
   * the renderer, so a lost CDP reply must never become an unhandled rejection.
   */
  async dispatchPreviewInput(
    profileId: ProfileId,
    event: PreviewInputEvent,
  ): Promise<void> {
    const r = this.running.get(profileId);
    const stream = r?.stream;
    if (!stream) return;
    // A reconnect can leave the input websocket unarmed; re-arm it so the
    // first click after the reconnect isn't silently dropped.
    try {
      await withTimeout(stream.ensureKeepalive(), 3000);
    } catch (e) {
      process.stderr.write(
        `[multizen] preview keepalive failed profile=${profileId}: ${String(e)}\n`,
      );
    }
    try {
      await withTimeout(stream.dispatchInput(event), 5000);
    } catch (e) {
      process.stderr.write(
        `[multizen] preview input failed profile=${profileId}: ${String(e)}\n`,
      );
    }
  }

  /**
   * Bring the profile's real browser window to the front — the read-only
   * preview has no input forwarding, so a click on the canvas focuses the
   * actual browser instead. Never throws.
   *
   * When the user closed their window, the only target left is the
   * off-screen survivor — activating THAT would raise a window the user
   * never asked for. So instead we open a fresh window on the page they
   * were last on: "click the preview" always ends with a visible browser
   * showing the profile.
   */
  async focusPreview(profileId: ProfileId): Promise<void> {
    const r = this.running.get(profileId);
    if (!r) return;
    try {
      // The profile's PAGE session dies when the user closes their window
      // (it is attached to that page's target). The browser-level socket
      // owned by the preview stream stays alive, so BOTH the lookup and the
      // reopen must use THAT one — otherwise the click either does nothing
      // or opens a second window on every click.
      const stream = r.stream;
      if (!stream) return;

      // An existing visible window wins: activating it is what the user
      // expects, and it keeps the "one browser window" promise.
      // Every step is bounded: this runs behind the renderer's click on the
      // preview, and a lost CDP reply must never freeze the app.
      const existing = await withTimeoutValue(stream.findVisibleWindow(), 5000);
      if (existing) {
        await withTimeout(stream.activateWindow(existing), 5000);
        return;
      }

      // The user closed their window — reopen it on the page they were on.
      await withTimeout(stream.openVisibleWindow(stream.lastUserUrl), 8000);
    } catch (e) {
      // The browser may already be gone — focusing is best-effort.
      process.stderr.write(
        `[multizen] preview focus failed profile=${profileId}: ${String(e)}\n`,
      );
    }
  }

  /**
   * Mirror the stream's parked state onto the engine's X11 windows.
   *
   * While the profile's window is PARKED (off-screen, driving the preview)
   * it must not sit in the system taskbar. The stream has no PID and must
   * not shell out — the driver owns the engine PID, so the driver owns the
   * taskbar helper and subscribes to the stream's "window-parked" event.
   *
   * Wired once per stream (a WeakSet guards against a double subscription
   * when the same stream is re-used).
   */
  private wireTaskbar(r: RunningProcess, stream: PreviewStream): void {
    if (this.taskbarWired.has(stream)) return;
    this.taskbarWired.add(stream);
    // Engines on Xvfb never appear in the user's taskbar, so there is no
    // taskbar entry to manage (and xprop would run against the wrong display).
    if (virtualDisplay()) return;
    stream.on("window-parked", (info) => {
      // hidden=true → add _NET_WM_STATE_SKIP_TASKBAR (the window disappears
      // from the taskbar); hidden=false → remove it again (the entry comes
      // back). The helper is a no-op off Linux and never throws.
      this.applyTaskbarState(r.pid, info.parked);
    });
  }

  /**
   * Apply the taskbar state to the engine's windows, RETRYING until the
   * windows actually exist.
   *
   * A Chrome window only registers in `_NET_CLIENT_LIST` ~190ms after it is
   * created (MEASURED). The stream emits "window-parked" the moment it
   * parks the window — which is in that window — so a single call finds no
   * window to update and the taskbar entry stays. The retry closes that
   * gap; it stops as soon as the update lands.
   *
   */
  private applyTaskbarState(pid: number, hidden: boolean): void {
    // ALWAYS stagger several re-applies, even when the first call succeeds.
    //
    // A close destroys the old window and races a new one. At the instant
    // "window-parked" fires the OLD window is often still in
    // _NET_CLIENT_LIST, so the first call can succeed on a window that is
    // about to die — then the NEW window registers ~190ms later and KWin
    // resets its state on map, wiping our atom. A single delayed re-apply
    // still landed before that reset and was wiped too (MEASURED).
    //
    // The helper is idempotent: it rewrites only when the state is wrong,
    // so these extra calls are cheap and safe. The final one at 2.6s is
    // after the new window has definitely mapped.
    setEngineTaskbarHidden(pid, hidden);
    for (const delay of TASKBAR_REAPPLY_DELAYS) {
      setTimeout(() => {
        setEngineTaskbarHidden(pid, hidden);
      }, delay);
    }
  }

  /**
   * The profile's stream: it owns the survivor window and, while a preview
   * runs, the screencast. Created once per profile at launch and reused —
   * the survivor must outlive individual preview start/stop cycles.
   */
  private async ensureStream(
    r: RunningProcess,
    profileId: ProfileId,
  ): Promise<PreviewStream | null> {
    if (r.stream) return r.stream;
    // No stream (e.g. the launch-time creation failed) — make one now so the
    // preview still works; its survivor is raced into existence on demand.
    const stream = new PreviewStream({
      profileId,
      port: r.port,
      virtualDisplay: virtualDisplay() !== null,
      virtualWindowSize: r.virtualWindowSize,
    });
    r.stream = stream;
    stream.on("frame", (frame: PreviewFrame) => {
      this.emit("preview-frame", frame);
    });
    stream.on("visible-window-closed", (info) => {
      if (info.ok) return;
      this.emit("running-changed", { kind: "closing", profileId });
      void gracefulShutdown(r);
    });
    this.wireTaskbar(r, stream);
    return stream;
  }

  /**
   * Tear the profile's stream down (idempotent). This closes the survivor
   * window too — the browser must be able to exit when the profile stops.
   */
  private async destroyPreview(r: RunningProcess): Promise<void> {
    const stream = r.stream;
    if (!stream) return;
    r.stream = null;
    await stream.close().catch(() => {});
  }

  private requireSession(profileId: ProfileId): CdpSession {
    const r = this.running.get(profileId);
    if (!r) throw new Error(`Profile ${profileId} is not running`);
    return r.session;
  }

  private allocatePort(): number {
    return this.nextPort++;
  }
}

function buildCloakBrowserFingerprintArgs(profileId: ProfileId, fp: FingerprintConfig): string[] {
  const args = [
    `--fingerprint=${fingerprintSeed(profileId, fp)}`,
    `--fingerprint-platform=${cloakBrowserPlatform(fp)}`,
    // NOTE: CloakBrowser has NO --fingerprint-locale switch (verified against
    // the binary — its --fingerprint-* set covers timezone/platform/screen/etc
    // but not locale/language). Locale is applied via CDP
    // Emulation.setLocaleOverride in the bootstrap step instead; passing a
    // --fingerprint-locale here would be silently ignored.
    `--fingerprint-timezone=${fp.timezone}`,
    `--fingerprint-screen-width=${fp.screen.width}`,
    `--fingerprint-screen-height=${fp.screen.height}`,
    `--fingerprint-hardware-concurrency=${fp.hardwareConcurrency}`,
    `--fingerprint-device-memory=${deviceMemoryApiValue(fp.deviceMemory)}`,
  ];
  // Explicitly set WebGL vendor/renderer instead of relying on seed-derived
  // auto-generation. Browserscan flags "WebGL exception" when CloakBrowser's
  // seed-derived GPU pool produces inconsistent values for the current
  // platform — pinning them to fp.webgl forces coherence with the persona.
  if (fp.webgl?.vendor) args.push(`--fingerprint-gpu-vendor=${fp.webgl.vendor}`);
  if (fp.webgl?.renderer) args.push(`--fingerprint-gpu-renderer=${fp.webgl.renderer}`);
  // Brand + version from Client Hints — keeps Sec-CH-UA + UA-string + UA-CH
  // brand list coherent. CloakBrowser's --fingerprint-brand-version drives
  // both UA and Sec-CH-UA-Full-Version simultaneously.
  const brandVersion = primaryBrandVersion(fp.clientHints);
  if (brandVersion) args.push(`--fingerprint-brand-version=${brandVersion}`);
  if (fp.clientHints?.secChUaPlatformVersion) {
    args.push(`--fingerprint-platform-version=${fp.clientHints.secChUaPlatformVersion}`);
  }
  return args;
}

function primaryBrandVersion(ch: ClientHints | undefined): string | null {
  if (!ch?.secChUaFullVersionList) return null;
  // Format: '"Chromium";v="148.0.7202.93", "Google Chrome";v="148.0.7202.93", "Not.A/Brand";v="99.0.0.0"'
  // Pick the first non-Chromium, non-"Not.A/Brand" entry — that's the
  // user-facing brand version (Chrome, Edge, etc.).
  const matches = ch.secChUaFullVersionList.matchAll(/"([^"]+)";v="([^"]+)"/g);
  for (const m of matches) {
    const brand = m[1];
    const version = m[2];
    if (!brand || !version) continue;
    if (!/Chromium|Not[.\s/]?A[.\s/]?Brand/i.test(brand)) return version;
  }
  return null;
}

/**
 * The value a real browser reports for `navigator.deviceMemory` / the
 * `Sec-CH-Device-Memory` hint: physical RAM rounded to the NEAREST power of two
 * and CAPPED AT 8 — the Device Memory API's spec upper bound. Chrome computes
 * `2 ** round(log2(gb))` clamped to [0.25, 8] (Blink's `floor(log2+0.5)`), so it
 * never exposes a value above 8; emitting a persona's raw physical RAM
 * (16/18/32/64 GB) would be an instant, impossible-value bot tell. The
 * fingerprint keeps the physical value for the UI and persona coherence; only
 * the web-facing surfaces get this quantized value.
 */
function deviceMemoryApiValue(physicalGb: number): number {
  if (!(physicalGb > 0)) return 8;
  return Math.min(8, 2 ** Math.round(Math.log2(physicalGb)));
}

function fingerprintSeed(profileId: ProfileId, fp: FingerprintConfig): string {
  // CloakBrowser accepts a stable seed. Keep it numeric and deterministic
  // so a MultiZen profile keeps the same native fingerprint across launches.
  // When the persona carries an explicit `seed`, key off it instead of the
  // profile id so the canvas/audio/WebGL readback noise can be rotated
  // without changing the profile id.
  const material = fp.seed ?? profileId;
  const hex = createHash("sha256").update(material).digest("hex").slice(0, 8);
  return String(10000 + (Number.parseInt(hex, 16) % 90000));
}

function cloakBrowserPlatform(fp: FingerprintConfig): "macos" | "windows" | "linux" {
  // Derive from the user's chosen device family — CloakBrowser's native
  // C++ patches handle the rest of the cross-platform spoof. Falls back
  // to the host OS if device is somehow unset.
  if (fp.device.startsWith("mac") || fp.device.startsWith("imac")) return "macos";
  if (fp.device.startsWith("windows")) return "windows";
  if (fp.device.startsWith("linux")) return "linux";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

export function browserDataDirForEngine(profileDataDir: string, engine: BrowserEngine): string {
  // Chrome profile data is not safely reusable across different browser
  // engines / major versions, so every engine keeps its browser state in its
  // own named user-data-dir under the logical MultiZen profile
  // (engines/cloakbrowser, engines/camoufox, ...).
  return join(profileDataDir, "engines", engine);
}

/**
 * Shut down a running Chromium child the canonical way: send `Browser.close`
 * over CDP (macOS ⌘Q equivalent — flushes session-restore data), then wait
 * up to 4s for the process to exit on its own. If CDP fails or the process
 * is hung, fall back to SIGTERM, then SIGKILL.
 *
 * Idempotent — safe to call once from `close()` and again from the window
 * watcher; the second call no-ops because the child is already exiting.
 */
async function gracefulShutdown(
  r: RunningProcess,
  stream?: PreviewStream | null,
): Promise<void> {
  const { pid } = r;

  // Source of truth is the OS, not `child.killed`/`exitCode`. Those flags lie
  // in a real case: the window watcher may have already fired a SIGTERM (so
  // `child.killed` is true) that Chromium ignored, and a subsequent Stop press
  // would then skip escalation and report "closed" while the browser lives on.
  if (!isPidAlive(pid)) {
    await r.session.close().catch(() => {});
    return;
  }

  // 1. Graceful CDP close (⌘Q equivalent — flushes session-restore). The
  //    websocket disconnects mid-call; timeout-bounded so a stuck send can
  //    never block the signal escalation below.
  //
  //    Prefer the preview STREAM's browser-level socket: the driver's own
  //    page-level session dies with the user's window, and a dead session
  //    cannot ask the browser to quit — the browser would then be killed by
  //    a signal and would NEVER write its session file (the tabs would not
  //    come back, and the relaunch would open a duplicate start URL).
  if (stream) {
    await withTimeout(stream.closeBrowserGracefully(), 3000);
  } else {
    await withTimeout(r.session.closeBrowser(), 3000);
  }
  // Chromium needs ~500ms–2s to flush session-restore on macOS; 4s is margin.
  if (await waitForPidDeath(pid, 4000)) {
    await withTimeout(r.session.close(), 1000);
    return;
  }

  await withTimeout(r.session.close(), 1000);

  // 2. SIGTERM by PID (not r.child.kill — don't trust the child flags).
  console.log(`[multizen] shutdown pid=${pid}: Browser.close didn't exit in 4s → SIGTERM`);
  killPid(pid, "SIGTERM");
  if (await waitForPidDeath(pid, 2000)) return;

  // 3. SIGKILL — the kernel guarantees this. We poll to confirm the process is
  //    genuinely gone before returning, so close() never reports a false
  //    "closed" while Chromium is still on screen.
  console.log(`[multizen] shutdown pid=${pid}: SIGTERM didn't exit in 2s → SIGKILL`);
  killPid(pid, "SIGKILL");
  await waitForPidDeath(pid, 2000);
}

/** All PIDs whose command line holds `--user-data-dir=<dataDir>` (main browser
 *  + helpers). Exact substring match — no regex pitfalls with path chars. */
async function pidsUsingDataDir(dataDir: string): Promise<number[]> {
  const needle = `--user-data-dir=${dataDir}`;
  try {
    const { stdout } = await execFileP("ps", ["-Ao", "pid=,command="]);
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      // Require a boundary after the dir (a following arg, or end of line) so
      // this profile's dir can't prefix-match a longer sibling's data-dir.
      if (!line.includes(`${needle} `) && !line.endsWith(needle)) continue;
      const pid = Number.parseInt(line.trimStart(), 10);
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

/** SIGKILL every process still holding `dataDir`. Final safety net so a Stop
 *  can never leave a Chromium window behind. */
async function killBrowsersUsingDataDir(dataDir: string): Promise<void> {
  const pids = await pidsUsingDataDir(dataDir);
  if (pids.length === 0) return;
  console.log(`[multizen] sweep: SIGKILL ${pids.length} lingering proc(s) for ${dataDir}: ${pids.join(", ")}`);
  for (const pid of pids) killPid(pid, "SIGKILL");
}

/** Resolve when `p` settles or after `ms`, whichever comes first. Never
 *  rejects — a hung or failing shutdown step must not block the kill path. */
function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([p.then(() => {}, () => {}), sleep(ms)]);
}

/**
 * Like {@link withTimeout}, but KEEPS the resolved value (and resolves with
 * `null` when the deadline passes). For a call whose result is used — e.g.
 * "find the visible window" — the value must survive the bounding.
 */
function withTimeoutValue<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.then((v) => v, () => null),
    sleep(ms).then(() => null),
  ]);
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH (already dead) or EPERM — nothing more we can do here.
  }
}

/**
 * Poll until `pid` is no longer alive or the timeout elapses. Returns true if
 * the process is confirmed dead. Uses the OS (`kill -0`) as the authority, so
 * it's immune to stale ChildProcess flags and works no matter which code path
 * (Stop button, window watcher, external ⌘Q) initiated the shutdown.
 */
async function waitForPidDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

/**
 * Poll for "the user closed every window" and report it.
 *
 * The survivor window is a page target too, so once it exists the page
 * count never reaches zero and this watcher never fires — the profile
 * survives the user closing their own window (that is the whole point of
 * the survivor). It only fires in the FALLBACK case, where the survivor
 * could not be created and the browser would otherwise linger with zero
 * windows.
 */
function createWindowWatcher(
  port: number,
  startedAt: string,
  onZeroWindows: () => void,
): NodeJS.Timeout {
  let zeroSinceMs: number | null = null;
  return setInterval(async () => {
    // Don't start counting "zero windows" until Chromium has had a chance
    // to open its initial window (some 1-2s after spawn).
    const ageMs = Date.now() - new Date(startedAt).getTime();
    if (ageMs < 2000) return;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!res.ok) return;
      const targets = (await res.json()) as Array<{ type?: string }>;
      const pages = targets.filter((t) => t.type === "page").length;
      if (pages === 0) {
        if (zeroSinceMs === null) {
          zeroSinceMs = Date.now();
        } else if (Date.now() - zeroSinceMs > 1500) {
          // Confirmed: zero pages for >1.5s. Treat as user closing the browser.
          onZeroWindows();
        }
      } else {
        zeroSinceMs = null;
      }
    } catch {
      // CDP unreachable — process likely already dying. exit handler will
      // clean up.
    }
  }, 1000);
}


/**
 * Mark the profile's last exit as clean in `Default/Preferences`
 * (exit_type=Normal / exited_cleanly=true) so a relaunch reopens the previous
 * tabs (via --restore-last-session) without the "Restore tabs?" crash infobar,
 * even after we killed Chromium ungracefully. Called before each spawn —
 * Chromium must NOT be running, or we'll corrupt its pref file (it writes
 * Preferences atomically with no flock). Deliberately does NOT touch the
 * protected `restore_on_startup` pref — see the note in the body.
 */
/**
 * Run `chromium --version` and parse the version triple. Returns null
 * if the probe fails — the caller should then trust whatever version is
 * baked into the profile.
 */
async function detectChromiumVersion(
  binaryPath: string,
): Promise<{ major: number; full: string } | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v: { major: number; full: string } | null): void => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };
    try {
      const p = spawn(binaryPath, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      p.stdout?.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      p.on("close", () => {
        const m = out.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
        if (!m) return done(null);
        done({ major: Number(m[1]), full: `${m[1]}.${m[2]}.${m[3]}.${m[4]}` });
      });
      p.on("error", () => done(null));
      setTimeout(() => {
        p.kill();
        done(null);
      }, 2000);
    } catch {
      done(null);
    }
  });
}

/**
 * Rewrite the version-bearing fields of a fingerprint to match the
 * actual Chromium binary. Returns a new object — does NOT persist; if
 * the user wants the persisted profile updated they should hit Regen.
 *
 * Touches: userAgent, clientHints.secChUa, clientHints.secChUaFullVersionList.
 * Leaves device, locale, screen, etc. untouched.
 */
function reconcileVersionInFingerprint(
  fp: FingerprintConfig,
  actual: { major: number; full: string },
): FingerprintConfig {
  // Rewrite Chrome version in UA: "Chrome/148.0.7390.42" → "Chrome/147.0.7727.138"
  const newUA = fp.userAgent.replace(/Chrome\/\d+\.\d+\.\d+\.\d+/, `Chrome/${actual.full}`);
  if (!fp.clientHints) {
    return { ...fp, userAgent: newUA };
  }
  const ch = fp.clientHints;
  // "Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"
  // Rewrite v="<num>" only on Chromium / Google Chrome / Microsoft Edge
  // brand entries; leave the GREASE brand alone.
  const newSecChUa = ch.secChUa.replace(
    /("(?:Chromium|Google Chrome|Microsoft Edge)";v=")(\d+)(")/g,
    `$1${actual.major}$3`,
  );
  const newFullList = ch.secChUaFullVersionList.replace(
    /("(?:Chromium|Google Chrome|Microsoft Edge)";v=")[\d.]+(")/g,
    `$1${actual.full}$2`,
  );
  return {
    ...fp,
    userAgent: newUA,
    clientHints: {
      ...ch,
      secChUa: newSecChUa,
      secChUaFullVersionList: newFullList,
    },
  };
}

/**
 * Tell macOS to skip the "reopen windows from previous crash?" alert
 * that NSPersistentUIRestorer shows when a previous launch died. The
 * alert is modal AppKit; CloakBrowser's stealth patches DCHECK on it
 * and crash with EXC_BREAKPOINT, creating a permanent boot loop.
 *
 * The Chromium-derived bundle uses `org.chromium.Chromium` as its bundle
 * identifier on macOS, so a single defaults block covers it.
 */
async function disableMacOsPersistentStateRestore(): Promise<void> {
  // Wipe the saved-state bundle entirely so the dialog has nothing to
  // restore from. Chromium will start fresh.
  const home = process.env.HOME ?? "";
  if (home) {
    const savedState = join(
      home,
      "Library",
      "Saved Application State",
      "org.chromium.Chromium.savedState",
    );
    await fsp.rm(savedState, { recursive: true, force: true }).catch(() => {});
  }
  // Defense in depth: turn off Apple's per-app persistence flags so
  // future crashes don't trigger the dialog either. These writes are
  // idempotent and silent if they already match.
  await execFileP("defaults", [
    "write",
    "org.chromium.Chromium",
    "NSQuitAlwaysKeepsWindows",
    "-bool",
    "false",
  ]).catch(() => {});
  await execFileP("defaults", [
    "write",
    "org.chromium.Chromium",
    "ApplePersistenceIgnoreState",
    "-bool",
    "true",
  ]).catch(() => {});
}

/**
 * Delete `SingletonLock` / `SingletonSocket` / `SingletonCookie` symlinks
 * if their target PID is no longer alive. Chromium refuses to launch
 * with these present (it interprets them as "another instance is using
 * this profile") and the failure manifests as a silent CDP "socket hang
 * up" — process exits seconds after spawn without any error to stderr.
 *
 * Safe to call before every launch: if the PID IS alive, we leave the
 * lock alone (real concurrent instance, let the second launch fail
 * loudly).
 */
async function cleanStaleSingletonLocks(dataDir: string): Promise<void> {
  const candidates = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  const { readlink } = await import("node:fs/promises");

  const lockPath = join(dataDir, "SingletonLock");
  let staleLockTarget: string | null = null;
  try {
    const lockTarget = await readlink(lockPath);
    const pid = pidFromSingletonTarget(lockTarget);
    if (pid !== null && !isPidAlive(pid)) {
      staleLockTarget = lockTarget;
    }
  } catch {
    // No lock to inspect.
  }

  if (staleLockTarget) {
    await unlinkSingletonFiles(dataDir, candidates, `dead lock ${staleLockTarget}`);
    return;
  }

  for (const name of candidates) {
    const path = join(dataDir, name);
    let target: string;
    try {
      target = await readlink(path);
    } catch {
      continue; // Not a symlink or doesn't exist — skip.
    }

    const pid = pidFromSingletonTarget(target);
    if (pid !== null && !isPidAlive(pid)) {
      try {
        await fsp.unlink(path);
        console.log(`[multizen] cleaned stale ${name} (was → ${target}, pid ${pid} not running)`);
      } catch {
        // ignore
      }
      continue;
    }

    // SingletonSocket points at a temp socket path. If the socket target
    // no longer exists, remove the symlink even when no PID is encoded.
    if (name === "SingletonSocket" && !existsSync(target)) {
      await fsp.unlink(path).catch(() => {});
      console.log(`[multizen] cleaned stale ${name} (missing target ${target})`);
    }
  }
}

function pidFromSingletonTarget(target: string): number | null {
  // Lock format is usually "<hostname>-<pid>". Socket paths sometimes
  // include the same suffix in an intermediate dir.
  const m = target.match(/-(\d+)(?:[/]|$)/);
  if (!m?.[1]) return null;
  const pid = Number(m[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isPidAlive(pid: number): boolean {
  try {
    // signal 0 = "is process alive" probe, doesn't actually signal it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function unlinkSingletonFiles(
  dataDir: string,
  names: string[],
  reason: string,
): Promise<void> {
  for (const name of names) {
    const path = join(dataDir, name);
    await fsp.unlink(path).catch(() => {});
  }
  console.log(`[multizen] cleaned stale Singleton files (${reason})`);
}

/**
 * Does the profile have a session Chromium can actually RESTORE?
 *
 * The check must look at the CONTENT, not just at the presence of a file:
 * Chromium leaves STALE `Session_*` / `Tabs_*` files behind forever, and a
 * profile whose last session held nothing restorable (e.g. only the
 * internal new-tab page, which Chromium deliberately excludes from the
 * session) still has files on disk.
 *
 * Getting this wrong is what produced the DUPLICATE TAB: the app believed
 * a session existed, so it skipped the positional start URL — and Chromium
 * restored an EMPTY session, leaving the user with just a blank tab. The
 * other direction is worse: believing there was NO session makes the app
 * pass the start URL as a positional argument, and Chromium then opens it
 * as an EXTRA tab on top of the restored ones (MEASURED: a relaunch with
 * a start URL produced ["example.com/", "example.org/", "example.com/"] —
 * the start page twice).
 *
 * So: a session counts only when it actually contains a restorable tab.
 */
async function hasRestorableSession(dataDir: string): Promise<boolean> {
  const sessionsDir = join(dataDir, "Default", "Sessions");
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(sessionsDir);
  } catch {
    // no Sessions dir yet
    entries = [];
  }
  // The newest session file holds the CURRENT session; older ones are the
  // previous session. Chromium names them `Session_<id>` / `Tabs_<id>`.
  const newest = entries.sort().at(-1);
  if (newest !== undefined) {
    try {
      const raw = await fsp.readFile(join(sessionsDir, newest), "utf8");
      // Chromium's session format is binary, but the tab URLs are stored as
      // plain ASCII — so a URL scan is a reliable, cheap way to tell an
      // EMPTY session from a real one.
      const hasUrl = /https?:\/\/[a-z0-9.-]+/i.test(raw);
      if (hasUrl) return true;
    } catch {
      // unreadable → fall through to the other checks
    }
  }
  // "Current Session" is the legacy location; it also holds the URLs.
  const current = join(dataDir, "Default", "Current Session");
  if (existsSync(current)) {
    try {
      const raw = await fsp.readFile(current, "utf8");
      if (/https?:\/\/[a-z0-9.-]+/i.test(raw)) return true;
    } catch {
      // unreadable → no session
    }
  }
  return false;
}

async function ensureSessionRestore(dataDir: string): Promise<void> {
  const prefsPath = join(dataDir, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    const raw = await fsp.readFile(prefsPath, "utf8");
    prefs = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Profile hasn't been launched yet — create minimal prefs and let
    // Chromium fill in the rest on first run.
  }
  const profileSection = (prefs.profile as Record<string, unknown>) ?? {};

  // Mark the previous run as a clean exit. If Chromium crashed or we killed it
  // ungracefully, exit_type gets stuck on "Crashed" and the next launch shows
  // the "Restore tabs?" infobar (or silently skips restore on some builds,
  // including CloakBrowser). exit_type / exited_cleanly are NOT protected prefs,
  // so editing them on disk is safe.
  profileSection.exit_type = "Normal";
  profileSection.exited_cleanly = true;

  // NOTE: we deliberately do NOT write session.restore_on_startup here. It IS a
  // protected/tracked pref (Secure Preferences stores a MAC + super_mac for it),
  // so editing it outside Chromium trips the "Your settings were changed by an
  // unknown app" reset of the WHOLE protected set — including the default search
  // engine — and Chromium resets our value to None anyway. Tab restore is driven
  // by the --restore-last-session CLI flag (passed in launch()), which forces
  // restore regardless of this pref, so the write was both harmful and useless.
  prefs.profile = profileSection;

  await fsp.mkdir(join(dataDir, "Default"), { recursive: true });
  // Atomic-ish write: write to .tmp then rename.
  const tmpPath = `${prefsPath}.multizen.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(prefs));
  await fsp.rename(tmpPath, prefsPath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
