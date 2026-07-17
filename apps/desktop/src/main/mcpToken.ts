import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

/**
 * Bearer token for the local MCP HTTP server.
 *
 * The MCP server exposes powerful browser-control tools (launch/navigate/extract
 * and, later, CDP + profile CRUD) on a loopback port. Binding to 127.0.0.1 keeps
 * it off the network, but any *local* process — or a web page reaching the port
 * via DNS rebinding — could still drive it. Requiring a secret bearer token that
 * a cross-origin page cannot read closes both holes.
 *
 * The token is generated once (256-bit, hex) and persisted with 0600 perms in
 * the app data dir — the same pattern Jupyter and Syncthing use for their local
 * APIs. A rogue same-user process can still read the file, but that is outside
 * the loopback/rebinding threat model this defends (a same-user process already
 * has the user's full session).
 */
const TOKEN_FILE = "mcp-token";
const TOKEN_RE = /^[0-9a-f]{64}$/;

export function loadOrCreateMcpToken(userDataDir: string): string {
  const path = join(userDataDir, TOKEN_FILE);
  if (existsSync(path)) {
    try {
      const existing = readFileSync(path, "utf8").trim();
      if (TOKEN_RE.test(existing)) return existing;
    } catch {
      // fall through and regenerate
    }
  }
  const token = randomBytes(32).toString("hex");
  // mode on write covers POSIX; chmod is belt-and-suspenders (and a no-op that
  // may throw on Windows, hence the guard).
  writeFileSync(path, token, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows / restricted FS — best effort.
  }
  return token;
}
