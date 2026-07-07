/**
 * Per-profile start page helpers (opened on a profile's first launch).
 *
 * NOTE: a per-profile default-search-engine feature was prototyped alongside
 * this, but ungoogled CloakBrowser ignores both pref-seeding and extension
 * `search_provider` overrides (verified on the real binary — see
 * specs/profile-startpage-search). Default search is therefore deferred to the
 * patched-Chromium build; only the start page ships for now.
 */

/** Opened on a profile's first launch when it has no explicit `startUrl`. */
export const DEFAULT_START_URL = "https://duckduckgo.com/";

/**
 * Sanitize a profile's start URL into a safe positional Chromium arg. Only
 * http(s) and about: URLs are allowed; anything else (empty, schemeless like
 * `example.com`, or a `-`/`--`-prefixed token that Chromium would parse as a
 * command-line switch) falls back to the default. This closes an arg-injection
 * surface — the value can be set by MCP agents, and Chromium's CommandLine
 * treats any leading-dash token as a switch regardless of argv position.
 */
export function sanitizeStartUrl(raw?: string): string {
  const v = (raw ?? "").trim();
  if (!v) return DEFAULT_START_URL;
  try {
    const u = new URL(v);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "about:") {
      return v;
    }
  } catch {
    // not a valid absolute URL
  }
  return DEFAULT_START_URL;
}
