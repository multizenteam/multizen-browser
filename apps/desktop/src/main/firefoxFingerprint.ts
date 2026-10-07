import type { FingerprintConfig, Profile } from "@multizen/types";

function osForDevice(device: string): "windows" | "macos" | "linux" {
  if (device.startsWith("mac") || device.startsWith("imac")) return "macos";
  if (device.startsWith("windows")) return "windows";
  if (device.startsWith("linux")) return "linux";
  // Fall back to the host OS if the device family is somehow unset.
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

/**
 * Map a profile's ENGINE-NEUTRAL persona attributes to a Camoufox
 * `launchOptions` config. Chrome-specific fields (userAgent, clientHints /
 * Sec-CH-UA) are deliberately NOT mapped: Camoufox is Firefox, so it generates
 * its own coherent Firefox UA + headers for the chosen OS. Forcing a Chrome UA
 * onto Firefox would be an obvious tell — and camoufox-js rejects non-Firefox
 * fingerprints outright. BrowserForge fills in everything we don't pin.
 *
 *   os        ← device family            (windows | macos | linux)
 *   locale    ← the persona's PRIMARY locale, e.g. "en-US"
 *   screen.*  ← the persona's screen size (raw CAMOU_CONFIG keys)
 *   timezone  ← the persona's IANA tz, so Date/Intl match the persona, not host
 *
 * `locale` is passed as a SINGLE region-qualified string, not the languages
 * array: camoufox-js's handleLocales routes a bare language like "en" (≤3 chars)
 * through a territory lookup whose async unicode data (`SELECTOR.loadUnicodeInfo`)
 * launchOptions never awaits, so it crashes on `this.root`. A >3-char locale
 * takes the safe normalizeLocale path instead.
 *
 * Screen + timezone go through the raw `config` map (camoufox has no typed option
 * for exact values). MultiZen already generates a COHERENT persona (device→screen,
 * locale→tz), so we set them explicitly and pass i_know_what_im_doing to accept
 * camoufox's manual-override warnings rather than let it randomize the persona
 * away. (No `fingerprint` object is passed, so that flag doesn't relax anything
 * else.)
 */
export function camoufoxConfigForProfile(profile: Profile): Record<string, unknown> {
  const fp: FingerprintConfig = profile.fingerprint;
  return {
    os: osForDevice(fp.device),
    locale: fp.locale,
    i_know_what_im_doing: true,
    config: {
      "screen.width": fp.screen.width,
      "screen.height": fp.screen.height,
      timezone: fp.timezone,
    },
  };
}
