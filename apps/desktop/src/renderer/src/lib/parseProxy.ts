/**
 * Parse a one-line proxy string into its parts so a paste can auto-fill the
 * whole proxy form — the convenience every anti-detect tool ships (AdsPower,
 * GoLogin, Multilogin all do it).
 *
 * Supported shapes (scheme optional, credentials optional):
 *   host:port
 *   host:port:user:pass                       ← Smartproxy/IPRoyal style
 *   user:pass:host:port                       ← reversed colon order (Thordata)
 *   user:pass@host:port                       ← cURL / standard URL style
 *   host:port@user:pass                       ← some panels export this
 *   host:port##user:pass                      ← '##' delimiter (some panels)
 *   host,port,user,pass                       ← comma delimiter (some panels)
 *   scheme://host:port[:user:pass]
 *   scheme://user:pass@host:port
 *
 * `scheme` sets the type: any "socks"-prefixed scheme → "socks5",
 * http/https → "http".
 * Without a scheme `type` is left undefined so the caller keeps the type the
 * user already selected.
 *
 * `host:port:user:pass` and `user:pass:host:port` are positionally ambiguous;
 * they're disambiguated heuristically — the segment pair that looks like a real
 * host + valid port is taken as the endpoint (see isReversedColon). The
 * heuristic can only misread the rare case where the password is itself a
 * number in the 1-65535 range AND the host isn't a plain dotted domain/IP; the
 * user can still correct the fields after the paste.
 *
 * Passwords may contain ':' (taken as everything after the 3rd colon in the
 * colon format) and '@' (kept verbatim when neither side of an '@' looks like
 * host:port). Returns null when the string isn't a usable proxy (no numeric
 * port, or just a bare hostname) — the caller then leaves the field as typed.
 *
 * Note: bracketed IPv6 literals ([::1]:8080) are not supported — proxy panels
 * effectively never export them, and the ':'-splitting would mangle them.
 */
export interface ParsedProxy {
  type?: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseProxyString(raw: string): ParsedProxy | null {
  let s = raw.trim();
  if (!s) return null;

  // 1. Optional scheme prefix → drives the proxy type.
  let type: ParsedProxy["type"];
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  if (scheme) {
    const name = (scheme[1] ?? "").toLowerCase();
    s = scheme[2] ?? s;
    if (name.startsWith("socks")) type = "socks5";
    else if (name === "http" || name === "https") type = "http";
    // Unknown scheme: keep parsing, leave type for the caller to decide.
  }

  // 1b. Normalize alternative delimiters some panels export to the canonical
  //     forms before parsing:
  //       host:port##user:pass  →  host:port@user:pass  ('##' → '@')
  //       host,port,user,pass   →  host:port:user:pass  (comma → colon)
  //     These treat ',' / '##' as pure field separators, so a value that itself
  //     contains one gets mangled — the same accepted limitation the colon
  //     format already has for ':' inside a password (real panels don't do it).
  if (s.includes("##")) s = s.replace("##", "@");
  if (s.includes(",")) s = s.replace(/,/g, ":");

  // 2. Credentials separated by '@'. Only split when one side actually looks
  //    like host:port — otherwise the '@' is part of a colon-format password.
  let credsPart: string | undefined;
  let hostPart = s;
  const at = s.lastIndexOf("@");
  if (at !== -1) {
    const left = s.slice(0, at);
    const right = s.slice(at + 1);
    const leftHP = looksLikeHostPort(left);
    const rightHP = looksLikeHostPort(right);
    if (leftHP && rightHP) {
      // Both sides look like host:port (e.g. `host:port@user:<numeric pass>`).
      // Prefer the side whose first segment looks like a real hostname/IP;
      // otherwise default to the right (standard `user:pass@host:port`).
      if (hostLooksReal(left) && !hostLooksReal(right)) {
        hostPart = left;
        credsPart = right;
      } else {
        hostPart = right;
        credsPart = left;
      }
    } else if (rightHP) {
      hostPart = right;
      credsPart = left;
    } else if (leftHP) {
      hostPart = left;
      credsPart = right;
    }
  }

  let username: string | undefined;
  let password: string | undefined;
  if (credsPart !== undefined) {
    const ci = credsPart.indexOf(":");
    if (ci === -1) {
      username = credsPart || undefined;
    } else {
      username = credsPart.slice(0, ci) || undefined;
      password = credsPart.slice(ci + 1) || undefined;
    }
  }

  // 3. hostPart is host:port, optionally with trailing :user:pass — or the
  //    reversed user:pass:host:port order. Only a 4-field colon string with no
  //    '@'-supplied creds is ambiguous; there isReversedColon decides which
  //    pair is the endpoint. Other lengths keep the host-first interpretation.
  const parts = hostPart.split(":");
  if (parts.length < 2) return null; // need at least host:port

  let host: string;
  let port: number;
  if (credsPart === undefined && parts.length === 4 && isReversedColon(parts)) {
    if (username === undefined) username = parts[0] || undefined;
    if (password === undefined) password = parts[1] || undefined;
    host = (parts[2] ?? "").trim();
    port = Number((parts[3] ?? "").trim());
  } else {
    host = (parts[0] ?? "").trim();
    port = Number((parts[1] ?? "").trim());
    // Colon-format credentials, only if '@' didn't already supply them.
    if (username === undefined && parts.length >= 3) {
      username = parts[2] || undefined;
      if (parts.length >= 4) {
        // Re-join so a ':' inside the password survives.
        password = parts.slice(3).join(":") || undefined;
      }
    }
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { type, host, port, username, password };
}

/** A valid TCP port (1-65535) after trimming. */
function isValidPort(s: string | undefined): boolean {
  const n = Number((s ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** True when `s` is "<something>:<valid port>[:...]". */
function looksLikeHostPort(s: string): boolean {
  const parts = s.split(":");
  if (parts.length < 2 || !parts[0]) return false;
  return isValidPort(parts[1]);
}

/**
 * For a 4-field colon string, decide whether it's `user:pass:host:port`
 * (reversed) rather than `host:port:user:pass` (normal). Pick the pair that
 * looks like the real endpoint: a host segment plus a valid port. When only one
 * pair has a valid port, that pair is the endpoint. When BOTH do (a numeric
 * password), fall back to which host segment looks real (a dotted host / IP or
 * "localhost"), defaulting to the normal host-first order.
 */
function isReversedColon(parts: string[]): boolean {
  const frontPort = isValidPort(parts[1]);
  const backPort = isValidPort(parts[3]);
  if (frontPort && !backPort) return false; // only front is host:port
  if (backPort && !frontPort) return true; // only back is host:port
  if (frontPort && backPort) {
    const frontReal = hostLooksReal(`${parts[0]}:${parts[1]}`);
    const backReal = hostLooksReal(`${parts[2]}:${parts[3]}`);
    return backReal && !frontReal;
  }
  return false; // neither is a valid endpoint → leave normal (fails validation)
}

/** True if the first segment looks like a real hostname/IP, not a bare username. */
function hostLooksReal(s: string): boolean {
  const host = (s.split(":")[0] ?? "").trim();
  return host === "localhost" || host.includes(".");
}
