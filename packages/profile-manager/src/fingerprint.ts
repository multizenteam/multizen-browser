import type {
  ClientHints,
  DeviceFamily,
  FingerprintConfig,
} from "@multizen/types";

/**
 * Coherent fingerprint generator.
 *
 * Detection vendors (Cloudflare Bot Management, DataDome, Imperva, Akamai,
 * FingerprintJS, CreepJS) cross-check fingerprint surfaces against each
 * other. A consistent UA + Sec-CH-UA + navigator.platform + WebGL + screen
 * + locale + timezone story is the single most-important rule. One
 * inconsistency is a flag.
 *
 * This module owns the data model. We pick a `DeviceFamily` first, then a
 * `LocaleGroup` (geo-coherent locale + timezones), then derive every other
 * surface from those two choices. We never let the caller mix-and-match
 * incompatible values without going through `applyOverrides()` (which
 * preserves coherence where it can).
 *
 * Limit of this open-source generator: only fields injectable via Chromium
 * launch flags or runtime preload scripts can be applied without a patched
 * binary. Sec-CH-UA / navigator.userAgentData / TLS JA3-JA4 / Canvas-Audio
 * noise require the closed-source patched Chromium build (multizen-pro).
 * The fingerprint we generate stores those fields anyway so the patched
 * binary can apply them when it ships.
 */

/**
 * Generate-time Chrome defaults for UA / Client Hints.
 * Launch always rewrites these via `reconcileVersionInFingerprint` to the
 * actual binary major — see docs/chrome-version-bump.md and
 * `scripts/check-chrome-version.ts`. Bump when shipping a new CloakBrowser/CFT.
 *
 * Must stay close to the Chromium binary — detection vendors compare claimed
 * UA version vs JS-engine feature signatures.
 */
export const CHROME_VERSION_MAJOR = 146;
export const CHROME_VERSION_FULL = "146.0.7680.177";

// ─────────────────────────────────────────────────────────────────────────
// Device profiles — real models, real specs.
// ─────────────────────────────────────────────────────────────────────────

interface WebGlPair {
  vendor: string;
  renderer: string;
}

interface DeviceSpec {
  family: DeviceFamily;
  /** Human-readable label for UI dropdowns */
  label: string;

  /** UA platform token (legacy User-Agent) */
  uaPlatformToken: string;
  /** navigator.platform value */
  navigatorPlatform: "MacIntel" | "Win32" | "Linux x86_64";
  /** Sec-CH-UA-Platform value */
  secChUaPlatform: string;
  /** Sec-CH-UA-Platform-Version value (current OS major) */
  secChUaPlatformVersion: string;
  secChUaArch: "arm" | "x86";
  secChUaBitness: "64" | "32";

  /** Real screen sizes for this device (logical = CSS pixels, not retina) */
  screens: ReadonlyArray<{ width: number; height: number; label: string }>;
  /** Device pixel ratio — 2 for Mac Retina, 1 for most Win/Linux */
  dpr: number;

  /** WebGL UNMASKED_* pairs typical of this device family (one picked per generate) */
  webgl: ReadonlyArray<WebGlPair>;

  /** Plausible CPU core counts for this family */
  hardwareConcurrency: ReadonlyArray<number>;
  /** Plausible device memory in GB */
  deviceMemory: ReadonlyArray<number>;
}

/** Common desktop logical sizes callers pass (doc §3.2) — attached to Win/Linux devices. */
const COMMON_DESKTOP_SCREENS: ReadonlyArray<{ width: number; height: number; label: string }> = [
  { width: 1920, height: 1080, label: "1920 × 1080 (FHD)" },
  { width: 1536, height: 864, label: "1536 × 864" },
  { width: 1366, height: 768, label: "1366 × 768 (HD)" },
  { width: 1440, height: 900, label: "1440 × 900" },
  { width: 1600, height: 900, label: "1600 × 900" },
  { width: 1280, height: 720, label: "1280 × 720 (HD)" },
  { width: 2560, height: 1440, label: "2560 × 1440 (QHD)" },
  { width: 1680, height: 1050, label: "1680 × 1050" },
];

const WIN_DESKTOP_SCREENS: ReadonlyArray<{ width: number; height: number; label: string }> = [
  ...COMMON_DESKTOP_SCREENS,
  { width: 3840, height: 2160, label: "3840 × 2160 (4K)" },
];

const ALLOWED_HWC_BASE = new Set([4, 6, 8, 12, 16]);
const ALLOWED_MEM_BASE = new Set([4, 8, 16]);

const DEVICES: ReadonlyArray<DeviceSpec> = [
  {
    family: "macbook-pro-14-m2",
    label: "MacBook Pro 14″ (M2)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.5.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1512, height: 982, label: "1512 × 982 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M2" },
      { vendor: "Apple Inc.", renderer: "Apple M2 Pro" },
    ],
    hardwareConcurrency: [8, 10],
    deviceMemory: [8, 16, 32],
  },
  {
    family: "macbook-pro-14-m3",
    label: "MacBook Pro 14″ (M3)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1512, height: 982, label: "1512 × 982 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3" },
      { vendor: "Apple Inc.", renderer: "Apple M3 (8-core GPU)" },
    ],
    hardwareConcurrency: [8],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "macbook-pro-14-m4",
    label: "MacBook Pro 14″ (M4)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "15.1.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1512, height: 982, label: "1512 × 982 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
      { width: 3024, height: 1964, label: "3024 × 1964 (native Retina)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M4" },
      { vendor: "Apple Inc.", renderer: "Apple M4 Pro" },
    ],
    hardwareConcurrency: [10, 12, 14],
    deviceMemory: [16, 24, 32, 48],
  },
  {
    family: "macbook-pro-14-m3-pro",
    label: "MacBook Pro 14″ (M3 Pro)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1512, height: 982, label: "1512 × 982 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3 Pro" },
      { vendor: "Apple Inc.", renderer: "Apple M3 Pro (14-core GPU)" },
    ],
    hardwareConcurrency: [11, 12],
    deviceMemory: [18, 36],
  },
  {
    family: "macbook-pro-16-m3-pro",
    label: "MacBook Pro 16″ (M3 Pro)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1728, height: 1117, label: "1728 × 1117 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3 Pro" },
      { vendor: "Apple Inc.", renderer: "Apple M3 Max" },
    ],
    hardwareConcurrency: [11, 12, 16],
    deviceMemory: [18, 36],
  },
  {
    family: "macbook-pro-16-m3",
    label: "MacBook Pro 16″ (M3)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1728, height: 1117, label: "1728 × 1117 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3" },
      { vendor: "Apple Inc.", renderer: "Apple M3 (10-core GPU)" },
    ],
    hardwareConcurrency: [8, 11],
    deviceMemory: [16, 18, 36],
  },
  {
    family: "macbook-pro-16-m4-pro",
    label: "MacBook Pro 16″ (M4 Pro)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "15.1.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1728, height: 1117, label: "1728 × 1117 (default)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
      { width: 3840, height: 2160, label: "3840 × 2160 (external 4K)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M4 Pro" },
      { vendor: "Apple Inc.", renderer: "Apple M4 Max" },
    ],
    hardwareConcurrency: [14, 16],
    deviceMemory: [24, 36, 48, 64],
  },
  {
    family: "macbook-air-13-m2",
    label: "MacBook Air 13″ (M2)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.5.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1440, height: 900, label: "1440 × 900 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M2" },
      { vendor: "Apple Inc.", renderer: "Apple M2 (8-core GPU)" },
    ],
    hardwareConcurrency: [8],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "macbook-air-13-m3",
    label: "MacBook Air 13″ (M3)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1440, height: 900, label: "1440 × 900 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3" },
      { vendor: "Apple Inc.", renderer: "Apple M2" },
    ],
    hardwareConcurrency: [8],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "macbook-air-13-m4",
    label: "MacBook Air 13″ (M4)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "15.1.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1440, height: 900, label: "1440 × 900 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M4" },
      { vendor: "Apple Inc.", renderer: "Apple M4 (10-core GPU)" },
    ],
    hardwareConcurrency: [10],
    deviceMemory: [16, 24, 32],
  },
  {
    family: "macbook-air-15-m2",
    label: "MacBook Air 15″ (M2)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.5.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1680, height: 1050, label: "1680 × 1050 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M2" },
      { vendor: "Apple Inc.", renderer: "Apple M2 (10-core GPU)" },
    ],
    hardwareConcurrency: [8],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "macbook-air-15-m3",
    label: "MacBook Air 15″ (M3)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1680, height: 1050, label: "1680 × 1050 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3" },
      { vendor: "Apple Inc.", renderer: "Apple M3 (10-core GPU)" },
    ],
    hardwareConcurrency: [8],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "imac-24-m3",
    label: "iMac 24″ (M3)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 2240, height: 1260, label: "2240 × 1260 (4.5K)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (scaled)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3" },
      { vendor: "Apple Inc.", renderer: "Apple M3 (10-core GPU)" },
    ],
    hardwareConcurrency: [8],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "imac-24-m4",
    label: "iMac 24″ (M4)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "15.1.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 2240, height: 1260, label: "2240 × 1260 (4.5K)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (scaled)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (scaled)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M4" },
      { vendor: "Apple Inc.", renderer: "Apple M4 (10-core GPU)" },
    ],
    hardwareConcurrency: [10],
    deviceMemory: [16, 24, 32],
  },
  {
    family: "mac-mini-m2",
    label: "Mac mini (M2)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1920, height: 1080, label: "1920 × 1080 (FHD)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (QHD)" },
      { width: 3840, height: 2160, label: "3840 × 2160 (4K)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M2" },
      { vendor: "Apple Inc.", renderer: "Apple M2 Pro" },
    ],
    hardwareConcurrency: [8, 12],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "mac-mini-m4",
    label: "Mac mini (M4)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "15.1.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1920, height: 1080, label: "1920 × 1080 (FHD)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (QHD)" },
      { width: 3840, height: 2160, label: "3840 × 2160 (4K)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M4" },
      { vendor: "Apple Inc.", renderer: "Apple M4 Pro" },
    ],
    hardwareConcurrency: [10, 14],
    deviceMemory: [16, 24, 32, 64],
  },
  {
    family: "windows-laptop-intel",
    label: "Windows laptop (Intel Iris Xe)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (Intel)",
        renderer:
          "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (Intel)",
        renderer:
          "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [4, 8, 12],
    deviceMemory: [8, 16],
  },
  {
    family: "windows-laptop-intel-uhd",
    label: "Windows laptop (Intel UHD)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (Intel)",
        renderer:
          "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (Intel)",
        renderer:
          "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (Intel)",
        renderer:
          "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [4, 6, 8],
    deviceMemory: [4, 8, 16],
  },
  {
    family: "windows-laptop-amd",
    label: "Windows laptop (AMD Radeon)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (AMD)",
        renderer:
          "ANGLE (AMD, AMD Radeon RX 7600M XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (AMD)",
        renderer:
          "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [6, 8, 12],
    deviceMemory: [8, 16],
  },
  {
    family: "windows-laptop-nvidia",
    label: "Windows laptop (NVIDIA RTX 4060)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [8, 12, 16],
    deviceMemory: [8, 16, 32],
  },
  {
    family: "windows-laptop-nvidia-4050",
    label: "Windows laptop (NVIDIA RTX 4050)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028E1) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU (0x000025A2) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [6, 8, 12],
    deviceMemory: [8, 16],
  },
  {
    family: "windows-desktop-nvidia",
    label: "Windows desktop (NVIDIA RTX 4070)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: WIN_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [8, 12, 16, 24, 32],
    deviceMemory: [16, 32, 64],
  },
  {
    family: "windows-desktop-nvidia-4080",
    label: "Windows desktop (NVIDIA RTX 4080)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: WIN_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002704) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti (0x00002782) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [12, 16, 24, 32],
    deviceMemory: [32, 64],
  },
  {
    family: "windows-desktop-amd",
    label: "Windows desktop (AMD Radeon)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: WIN_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (AMD)",
        renderer:
          "ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (AMD)",
        renderer:
          "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [8, 12, 16],
    deviceMemory: [16, 32],
  },
  {
    family: "windows-desktop-intel",
    label: "Windows desktop (Intel UHD/Arc)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: WIN_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (Intel)",
        renderer:
          "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (Intel)",
        renderer:
          "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [6, 8, 12, 16],
    deviceMemory: [8, 16, 32],
  },
  {
    family: "linux-laptop-intel",
    label: "Linux laptop (Intel Iris Xe)",
    uaPlatformToken: "X11; Linux x86_64",
    navigatorPlatform: "Linux x86_64",
    secChUaPlatform: "Linux",
    secChUaPlatformVersion: "6.8.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      { vendor: "Mesa", renderer: "Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)" },
      { vendor: "Mesa", renderer: "Mesa Intel(R) Graphics (RPL-P)" },
      { vendor: "Intel", renderer: "Intel(R) Iris(R) Xe Graphics (0x0000A7A0)" },
    ],
    hardwareConcurrency: [4, 8, 12],
    deviceMemory: [8, 16],
  },
  {
    family: "linux-laptop-amd",
    label: "Linux laptop (AMD Radeon)",
    uaPlatformToken: "X11; Linux x86_64",
    navigatorPlatform: "Linux x86_64",
    secChUaPlatform: "Linux",
    secChUaPlatformVersion: "6.8.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      { vendor: "Mesa", renderer: "AMD Radeon Graphics (radeonsi, rembrandt, LLVM 17.0.6, DRM 3.57, 6.8.0)" },
      { vendor: "Mesa", renderer: "AMD Radeon 780M (radeonsi, phoenix, LLVM 17.0.6, DRM 3.57, 6.8.0)" },
      { vendor: "AMD", renderer: "AMD Radeon RX 7600M XT (radeonsi, navi33, LLVM 17.0.6, DRM 3.57, 6.8.0)" },
    ],
    hardwareConcurrency: [6, 8, 12, 16],
    deviceMemory: [8, 16, 32],
  },
  {
    family: "linux-laptop-nvidia",
    label: "Linux laptop (NVIDIA)",
    uaPlatformToken: "X11; Linux x86_64",
    navigatorPlatform: "Linux x86_64",
    secChUaPlatform: "Linux",
    secChUaPlatformVersion: "6.8.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      { vendor: "NVIDIA Corporation", renderer: "NVIDIA GeForce RTX 4060 Laptop GPU/PCIe/SSE2" },
      { vendor: "NVIDIA Corporation", renderer: "NVIDIA GeForce RTX 4050 Laptop GPU/PCIe/SSE2" },
      { vendor: "Mesa", renderer: "NV178" },
    ],
    hardwareConcurrency: [8, 12, 16],
    deviceMemory: [8, 16, 32],
  },
  {
    family: "linux-desktop-intel",
    label: "Linux desktop (Intel UHD/Arc)",
    uaPlatformToken: "X11; Linux x86_64",
    navigatorPlatform: "Linux x86_64",
    secChUaPlatform: "Linux",
    secChUaPlatformVersion: "6.6.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: [...COMMON_DESKTOP_SCREENS, { width: 3840, height: 2160, label: "3840 × 2160 (4K)" }],
    dpr: 1,
    webgl: [
      { vendor: "Mesa", renderer: "Mesa Intel(R) UHD Graphics 770 (RPL-S)" },
      { vendor: "Mesa", renderer: "Mesa Intel(R) Graphics (ADL GT2)" },
      { vendor: "Mesa", renderer: "Mesa Intel(R) Arc(tm) A750 Graphics (DG2)" },
      { vendor: "Intel", renderer: "Intel(R) Arc(TM) A770 Graphics (0x000056A0)" },
    ],
    hardwareConcurrency: [4, 8, 12, 16],
    deviceMemory: [8, 16, 32],
  },
  {
    family: "linux-desktop-amd",
    label: "Linux desktop (AMD Radeon)",
    uaPlatformToken: "X11; Linux x86_64",
    navigatorPlatform: "Linux x86_64",
    secChUaPlatform: "Linux",
    secChUaPlatformVersion: "6.6.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: [...COMMON_DESKTOP_SCREENS, { width: 3840, height: 2160, label: "3840 × 2160 (4K)" }],
    dpr: 1,
    webgl: [
      { vendor: "Mesa", renderer: "AMD Radeon RX 7800 XT (radeonsi, navi32, LLVM 17.0.6, DRM 3.57, 6.6.0)" },
      { vendor: "Mesa", renderer: "AMD Radeon Graphics (radeonsi, renoir, LLVM 17.0.6, DRM 3.57, 6.6.0)" },
      { vendor: "Mesa", renderer: "AMD Radeon RX 6700 XT (radeonsi, navi22, LLVM 17.0.6, DRM 3.57, 6.6.0)" },
      { vendor: "AMD", renderer: "AMD Radeon RX 7900 XTX (radeonsi, navi31, LLVM 17.0.6, DRM 3.57, 6.6.0)" },
    ],
    hardwareConcurrency: [6, 8, 12, 16, 24],
    deviceMemory: [8, 16, 32, 64],
  },
  {
    family: "linux-desktop-nvidia",
    label: "Linux desktop (NVIDIA)",
    uaPlatformToken: "X11; Linux x86_64",
    navigatorPlatform: "Linux x86_64",
    secChUaPlatform: "Linux",
    secChUaPlatformVersion: "6.6.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: [...COMMON_DESKTOP_SCREENS, { width: 3840, height: 2160, label: "3840 × 2160 (4K)" }],
    dpr: 1,
    webgl: [
      { vendor: "NVIDIA Corporation", renderer: "NVIDIA GeForce RTX 4070/PCIe/SSE2" },
      { vendor: "NVIDIA Corporation", renderer: "NVIDIA GeForce RTX 3080/PCIe/SSE2" },
      { vendor: "Mesa", renderer: "NVIDIA GeForce RTX 4070/PCIe/SSE2" },
      { vendor: "Mesa", renderer: "NV137" },
    ],
    hardwareConcurrency: [8, 12, 16, 24],
    deviceMemory: [16, 32, 64],
  },
];

/** Whitelist of screens reconcile will honor (common desktop + every device screen). */
function buildAllowedDesktopScreens(): Set<string> {
  const keys = new Set<string>();
  for (const s of COMMON_DESKTOP_SCREENS) keys.add(`${s.width}x${s.height}`);
  keys.add("3840x2160");
  for (const d of DEVICES) {
    for (const s of d.screens) keys.add(`${s.width}x${s.height}`);
  }
  return keys;
}

const ALLOWED_DESKTOP_SCREENS = buildAllowedDesktopScreens();

function screenKey(s: { width: number; height: number }): string {
  return `${s.width}x${s.height}`;
}

function isAllowedHwc(n: number, device: DeviceSpec): boolean {
  return ALLOWED_HWC_BASE.has(n) || device.hardwareConcurrency.includes(n);
}

function isAllowedMem(n: number, device: DeviceSpec): boolean {
  return ALLOWED_MEM_BASE.has(n) || device.deviceMemory.includes(n);
}

function webglMatches(a: WebGlPair, b: WebGlPair): boolean {
  return a.vendor === b.vendor && a.renderer === b.renderer;
}

function resolveWebgl(
  device: DeviceSpec,
  preferred: WebGlPair | undefined,
  rand?: () => number,
): WebGlPair {
  if (preferred && device.webgl.some((w) => webglMatches(w, preferred))) {
    return preferred;
  }
  return rand ? pick(device.webgl, rand) : device.webgl[0]!;
}

/**
 * Thrown when a caller-supplied fingerprint field is present but invalid.
 * MCP maps this to INVALID_INPUT — profile must not be created/updated.
 */
export class FingerprintReconcileError extends Error {
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`Invalid fingerprint.${field}: ${reason}`);
    this.name = "FingerprintReconcileError";
    this.field = field;
    this.reason = reason;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Locale groups — geographically coherent locale + timezones + country.
// ─────────────────────────────────────────────────────────────────────────

interface LocaleGroup {
  /** Stable id for UI selection */
  id: string;
  label: string;
  locale: string;
  /** Languages array: starts with `locale`, expands to base */
  languages: string[];
  /** ISO 3166-1 alpha-2 */
  country: string;
  /** Plausible IANA timezones for this locale's country */
  timezones: ReadonlyArray<string>;
}

const LOCALES: ReadonlyArray<LocaleGroup> = [
  {
    id: "en-US",
    label: "English (United States)",
    locale: "en-US",
    languages: ["en-US", "en"],
    country: "us",
    timezones: [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
    ],
  },
  {
    id: "en-GB",
    label: "English (United Kingdom)",
    locale: "en-GB",
    languages: ["en-GB", "en"],
    country: "gb",
    timezones: ["Europe/London"],
  },
  {
    id: "en-CA",
    label: "English (Canada)",
    locale: "en-CA",
    languages: ["en-CA", "en"],
    country: "ca",
    timezones: ["America/Toronto", "America/Vancouver"],
  },
  {
    id: "en-AU",
    label: "English (Australia)",
    locale: "en-AU",
    languages: ["en-AU", "en"],
    country: "au",
    timezones: ["Australia/Sydney", "Australia/Melbourne", "Australia/Perth"],
  },
  {
    id: "en-IN",
    label: "English (India)",
    locale: "en-IN",
    languages: ["en-IN", "en"],
    country: "in",
    timezones: ["Asia/Kolkata"],
  },
  {
    id: "de-DE",
    label: "Deutsch (Deutschland)",
    locale: "de-DE",
    languages: ["de-DE", "de", "en"],
    country: "de",
    timezones: ["Europe/Berlin"],
  },
  {
    id: "fr-FR",
    label: "Français (France)",
    locale: "fr-FR",
    languages: ["fr-FR", "fr", "en"],
    country: "fr",
    timezones: ["Europe/Paris"],
  },
  {
    id: "es-ES",
    label: "Español (España)",
    locale: "es-ES",
    languages: ["es-ES", "es", "en"],
    country: "es",
    timezones: ["Europe/Madrid"],
  },
  {
    id: "es-MX",
    label: "Español (México)",
    locale: "es-MX",
    languages: ["es-MX", "es", "en"],
    country: "mx",
    timezones: ["America/Mexico_City"],
  },
  {
    id: "pt-BR",
    label: "Português (Brasil)",
    locale: "pt-BR",
    languages: ["pt-BR", "pt", "en"],
    country: "br",
    timezones: ["America/Sao_Paulo"],
  },
  {
    id: "it-IT",
    label: "Italiano (Italia)",
    locale: "it-IT",
    languages: ["it-IT", "it", "en"],
    country: "it",
    timezones: ["Europe/Rome"],
  },
  {
    id: "nl-NL",
    label: "Nederlands",
    locale: "nl-NL",
    languages: ["nl-NL", "nl", "en"],
    country: "nl",
    timezones: ["Europe/Amsterdam"],
  },
  {
    id: "ja-JP",
    label: "日本語 (日本)",
    locale: "ja-JP",
    languages: ["ja-JP", "ja", "en"],
    country: "jp",
    timezones: ["Asia/Tokyo"],
  },
  {
    id: "ko-KR",
    label: "한국어 (대한민국)",
    locale: "ko-KR",
    languages: ["ko-KR", "ko", "en"],
    country: "kr",
    timezones: ["Asia/Seoul"],
  },
  {
    id: "zh-CN",
    label: "中文 (简体, 中国)",
    locale: "zh-CN",
    languages: ["zh-CN", "zh", "en"],
    country: "cn",
    timezones: ["Asia/Shanghai"],
  },
  {
    id: "zh-TW",
    label: "中文 (繁體, 台灣)",
    locale: "zh-TW",
    languages: ["zh-TW", "zh", "en"],
    country: "tw",
    timezones: ["Asia/Taipei"],
  },
  {
    id: "ru-RU",
    label: "Русский (Россия)",
    locale: "ru-RU",
    languages: ["ru-RU", "ru", "en"],
    country: "ru",
    timezones: ["Europe/Moscow"],
  },
  {
    id: "tr-TR",
    label: "Türkçe (Türkiye)",
    locale: "tr-TR",
    languages: ["tr-TR", "tr", "en"],
    country: "tr",
    timezones: ["Europe/Istanbul"],
  },
  // ── Europe ──────────────────────────────────────────────────────────
  {
    id: "en-IE",
    label: "English (Ireland)",
    locale: "en-IE",
    languages: ["en-IE", "en"],
    country: "ie",
    timezones: ["Europe/Dublin"],
  },
  {
    id: "fr-LU",
    label: "Français (Luxembourg)",
    locale: "fr-LU",
    languages: ["fr-LU", "fr", "de", "en"],
    country: "lu",
    timezones: ["Europe/Luxembourg"],
  },
  {
    id: "de-LU",
    label: "Deutsch (Luxemburg)",
    locale: "de-LU",
    languages: ["de-LU", "de", "fr", "en"],
    country: "lu",
    timezones: ["Europe/Luxembourg"],
  },
  {
    id: "nl-BE",
    label: "Nederlands (België)",
    locale: "nl-BE",
    languages: ["nl-BE", "nl", "fr", "en"],
    country: "be",
    timezones: ["Europe/Brussels"],
  },
  {
    id: "fr-BE",
    label: "Français (Belgique)",
    locale: "fr-BE",
    languages: ["fr-BE", "fr", "nl", "en"],
    country: "be",
    timezones: ["Europe/Brussels"],
  },
  {
    id: "de-CH",
    label: "Deutsch (Schweiz)",
    locale: "de-CH",
    languages: ["de-CH", "de", "fr", "en"],
    country: "ch",
    timezones: ["Europe/Zurich"],
  },
  {
    id: "fr-CH",
    label: "Français (Suisse)",
    locale: "fr-CH",
    languages: ["fr-CH", "fr", "de", "en"],
    country: "ch",
    timezones: ["Europe/Zurich"],
  },
  {
    id: "it-CH",
    label: "Italiano (Svizzera)",
    locale: "it-CH",
    languages: ["it-CH", "it", "de", "en"],
    country: "ch",
    timezones: ["Europe/Zurich"],
  },
  {
    id: "de-AT",
    label: "Deutsch (Österreich)",
    locale: "de-AT",
    languages: ["de-AT", "de", "en"],
    country: "at",
    timezones: ["Europe/Vienna"],
  },
  {
    id: "pt-PT",
    label: "Português (Portugal)",
    locale: "pt-PT",
    languages: ["pt-PT", "pt", "en"],
    country: "pt",
    timezones: ["Europe/Lisbon"],
  },
  {
    id: "el-GR",
    label: "Ελληνικά (Ελλάδα)",
    locale: "el-GR",
    languages: ["el-GR", "el", "en"],
    country: "gr",
    timezones: ["Europe/Athens"],
  },
  {
    id: "pl-PL",
    label: "Polski (Polska)",
    locale: "pl-PL",
    languages: ["pl-PL", "pl", "en"],
    country: "pl",
    timezones: ["Europe/Warsaw"],
  },
  {
    id: "cs-CZ",
    label: "Čeština (Česko)",
    locale: "cs-CZ",
    languages: ["cs-CZ", "cs", "en"],
    country: "cz",
    timezones: ["Europe/Prague"],
  },
  {
    id: "sk-SK",
    label: "Slovenčina (Slovensko)",
    locale: "sk-SK",
    languages: ["sk-SK", "sk", "en"],
    country: "sk",
    timezones: ["Europe/Bratislava"],
  },
  {
    id: "hu-HU",
    label: "Magyar (Magyarország)",
    locale: "hu-HU",
    languages: ["hu-HU", "hu", "en"],
    country: "hu",
    timezones: ["Europe/Budapest"],
  },
  {
    id: "ro-RO",
    label: "Română (România)",
    locale: "ro-RO",
    languages: ["ro-RO", "ro", "en"],
    country: "ro",
    timezones: ["Europe/Bucharest"],
  },
  {
    id: "bg-BG",
    label: "Български (България)",
    locale: "bg-BG",
    languages: ["bg-BG", "bg", "en"],
    country: "bg",
    timezones: ["Europe/Sofia"],
  },
  {
    id: "hr-HR",
    label: "Hrvatski (Hrvatska)",
    locale: "hr-HR",
    languages: ["hr-HR", "hr", "en"],
    country: "hr",
    timezones: ["Europe/Zagreb"],
  },
  {
    id: "sl-SI",
    label: "Slovenščina (Slovenija)",
    locale: "sl-SI",
    languages: ["sl-SI", "sl", "en"],
    country: "si",
    timezones: ["Europe/Ljubljana"],
  },
  {
    id: "sr-RS",
    label: "Srpski (Srbija)",
    locale: "sr-RS",
    languages: ["sr-RS", "sr", "en"],
    country: "rs",
    timezones: ["Europe/Belgrade"],
  },
  {
    id: "uk-UA",
    label: "Українська (Україна)",
    locale: "uk-UA",
    languages: ["uk-UA", "uk", "ru", "en"],
    country: "ua",
    timezones: ["Europe/Kyiv"],
  },
  {
    id: "fi-FI",
    label: "Suomi (Suomi)",
    locale: "fi-FI",
    languages: ["fi-FI", "fi", "sv", "en"],
    country: "fi",
    timezones: ["Europe/Helsinki"],
  },
  {
    id: "sv-SE",
    label: "Svenska (Sverige)",
    locale: "sv-SE",
    languages: ["sv-SE", "sv", "en"],
    country: "se",
    timezones: ["Europe/Stockholm"],
  },
  {
    id: "da-DK",
    label: "Dansk (Danmark)",
    locale: "da-DK",
    languages: ["da-DK", "da", "en"],
    country: "dk",
    timezones: ["Europe/Copenhagen"],
  },
  {
    id: "nb-NO",
    label: "Norsk bokmål (Norge)",
    locale: "nb-NO",
    languages: ["nb-NO", "nb", "no", "en"],
    country: "no",
    timezones: ["Europe/Oslo"],
  },
  {
    id: "et-EE",
    label: "Eesti (Eesti)",
    locale: "et-EE",
    languages: ["et-EE", "et", "en"],
    country: "ee",
    timezones: ["Europe/Tallinn"],
  },
  {
    id: "lv-LV",
    label: "Latviešu (Latvija)",
    locale: "lv-LV",
    languages: ["lv-LV", "lv", "en"],
    country: "lv",
    timezones: ["Europe/Riga"],
  },
  {
    id: "lt-LT",
    label: "Lietuvių (Lietuva)",
    locale: "lt-LT",
    languages: ["lt-LT", "lt", "en"],
    country: "lt",
    timezones: ["Europe/Vilnius"],
  },
  {
    id: "is-IS",
    label: "Íslenska (Ísland)",
    locale: "is-IS",
    languages: ["is-IS", "is", "en"],
    country: "is",
    timezones: ["Atlantic/Reykjavik"],
  },
  {
    id: "mt-MT",
    label: "Malti (Malta)",
    locale: "mt-MT",
    languages: ["mt-MT", "mt", "en"],
    country: "mt",
    timezones: ["Europe/Malta"],
  },
  // ── Middle East / Africa ───────────────────────────────────────────
  {
    id: "he-IL",
    label: "עברית (ישראל)",
    locale: "he-IL",
    languages: ["he-IL", "he", "en"],
    country: "il",
    timezones: ["Asia/Jerusalem"],
  },
  {
    id: "ar-AE",
    label: "العربية (الإمارات)",
    locale: "ar-AE",
    languages: ["ar-AE", "ar", "en"],
    country: "ae",
    timezones: ["Asia/Dubai"],
  },
  {
    id: "ar-SA",
    label: "العربية (السعودية)",
    locale: "ar-SA",
    languages: ["ar-SA", "ar", "en"],
    country: "sa",
    timezones: ["Asia/Riyadh"],
  },
  {
    id: "ar-EG",
    label: "العربية (مصر)",
    locale: "ar-EG",
    languages: ["ar-EG", "ar", "en"],
    country: "eg",
    timezones: ["Africa/Cairo"],
  },
  {
    id: "ar-MA",
    label: "العربية (المغرب)",
    locale: "ar-MA",
    languages: ["ar-MA", "ar", "fr", "en"],
    country: "ma",
    timezones: ["Africa/Casablanca"],
  },
  {
    id: "en-ZA",
    label: "English (South Africa)",
    locale: "en-ZA",
    languages: ["en-ZA", "en"],
    country: "za",
    timezones: ["Africa/Johannesburg"],
  },
  {
    id: "en-NG",
    label: "English (Nigeria)",
    locale: "en-NG",
    languages: ["en-NG", "en"],
    country: "ng",
    timezones: ["Africa/Lagos"],
  },
  {
    id: "en-KE",
    label: "English (Kenya)",
    locale: "en-KE",
    languages: ["en-KE", "en", "sw"],
    country: "ke",
    timezones: ["Africa/Nairobi"],
  },
  // ── South Asia ─────────────────────────────────────────────────────
  {
    id: "en-PK",
    label: "English (Pakistan)",
    locale: "en-PK",
    languages: ["en-PK", "en", "ur"],
    country: "pk",
    timezones: ["Asia/Karachi"],
  },
  {
    id: "bn-BD",
    label: "বাংলা (বাংলাদেশ)",
    locale: "bn-BD",
    languages: ["bn-BD", "bn", "en"],
    country: "bd",
    timezones: ["Asia/Dhaka"],
  },
  // ── Asia / Pacific ─────────────────────────────────────────────────
  {
    id: "th-TH",
    label: "ไทย (ประเทศไทย)",
    locale: "th-TH",
    languages: ["th-TH", "th", "en"],
    country: "th",
    timezones: ["Asia/Bangkok"],
  },
  {
    id: "km-KH",
    label: "ភាសាខ្មែរ (កម្ពុជា)",
    locale: "km-KH",
    languages: ["km-KH", "km", "en"],
    country: "kh",
    timezones: ["Asia/Phnom_Penh"],
  },
  {
    id: "vi-VN",
    label: "Tiếng Việt (Việt Nam)",
    locale: "vi-VN",
    languages: ["vi-VN", "vi", "en"],
    country: "vn",
    timezones: ["Asia/Ho_Chi_Minh"],
  },
  {
    id: "id-ID",
    label: "Bahasa Indonesia",
    locale: "id-ID",
    languages: ["id-ID", "id", "en"],
    country: "id",
    timezones: ["Asia/Jakarta"],
  },
  {
    id: "ms-MY",
    label: "Bahasa Melayu (Malaysia)",
    locale: "ms-MY",
    languages: ["ms-MY", "ms", "en"],
    country: "my",
    timezones: ["Asia/Kuala_Lumpur"],
  },
  {
    id: "en-PH",
    label: "English (Philippines)",
    locale: "en-PH",
    languages: ["en-PH", "en", "tl"],
    country: "ph",
    timezones: ["Asia/Manila"],
  },
  {
    id: "en-SG",
    label: "English (Singapore)",
    locale: "en-SG",
    languages: ["en-SG", "en"],
    country: "sg",
    timezones: ["Asia/Singapore"],
  },
  {
    id: "zh-HK",
    label: "中文 (香港)",
    locale: "zh-HK",
    languages: ["zh-HK", "zh", "en"],
    country: "hk",
    timezones: ["Asia/Hong_Kong"],
  },
  {
    id: "en-NZ",
    label: "English (New Zealand)",
    locale: "en-NZ",
    languages: ["en-NZ", "en"],
    country: "nz",
    timezones: ["Pacific/Auckland"],
  },
  // ── Latin America ──────────────────────────────────────────────────
  {
    id: "es-AR",
    label: "Español (Argentina)",
    locale: "es-AR",
    languages: ["es-AR", "es", "en"],
    country: "ar",
    timezones: ["America/Argentina/Buenos_Aires"],
  },
  {
    id: "es-CL",
    label: "Español (Chile)",
    locale: "es-CL",
    languages: ["es-CL", "es", "en"],
    country: "cl",
    timezones: ["America/Santiago"],
  },
  {
    id: "es-CO",
    label: "Español (Colombia)",
    locale: "es-CO",
    languages: ["es-CO", "es", "en"],
    country: "co",
    timezones: ["America/Bogota"],
  },
  {
    id: "es-PE",
    label: "Español (Perú)",
    locale: "es-PE",
    languages: ["es-PE", "es", "en"],
    country: "pe",
    timezones: ["America/Lima"],
  },
  {
    id: "es-BO",
    label: "Español (Bolivia)",
    locale: "es-BO",
    languages: ["es-BO", "es", "en"],
    country: "bo",
    timezones: ["America/La_Paz"],
  },
];

/**
 * Map an ISO 3166-1 alpha-2 country code to a locale group id, with
 * sensible fallbacks for multilingual countries that have several locale
 * entries (preference is the most common browser locale we'd expect to
 * see). Returns null if no locale fits.
 */
export function findLocaleIdByCountry(cc: string): string | null {
  const found = findLocaleByCountry(cc);
  return found?.id ?? null;
}

function findLocaleByCountry(cc: string): LocaleGroup | null {
  const lower = cc.toLowerCase();
  // Exact preferred locale per multilingual country. The country has more
  // than one locale entry above; this picks the dominant one.
  const PREFERRED_BY_CC: Record<string, string> = {
    lu: "fr-LU", // Luxembourg: French is primary administrative language
    be: "nl-BE", // Belgium: Dutch slightly more populous than French
    ch: "de-CH", // Switzerland: German-speaking majority
    ca: "en-CA", // Canada: anglo majority
    // Country with no exact locale entry but a dominant linguistic neighbour:
    li: "de-DE", // Liechtenstein → German
    sm: "it-IT", // San Marino → Italian
    mc: "fr-FR", // Monaco → French
    ad: "es-ES", // Andorra → Spanish (Catalan unrepresented in our list)
    cy: "el-GR", // Cyprus → Greek
    al: "en-US", // Albania has no entry; default English
    by: "ru-RU", // Belarus → Russian
    kz: "ru-RU", // Kazakhstan → Russian (most common online)
    md: "ro-RO", // Moldova → Romanian
    me: "sr-RS", // Montenegro → Serbian (close to Montenegrin)
    mk: "sr-RS", // North Macedonia → Serbian (closest Slavic)
    ba: "hr-HR", // Bosnia & Herzegovina → Croatian
    xk: "sr-RS", // Kosovo → Serbian
  };
  const preferredId = PREFERRED_BY_CC[lower];
  if (preferredId) {
    const match = LOCALES.find((l) => l.id === preferredId);
    if (match) return match;
  }
  // Default: first locale whose country code matches.
  return LOCALES.find((l) => l.country === lower) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Public catalogs (for UI)
// ─────────────────────────────────────────────────────────────────────────

export interface DeviceCatalogEntry {
  family: DeviceFamily;
  label: string;
  screens: ReadonlyArray<{ width: number; height: number; label: string }>;
}

export interface LocaleCatalogEntry {
  id: string;
  label: string;
  locale: string;
  country: string;
  timezones: ReadonlyArray<string>;
}

export function deviceCatalog(): ReadonlyArray<DeviceCatalogEntry> {
  return DEVICES.map((d) => ({
    family: d.family,
    label: d.label,
    screens: d.screens,
  }));
}

export function localeCatalog(): ReadonlyArray<LocaleCatalogEntry> {
  return LOCALES.map((l) => ({
    id: l.id,
    label: l.label,
    locale: l.locale,
    country: l.country,
    timezones: l.timezones,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Generator
// ─────────────────────────────────────────────────────────────────────────

export interface GenerateFingerprintOptions {
  /**
   * When true (default), restrict the device pool to the host OS family.
   * Set false for CloakBrowser-style cross-OS spoof tests (full Windows/Mac/Linux
   * catalog) — CFT still needs hostFilter true at runtime.
   */
  hostFilter?: boolean;
}

/**
 * Generate a coherent fingerprint preset.
 *
 * If `seed` is provided, the result is deterministic — useful so existing
 * profiles get a stable fingerprint on every read.
 */
export function generateFingerprint(
  seed?: string,
  opts: GenerateFingerprintOptions = {},
): FingerprintConfig {
  const rand = seed ? seededRand(seed) : Math.random;
  // Device family must match the host OS — claiming Windows on a Mac
  // binary is detectable via V8/Blink/CSS-feature signatures (browserscan,
  // FingerprintJS, DataDome all compare actual platform behaviour vs the
  // claimed UA platform). CloakBrowser can spoof cross-OS natively; pass
  // `{ hostFilter: false }` for full-catalog diversity tests.
  const hostFamily = hostPlatformFamily();
  const candidates =
    opts.hostFilter === false
      ? DEVICES
      : DEVICES.filter((d) => deviceMatchesHost(d, hostFamily));
  const device = pick(candidates.length > 0 ? candidates : DEVICES, rand);
  const locale = pick(LOCALES, rand);
  const screen = pick(device.screens, rand);
  const tz = pick(locale.timezones, rand);
  const hwc = pick(device.hardwareConcurrency, rand);
  const mem = pick(device.deviceMemory, rand);
  const webgl = pick(device.webgl, rand);

  return assemble(device, locale, screen, tz, hwc, mem, webgl);
}

/** Returns "mac" | "windows" | "linux" for the running Node/Electron host. */
export function hostPlatformFamily(): "mac" | "windows" | "linux" {
  if (typeof process !== "undefined" && process.platform) {
    if (process.platform === "darwin") return "mac";
    if (process.platform === "win32") return "windows";
  }
  return "linux";
}

function deviceMatchesHost(
  d: DeviceSpec,
  host: ReturnType<typeof hostPlatformFamily>,
): boolean {
  // Device family naming convention in DEVICES is "<os>-<form>-<gpu>",
  // e.g. "macbook-pro-14-m3", "windows-laptop-intel", "linux-desktop-intel".
  if (host === "mac") return d.family.startsWith("mac") || d.family.startsWith("imac");
  if (host === "windows") return d.family.startsWith("windows");
  return d.family.startsWith("linux");
}

/**
 * Reconcile a fingerprint's device family to match the host OS we're
 * running on, preserving locale + timezone where possible. Used at
 * launch to auto-fix profiles created on a different host or with the
 * old "any device" generator.
 *
 * Why: claiming Windows 11 while running a macOS Chromium binary is
 * detectable via V8/Blink/CSS feature signatures. The only safe match
 * for stock binaries is "device family == host family".
 */
export function reconcileDeviceFamilyToHost(
  fp: FingerprintConfig,
): FingerprintConfig {
  const host = hostPlatformFamily();
  const currentDevice = DEVICES.find((d) => d.family === fp.device);
  if (currentDevice && deviceMatchesHost(currentDevice, host)) return fp;

  // Pick a deterministic device for this profile so the choice is stable
  // across launches (locale/timezone get preserved).
  const candidates = DEVICES.filter((d) => deviceMatchesHost(d, host));
  if (candidates.length === 0) return fp;
  // Use UA hash as seed so the same profile always lands on the same
  // replacement device.
  const seed = stringHash(fp.userAgent + fp.locale);
  const device = candidates[seed % candidates.length]!;

  const screen =
    device.screens.find(
      (s) => s.width === fp.screen.width && s.height === fp.screen.height,
    ) ?? device.screens[0]!;
  const locale =
    LOCALES.find((l) => l.locale === fp.locale) ?? LOCALES[0]!;
  const tz = locale.timezones.includes(fp.timezone)
    ? fp.timezone
    : locale.timezones[0]!;
  const hwc = device.hardwareConcurrency.includes(fp.hardwareConcurrency)
    ? fp.hardwareConcurrency
    : device.hardwareConcurrency[0]!;
  const mem = device.deviceMemory.includes(fp.deviceMemory)
    ? fp.deviceMemory
    : device.deviceMemory[0]!;
  const webgl = resolveWebgl(device, fp.webgl);

  const next = assemble(device, locale, screen, tz, hwc, mem, webgl);
  return fp.seed ? { ...next, seed: fp.seed } : next;
}

function stringHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h | 0);
}

/** Backwards-compat: deterministic fingerprint for an existing profile id. */
export function defaultFingerprint(seed: string): FingerprintConfig {
  return generateFingerprint(seed);
}

/**
 * Apply user overrides while preserving as much coherence as possible.
 * If the user changes `device`, screens are constrained to that device.
 * If the user changes `locale`, timezone is constrained to that locale.
 */
export function reconcileFingerprint(
  current: FingerprintConfig,
  patch: Partial<{
    device: DeviceFamily;
    localeId: string;
    screen: { width: number; height: number };
    timezone: string;
    hardwareConcurrency: number;
    deviceMemory: number;
  }>,
): FingerprintConfig {
  const hostFamily = hostPlatformFamily();

  // ── Locale ──────────────────────────────────────────────────────────
  let locale: LocaleGroup;
  if (patch.localeId !== undefined) {
    const found = LOCALES.find((l) => l.id === patch.localeId);
    if (!found) {
      throw new FingerprintReconcileError(
        "localeId",
        `unknown localeId '${patch.localeId}' (see list_fingerprint_options)`,
      );
    }
    locale = found;
  } else {
    locale =
      LOCALES.find((l) => l.locale === current.locale) ?? LOCALES[0]!;
  }

  // ── Device ──────────────────────────────────────────────────────────
  let device: DeviceSpec;
  if (patch.device !== undefined) {
    const found = DEVICES.find((d) => d.family === patch.device);
    if (!found) {
      throw new FingerprintReconcileError(
        "device",
        `unknown device family '${patch.device}'`,
      );
    }
    device = found;
  } else {
    device =
      DEVICES.find((d) => d.family === current.device) ??
      DEVICES.find((d) => deviceMatchesHost(d, hostFamily)) ??
      DEVICES[0]!;
  }

  // ── Screen ──────────────────────────────────────────────────────────
  let screen: { width: number; height: number };
  if (patch.screen !== undefined) {
    const key = screenKey(patch.screen);
    if (!ALLOWED_DESKTOP_SCREENS.has(key)) {
      throw new FingerprintReconcileError(
        "screen",
        `${patch.screen.width}x${patch.screen.height} is not an allowed desktop size`,
      );
    }
    screen = { width: patch.screen.width, height: patch.screen.height };
    // Ensure a host-compatible desktop device that owns this screen.
    const ownsScreen = (d: DeviceSpec) =>
      d.screens.some((s) => s.width === screen.width && s.height === screen.height);
    if (!ownsScreen(device)) {
      const hostCandidates = DEVICES.filter(
        (d) => deviceMatchesHost(d, hostFamily) && ownsScreen(d),
      );
      const anyCandidates = DEVICES.filter(ownsScreen);
      const next =
        hostCandidates[0] ??
        anyCandidates[0] ??
        null;
      if (!next) {
        throw new FingerprintReconcileError(
          "screen",
          `${key} accepted but no device can own that screen`,
        );
      }
      // Only auto-switch device when caller did not pin device.
      if (patch.device === undefined) {
        device = next;
      } else {
        throw new FingerprintReconcileError(
          "screen",
          `${key} is not valid for device '${device.family}'`,
        );
      }
    }
  } else {
    const requested = current.screen;
    screen =
      device.screens.find(
        (s) => s.width === requested.width && s.height === requested.height,
      ) ?? device.screens[0]!;
  }

  // Desktop screen ⇒ desktop UA (all our devices are desktop; assert width).
  if (screen.width >= 1280) {
    const mobileUa =
      /iPhone|Android|Mobile/i.test(device.uaPlatformToken) ||
      device.navigatorPlatform === ("iPhone" as never);
    if (mobileUa) {
      throw new FingerprintReconcileError(
        "screen",
        `desktop screen ${screenKey(screen)} is incoherent with mobile device`,
      );
    }
  }

  // ── Timezone ────────────────────────────────────────────────────────
  let timezone: string;
  if (patch.timezone !== undefined) {
    if (!locale.timezones.includes(patch.timezone)) {
      throw new FingerprintReconcileError(
        "timezone",
        `'${patch.timezone}' is not valid for locale '${locale.id}' (allowed: ${locale.timezones.join(", ")})`,
      );
    }
    timezone = patch.timezone;
  } else {
    timezone = locale.timezones.includes(current.timezone)
      ? current.timezone
      : locale.timezones[0]!;
  }

  // ── CPU / RAM ───────────────────────────────────────────────────────
  let hardwareConcurrency: number;
  if (patch.hardwareConcurrency !== undefined) {
    if (!isAllowedHwc(patch.hardwareConcurrency, device)) {
      throw new FingerprintReconcileError(
        "hardwareConcurrency",
        `${patch.hardwareConcurrency} is not an allowed value`,
      );
    }
    hardwareConcurrency = patch.hardwareConcurrency;
  } else {
    hardwareConcurrency = device.hardwareConcurrency.includes(
      current.hardwareConcurrency,
    )
      ? current.hardwareConcurrency
      : device.hardwareConcurrency[0]!;
  }

  let deviceMemory: number;
  if (patch.deviceMemory !== undefined) {
    if (!isAllowedMem(patch.deviceMemory, device)) {
      throw new FingerprintReconcileError(
        "deviceMemory",
        `${patch.deviceMemory} is not an allowed value`,
      );
    }
    deviceMemory = patch.deviceMemory;
  } else {
    deviceMemory = device.deviceMemory.includes(current.deviceMemory)
      ? current.deviceMemory
      : device.deviceMemory[0]!;
  }

  const webgl = resolveWebgl(device, current.webgl);
  const next = assemble(
    device,
    locale,
    screen,
    timezone,
    hardwareConcurrency,
    deviceMemory,
    webgl,
  );
  return current.seed ? { ...next, seed: current.seed } : next;
}

function assemble(
  device: DeviceSpec,
  locale: LocaleGroup,
  screen: { width: number; height: number },
  timezone: string,
  hardwareConcurrency: number,
  deviceMemory: number,
  webgl: WebGlPair,
): FingerprintConfig {
  const userAgent = buildUserAgent(device);
  const clientHints = buildClientHints(device);
  const acceptLanguage = buildAcceptLanguage(locale.languages);

  return {
    device: device.family,
    userAgent,
    platform: device.navigatorPlatform,
    clientHints,
    locale: locale.locale,
    languages: [...locale.languages],
    acceptLanguage,
    timezone,
    country: locale.country,
    screen: { width: screen.width, height: screen.height },
    availScreen: defaultAvail(screen, device.navigatorPlatform),
    dpr: device.dpr,
    webgl: { vendor: webgl.vendor, renderer: webgl.renderer },
    hardwareConcurrency,
    deviceMemory,
  };
}

function buildUserAgent(device: DeviceSpec): string {
  return `Mozilla/5.0 (${device.uaPlatformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION_FULL} Safari/537.36`;
}

function buildClientHints(device: DeviceSpec): ClientHints {
  // Chromium's GREASE pattern — randomised "Not?A_Brand" entry to discourage
  // brand allowlisting. The actual GREASE token rotates per Chromium build;
  // we use a stable one. If a detector compares to live Chrome, this is a
  // potential mismatch — the patched-Chromium build will randomise it.
  const grease = '"Not?A_Brand";v="99"';
  const secChUa = `"Chromium";v="${CHROME_VERSION_MAJOR}", "Google Chrome";v="${CHROME_VERSION_MAJOR}", ${grease}`;
  const secChUaFullVersionList = `"Chromium";v="${CHROME_VERSION_FULL}", "Google Chrome";v="${CHROME_VERSION_FULL}", ${grease}`;

  return {
    secChUa,
    secChUaPlatform: device.secChUaPlatform,
    secChUaPlatformVersion: device.secChUaPlatformVersion,
    secChUaArch: device.secChUaArch,
    secChUaBitness: device.secChUaBitness,
    secChUaMobile: "?0",
    secChUaModel: "",
    secChUaFullVersionList,
  };
}

function buildAcceptLanguage(languages: string[]): string {
  // Chrome formats Accept-Language as `lang-region;q=0.9,lang;q=0.8`...
  if (languages.length === 0) return "en-US";
  const parts: string[] = [languages[0]!];
  let q = 0.9;
  for (let i = 1; i < languages.length; i++) {
    parts.push(`${languages[i]};q=${q.toFixed(1)}`);
    q -= 0.1;
    if (q < 0.1) q = 0.1;
  }
  return parts.join(",");
}

function defaultAvail(
  screen: { width: number; height: number },
  platform: "MacIntel" | "Win32" | "Linux x86_64",
): { width: number; height: number } {
  // macOS dock: ~80px bottom; Win taskbar: ~40px bottom; Linux varies.
  const bottom =
    platform === "MacIntel" ? 80 : platform === "Win32" ? 40 : 30;
  return { width: screen.width, height: Math.max(0, screen.height - bottom) };
}

// ─────────────────────────────────────────────────────────────────────────
// Random utilities
// ─────────────────────────────────────────────────────────────────────────

function pick<T>(items: ReadonlyArray<T>, rand: () => number): T {
  if (items.length === 0) throw new Error("pick() got empty array");
  const idx = Math.floor(rand() * items.length);
  return items[idx]!;
}

function seededRand(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    return state / 0xffffffff;
  };
}
