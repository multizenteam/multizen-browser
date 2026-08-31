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
 *   locale    ← navigator.languages      (typed `locale` param)
 *   screen.*  ← the persona's screen size (raw CAMOU_CONFIG keys)
 *   timezone  ← the persona's IANA tz, so Date/Intl match the persona, not host
 *
 * Screen and timezone go through the raw `config` map because camoufox exposes
 * no typed option for exact values; `screen.width`/`screen.height`/`timezone`
 * are recognized CAMOU_CONFIG properties, so this needs no i_know_what_im_doing.
 */
export function camoufoxConfigForProfile(profile: Profile): Record<string, unknown> {
  const fp: FingerprintConfig = profile.fingerprint;
  return {
    os: osForDevice(fp.device),
    locale: fp.languages.length > 0 ? fp.languages : [fp.locale],
    config: {
      "screen.width": fp.screen.width,
      "screen.height": fp.screen.height,
      timezone: fp.timezone,
    },
  };
}
