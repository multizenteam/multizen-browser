import { app } from "electron";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import type { BrowserDriver } from "@multizen/mcp-server";
import type { ProfileManager } from "@multizen/profile-manager";
import { reconcileDeviceFamilyToHost } from "@multizen/profile-manager";
import type { ClientHints, FingerprintConfig, LaunchedProfile, ProfileId } from "@multizen/types";
import type { BrowserEngine } from "@multizen/settings-store";
import { CdpSession } from "@multizen/cdp-driver";
import type { ChromiumBootstrap } from "./ChromiumBootstrap";
import { startBridgeForProfile, stopBridgeForProfile } from "./socks5Bridge";
import { probeProxyGeo } from "./proxyGeo";
import { companionDir } from "./extensions/companion";
import { resolveLoadDir } from "./extensions/extensionStore.ts";
import { sanitizeStartUrl } from "./startPage";

interface RunningProcess {
  child: ChildProcess;
  cdpEndpoint: string;
  port: number;
  pid: number;
  startedAt: string;
  session: CdpSession;
  /** Polls /json/list and kills the child when no page targets remain. */
  windowWatcher: NodeJS.Timeout;
}

export interface ChromiumBrowserDriverOptions {
  profileManager: ProfileManager;
  chromiumBootstrap: ChromiumBootstrap;
  /**
   * Called when the companion extension's "Add to MultiZen" button is clicked
   * inside a running profile. `profileId` is the profile that made the call
   * (the CDP session is profile-scoped). The host installs the extension.
   */
  onCompanionInstall?: (profileId: ProfileId, extensionId: string) => void;
  /** Root of the shared extension store, e.g. `<userData>/data/extension-store`.
   *  Used to resolve shared extension references to their on-disk load dir. */
  extensionStoreRoot: string;
}

export type RunningStateChange =
  | { kind: "launched"; profileId: ProfileId }
  // Shutdown has begun (window closed / Stop pressed) but the process hasn't
  // fully exited yet — the GUI shows a "Terminating…" transitional state.
  | { kind: "closing"; profileId: ProfileId }
  | { kind: "closed"; profileId: ProfileId; reason: "user-close" | "external-exit" };

interface DriverEvents {
  "running-changed": (change: RunningStateChange) => void;
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
  private nextPort = 9222;
  private readonly profileManager: ProfileManager;
  private readonly bootstrap: ChromiumBootstrap;
  private readonly onCompanionInstall?: (profileId: ProfileId, extensionId: string) => void;
  private readonly extensionStoreRoot: string;

  constructor(opts: ChromiumBrowserDriverOptions) {
    super();
    this.profileManager = opts.profileManager;
    this.bootstrap = opts.chromiumBootstrap;
    this.onCompanionInstall = opts.onCompanionInstall;
    this.extensionStoreRoot = opts.extensionStoreRoot;
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
    const chromiumPath = this.bootstrap.resolveBinaryPath();
    const engine: BrowserEngine = this.bootstrap.getEngine();
    const browserDataDir = browserDataDirForEngine(profile.dataDir, engine);
    // Read the actual Chromium binary's version and reconcile the
    // profile's spoofed UA against it. Detection vendors fingerprint the
    // JS engine and compare against the claimed UA — claiming Chrome
    // 148 while running 147 is an instant flag.
    const actualVersion = await detectChromiumVersion(chromiumPath);
    // Reconcile (1) device family to host OS (claiming Win on a Mac
    //   binary is detected via V8/CSS feature signatures), then
    //   (2) Chrome version to the actual binary version. Both run
    //   on every launch so legacy profiles auto-fix.
    // CloakBrowser is built for cross-platform spoofing — claiming Windows
    // on a Mac binary is exactly its job (--fingerprint-platform=windows
    // patches V8/CSS/Blink at C++ level). For stock Chromium (CFT) we
    // can't hide the host, so we still snap back. Net: respect user's
    // platform choice on CloakBrowser, override it on CFT.
    let fp =
      engine === "cloakbrowser"
        ? profile.fingerprint
        : reconcileDeviceFamilyToHost(profile.fingerprint);
    if (actualVersion) fp = reconcileVersionInFingerprint(fp, actualVersion);

    // Align fp.timezone to the egress IP's timezone BEFORE we build CLI
    // args (CloakBrowser's --fingerprint-timezone= is set at spawn time
    // and reads from fp.timezone at that moment). Detection vendors do
    // an "IP timezone vs JS timezone" check — a mismatch here is an
    // instant -10% on creepjs/browserscan. With a proxy we probe via
    // ipapi.co; without one we use the host system timezone.
    let webrtcSpoofIp: string | null = null;
    let geoCoords: { latitude: number; longitude: number } | null = null;
    if (profile.proxy) {
      try {
        const geo = await probeProxyGeo(profile.proxy, { timeoutMs: 4000 });
        webrtcSpoofIp = geo.ip;
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
          "[multizen] proxy IP probe failed; using WebRTC block fallback:",
          (e as Error).message,
        );
      }
    } else {
      const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (hostTz && hostTz !== fp.timezone) {
        console.log(
          `[multizen] aligning fingerprint timezone ${fp.timezone} → ${hostTz} (host system, no proxy)`,
        );
        fp = { ...fp, timezone: hostTz };
      }
    }

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

    // Make Chromium reopen last-session tabs on every launch — what
    // Multilogin / AdsPower / GoLogin do by default. The setting is
    // `session.restore_on_startup = 1` in the Default profile's
    // Preferences JSON. We mutate it before spawn (Chrome must be off
    // to avoid corruption).
    await ensureSessionRestore(browserDataDir).catch((e: unknown) => {
      console.warn("[multizen] failed to write session restore preference:", (e as Error).message);
    });

    // Best-effort: suppress CFT's "is only for automated testing" infobar
    // via the macOS managed-preference. Idempotent — only prompts for
    // admin if the plist doesn't already exist or doesn't have the key.
    if (process.platform === "darwin" && engine === "cft") {
      await ensureCftInfobarSuppressed().catch((e: unknown) => {
        console.warn(
          "[multizen] failed to suppress CFT infobar (continuing):",
          (e as Error).message,
        );
      });
    }
    // Chromium's --accept-lang flag expects a PLAIN comma-separated list
    // of language tags ("en-US,en"). It then computes q-values itself for
    // the HTTP Accept-Language header AND for `navigator.languages`. If
    // we pass a pre-formatted string with q-values ("en-US,en;q=0.9"),
    // Chromium parses it as ["en-US", "en;q=0.9"] and then re-adds q's,
    // producing the malformed "en-US,en;q=0.9;q=0.9" we saw on browserscan.
    const acceptLangPlain = fp.languages.join(",");
    const args = [
      `--user-data-dir=${browserDataDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Force-restore the previous session's tabs at startup. Combined
      // with the Preferences flip in ensureSessionRestore() and our
      // CDP-based graceful shutdown on close, this makes tab persistence
      // reliable across stop/launch even after a crash.
      "--restore-last-session",
      "--disable-features=Translate,MediaRouter",
      // UI language for the Chromium chrome itself
      `--lang=${fp.locale}`,
      // Accept-Language: plain list, Chromium adds q-values.
      `--accept-lang=${acceptLangPlain}`,
      // Initial window size
      `--window-size=${fp.screen.width},${fp.screen.height}`,
    ];
    if (engine === "cloakbrowser") {
      // CloakBrowser implements fingerprint patches in C++. Feed it
      // native flags and avoid CDP/JS overrides later; those are exactly
      // the automation surfaces it hardens against.
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
    } else {
      // User-Agent (legacy header + navigator.userAgent). CFT needs this;
      // CloakBrowser keeps UA + Client Hints coherent via native flags.
      args.push(`--user-agent=${fp.userAgent}`);
    }
    // CFT-only: --test-type=gpu disables the "Chrome for Testing is for
    // automated testing" infobar by entering IsGpuTest() exit branch in
    // chrome/browser/ui/startup/infobar_utils.cc. CloakBrowser doesn't
    // need this — and putting it in gpu-test mode crashes the binary.
    if (engine === "cft") {
      args.push("--test-type=gpu");
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

    const child = spawn(chromiumPath, args, {
      detached: false,
      stdio: ["ignore", "ignore", "pipe"],
      env: cleanEnv,
    });
    if (!child.pid) throw new Error("Failed to spawn Chromium");
    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) process.stderr.write(`[chromium ${child.pid}] ${line}\n`);
    });
    child.on("exit", (code, signal) => {
      // First-line breadcrumb — child.on("exit") below also handles
      // running-changed teardown.
      if (code !== 0 && code !== null) {
        process.stderr.write(
          `[multizen] Chromium pid ${child.pid} exited code=${code} signal=${signal ?? "—"}\n`,
        );
      }
    });

    const startedAt = new Date().toISOString();
    const cdpEndpoint = `http://127.0.0.1:${port}`;

    const session = new CdpSession({ port });
    await waitForCdpReady(port, 10000);
    await session.connect();

    // Apply per-target emulation: timezone, locale, Sec-CH-UA via
    // userAgentMetadata (works on stock Chromium — no patches needed!),
    // plus a WebRTC handler when a proxy is configured. Runs on the
    // root tab + every existing tab + every future tab.
    //
    // Order matters: WebRTC injection goes FIRST so that even if
    // Emulation commands fail, the IP leak is already plugged.
    const useProxy = !!profile.proxy;

    // Probe the proxy's public IP so we can spoof WebRTC ICE candidates
    // to match it (the convincing fingerprint pattern: VPN user with
    // WebRTC enabled, candidates pointing to the egress IP). If the
    // probe fails (proxy down, ipapi blocked) we fall back to disabling
    // RTCPeerConnection entirely — less stealthy but still leak-proof.
    // WebRTC: if we have a proxy with a known egress IP, spoof ICE
    // candidates to match. Otherwise (or if probe failed) fall back to
    // a kill-switch that disables RTCPeerConnection — less stealthy but
    // leak-proof. CloakBrowser handles WebRTC natively when the
    // --fingerprint-webrtc-ip=auto flag is set, so we skip this preload.
    const webrtcScript =
      engine === "cloakbrowser"
        ? null
        : webrtcSpoofIp
          ? buildWebRtcSpoofScript(webrtcSpoofIp)
          : WEBRTC_BLOCK_SCRIPT;
    // Unified fingerprint preload — covers everything CDP `Emulation`
    // domain doesn't (navigator.platform, hardwareConcurrency, deviceMemory,
    // WebGL UNMASKED_VENDOR/RENDERER). CloakBrowser already handles these
    // natively in C++, so we skip our preload entirely on it — double-
    // patching produces inconsistent values that detection vendors flag.
    const fingerprintScript =
      engine === "cloakbrowser"
        ? null
        : buildFingerprintPreloadScript(fp, { includeWebGl: true });
    await session
      .bootstrapTargets(async (send, ctx) => {
        // 1. WebRTC kill-switch / spoof when proxy is on.
        //    CloakBrowser handles WebRTC natively (webrtcScript is null).
        if (useProxy && webrtcScript) {
          // addScriptToEvaluateOnNewDocument applies on EVERY future
          // document load in this target — works for iframes too. The
          // immediate Runtime.evaluate is a belt-and-braces patch of the
          // currently-loaded document; it expects an active execution
          // context which iframes that haven't finished navigating yet
          // don't have. Silence "Cannot find default execution context"
          // — addScript already covered the next load.
          await send("Page.addScriptToEvaluateOnNewDocument", {
            source: webrtcScript,
          }).catch((e: unknown) => {
            console.error("[multizen] WebRTC addScript failed:", e);
          });
          await send("Runtime.evaluate", { expression: webrtcScript }).catch((e: unknown) => {
            const msg = (e as Error).message;
            if (!/default execution context/i.test(msg)) {
              console.error("[multizen] WebRTC eval failed:", e);
            }
          });
        }
        // 1b. Generic fingerprint patches (deviceMemory, hwConcurrency,
        //     navigator.platform, WebGL UNMASKED_*). CloakBrowser handles
        //     these in C++ — skip our preload to avoid double-patching.
        if (fingerprintScript) {
          await send("Page.addScriptToEvaluateOnNewDocument", {
            source: fingerprintScript,
          }).catch((e: unknown) => {
            console.error("[multizen] fingerprint addScript failed:", e);
          });
          await send("Runtime.evaluate", { expression: fingerprintScript }).catch(
            (e: unknown) => {
              const msg = (e as Error).message;
              if (!/default execution context/i.test(msg)) {
                console.error("[multizen] fingerprint eval failed:", e);
              }
            },
          );
        }
        // 1c. Screen / device metrics — TOP-LEVEL TARGETS ONLY. iframes
        //     reject with "Command can only be executed on top-level
        //     targets" — they inherit metrics from their parent page.
        //     Skip for CloakBrowser: --fingerprint-screen-{width,height}
        //     already configures native screen at C++ level, and
        //     setDeviceMetricsOverride on top can produce inconsistent
        //     window.innerWidth vs screen.width values that detection
        //     vendors flag.
        if (ctx.isRoot && engine !== "cloakbrowser") {
          try {
            await send("Emulation.setDeviceMetricsOverride", {
              width: 0,
              height: 0,
              deviceScaleFactor: fp.dpr,
              mobile: false,
              screenWidth: fp.screen.width,
              screenHeight: fp.screen.height,
              screenOrientation: { type: "landscapePrimary", angle: 0 },
            });
          } catch (e) {
            console.error("[multizen] setDeviceMetricsOverride failed:", e);
          }
        }
        // 2-4. Timezone / Locale / UA+UA-CH overrides via CDP.
        //
        // ONLY run for CFT. CloakBrowser sets these natively at C++ level
        // through --fingerprint-timezone / --fingerprint-locale /
        // --fingerprint-brand-version. Layering CDP `Emulation.*` on top
        // produces subtle disagreements between layers (e.g. our CDP UA
        // string ≠ CloakBrowser's native UA-CH brand list) that
        // composite scorers like fingerprint-scan.com flag as "Masking
        // detected". Trust the native binary on CloakBrowser.
        if (engine !== "cloakbrowser") {
          try {
            await send("Emulation.setTimezoneOverride", {
              timezoneId: fp.timezone,
            });
          } catch (e) {
            console.error("[multizen] setTimezoneOverride failed:", e);
          }
          try {
            await send("Emulation.setLocaleOverride", { locale: fp.locale });
          } catch (e) {
            // "Another locale override is already in effect" fires when
            // Target.setAutoAttach re-attaches an already-configured target;
            // the override is in place, we just can't replace it. Harmless.
            const msg = (e as Error).message;
            if (!/already in effect/i.test(msg)) {
              console.error("[multizen] setLocaleOverride failed:", e);
            }
          }
          const meta = safeBuildUserAgentMetadata(fp);
          try {
            const params: Record<string, unknown> = {
              userAgent: fp.userAgent,
              // Plain language list — see --accept-lang comment above.
              acceptLanguage: acceptLangPlain,
              platform: fp.platform,
            };
            if (meta) params.userAgentMetadata = meta;
            await send("Emulation.setUserAgentOverride", params);
          } catch (e) {
            console.error("[multizen] setUserAgentOverride failed:", e);
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
              lang: navigator.language,
              langs: navigator.languages,
              hasRTCPC: typeof window.RTCPeerConnection !== "undefined",
            })`,
            returnByValue: true,
          });
          const value = probe?.result?.value;
          if (value) console.log("[multizen] post-bootstrap probe:", value);
        } catch (e) {
          // Non-fatal — diagnostic only.
          void e;
        }
      })
      .catch((e: unknown) => {
        console.error("[multizen] CDP bootstrap failed:", e);
      });

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
      // Graceful CDP shutdown — preserves session-restore on CFT too.
      void gracefulShutdown(r);
    });

    const record: RunningProcess = {
      child,
      cdpEndpoint,
      port,
      pid: child.pid,
      startedAt,
      session,
      windowWatcher,
    };
    const r = record;
    this.running.set(profileId, record);

    child.on("exit", () => {
      const wasTracked = this.running.has(profileId);
      clearInterval(record.windowWatcher);
      void session.close().catch(() => {});
      void stopBridgeForProfile(profileId).catch(() => {});
      this.running.delete(profileId);
      if (wasTracked) {
        // close() removes from the map first so wasTracked is false there;
        // this path covers (a) user quit Chrome directly with ⌘Q, and (b)
        // our own kill() from the windowWatcher when the last window closed.
        this.emit("running-changed", { kind: "closed", profileId, reason: "external-exit" });
      }
    });

    this.emit("running-changed", { kind: "launched", profileId });
    return { id: profileId, cdpEndpoint, pid: child.pid, startedAt };
  }

  async close(profileId: ProfileId): Promise<void> {
    const r = this.running.get(profileId);
    if (!r) return;
    // Signal the terminating phase up front (covers MCP/external callers that
    // don't drive the button's local "Stopping…" state).
    this.emit("running-changed", { kind: "closing", profileId });
    // Remove from map first so the child.on('exit') handler treats this as
    // a planned close (no event emitted from there).
    this.running.delete(profileId);
    clearInterval(r.windowWatcher);
    // Always emit "closed" — even if shutdown throws — so the GUI's terminating
    // state can never get stranded.
    try {
      await stopBridgeForProfile(profileId).catch(() => {});
      await gracefulShutdown(r);
    } finally {
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

  async closeAll(): Promise<void> {
    const ids = [...this.running.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
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

/**
 * Convert our string-formatted ClientHints into the structured
 * `userAgentMetadata` shape that CDP `Emulation.setUserAgentOverride`
 * expects. The CDP call then sets every Sec-CH-UA-* header AND populates
 * `navigator.userAgentData` — no Chromium patch needed.
 */
function safeBuildUserAgentMetadata(
  fp: FingerprintConfig,
): ReturnType<typeof buildUserAgentMetadata> | null {
  if (!fp.clientHints || !fp.clientHints.secChUa) {
    // Legacy profile created before clientHints existed. The basic
    // userAgent + platform string are still applied via the parent call;
    // Sec-CH-UA-* headers will fall back to Chromium defaults until the
    // user regenerates the fingerprint.
    return null;
  }
  try {
    return buildUserAgentMetadata(fp);
  } catch (e) {
    console.error("[multizen] buildUserAgentMetadata threw:", e);
    return null;
  }
}

function buildUserAgentMetadata(fp: FingerprintConfig): {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  model: string;
  mobile: boolean;
  wow64: boolean;
} {
  const ch: ClientHints = fp.clientHints;
  return {
    brands: parseBrandList(ch.secChUa),
    fullVersionList: parseBrandList(ch.secChUaFullVersionList),
    platform: ch.secChUaPlatform,
    platformVersion: ch.secChUaPlatformVersion,
    architecture: ch.secChUaArch,
    bitness: ch.secChUaBitness,
    model: ch.secChUaModel,
    mobile: ch.secChUaMobile === "?1",
    wow64: false,
  };
}

/**
 * Parse an Sec-CH-UA header value of the form:
 *   "Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"
 * into the [{brand, version}] array CDP wants.
 */
function parseBrandList(header: string): Array<{ brand: string; version: string }> {
  const out: Array<{ brand: string; version: string }> = [];
  // Each item is `"<brand>";v="<version>"` — split on top-level commas
  // (brand strings cannot contain commas in practice).
  for (const part of header.split(",")) {
    const m = part.trim().match(/^"([^"]*)"\s*;\s*v="([^"]*)"\s*$/);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out.push({ brand: m[1], version: m[2] });
  }
  return out;
}

/**
 * Patches non-CDP-controllable fingerprint surfaces:
 *   - `navigator.platform` (CDP `setUserAgentOverride` sets it once but
 *     iframes / web-workers can drift — reapplied on every document)
 *   - `navigator.hardwareConcurrency`
 *   - `navigator.deviceMemory`
 *   - `WebGLRenderingContext.getParameter` UNMASKED_VENDOR_WEBGL (0x9245)
 *     and UNMASKED_RENDERER_WEBGL (0x9246) for both WebGL1 and WebGL2.
 *
 * All wrappers carry a spoofed `.toString()` that returns
 * `function <name>() { [native code] }` so naive detection via
 * `Function.prototype.toString.call(fn)` passes.
 */
function buildFingerprintPreloadScript(
  fp: FingerprintConfig,
  opts: { includeWebGl?: boolean } = {},
): string {
  // includeWebGl=false when the engine (e.g. CloakBrowser) handles WebGL
  // farbling at C++ level — our JS wrapper would create a double-spoof
  // anomaly. Default true for stock CFT.
  const includeWebGl = opts.includeWebGl ?? true;
  return `
(() => {
  const INCLUDE_WEBGL = ${JSON.stringify(includeWebGl)};
  const PLATFORM = ${JSON.stringify(fp.platform)};
  const HW_CONCURRENCY = ${fp.hardwareConcurrency};
  const DEVICE_MEMORY = ${fp.deviceMemory};
  const GPU_VENDOR = ${JSON.stringify(fp.webgl.vendor)};
  const GPU_RENDERER = ${JSON.stringify(fp.webgl.renderer)};
  const SCREEN_W = ${fp.screen.width};
  const SCREEN_H = ${fp.screen.height};
  const AVAIL_W = ${fp.availScreen?.width ?? fp.screen.width};
  const AVAIL_H = ${fp.availScreen?.height ?? fp.screen.height};
  const DPR = ${fp.dpr};

  function fakeNative(fn, name) {
    try {
      const stringified = "function " + name + "() { [native code] }";
      Object.defineProperty(fn, "toString", {
        value: function () { return stringified; },
        configurable: false,
        writable: false,
      });
      Object.defineProperty(fn, "name", { value: name });
    } catch (_) {}
  }

  function defineProp(obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, {
        get: function () { return value; },
        configurable: true,
      });
    } catch (_) {}
  }

  // ---- navigator props ----------------------------------------------------
  defineProp(Navigator.prototype, "platform", PLATFORM);
  defineProp(Navigator.prototype, "hardwareConcurrency", HW_CONCURRENCY);
  defineProp(Navigator.prototype, "deviceMemory", DEVICE_MEMORY);

  // ---- screen props (some sites read screen.* not via Emulation) ----------
  defineProp(Screen.prototype, "width", SCREEN_W);
  defineProp(Screen.prototype, "height", SCREEN_H);
  defineProp(Screen.prototype, "availWidth", AVAIL_W);
  defineProp(Screen.prototype, "availHeight", AVAIL_H);
  defineProp(Screen.prototype, "colorDepth", 24);
  defineProp(Screen.prototype, "pixelDepth", 24);

  // ---- devicePixelRatio (Emulation should set this but cover it) ----------
  defineProp(window, "devicePixelRatio", DPR);

  // ---- WebGL renderer / vendor -------------------------------------------
  // Real Chrome only resolves UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL
  // *after* the page has activated WEBGL_debug_renderer_info via
  // gl.getExtension(...). If we return spoofed strings unconditionally, sites
  // that probe getParameter without enabling the extension see a string
  // where real Chrome returns "" — that anomaly = browserscan "WebGL exception".
  const debugInfoEnabled = new WeakMap();
  function patchGetExtension(Ctor) {
    if (!Ctor || !Ctor.prototype) return;
    const origGet = Ctor.prototype.getExtension;
    if (!origGet) return;
    function wrapped(name) {
      const result = origGet.call(this, name);
      if (result && name === "WEBGL_debug_renderer_info") {
        debugInfoEnabled.set(this, true);
      }
      return result;
    }
    fakeNative(wrapped, "getExtension");
    Object.defineProperty(Ctor.prototype, "getExtension", {
      value: wrapped, configurable: true, writable: true,
    });
  }
  function patchGetParameter(Ctor) {
    if (!Ctor || !Ctor.prototype || !Ctor.prototype.getParameter) return;
    const orig = Ctor.prototype.getParameter;
    function wrapped(p) {
      // 0x9245 = UNMASKED_VENDOR_WEBGL, 0x9246 = UNMASKED_RENDERER_WEBGL
      if (p === 0x9245 || p === 0x9246) {
        if (!debugInfoEnabled.get(this)) {
          // Page didn't enable WEBGL_debug_renderer_info — match real Chrome
          // which returns null/empty. Returning the spoof here is a tell.
          return orig.call(this, p);
        }
        return p === 0x9245 ? GPU_VENDOR : GPU_RENDERER;
      }
      return orig.call(this, p);
    }
    fakeNative(wrapped, "getParameter");
    Object.defineProperty(Ctor.prototype, "getParameter", {
      value: wrapped, configurable: true, writable: true,
    });
  }
  if (INCLUDE_WEBGL) {
    patchGetExtension(window.WebGLRenderingContext);
    patchGetExtension(window.WebGL2RenderingContext);
    patchGetParameter(window.WebGLRenderingContext);
    patchGetParameter(window.WebGL2RenderingContext);
  }

  // ---- navigator.userAgentData getHighEntropyValues fallback --------------
  // CDP Emulation.setUserAgentOverride.userAgentMetadata sets this on stock
  // Chromium, but iframes occasionally see the unpatched version. Cover the
  // gap by mirroring values from navigator.userAgent + platform.
  // (Not invoked here — handled via CDP. Placeholder for future hardening.)
})();
`;
}

function buildCloakBrowserFingerprintArgs(profileId: ProfileId, fp: FingerprintConfig): string[] {
  const args = [
    `--fingerprint=${fingerprintSeed(profileId)}`,
    `--fingerprint-platform=${cloakBrowserPlatform(fp)}`,
    `--fingerprint-locale=${fp.locale}`,
    `--fingerprint-timezone=${fp.timezone}`,
    `--fingerprint-screen-width=${fp.screen.width}`,
    `--fingerprint-screen-height=${fp.screen.height}`,
    `--fingerprint-hardware-concurrency=${fp.hardwareConcurrency}`,
    `--fingerprint-device-memory=${fp.deviceMemory}`,
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

function fingerprintSeed(profileId: ProfileId): string {
  // CloakBrowser accepts a stable seed. Keep it numeric and deterministic
  // so a MultiZen profile keeps the same native fingerprint across launches.
  const hex = createHash("sha256").update(profileId).digest("hex").slice(0, 8);
  return String(10000 + (Number.parseInt(hex, 16) % 90000));
}

function cloakBrowserPlatform(fp: FingerprintConfig): "macos" | "windows" | "linux" {
  // Derive from the user's chosen device family — CloakBrowser's native
  // C++ patches handle the rest of the cross-platform spoof. Falls back
  // to the host OS if device is somehow unset.
  if (fp.device.startsWith("macbook") || fp.device.startsWith("imac")) return "macos";
  if (fp.device.startsWith("windows")) return "windows";
  if (fp.device.startsWith("linux")) return "linux";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function browserDataDirForEngine(profileDataDir: string, engine: BrowserEngine): string {
  // Chrome profile data is not safely reusable across different Chromium
  // forks/major versions. CloakBrowser 145 SIGTRAPs on profile roots that
  // were previously opened by CFT 147/148, so keep its browser state in a
  // separate user-data-dir while preserving the logical MultiZen profile.
  if (engine === "cloakbrowser") {
    return join(profileDataDir, "engines", "cloakbrowser");
  }
  return profileDataDir;
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
async function gracefulShutdown(r: RunningProcess): Promise<void> {
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
  //    websocket disconnects mid-call, so ignore the rejection.
  await r.session.closeBrowser().catch(() => {});
  // Chromium needs ~500ms–2s to flush session-restore on macOS; 4s is margin.
  if (await waitForPidDeath(pid, 4000)) {
    await r.session.close().catch(() => {});
    return;
  }

  await r.session.close().catch(() => {});

  // 2. SIGTERM by PID (not r.child.kill — don't trust the child flags).
  killPid(pid, "SIGTERM");
  if (await waitForPidDeath(pid, 2000)) return;

  // 3. SIGKILL — the kernel guarantees this. We poll to confirm the process is
  //    genuinely gone before returning, so close() never reports a false
  //    "closed" while Chromium is still on screen.
  killPid(pid, "SIGKILL");
  await waitForPidDeath(pid, 2000);
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
 * Build the WebRTC spoof script with the supplied proxy IP baked in.
 *
 * Stealth strategy: we DO NOT replace `window.RTCPeerConnection` — its
 * `.toString()` would diverge from `[native code]`. Instead we patch the
 * prototype's `addEventListener`, the `onicecandidate` setter, and the
 * `localDescription` / `currentLocalDescription` getters to launder ICE
 * candidates as they leave the API. The constructor stays native.
 *
 * For every emitted ICE candidate:
 *   - Drop mDNS `.local` host candidates (would expose hostname).
 *   - Drop loopback / private-RFC1918 candidates.
 *   - Replace any public IP in `candidate.candidate` and `candidate.address`
 *     with the proxy's public IP, keeping foundation/port/typ srflx so
 *     the SDP looks like a real STUN-discovered candidate.
 *
 * For SDP munging (`localDescription`):
 *   - Same IP rewrite + remove `c=IN IP4 <real>` lines that don't match
 *     the proxy IP.
 *
 * `Function.prototype.toString` is also patched on our wrappers so that
 * naive `RTCPeerConnection.prototype.addEventListener.toString()` checks
 * still return `function addEventListener() { [native code] }`.
 */
function buildWebRtcSpoofScript(proxyIp: string): string {
  return `
(() => {
  if (!window.RTCPeerConnection) return;
  const PROXY_IP = ${JSON.stringify(proxyIp)};
  // Sentinel: patchEvent returns this when the candidate must be
  // silently suppressed. Listener wrappers check for it and skip
  // dispatch entirely — emitting candidate=null would prematurely
  // signal "gathering done" to the page.
  const SUPPRESS = Symbol("suppress-ice");
  // Plausible LAN IP for raddr/rport — real srflx candidates carry
  // the local interface IP that STUN used. Stripping these creates
  // an "srflx without raddr" anomaly that fingerprinters flag.
  const FAKE_LAN = "192.168.1.42";

  const PRIV_RE = /^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|169\\.254\\.|127\\.|fe80:|fc00:|fd)/i;
  function isPrivate(ip) {
    if (!ip) return true;
    if (ip.endsWith(".local")) return true;
    return PRIV_RE.test(ip);
  }

  function rewriteCandidateLine(line) {
    // candidate:foundation 1 udp 2113937151 1.2.3.4 50000 typ host generation 0 ufrag XXX network-id 1
    const parts = line.split(" ");
    if (parts.length < 8) return line;
    const port = parts[5];
    parts[4] = PROXY_IP;       // public IP
    parts[7] = "srflx";        // looks STUN-discovered

    // Walk extra k/v pairs after typ — rewrite raddr/rport to fake LAN.
    let hasRaddr = false;
    for (let i = 8; i < parts.length - 1; i++) {
      if (parts[i] === "raddr") { parts[i + 1] = FAKE_LAN; hasRaddr = true; }
      if (parts[i] === "rport") { parts[i + 1] = port; }
    }
    if (!hasRaddr) {
      // Insert raddr/rport right after "typ srflx" so the candidate
      // looks like a real STUN-reflected one.
      parts.splice(8, 0, "raddr", FAKE_LAN, "rport", port);
    }
    return parts.join(" ");
  }

  function patchEvent(event) {
    const c = event && event.candidate;
    if (!c) return event; // end-of-gathering marker — pass through
    const real = c.address || c.ip || "";
    // mDNS .local hostnames leak the device hostname — suppress, but
    // do NOT replace with candidate=null mid-stream.
    if (real.endsWith(".local")) return SUPPRESS;
    try {
      const newStr = rewriteCandidateLine(c.candidate || "");
      const fake = new RTCIceCandidate({
        candidate: newStr,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        usernameFragment: c.usernameFragment,
      });
      return new RTCPeerConnectionIceEvent("icecandidate", { candidate: fake });
    } catch (_) {
      return SUPPRESS;
    }
  }

  function mungeSdp(sdp) {
    if (!sdp) return sdp;
    // Replace c=IN IP4 / c=IN IP6 with proxy IP.
    let out = sdp.replace(/c=IN IP4 \\S+/g, "c=IN IP4 " + PROXY_IP);
    // Rewrite a=candidate lines, drop private-IP entries (mDNS .local).
    out = out
      .split(/\\r?\\n/)
      .map((line) => {
        if (!line.startsWith("a=candidate:")) return line;
        const parts = line.replace("a=candidate:", "").split(" ");
        const ip = parts[4];
        if (ip && (ip.endsWith(".local"))) return null;
        return "a=candidate:" + rewriteCandidateLine(parts.join(" "));
      })
      .filter((l) => l !== null)
      .join("\\r\\n");
    return out;
  }

  // ---- Hook prototype, leave constructor untouched ------------------------
  const proto = window.RTCPeerConnection.prototype;
  const ctorVariants = [window.RTCPeerConnection];
  if (window.webkitRTCPeerConnection && window.webkitRTCPeerConnection !== window.RTCPeerConnection) {
    ctorVariants.push(window.webkitRTCPeerConnection);
  }

  // 1. addEventListener('icecandidate', ...)
  const origAdd = proto.addEventListener;
  function wrappedAdd(type, listener, options) {
    if (type === "icecandidate" && typeof listener === "function") {
      const wrapped = function (event) {
        return listener.call(this, patchEvent(event));
      };
      // Make .toString look ordinary so detection that does
      // listener.toString() doesn't see "wrapped".
      try {
        Object.defineProperty(wrapped, "toString", {
          value: listener.toString.bind(listener),
        });
      } catch (_) {}
      return origAdd.call(this, type, wrapped, options);
    }
    return origAdd.call(this, type, listener, options);
  }
  Object.defineProperty(proto, "addEventListener", { value: wrappedAdd });
  fakeNativeToString(wrappedAdd, "addEventListener");

  // 2. onicecandidate setter
  const origDescr = Object.getOwnPropertyDescriptor(proto, "onicecandidate");
  if (origDescr && origDescr.set) {
    const origSet = origDescr.set;
    Object.defineProperty(proto, "onicecandidate", {
      get: origDescr.get,
      set: function (cb) {
        if (typeof cb === "function") {
          const wrapped = function (event) {
            return cb.call(this, patchEvent(event));
          };
          try {
            Object.defineProperty(wrapped, "toString", {
              value: cb.toString.bind(cb),
            });
          } catch (_) {}
          return origSet.call(this, wrapped);
        }
        return origSet.call(this, cb);
      },
      configurable: true,
    });
  }

  // 3. localDescription / currentLocalDescription getters
  for (const propName of ["localDescription", "currentLocalDescription"]) {
    const d = Object.getOwnPropertyDescriptor(proto, propName);
    if (!d || !d.get) continue;
    const origGet = d.get;
    Object.defineProperty(proto, propName, {
      get: function () {
        const desc = origGet.call(this);
        if (desc && desc.sdp) {
          try {
            return { type: desc.type, sdp: mungeSdp(desc.sdp), toJSON: desc.toJSON };
          } catch (_) {
            return desc;
          }
        }
        return desc;
      },
      configurable: true,
    });
  }

  // 4. createOffer / createAnswer munge their SDP before resolving.
  for (const fnName of ["createOffer", "createAnswer"]) {
    const orig = proto[fnName];
    function wrapped() {
      const args = arguments;
      return orig.apply(this, args).then((desc) => {
        if (desc && desc.sdp) desc.sdp = mungeSdp(desc.sdp);
        return desc;
      });
    }
    fakeNativeToString(wrapped, fnName);
    Object.defineProperty(proto, fnName, { value: wrapped, configurable: true, writable: true });
  }

  // 4b. getStats() — bypasses onicecandidate / localDescription wrappers.
  // Returns RTCIceCandidateStats with .address / .ip / .relatedAddress
  // fields straight from internal state. browserscan reads these to
  // catch the real public IP. We rewrite IPs in stats too.
  const origGetStats = proto.getStats;
  if (origGetStats) {
    function wrappedGetStats() {
      const args = arguments;
      return origGetStats.apply(this, args).then((report) => {
        try {
          report.forEach((stat) => {
            if (!stat) return;
            if (typeof stat.address === "string" && !isPrivate(stat.address) && !stat.address.endsWith(".local")) {
              stat.address = PROXY_IP;
            }
            if (typeof stat.ip === "string" && !isPrivate(stat.ip) && !stat.ip.endsWith(".local")) {
              stat.ip = PROXY_IP;
            }
            if (typeof stat.relatedAddress === "string" && !isPrivate(stat.relatedAddress)) {
              stat.relatedAddress = "192.168.1.42";
            }
            // Hide candidate type "host" (which would imply native interface)
            if (stat.candidateType === "host") {
              stat.candidateType = "srflx";
            }
          });
        } catch (_) {}
        return report;
      });
    }
    fakeNativeToString(wrappedGetStats, "getStats");
    Object.defineProperty(proto, "getStats", { value: wrappedGetStats, configurable: true, writable: true });
  }

  // 5. mediaDevices.enumerateDevices — keep working but strip per-device
  //    ids that uniquely identify hardware. Returns generic labels.
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    const origEnum = navigator.mediaDevices.enumerateDevices.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.enumerateDevices = function () {
      return origEnum().then((list) =>
        list.map((d) => ({
          deviceId: "",
          groupId: "",
          kind: d.kind,
          label: "",
          toJSON: d.toJSON,
        })),
      );
    };
    fakeNativeToString(navigator.mediaDevices.enumerateDevices, "enumerateDevices");
  }

  function fakeNativeToString(fn, name) {
    try {
      Object.defineProperty(fn, "toString", {
        value: function () { return "function " + name + "() { [native code] }"; },
        configurable: false,
        writable: false,
      });
      Object.defineProperty(fn, "name", { value: name });
    } catch (_) {}
  }

  // Sanity: keep ctorVariants reachable so if the page fishes the
  // original via a global, it still reaches our patched prototype.
  void ctorVariants;
})();
`;
}

/**
 * Removes WebRTC peer-connection APIs entirely. Runs before any page
 * script via Page.addScriptToEvaluateOnNewDocument.
 *
 * We do not just override with `undefined` — we use `Object.defineProperty`
 * with a getter that returns undefined and `configurable: false` so a
 * page cannot later restore the constructor by digging out the original
 * via iframe contentWindow. Iframes also get the script via the same
 * preload mechanism (it runs on every new document, including frames).
 *
 * This is detectable as a "no WebRTC" signal — a real Chrome on a real
 * machine has it. For an anti-detect profile that's an OK trade-off:
 * "WebRTC disabled" is a small population but not unheard of (corporate
 * networks, privacy extensions). "WebRTC reveals real IP" is the
 * unambiguous-bot-or-proxy-leak signal we MUST avoid.
 */
const WEBRTC_BLOCK_SCRIPT = `
(() => {
  const noop = function () { throw new TypeError("WebRTC is disabled"); };
  // Make .toString() look like a native function so naive detection
  // (Function.prototype.toString.call(RTCPeerConnection)) returns
  // [native code] like in real Chrome with WebRTC behind enterprise
  // policy.
  try {
    Object.defineProperty(noop, "toString", {
      value: function () { return "function () { [native code] }"; },
      configurable: false,
      writable: false,
    });
    Object.defineProperty(noop, "name", { value: "RTCPeerConnection" });
  } catch (_) {}

  const kill = (name) => {
    try {
      Object.defineProperty(window, name, {
        get: () => undefined,
        set: () => {},
        configurable: false,
      });
    } catch (_) {}
  };

  kill("RTCPeerConnection");
  kill("webkitRTCPeerConnection");
  kill("RTCDataChannel");
  kill("RTCSessionDescription");
  kill("RTCIceCandidate");

  // mediaDevices.enumerateDevices() can also leak hardware identifiers;
  // wrap it so it returns an empty list. getUserMedia stays so sites
  // can ask permission, but it'll never actually return devices.
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const orig = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = function () {
        return Promise.resolve([]);
      };
      // Preserve toString shape
      try {
        Object.defineProperty(navigator.mediaDevices.enumerateDevices, "toString", {
          value: orig.toString.bind(orig),
        });
      } catch (_) {}
    }
  } catch (_) {}
})();
`;

/**
 * Ensure the profile's Chrome `Default/Preferences` JSON has
 * `session.restore_on_startup = 1` so a relaunch reopens the tabs that
 * were open when the user last closed the window. Called before each
 * spawn — Chromium must NOT be running, otherwise we'll corrupt its
 * pref file (Chromium writes Preferences atomically with no flock).
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
 * Suppress Chrome for Testing's "this build is only for automated testing"
 * infobar by writing the macOS managed-preference plist that the CfT
 * policy `CommandLineFlagSecurityWarningsEnabled` lives in. The path is
 * `/Library/Managed Preferences/com.google.chrome.for.testing.plist`,
 * which requires admin — but only ONCE; subsequent launches see the
 * file and skip the prompt.
 *
 * If the user declines admin (or just hits cancel), we swallow the
 * error and continue with the infobar visible. We don't keep prompting.
 */
async function ensureCftInfobarSuppressed(): Promise<void> {
  // macOS reads managed prefs from BOTH paths; the per-user one wins on
  // recent macOS (Big Sur+), the system-wide one is the fallback. We
  // write both for max compatibility.
  const username = process.env.USER ?? "";
  const userPlistPath = `/Library/Managed Preferences/${username}/com.google.chrome.for.testing.plist`;
  const systemPlistPath = "/Library/Managed Preferences/com.google.chrome.for.testing.plist";
  const plistPath = systemPlistPath; // primary write target; user-dir handled in script below

  // Skip if already configured. Read the plist value to ensure it's
  // actually `false`, not just present.
  if (existsSync(plistPath) || existsSync(userPlistPath)) {
    try {
      const { stdout } = await execFileP("defaults", [
        "read",
        "/Library/Managed Preferences/com.google.chrome.for.testing",
        "CommandLineFlagSecurityWarningsEnabled",
      ]);
      if (stdout.trim() === "0") return;
    } catch {
      // Key missing — fall through and (re-)write below.
    }
  }

  // Sentinel file: if the user has previously declined the admin
  // prompt, remember that and do NOT re-prompt on every launch.
  const sentinelPath = `${app.getPath("userData")}/.cft-infobar-prompt-declined`;
  if (existsSync(sentinelPath)) return;

  // Write the plist to a tempfile in user-space first (no admin needed),
  // then `cp` it to /Library/Managed Preferences/ via osascript admin.
  // Avoids the shell-escaping nightmare of putting XML inside a nested
  // AppleScript double-quoted string.
  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CommandLineFlagSecurityWarningsEnabled</key>
  <false/>
</dict>
</plist>
`;
  const tempPath = `${app.getPath("temp")}/multizen-cft-policy-${process.pid}.plist`;
  await writeFile(tempPath, plistXml);

  const shellScript =
    `/bin/mkdir -p '/Library/Managed Preferences/${username}' && ` +
    `/bin/cp '${tempPath}' '${plistPath}' && ` +
    `/bin/chmod 644 '${plistPath}' && ` +
    `/usr/sbin/chown root:wheel '${plistPath}' && ` +
    `/bin/cp '${tempPath}' '${userPlistPath}' && ` +
    `/bin/chmod 644 '${userPlistPath}' && ` +
    `/usr/sbin/chown root:wheel '${userPlistPath}'`;
  const apple = `do shell script "${shellScript.replace(/"/g, '\\"')}" with administrator privileges with prompt "MultiZen needs a one-time admin authorization to hide the 'Chrome for Testing' warning bar."`;

  try {
    await execFileP("osascript", ["-e", apple]);
    // Cleanup tempfile after copy succeeds (no admin needed since we own it).
    await fsp.unlink(tempPath).catch(() => {});
    console.log("[multizen] CFT infobar suppressed via managed-preferences plist");
  } catch (e) {
    await fsp.unlink(tempPath).catch(() => {});
    // User cancelled or osascript failed. Plant the sentinel so we
    // don't pester them on every launch.
    try {
      await writeFile(sentinelPath, new Date().toISOString());
    } catch {
      // Sentinel write may fail in weird envs — not critical.
    }
    throw e;
  }
}

/**
 * Tell macOS to skip the "reopen windows from previous crash?" alert
 * that NSPersistentUIRestorer shows when a previous launch died. The
 * alert is modal AppKit; CloakBrowser's stealth patches DCHECK on it
 * and crash with EXC_BREAKPOINT, creating a permanent boot loop.
 *
 * Both Chromium-derived bundles share `org.chromium.Chromium` as their
 * bundle identifier on macOS, so a single defaults block covers CFT and
 * CloakBrowser.
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
 * Whether the profile has a session Chromium can restore on launch. Used to
 * decide if we should open the start page (only on a genuine first run).
 * Chromium writes tab/session state under `Default/Sessions/`; older builds
 * also keep `Default/Current Session`. Any of these present → restorable.
 */
async function hasRestorableSession(dataDir: string): Promise<boolean> {
  const sessionsDir = join(dataDir, "Default", "Sessions");
  try {
    const entries = await fsp.readdir(sessionsDir);
    if (entries.length > 0) return true;
  } catch {
    // no Sessions dir yet
  }
  return existsSync(join(dataDir, "Default", "Current Session"));
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
  const session = (prefs.session as Record<string, unknown>) ?? {};
  const profileSection = (prefs.profile as Record<string, unknown>) ?? {};

  // 1 = restore last session ("Continue where you left off")
  // 5 = new tab page (Chromium default)
  session.restore_on_startup = 1;

  // Mark the previous run as a clean exit. If Chromium crashed or we
  // killed it ungracefully, exit_type gets stuck on "Crashed" and the
  // next launch shows the "Restore tabs?" infobar (or silently skips
  // restore on some builds, including CloakBrowser). Forcing "Normal"
  // here defuses both — combined with --restore-last-session CLI flag
  // and our gracefulShutdown via CDP Browser.close, tabs reliably come
  // back across stop → launch cycles.
  profileSection.exit_type = "Normal";
  profileSection.exited_cleanly = true;

  prefs.session = session;
  prefs.profile = profileSection;

  await fsp.mkdir(join(dataDir, "Default"), { recursive: true });
  // Atomic-ish write: write to .tmp then rename.
  const tmpPath = `${prefsPath}.multizen.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(prefs));
  await fsp.rename(tmpPath, prefsPath);
}

async function waitForCdpReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch (e) {
      lastError = e;
    }
    await sleep(150);
  }
  throw new Error(
    `CDP did not become ready on port ${port} within ${timeoutMs}ms: ${String(lastError)}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
