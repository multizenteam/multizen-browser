/**
 * Strict-pin launch timezone policy.
 *
 * Default: pinned `fingerprint.timezone` always wins. Proxy geo only feeds
 * WebRTC IP + geolocation coords. Opt-in `alignTimezoneToProxy` may overwrite
 * TZ only when the geo timezone is in the locale's allowlist.
 */

export interface LaunchTimezoneFingerprint {
  timezone: string;
  country: string;
}

export interface LaunchTimezoneGeo {
  timezone?: string;
  country?: string;
}

export interface LaunchTimezoneOptions {
  /** When true, apply geo TZ if it is in `localeTimezones`. Default false. */
  alignTimezoneToProxy?: boolean;
  /** When true, country mismatch between geo and fingerprint fails launch. */
  strictGeoCoherence?: boolean;
}

export interface LaunchTimezoneResult {
  timezone: string;
  warnings: string[];
  appliedGeoTimezone: boolean;
}

export class StrictGeoCoherenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictGeoCoherenceError";
  }
}

export function resolveLaunchTimezone(
  fp: LaunchTimezoneFingerprint,
  geo: LaunchTimezoneGeo | null | undefined,
  localeTimezones: readonly string[],
  opts: LaunchTimezoneOptions = {},
): LaunchTimezoneResult {
  const warnings: string[] = [];
  let timezone = fp.timezone;
  let appliedGeoTimezone = false;

  if (geo?.country) {
    const geoCountry = geo.country.toLowerCase();
    const fpCountry = fp.country.toLowerCase();
    if (geoCountry !== fpCountry) {
      const msg = `proxy geo country '${geoCountry}' ≠ fingerprint country '${fpCountry}'`;
      warnings.push(msg);
      if (opts.strictGeoCoherence) {
        throw new StrictGeoCoherenceError(msg);
      }
    }
  }

  if (opts.alignTimezoneToProxy && geo?.timezone) {
    if (localeTimezones.includes(geo.timezone)) {
      if (geo.timezone !== fp.timezone) {
        timezone = geo.timezone;
        appliedGeoTimezone = true;
      }
    } else if (geo.timezone !== fp.timezone) {
      warnings.push(
        `geo timezone '${geo.timezone}' not in locale allowlist [${localeTimezones.join(", ")}]; keeping pinned '${fp.timezone}'`,
      );
    }
  } else if (geo?.timezone && geo.timezone !== fp.timezone) {
    warnings.push(
      `keeping pinned timezone '${fp.timezone}' (geo reported '${geo.timezone}'; set alignTimezoneToProxy to opt in)`,
    );
  }

  return { timezone, warnings, appliedGeoTimezone };
}
