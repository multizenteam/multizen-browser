export type ProfileId = string;

export interface ProxyConfig {
  type: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** Identifier of a real device family — defines the platform / CPU / GPU class. */
export type DeviceFamily =
  | "macbook-pro-14-m3"
  | "macbook-pro-14-m3-pro"
  | "macbook-pro-16-m3-pro"
  | "macbook-air-13-m3"
  | "macbook-air-15-m3"
  | "imac-24-m3"
  | "mac-mini-m2"
  | "windows-laptop-intel"
  | "windows-laptop-intel-uhd"
  | "windows-laptop-amd"
  | "windows-laptop-nvidia"
  | "windows-laptop-nvidia-4050"
  | "windows-desktop-nvidia"
  | "windows-desktop-nvidia-4080"
  | "windows-desktop-amd"
  | "windows-desktop-intel"
  | "linux-desktop-intel"
  | "linux-desktop-amd"
  | "linux-desktop-nvidia";

/**
 * Sec-CH-UA Client Hints — what every modern Chromium send as headers AND
 * exposes via `navigator.userAgentData`. Detection vendors cross-check
 * these against the legacy User-Agent string and `navigator.platform`,
 * so they MUST stay coherent.
 *
 * In our open-source build we can only set `navigator.userAgent` (via
 * Chromium `--user-agent` flag); the Sec-CH-UA family requires native
 * patches in our closed Chromium binary. The fields below are stored
 * with the profile so the patched Chromium can apply them at runtime.
 */
export interface ClientHints {
  /** Sec-CH-UA header value, e.g. `"Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"` */
  secChUa: string;
  /** Sec-CH-UA-Platform: `"macOS" | "Windows" | "Linux" | "Android" | "iOS"` */
  secChUaPlatform: string;
  /** Sec-CH-UA-Platform-Version: `"14.6.0"` for macOS 14, `"10.0.0"` for Win 10 */
  secChUaPlatformVersion: string;
  /** Sec-CH-UA-Arch: `"arm" | "x86"` */
  secChUaArch: "arm" | "x86";
  /** Sec-CH-UA-Bitness: `"64" | "32"` */
  secChUaBitness: "64" | "32";
  /** Sec-CH-UA-Mobile: `"?0" | "?1"` */
  secChUaMobile: "?0" | "?1";
  /** Sec-CH-UA-Model: usually empty on desktop, e.g. `"Pixel 8"` on mobile */
  secChUaModel: string;
  /** Sec-CH-UA-Full-Version-List: full version per brand */
  secChUaFullVersionList: string;
}

export interface FingerprintConfig {
  /** Real device family this fingerprint impersonates */
  device: DeviceFamily;

  // ── Headers / navigator ──────────────────────────────────────────
  /** Full legacy User-Agent string */
  userAgent: string;
  /** `navigator.platform` — must match device family */
  platform: "MacIntel" | "Win32" | "Linux x86_64";
  /** Client Hints (Sec-CH-UA-*) */
  clientHints: ClientHints;

  // ── Locale / geo ─────────────────────────────────────────────────
  /** BCP 47 primary locale, e.g. `"en-US"` */
  locale: string;
  /** Ordered list for `navigator.languages`, e.g. `["en-US", "en"]` */
  languages: string[];
  /** HTTP `Accept-Language` header, derived from `languages` */
  acceptLanguage: string;
  /** IANA timezone, e.g. `"America/New_York"` */
  timezone: string;
  /** ISO 3166-1 alpha-2 country code matching the locale, for flag rendering */
  country: string;

  // ── Display ──────────────────────────────────────────────────────
  /** Logical screen size — `screen.width` / `screen.height` */
  screen: { width: number; height: number };
  /** Available area (screen minus dock/taskbar). Defaults to screen. */
  availScreen?: { width: number; height: number };
  /** `devicePixelRatio` — 2 on Retina, 1 on most desktops */
  dpr: number;

  // ── GPU ──────────────────────────────────────────────────────────
  webgl: {
    /** UNMASKED_VENDOR_WEBGL */
    vendor: string;
    /** UNMASKED_RENDERER_WEBGL */
    renderer: string;
  };

  // ── CPU / RAM ────────────────────────────────────────────────────
  hardwareConcurrency: number;
  deviceMemory: number;

  /**
   * Optional entropy seed. When set, drives deterministic generateFingerprint
   * choices and CloakBrowser `--fingerprint=` noise (canvas/audio/WebGL readback).
   * Same seed → same noise; different seed → different noise.
   */
  seed?: string;
}

/**
 * A Chrome extension installed into a single profile. Unpacked on disk under
 * `{profile.dataDir}/extensions/{id}/` and loaded via Chromium's
 * `--load-extension` at launch. `id` is the Chromium-derived extension ID
 * (deterministic from the absolute install path). The companion "Add to
 * MultiZen" helper extension is NOT represented here — it's app-managed and
 * invisible to the user.
 */
export interface ExtensionConfig {
  /** Chromium extension ID (32 a–p chars). For store/CRX installs with a
   *  recovered developer key this is the genuine Chrome Web Store ID; for
   *  keyless folder/zip installs it's a stable content-hash-derived ID. */
  id: string;
  /** Display name from the extension's manifest. */
  name: string;
  /** Manifest version string (e.g. "1.50.0"). Shared store entries are keyed by
   *  id + version. "" for legacy rows installed before dedup. */
  version: string;
  /** Whether to load this extension on the next profile launch. */
  enabled: boolean;
  /** Where the unpacked files live:
   *  - "shared": one copy in the global store at <storeRoot>/<id>/<version>/,
   *    shared across profiles (`dir` is "").
   *  - "profile": legacy per-profile copy under the profile's dataDir, located
   *    via `dir`. */
  scope: "shared" | "profile";
  /** Install directory relative to the profile's dataDir (e.g. "extensions/<uuid>").
   *  Used only for scope "profile" (legacy / local); "" for shared entries. */
  dir: string;
  /** How it was added. */
  source: "web-store" | "file" | "folder";
}

export interface Profile {
  id: ProfileId;
  name: string;
  notes?: string;
  tags: string[];
  proxy?: ProxyConfig;
  fingerprint: FingerprintConfig;
  /** Extensions installed into this profile (see {@link ExtensionConfig}). */
  extensions?: ExtensionConfig[];
  /** Optional emoji the user picked as this profile's avatar. When unset the
   *  GUI derives a default emoji from the name/tags/id (see profileEmoji). */
  icon?: string;
  /** Start page opened on first launch (no restorable session). Empty/unset →
   *  the app default (DuckDuckGo). Opened as a positional URL arg; not enforced,
   *  so later in-browser navigation / session restore is untouched. */
  startUrl?: string;
  /** Reserved: per-profile default search engine. NOT wired yet — ungoogled
   *  CloakBrowser ignores both pref-seeding and extension `search_provider`
   *  overrides (verified), so this is deferred to the patched-Chromium build.
   *  The column/field are kept so the feature can land without a migration. */
  searchProvider?: string;
  dataDir: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  /** ISO 3166-1 alpha-2 country code resolved from the proxy's egress IP.
   *  Cached on every successful proxy probe (launch flow + manual ProxyTester).
   *  Used by the GUI to render the country flag — proxy egress trumps the
   *  fingerprint's timezone-derived country, since that's what websites see. */
  proxyCountry?: string;
}

export interface ProfileSummary {
  id: ProfileId;
  name: string;
  tags: string[];
  lastOpenedAt?: string;
  isRunning: boolean;
  /** User-picked emoji avatar (empty → GUI derives a default from name/tags/id). */
  icon?: string;
  /** Proxy config (denormalised so the GUI can render a proxy chip without a second fetch) */
  proxy?: ProxyConfig;
  /** IANA timezone from the profile's fingerprint (for flag inference) */
  timezone?: string;
  /** Country code resolved from the proxy's egress IP — preferred over
   *  `timezone` for flag rendering when the profile has a proxy. */
  proxyCountry?: string;
  /** Device family from the fingerprint — drives the platform icon
   *  (windows-laptop-intel → 🪟, macbook-pro-14-m3 → ). */
  device?: DeviceFamily;
}

export interface CreateProfileInput {
  name: string;
  notes?: string;
  tags?: string[];
  icon?: string;
  startUrl?: string;
  searchProvider?: string;
  proxy?: ProxyConfig;
  fingerprint?: Partial<FingerprintConfig>;
  extensions?: ExtensionConfig[];
}

export interface UpdateProfileInput {
  name?: string;
  notes?: string;
  tags?: string[];
  icon?: string | null;
  startUrl?: string | null;
  searchProvider?: string | null;
  proxy?: ProxyConfig | null;
  fingerprint?: Partial<FingerprintConfig>;
  extensions?: ExtensionConfig[];
}

export interface LaunchedProfile {
  id: ProfileId;
  cdpEndpoint: string;
  pid: number;
  startedAt: string;
}

export interface McpToolError {
  code: "PROFILE_NOT_FOUND" | "PROFILE_ALREADY_RUNNING" | "PROFILE_NOT_RUNNING" | "LAUNCH_FAILED" | "INVALID_INPUT" | "INTERNAL_ERROR";
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Status of the bundled / downloaded patched Chromium runtime.
 *
 *   ready          — binary present + verified, ready for spawn
 *   missing        — never downloaded, first run
 *   downloading    — fetch in progress
 *   verifying      — sha256 check after download
 *   error          — last attempt failed; retry or fall back
 *   dev-system     — dev mode, using system Chrome (no patches)
 */
export type ChromiumStatus =
  | { kind: "ready"; version: string; binaryPath: string }
  | { kind: "missing" }
  | { kind: "fetching-manifest" }
  | { kind: "downloading"; bytesReceived: number; bytesTotal: number; version: string }
  | { kind: "verifying"; version: string }
  | { kind: "extracting"; version: string }
  | { kind: "error"; message: string }
  | { kind: "dev-system"; binaryPath: string };

/**
 * App self-update lifecycle (electron-updater). Drives the in-app update UX.
 *   idle           — nothing known / no update; show nothing
 *   checking       — a check is in flight (manual or automatic)
 *   up-to-date     — a (manual) check completed and we're current
 *   available      — a newer version exists. On macOS this is TERMINAL (no
 *                    auto-install possible without an Apple Developer ID), so
 *                    it carries a `downloadUrl` to the DMG. On win/linux the
 *                    download auto-starts, so this is usually transient.
 *   downloading    — update downloading in the background (win/linux)
 *   ready          — update downloaded and staged; restart applies it (win/linux)
 *   error          — check/download/install failed; carries a human message
 */
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; version: string; downloadUrl: string }
  | { kind: "downloading"; version: string; percent: number; bytesPerSecond?: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

/**
 * Browser-ENGINE update lifecycle (the downloaded Chromium runtime —
 * CloakBrowser / Chrome for Testing — NOT the MultiZen app itself). Drives
 * the "Browser engine" update UX in Settings. Apply semantics are
 * "next launch": a newer version is downloaded side-by-side and current.json
 * is swapped, so the next profile launch picks it up while already-running
 * browsers stay on the old binary.
 *   idle           — nothing known yet
 *   checking       — resolving the latest published version
 *   up-to-date     — installed engine is already the latest
 *   available      — a newer version exists (carries the installed `current`)
 *   downloading    — staging the new version in the background
 *   staged         — new version installed; applies on the next profile launch
 *   error          — check/download failed; carries a human message
 */
export type EngineUpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; version: string; current: string }
  | { kind: "downloading"; version: string; bytesReceived: number; bytesTotal: number }
  | { kind: "staged"; version: string }
  | { kind: "error"; message: string };

export interface ChromiumManifest {
  version: string;
  /** Direct download URL; we recommend our R2 CDN */
  url: string;
  /** SHA-256 of the downloaded blob (lowercase hex) */
  sha256: string;
  /** Uncompressed size in bytes — used for progress UI when content-length is missing */
  size: number;
}
