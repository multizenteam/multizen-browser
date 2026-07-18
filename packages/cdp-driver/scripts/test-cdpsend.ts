/**
 * Standalone tsx verification for the stealth-preserving `CdpSession.cdpSend`
 * primitive. No test runner exists on master (project rule: do not add one), so
 * this mirrors Phase 1's approach — a self-running script that exits non-zero on
 * the first failed invariant.
 *
 * Run:
 *   node --import ../mcp-server/node_modules/tsx/dist/loader.mjs \
 *        packages/cdp-driver/scripts/test-cdpsend.ts
 *
 * We bypass the real chrome-remote-interface transport by grafting a fake client
 * straight onto the session (the only thing connect() would set), then record the
 * exact sequence of CDP commands the safe layer emits.
 */
import assert from "node:assert/strict";
import { CdpSession } from "../src/CdpSession.ts";

interface SendCall {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface FakeClient {
  client: { send: (m: string, p?: Record<string, unknown>, s?: string) => Promise<unknown> };
  calls: SendCall[];
  methods: () => string[];
}

function makeFakeClient(
  opts: { throwOn?: (method: string, callIndex: number) => boolean } = {},
): FakeClient {
  const calls: SendCall[] = [];
  let i = 0;
  const client = {
    send: async (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ): Promise<unknown> => {
      const idx = i++;
      calls.push({ method, params, sessionId });
      if (opts.throwOn?.(method, idx)) throw new Error(`fake CDP failure: ${method}`);
      return { ok: true, method };
    },
  };
  return { client, calls, methods: () => calls.map((c) => c.method) };
}

function sessionWith(fake: FakeClient, engine?: string): CdpSession {
  const s = new CdpSession({ port: 0, engine });
  (s as unknown as { client: unknown }).client = fake.client;
  return s;
}

function refcount(s: CdpSession): Map<string, number> {
  return (s as unknown as { safeEnableRefcount: Map<string, number> }).safeEnableRefcount;
}

const tests: Array<[string, () => Promise<void>]> = [];
function test(name: string, fn: () => Promise<void>): void {
  tests.push([name, fn]);
}

// ── connect-domain protection (Page is sacred) ───────────────────────────────

test("safe cdpSend never disables a connect-enabled domain (Page)", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Page.enable");
  assert.deepEqual(fake.methods(), ["Page.enable"]);
  assert.ok(!fake.methods().includes("Page.disable"), "Page must never be disabled");
  assert.equal(refcount(s).size, 0);
});

// ── allowlisted domain: enable is paired with a disable ──────────────────────

test("safe cdpSend pairs an allowlisted *.enable with a *.disable (Accessibility)", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Accessibility.enable");
  assert.deepEqual(fake.methods(), ["Accessibility.enable", "Accessibility.disable"]);
  assert.equal(refcount(s).size, 0);
});

test("safe cdpSend pairs Runtime.enable with Runtime.disable on a non-anti-detect engine", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cft");
  await s.cdpSend("Runtime.enable");
  assert.deepEqual(fake.methods(), ["Runtime.enable", "Runtime.disable"]);
});

test("the paired disable is threaded through the same sessionId as the enable", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Accessibility.enable", undefined, "SESS-1");
  assert.deepEqual(
    fake.calls.map((c) => [c.method, c.sessionId]),
    [
      ["Accessibility.enable", "SESS-1"],
      ["Accessibility.disable", "SESS-1"],
    ],
  );
});

// ── unknown domains are left strictly alone (allowlist, not a heuristic) ──────

test("safe cdpSend does NOT pair a disable for a domain outside the allowlist", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Foo.enable");
  assert.deepEqual(fake.methods(), ["Foo.enable"], "unknown domains must not be auto-disabled");
  assert.equal(refcount(s).size, 0);
});

// ── CloakBrowser: refuse risky enables at enable time ────────────────────────

for (const method of ["Runtime.enable", "Network.enable"]) {
  test(`safe cdpSend on cloakbrowser refuses ${method} (never sent) — reworded msg omits no_safety`, async () => {
    const fake = makeFakeClient();
    const s = sessionWith(fake, "cloakbrowser");
    await assert.rejects(s.cdpSend(method), (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /refus/i);
      // Gate #1 fallout: the refusal message must NOT advertise the dropped tool.
      assert.doesNotMatch(msg, /cdp_send_no_safety/);
      return true;
    });
    assert.deepEqual(fake.methods(), [], "the risky enable must not reach the transport");
    assert.equal(refcount(s).size, 0);
  });
}

test("safe cdpSend on cloakbrowser STILL pairs a non-risky enable (DOM) normally", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  await s.cdpSend("DOM.enable");
  assert.deepEqual(fake.methods(), ["DOM.enable", "DOM.disable"]);
});

test("safe cdpSend on cloakbrowser does not touch Page (connect domain)", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  await s.cdpSend("Page.enable");
  assert.deepEqual(fake.methods(), ["Page.enable"]);
});

// ── no-safety passthrough (code path retained; no MCP tool reaches it) ────────

test("safe:false is a pure passthrough: no disable, even for risky enables", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  await s.cdpSend("Network.enable", undefined, undefined, { safe: false });
  assert.deepEqual(fake.methods(), ["Network.enable"], "no auto-disable in unsafe mode");
  assert.equal(refcount(s).size, 0);
});

test("safe:false on cloakbrowser does not apply the risky-enable refusal", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  await s.cdpSend("Runtime.enable", undefined, undefined, { safe: false });
  assert.deepEqual(fake.methods(), ["Runtime.enable"]);
});

// ── wrappers' underlying calls never enable a domain ─────────────────────────

test("typical wrapper calls (Runtime.evaluate, Network.getCookies, Target.*) never enable/disable", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Runtime.evaluate", { expression: "1", returnByValue: true });
  await s.cdpSend("Network.getCookies", { urls: ["https://example.com"] });
  await s.cdpSend("Network.setCookies", { cookies: [] });
  await s.cdpSend("Target.getTargets", {});
  await s.cdpSend("Target.createTarget", { url: "about:blank" });
  assert.deepEqual(fake.methods(), [
    "Runtime.evaluate",
    "Network.getCookies",
    "Network.setCookies",
    "Target.getTargets",
    "Target.createTarget",
  ]);
  assert.ok(!fake.methods().some((m) => /\.(enable|disable)$/.test(m)));
});

// ── concurrency: refcount keeps the disable until the last enable finishes ────

test("parallel safe enables of one domain refcount to a single trailing disable", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await Promise.all([s.cdpSend("Runtime.enable"), s.cdpSend("Runtime.enable")]);
  const enables = fake.methods().filter((m) => m === "Runtime.enable").length;
  const disables = fake.methods().filter((m) => m === "Runtime.disable").length;
  assert.equal(enables, 2, "both enables must reach the transport");
  assert.equal(disables, 1, "only one disable once the refcount hits zero");
  assert.equal(fake.methods().at(-1), "Runtime.disable", "disable must come after both enables");
  assert.equal(refcount(s).size, 0);
});

// ── exception safety: a throwing enable must not pin the domain ───────────────

test("an exception after increment still decrements the refcount (domain not pinned)", async () => {
  const fake = makeFakeClient({
    throwOn: (method, idx) => method === "Runtime.enable" && idx === 0,
  });
  const s = sessionWith(fake, "cft");
  await assert.rejects(s.cdpSend("Runtime.enable"), /fake CDP failure/);
  assert.equal(refcount(s).size, 0, "refcount must be cleared even when the enable throws");
  await s.cdpSend("Runtime.enable");
  assert.equal(refcount(s).size, 0);
  assert.deepEqual(fake.methods().slice(-2), ["Runtime.enable", "Runtime.disable"]);
});

// ── require(): cdpSend before connect throws a clear error ────────────────────

test("cdpSend before connect() throws a clear 'not connected' error", async () => {
  const s = new CdpSession({ port: 0 });
  await assert.rejects(s.cdpSend("Runtime.evaluate"), /not connected/i);
});

async function main(): Promise<void> {
  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (e) {
      failures++;
      console.error(`FAIL  ${name}\n      ${(e as Error).message}`);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  if (failures > 0) process.exit(1);
}

void main();
