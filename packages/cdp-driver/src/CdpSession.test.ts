import { test } from "node:test";
import assert from "node:assert/strict";

import { CdpSession } from "./CdpSession.js";

/**
 * Unit/integration coverage for the stealth-preserving `cdpSend` primitive.
 *
 * We bypass the real chrome-remote-interface transport by injecting a fake
 * client straight onto the session (the only thing `connect()` would set), then
 * record the exact sequence of CDP commands the safe layer emits. This lets us
 * assert the stealth invariants precisely without a browser.
 */

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

function makeFakeClient(opts: { throwOn?: (method: string, callIndex: number) => boolean } = {}): FakeClient {
  const calls: SendCall[] = [];
  let i = 0;
  const client = {
    send: async (method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
      const idx = i++;
      calls.push({ method, params, sessionId });
      if (opts.throwOn?.(method, idx)) throw new Error(`fake CDP failure: ${method}`);
      return { ok: true, method };
    },
  };
  return { client, calls, methods: () => calls.map((c) => c.method) };
}

/** Build a session and graft the fake client on, skipping the real connect(). */
function sessionWith(fake: FakeClient, engine?: string): CdpSession {
  const s = new CdpSession({ port: 0, engine });
  (s as unknown as { client: unknown }).client = fake.client;
  return s;
}

function refcount(s: CdpSession): Map<string, number> {
  return (s as unknown as { safeEnableRefcount: Map<string, number> }).safeEnableRefcount;
}

// ── connect-domain protection (Page is sacred) ───────────────────────────────

test("safe cdp_send never disables a connect-enabled domain (Page.enable is a no-op for disable)", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Page.enable");
  assert.deepEqual(fake.methods(), ["Page.enable"]);
  assert.ok(!fake.methods().includes("Page.disable"), "Page must never be disabled");
  assert.equal(refcount(s).size, 0);
});

// ── allowlisted domain: enable is paired with a disable ──────────────────────

test("safe cdp_send pairs an allowlisted *.enable with a *.disable (Accessibility)", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Accessibility.enable");
  assert.deepEqual(fake.methods(), ["Accessibility.enable", "Accessibility.disable"]);
  assert.equal(refcount(s).size, 0, "refcount must return to empty after the paired disable");
});

test("safe cdp_send pairs Runtime.enable with Runtime.disable on a non-anti-detect engine", async () => {
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

test("safe cdp_send does NOT pair a disable for a domain outside the allowlist", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Foo.enable");
  assert.deepEqual(fake.methods(), ["Foo.enable"], "unknown domains must not be auto-disabled");
  assert.equal(refcount(s).size, 0);
});

// ── CloakBrowser: refuse risky enables at enable time ────────────────────────

for (const method of ["Runtime.enable", "Network.enable"]) {
  test(`safe cdp_send on cloakbrowser refuses ${method} with a clear error and never sends it`, async () => {
    const fake = makeFakeClient();
    const s = sessionWith(fake, "cloakbrowser");
    await assert.rejects(s.cdpSend(method), (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /refus/i);
      assert.match(msg, /cdp_send_no_safety/);
      return true;
    });
    assert.deepEqual(fake.methods(), [], "the risky enable must not reach the transport");
    assert.equal(refcount(s).size, 0);
  });
}

test("safe cdp_send on cloakbrowser STILL pairs a non-risky enable (DOM) normally", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  await s.cdpSend("DOM.enable");
  assert.deepEqual(fake.methods(), ["DOM.enable", "DOM.disable"]);
});

test("safe cdp_send on cloakbrowser does not touch Page (connect domain) at all", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  await s.cdpSend("Page.enable");
  assert.deepEqual(fake.methods(), ["Page.enable"]);
});

// ── no-safety passthrough ────────────────────────────────────────────────────

test("cdp_send_no_safety is a pure passthrough: no disable, even for risky enables", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  await s.cdpSend("Network.enable", undefined, undefined, { safe: false });
  assert.deepEqual(fake.methods(), ["Network.enable"], "no auto-disable in unsafe mode");
  assert.equal(refcount(s).size, 0);
});

test("cdp_send_no_safety on cloakbrowser does not apply the risky-enable refusal", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  // Must resolve (not throw) — the caller owns the consequences.
  await s.cdpSend("Runtime.enable", undefined, undefined, { safe: false });
  assert.deepEqual(fake.methods(), ["Runtime.enable"]);
});

// ── wrappers' underlying calls never enable a domain ─────────────────────────

test("typical wrapper calls (Runtime.evaluate, Network.getCookies, Target.*) never enable/disable", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Runtime.evaluate", { expression: "1", returnByValue: true });
  await s.cdpSend("Network.getCookies", {});
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
  // Throw only on the FIRST Runtime.enable so we can prove the domain is not
  // left pinned: a later enable must behave normally.
  const fake = makeFakeClient({ throwOn: (method, idx) => method === "Runtime.enable" && idx === 0 });
  const s = sessionWith(fake, "cft");

  await assert.rejects(s.cdpSend("Runtime.enable"), /fake CDP failure/);
  assert.equal(refcount(s).size, 0, "refcount must be cleared even when the enable throws");

  // A subsequent enable enables + pairs a disable as usual — proof the domain
  // was never stuck in the 'enabled' accounting state.
  await s.cdpSend("Runtime.enable");
  assert.equal(refcount(s).size, 0);
  const tail = fake.methods().slice(-2);
  assert.deepEqual(tail, ["Runtime.enable", "Runtime.disable"]);
});

// ── require(): cdpSend before connect throws a clear error ────────────────────

test("cdp_send before connect() throws a clear 'not connected' error", async () => {
  const s = new CdpSession({ port: 0 });
  await assert.rejects(s.cdpSend("Runtime.evaluate"), /not connected/i);
});
