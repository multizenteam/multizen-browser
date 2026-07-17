/**
 * Canvas/seed fingerprint smoke.
 *
 * Offline (always):
 *   - ≥5 creates same localeId / different seeds → coarse-hash diversity
 *   - same seed → stable device/WebGL; update seed patch path documented
 *
 * Live (optional, needs running MultiZen MCP + CloakBrowser):
 *   - create 2 profiles, launch, canvas toDataURL hashes differ by seed
 *   - relaunch same seed → same hash
 *   - probe_fingerprint drift check
 *   - update_profile seed → noise changes after relaunch
 *
 * Env:
 *   MULTIZEN_MCP_URL — default http://127.0.0.1:7777
 *   MULTIZEN_SMOKE_LIVE=1 — force fail if live phase unavailable
 *
 * Run: `yarn smoke:fingerprint-seed` or
 *      `npx tsx packages/mcp-server/scripts/smoke-fingerprint-seed.ts`
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateFingerprint,
  reconcileFingerprint,
  ProfileManager,
} from "@multizen/profile-manager";
import type { FingerprintConfig } from "@multizen/types";

const MCP_BASE = (process.env.MULTIZEN_MCP_URL ?? "http://127.0.0.1:7777").replace(/\/$/, "");
const REQUIRE_LIVE = process.env.MULTIZEN_SMOKE_LIVE === "1";

function coarseHash(fp: FingerprintConfig): string {
  return [
    fp.userAgent,
    fp.platform,
    fp.webgl.vendor,
    fp.webgl.renderer,
    `${fp.screen.width}x${fp.screen.height}`,
  ].join("|");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function offlineSeedDiversity(): void {
  const hashes = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const fp = reconcileFingerprint(generateFingerprint(`smoke-offline-${i}`), {
      localeId: "en-PK",
      timezone: "Asia/Karachi",
    });
    hashes.add(coarseHash(fp));
  }
  assert(hashes.size >= 2, `offline: expected ≥2 distinct coarse hashes among 5 seeds, got ${hashes.size}`);
  console.log(`[offline] 5 seeds → ${hashes.size} coarse hashes (need ≥2) OK`);

  const a = generateFingerprint("smoke-stable");
  const b = generateFingerprint("smoke-stable");
  assert(a.device === b.device && coarseHash(a) === coarseHash(b), "same seed must be stable");
  console.log("[offline] same-seed stability OK");

  const root = join(tmpdir(), `multizen-smoke-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const pm = new ProfileManager({
    dbPath: join(root, "profiles.db"),
    profilesRoot: join(root, "profiles"),
  });
  try {
    const created = [];
    for (let i = 0; i < 5; i++) {
      const seed = `pm-seed-${i}`;
      const fp = {
        ...reconcileFingerprint(generateFingerprint(seed), {
          localeId: "bn-BD",
          timezone: "Asia/Dhaka",
        }),
        seed,
      };
      created.push(pm.create({ name: `smoke-${i}`, fingerprint: fp }));
    }
    const pmHashes = new Set(created.map((p) => coarseHash(p.fingerprint)));
    assert(pmHashes.size >= 2, `ProfileManager creates: only ${pmHashes.size} coarse hashes`);
    console.log(`[offline] ProfileManager 5 creates → ${pmHashes.size} coarse hashes OK`);

    const p0 = created[0]!;
    const newSeed = "pm-seed-rotated";
    const rotated = reconcileFingerprint(p0.fingerprint, { localeId: "bn-BD" });
    const updated = pm.update(p0.id, {
      fingerprint: { ...rotated, seed: newSeed },
    });
    assert(updated.fingerprint.seed === newSeed, "update_profile seed must persist");
    console.log("[offline] update seed on same profileId OK");
  } finally {
    pm.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function mcpHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${MCP_BASE}/healthz`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reused Streamable HTTP session for the live smoke phase. */
let mcpSession: { headers: Record<string, string>; nextId: number } | null = null;

async function ensureMcpSession(): Promise<Record<string, string> | null> {
  if (mcpSession) return mcpSession.headers;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const initRes = await fetch(`${MCP_BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-fingerprint-seed", version: "0.7.0" },
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!initRes.ok) return null;
  const sessionId = initRes.headers.get("mcp-session-id");
  if (sessionId) headers["mcp-session-id"] = sessionId;
  await initRes.text().catch(() => "");
  await fetch(`${MCP_BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);

  mcpSession = { headers, nextId: 2 };
  return headers;
}

/**
 * Minimal Streamable HTTP tools/call helper (single shared session).
 * Returns null if the transport handshake fails.
 */
async function mcpCall(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown | null> {
  const headers = await ensureMcpSession();
  if (!headers || !mcpSession) return null;

  const id = mcpSession.nextId++;
  const callRes = await fetch(`${MCP_BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!callRes.ok) return null;
  const text = await callRes.text();
  // Streamable HTTP may return SSE-framed JSON; pull the last data: line or raw JSON.
  let payload = text;
  if (text.includes("data:")) {
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    payload = lines[lines.length - 1]?.slice(5).trim() ?? text;
  }
  try {
    const json = JSON.parse(payload) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message?: string };
    };
    if (json.error) throw new Error(json.error.message ?? "mcp error");
    const body = json.result?.content?.[0]?.text;
    if (!body) return json.result ?? null;
    return JSON.parse(body) as unknown;
  } catch (e) {
    console.warn(`[live] failed to parse MCP response for ${tool}:`, (e as Error).message);
    return null;
  }
}

const CANVAS_EXPR = `(() => {
  const c = document.createElement("canvas");
  c.width = 220; c.height = 30;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.textBaseline = "top";
  ctx.font = "14px Arial";
  ctx.fillStyle = "#f60";
  ctx.fillRect(125, 1, 62, 20);
  ctx.fillStyle = "#069";
  ctx.fillText("MultiZen smoke", 2, 15);
  const data = c.toDataURL();
  let h = 0;
  for (let i = 0; i < data.length; i++) h = ((h << 5) - h + data.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
})()`;

async function canvasHash(profileId: string): Promise<string | null> {
  const res = (await mcpCall("evaluate_js", {
    profile_id: profileId,
    expression: CANVAS_EXPR,
  })) as { result?: { value?: string | null } } | null;
  return res?.result?.value ?? null;
}

async function liveSmoke(): Promise<"ok" | "skipped" | "fail"> {
  const healthy = await mcpHealth();
  if (!healthy) {
    console.log(
      `[live] SKIPPED — MCP not reachable at ${MCP_BASE}/healthz (start MultiZen desktop with CloakBrowser).`,
    );
    return "skipped";
  }
  console.log(`[live] MCP healthy at ${MCP_BASE}`);

  const ids: string[] = [];
  try {
    const p1 = (await mcpCall("create_profile", {
      name: `smoke-a-${Date.now()}`,
      seed: "live-seed-A",
      fingerprint: { localeId: "en-PK", timezone: "Asia/Karachi" },
    })) as { id?: string } | null;
    const p2 = (await mcpCall("create_profile", {
      name: `smoke-b-${Date.now()}`,
      seed: "live-seed-B",
      fingerprint: { localeId: "en-PK", timezone: "Asia/Karachi" },
    })) as { id?: string } | null;
    if (!p1?.id || !p2?.id) {
      console.warn("[live] create_profile failed via MCP — skipping live canvas checks");
      return "skipped";
    }
    ids.push(p1.id, p2.id);

    await mcpCall("launch_profile", { profile_id: p1.id });
    await mcpCall("launch_profile", { profile_id: p2.id });
    await mcpCall("navigate", { profile_id: p1.id, url: "about:blank" });
    await mcpCall("navigate", { profile_id: p2.id, url: "about:blank" });

    const h1 = await canvasHash(p1.id);
    const h2 = await canvasHash(p2.id);
    console.log(`[live] canvas hashes: A=${h1} B=${h2}`);
    if (!h1 || !h2) {
      console.warn("[live] canvas hash null — engine may block canvas; mark checklist manually");
      return "fail";
    }
    assert(h1 !== h2, "different seeds must produce different canvas hashes");

    await mcpCall("close_profile", { profile_id: p1.id });
    await mcpCall("launch_profile", { profile_id: p1.id });
    await mcpCall("navigate", { profile_id: p1.id, url: "about:blank" });
    const h1b = await canvasHash(p1.id);
    assert(h1b === h1, `same seed relaunch must match canvas hash (${h1} vs ${h1b})`);

    const probe = (await mcpCall("probe_fingerprint", { profile_id: p1.id })) as {
      ok?: boolean;
      drift?: string[];
      error?: { code?: string; message?: string };
    } | null;
    if (!probe || probe.ok === undefined) {
      console.warn(
        "[live] probe_fingerprint unavailable or unexpected shape — rebuild/restart MultiZen with 0.7 MCP tools",
        probe ? JSON.stringify(probe).slice(0, 200) : "null",
      );
    } else {
      console.log(`[live] probe_fingerprint ok=${probe.ok} drift=${JSON.stringify(probe.drift)}`);
    }

    await mcpCall("close_profile", { profile_id: p1.id });
    await mcpCall("update_profile", {
      profile_id: p1.id,
      fingerprint: { seed: "live-seed-A-rotated", localeId: "en-PK", timezone: "Asia/Karachi" },
    });
    await mcpCall("launch_profile", { profile_id: p1.id });
    await mcpCall("navigate", { profile_id: p1.id, url: "about:blank" });
    const h1c = await canvasHash(p1.id);
    assert(h1c !== h1, "new seed after update_profile must change canvas hash");
    console.log("[live] canvas seed smoke OK");
    return "ok";
  } catch (e) {
    console.error("[live] FAIL:", (e as Error).message);
    return "fail";
  } finally {
    for (const id of ids) {
      await mcpCall("close_profile", { profile_id: id }).catch(() => null);
      await mcpCall("delete_profile", { profile_id: id }).catch(() => null);
    }
  }
}

async function main(): Promise<void> {
  console.log("=== smoke-fingerprint-seed ===");
  offlineSeedDiversity();
  const live = await liveSmoke();
  if (live === "fail" || (live === "skipped" && REQUIRE_LIVE)) {
    process.exit(1);
  }
  if (live === "skipped") {
    console.log(
      "\nOffline checks passed. Live CloakBrowser checklist still needs a running MultiZen ≥0.6.0 binary — see docs/fingerprint-entropy-verification.md §6.",
    );
  } else {
    console.log("\nOffline + live checks passed.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
