import { request } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { ProxyConfig } from "@multizen/types";

/**
 * Result of probing a proxy for its public IP geolocation.
 *
 * Used to verify that a profile's locale + timezone are coherent with the
 * proxy IP's country — detection vendors flag mismatches like
 * "Accept-Language: ru-RU + IP in US".
 */
export interface ProxyGeoResult {
  country: string;
  countryName: string;
  timezone: string;
  city: string;
  ip: string;
  /** Egress IP coordinates — fed into CloakBrowser's --fingerprint-location
   *  so navigator.geolocation reports the proxy's geo, matching the IP. */
  latitude?: number;
  longitude?: number;
}

/** A geo lookup endpoint + a parser that normalizes its (provider-specific)
 *  JSON shape into a {@link ProxyGeoResult}, or null if the payload is
 *  unusable (rate-limited, error object, missing country/timezone). */
interface GeoProvider {
  name: string;
  url: string;
  parse: (raw: unknown) => ProxyGeoResult | null;
}

/**
 * Providers are tried in order until one returns a usable result. All are
 * free, keyless, HTTPS, and return an IANA timezone + country code + lat/lon
 * (the fields we actually need). Formats differ, so each has its own parser —
 * response shapes verified live 2026-07-31:
 *   - ipapi.co:  country_code, country_name, timezone (string), latitude/longitude (num)
 *   - ipwho.is:  country_code, country, timezone.id (OBJECT), latitude/longitude (num), success flag
 *   - ipinfo.io: country (cc), timezone (string), loc "lat,lng" (string), city
 *   - geojs:     country_code, country, timezone (string), latitude/longitude (STRINGS)
 * ipapi.co is primary (richest) but rate-limits aggressively, hence the chain.
 */
const PROVIDERS: readonly GeoProvider[] = [
  { name: "ipapi.co", url: "https://ipapi.co/json/", parse: parseIpapi },
  { name: "ipwho.is", url: "https://ipwho.is/", parse: parseIpwho },
  { name: "ipinfo.io", url: "https://ipinfo.io/json", parse: parseIpinfo },
  { name: "geojs.io", url: "https://get.geojs.io/v1/ip/geo.json", parse: parseGeojs },
];

/**
 * Probe the supplied proxy for its egress IP geolocation. Tries several geo
 * providers in order (see {@link PROVIDERS}) and returns the first usable
 * result, so a single provider being down or rate-limited doesn't break the
 * locale/timezone coherence check. Uses Node's built-in `https.request` with
 * `https-proxy-agent` / `socks-proxy-agent` (Electron's bundled Node lacks the
 * latest undici APIs).
 */
export async function probeProxyGeo(
  proxy: ProxyConfig,
  opts: { timeoutMs?: number } = {},
): Promise<ProxyGeoResult> {
  const proxyUrl = buildProxyUrl(proxy);
  const agent =
    proxy.type === "socks5" ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
  const timeoutMs = opts.timeoutMs ?? 10000;
  // `timeoutMs` bounds the WHOLE probe, not each provider. Each provider gets
  // only the remaining budget, so a dead/black-holing proxy can't stall the
  // caller for N× the timeout (this runs synchronously in the launch path).
  // A provider that fails fast (HTTP error, bad payload) still leaves budget
  // for the next one, preserving the fallback for the common case.
  const deadline = Date.now() + timeoutMs;

  const errors: string[] = [];
  for (const provider of PROVIDERS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      errors.push(`${provider.name}: skipped (probe deadline reached)`);
      break;
    }
    try {
      const raw = await fetchJson(provider.url, agent, remaining);
      const result = provider.parse(raw);
      if (result) return result;
      errors.push(`${provider.name}: unexpected payload`);
    } catch (e) {
      errors.push(`${provider.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`all geo providers failed through the proxy — ${errors.join("; ")}`);
}

/** GET a URL through the proxy agent and parse the JSON body. */
function fetchJson(url: string, agent: HttpsProxyAgent<string> | SocksProxyAgent, timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const req = request(
      url,
      {
        agent,
        method: "GET",
        headers: {
          "user-agent": "MultiZen/0.3 (proxy-geo-probe)",
          accept: "application/json",
        },
      },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(new Error(`invalid JSON: ${(e as Error).message}`));
          }
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

// ── per-provider parsers (each normalizes to ProxyGeoResult) ────────────────

function parseIpapi(raw: unknown): ProxyGeoResult | null {
  const d = asObj(raw);
  if (!d || d.error) return null;
  const country = cc(d.country_code);
  const timezone = str(d.timezone);
  if (!country || !timezone) return null;
  return {
    country,
    countryName: str(d.country_name) ?? country.toUpperCase(),
    timezone,
    city: str(d.city) ?? "",
    ip: str(d.ip) ?? "",
    latitude: num(d.latitude),
    longitude: num(d.longitude),
  };
}

function parseIpwho(raw: unknown): ProxyGeoResult | null {
  const d = asObj(raw);
  if (!d || d.success === false) return null;
  const country = cc(d.country_code);
  // ipwho.is nests the IANA id under `timezone.id`.
  const tz = asObj(d.timezone);
  const timezone = str(tz?.id);
  if (!country || !timezone) return null;
  return {
    country,
    countryName: str(d.country) ?? country.toUpperCase(),
    timezone,
    city: str(d.city) ?? "",
    ip: str(d.ip) ?? "",
    latitude: num(d.latitude),
    longitude: num(d.longitude),
  };
}

function parseIpinfo(raw: unknown): ProxyGeoResult | null {
  const d = asObj(raw);
  if (!d) return null;
  const country = cc(d.country);
  const timezone = str(d.timezone);
  if (!country || !timezone) return null;
  // `loc` is a "lat,lng" string.
  const loc = str(d.loc)?.split(",") ?? [];
  return {
    country,
    countryName: country.toUpperCase(),
    timezone,
    city: str(d.city) ?? "",
    ip: str(d.ip) ?? "",
    latitude: num(loc[0]),
    longitude: num(loc[1]),
  };
}

function parseGeojs(raw: unknown): ProxyGeoResult | null {
  const d = asObj(raw);
  if (!d) return null;
  const country = cc(d.country_code);
  const timezone = str(d.timezone);
  if (!country || !timezone) return null;
  return {
    country,
    countryName: str(d.country) ?? country.toUpperCase(),
    timezone,
    city: str(d.city) ?? "",
    ip: str(d.ip) ?? "",
    // geojs returns lat/lon as strings.
    latitude: num(d.latitude),
    longitude: num(d.longitude),
  };
}

// ── small normalization helpers ────────────────────────────────────────────

function asObj(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null ? (x as Record<string, unknown>) : null;
}

/** A 2-letter country code, lowercased, or null. */
function cc(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z]{2}$/.test(v) ? v.toLowerCase() : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Coerce a number or numeric string to a finite number, else undefined. */
function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function buildProxyUrl(p: ProxyConfig): string {
  const auth =
    p.username && p.password
      ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
      : p.username
        ? `${encodeURIComponent(p.username)}@`
        : "";
  const scheme = p.type === "socks5" ? "socks5" : "http";
  return `${scheme}://${auth}${p.host}:${p.port}`;
}
