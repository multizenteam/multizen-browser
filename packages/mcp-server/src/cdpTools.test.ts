import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMultizenMcpServer, type BrowserDriver } from "./server.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import type { ProfileManager } from "@multizen/profile-manager";
import type { LaunchedProfile, ProfileId } from "@multizen/types";

/**
 * End-to-end exercise of the MCP server CDP tool surfaces. We connect a real
 * MCP `Client` to a real `Server` over an in-memory transport pair, so every
 * assertion goes through genuine `tools/list` + `tools/call` JSON-RPC round
 * trips (including Zod validation and the dispatch switch). The browser layer
 * is faked so we can capture exactly what `dispatch()` asks the driver to do.
 */

const NEW_TOOLS = [
  "cdp_send",
  "cdp_send_no_safety",
  "evaluate_js",
  "wait_for_selector",
  "get_cookies",
  "set_cookies",
  "list_tabs",
  "new_tab",
  "activate_tab",
  "close_tab",
  "wait_for_navigation",
  "wait_for_load",
] as const;

interface CdpCall {
  profileId: string;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  opts?: { safe?: boolean };
}

/** A BrowserDriver that records every cdpSend and returns a configurable
 *  response, so dispatch composition (method + params + safe flag) is
 *  observable without a browser. */
class SpyDriver implements BrowserDriver {
  readonly running = new Set<string>();
  readonly calls: CdpCall[] = [];
  respond: (method: string, params?: Record<string, unknown>) => unknown = () => ({ ok: true });

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    this.running.add(profileId);
    return {
      id: profileId,
      cdpEndpoint: "http://127.0.0.1:0",
      pid: 1,
      startedAt: new Date().toISOString(),
    };
  }
  async close(profileId: ProfileId): Promise<void> {
    this.running.delete(profileId);
  }
  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }
  async navigate(_profileId: ProfileId, url: string): Promise<{ url: string }> {
    return { url };
  }
  async click(): Promise<{ ok: true }> {
    return { ok: true };
  }
  async type(): Promise<{ ok: true }> {
    return { ok: true };
  }
  async extract(): Promise<{ result: unknown }> {
    return { result: {} };
  }
  async screenshot(): Promise<{ pngBase64: string }> {
    return { pngBase64: "" };
  }
  async cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown> {
    this.calls.push({ profileId, method, params, sessionId, opts });
    return this.respond(method, params);
  }
}

async function connect(driver: BrowserDriver): Promise<Client> {
  // The profile manager is never touched by the CDP tool paths (they only
  // need isRunning + cdpSend), so a bare stub is sufficient here.
  const profileManager = {} as unknown as ProfileManager;
  const { server } = createMultizenMcpServer({ profileManager, browserDriver: driver });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

interface CallResult {
  isError: boolean;
  parsed: any;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  const text = content[0]?.text ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { isError: res.isError === true, parsed };
}

/** No convenience wrapper is allowed to enable a CDP domain — that is the
 *  whole stealth point of composing them over the bare primitive. */
function assertNoDomainEnable(spy: SpyDriver): void {
  for (const c of spy.calls) {
    assert.ok(
      !/\.enable$/.test(c.method),
      `wrapper unexpectedly issued a domain enable: ${c.method}`,
    );
  }
}

// ── tools/list registration ─────────────────────────────────────────────────

test("tools/list exposes all 12 CDP tool surfaces with object input schemas", async () => {
  const client = await connect(new SpyDriver());
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const name of NEW_TOOLS) {
    const tool = byName.get(name);
    assert.ok(tool, `tool ${name} is not registered in TOOL_DEFINITIONS`);
    assert.equal(typeof tool!.description, "string");
    assert.ok((tool!.description ?? "").length > 0, `tool ${name} has no description`);
    assert.equal((tool!.inputSchema as { type?: string }).type, "object");
  }
  await client.close();
});

test("cdp_send_no_safety description explicitly warns it bypasses stealth", async () => {
  const client = await connect(new SpyDriver());
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "cdp_send_no_safety");
  assert.ok(tool);
  const desc = tool!.description ?? "";
  assert.match(desc, /bypass/i);
  assert.match(desc, /stealth/i);
  await client.close();
});

// ── safe / no-safety routing ────────────────────────────────────────────────

test("cdp_send routes to driver.cdpSend with safe:true and verbatim method/params", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  await call(client, "cdp_send", {
    profile_id: "p1",
    method: "Page.captureScreenshot",
    params: { format: "png" },
    sessionId: "S1",
  });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Page.captureScreenshot");
  assert.deepEqual(c.params, { format: "png" });
  assert.equal(c.sessionId, "S1");
  assert.equal(c.opts?.safe, true);
  await client.close();
});

test("cdp_send_no_safety routes to driver.cdpSend with safe:false", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  await call(client, "cdp_send_no_safety", { profile_id: "p1", method: "Network.enable" });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Network.enable");
  assert.equal(c.opts?.safe, false);
  await client.close();
});

// ── convenience wrappers compose the right CDP method without enabling ───────

test("evaluate_js composes Runtime.evaluate{returnByValue} (no domain enable)", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  await call(client, "evaluate_js", {
    profile_id: "p1",
    expression: "1 + 1",
    sessionId: "S2",
  });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Runtime.evaluate");
  assert.deepEqual(c.params, { expression: "1 + 1", returnByValue: true });
  assert.equal(c.sessionId, "S2");
  assert.equal(c.opts?.safe, true);
  assertNoDomainEnable(spy);
  await client.close();
});

test("wait_for_selector polls Runtime.evaluate(querySelector) and reports found", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  spy.respond = (method) =>
    method === "Runtime.evaluate" ? { result: { value: true } } : { ok: true };
  const client = await connect(spy);
  const { parsed } = await call(client, "wait_for_selector", {
    profile_id: "p1",
    selector: "#login",
  });
  assert.deepEqual(parsed, { found: true, selector: "#login" });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Runtime.evaluate");
  assert.equal(c.params?.expression, '!!document.querySelector("#login")');
  assert.equal(c.params?.returnByValue, true);
  assert.equal(c.opts?.safe, true);
  assertNoDomainEnable(spy);
  await client.close();
});

test("wait_for_selector returns found:false when the budget elapses", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  spy.respond = () => ({ result: { value: false } });
  const client = await connect(spy);
  const { parsed } = await call(client, "wait_for_selector", {
    profile_id: "p1",
    selector: "#never",
    timeout_ms: 1,
  });
  assert.deepEqual(parsed, { found: false, selector: "#never" });
  await client.close();
});

// ── pollUntil scoped-retry on transient navigation errors ────────────────────
// pollUntil (shared by wait_for_selector / wait_for_navigation / wait_for_load)
// must keep polling through transient "execution context destroyed" failures
// raised mid-navigation, but never mask a real error.

test("wait_for_selector swallows transient navigation errors and resolves once the context returns", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  let attempts = 0;
  spy.respond = (method) => {
    if (method !== "Runtime.evaluate") return { ok: true };
    attempts += 1;
    // The first couple of evaluations land while the page is reloading.
    if (attempts <= 2) throw new Error("Execution context was destroyed.");
    return { result: { value: true } };
  };
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "wait_for_selector", {
    profile_id: "p1",
    selector: "#login",
  });
  assert.equal(isError, false);
  assert.deepEqual(parsed, { found: true, selector: "#login" });
  assert.ok(attempts >= 3, "retried through the transient errors before succeeding");
  await client.close();
});

test("wait_for_selector rethrows a non-transient error immediately (no retry to timeout)", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  spy.respond = (method) => {
    if (method === "Runtime.evaluate") throw new Error("SyntaxError: 'foo[' is not a valid selector");
    return { ok: true };
  };
  const client = await connect(spy);
  // A generous budget: if a real error were (wrongly) retried this would spin
  // ~30s and rack up many calls. We assert it returns at once after one check.
  const { isError, parsed } = await call(client, "wait_for_selector", {
    profile_id: "p1",
    selector: "foo[",
    timeout_ms: 30000,
  });
  assert.equal(isError, true);
  assert.match(parsed.error.message, /not a valid selector/i);
  assert.doesNotMatch(parsed.error.message, /timed out/i, "surfaced the real error, not a timeout");
  const evals = spy.calls.filter((c) => c.method === "Runtime.evaluate");
  assert.equal(evals.length, 1, "thrown on the first check — no retry loop");
  await client.close();
});

test("wait_for_selector throws a clear timeout when transient errors persist past the budget", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  spy.respond = (method) => {
    if (method === "Runtime.evaluate") throw new Error("Cannot find context with specified id");
    return { ok: true };
  };
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "wait_for_selector", {
    profile_id: "p1",
    selector: "#login",
    timeout_ms: 1,
  });
  assert.equal(isError, true);
  assert.match(parsed.error.message, /timed out/i);
  assert.match(parsed.error.message, /Cannot find context/i, "names the underlying transient error");
  await client.close();
});

test("get_cookies composes Network.getCookies with an optional url filter", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);

  await call(client, "get_cookies", { profile_id: "p1" });
  assert.equal(spy.calls.at(-1)!.method, "Network.getCookies");
  assert.deepEqual(spy.calls.at(-1)!.params, {});

  await call(client, "get_cookies", { profile_id: "p1", urls: ["https://example.com"] });
  assert.deepEqual(spy.calls.at(-1)!.params, { urls: ["https://example.com"] });
  assert.equal(spy.calls.at(-1)!.opts?.safe, true);

  assertNoDomainEnable(spy);
  await client.close();
});

// NOTE: the implementation uses Network.setCookies (PLURAL) — a known,
// intentional deviation from the plan's "Network.setCookie". The test asserts
// the actual shipped behaviour.
test("set_cookies composes Network.setCookies (plural) with the cookie batch", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  const cookies = [
    { name: "sid", value: "abc", domain: "example.com" },
    { name: "theme", value: "dark" },
  ];
  await call(client, "set_cookies", { profile_id: "p1", cookies });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Network.setCookies");
  assert.deepEqual(c.params, { cookies });
  assert.equal(c.opts?.safe, true);
  assertNoDomainEnable(spy);
  await client.close();
});

test("list_tabs composes Target.getTargets", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  await call(client, "list_tabs", { profile_id: "p1" });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Target.getTargets");
  assert.deepEqual(c.params, {});
  assertNoDomainEnable(spy);
  await client.close();
});

test("new_tab composes Target.createTarget (defaulting url to about:blank)", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);

  await call(client, "new_tab", { profile_id: "p1" });
  assert.equal(spy.calls.at(-1)!.method, "Target.createTarget");
  assert.deepEqual(spy.calls.at(-1)!.params, { url: "about:blank" });

  await call(client, "new_tab", { profile_id: "p1", url: "https://example.com" });
  assert.deepEqual(spy.calls.at(-1)!.params, { url: "https://example.com" });

  assertNoDomainEnable(spy);
  await client.close();
});

test("activate_tab and close_tab compose Target.activateTarget / Target.closeTarget", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);

  await call(client, "activate_tab", { profile_id: "p1", target_id: "T7" });
  assert.equal(spy.calls.at(-1)!.method, "Target.activateTarget");
  assert.deepEqual(spy.calls.at(-1)!.params, { targetId: "T7" });

  await call(client, "close_tab", { profile_id: "p1", target_id: "T7" });
  assert.equal(spy.calls.at(-1)!.method, "Target.closeTarget");
  assert.deepEqual(spy.calls.at(-1)!.params, { targetId: "T7" });

  assertNoDomainEnable(spy);
  await client.close();
});

// NOTE: wait_for_navigation / wait_for_load poll document.readyState === "complete"
// via Runtime.evaluate — a known, intentional deviation from the plan's
// Page.loadEventFired event subscription.
for (const name of ["wait_for_navigation", "wait_for_load"] as const) {
  test(`${name} polls document.readyState and reports loaded`, async () => {
    const spy = new SpyDriver();
    spy.running.add("p1");
    spy.respond = (method) =>
      method === "Runtime.evaluate" ? { result: { value: "complete" } } : { ok: true };
    const client = await connect(spy);
    const { parsed } = await call(client, name, { profile_id: "p1" });
    assert.deepEqual(parsed, { loaded: true });
    const c = spy.calls.at(-1)!;
    assert.equal(c.method, "Runtime.evaluate");
    assert.equal(c.params?.expression, "document.readyState");
    assert.equal(c.params?.returnByValue, true);
    assert.equal(c.opts?.safe, true);
    assertNoDomainEnable(spy);
    await client.close();
  });
}

// ── negative / validation paths ─────────────────────────────────────────────

test("CDP tools require a running profile and return a clear error otherwise", async () => {
  const spy = new SpyDriver(); // nothing running
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "cdp_send", {
    profile_id: "ghost",
    method: "Runtime.evaluate",
  });
  assert.equal(isError, true);
  assert.equal(parsed.error.code, "INTERNAL_ERROR");
  assert.match(parsed.error.message, /not running/i);
  assert.match(parsed.error.message, /launch_profile/i);
  assert.equal(spy.calls.length, 0, "driver.cdpSend must not run for a stopped profile");
  await client.close();
});

test("cdp_send rejects a missing method via Zod (INVALID_INPUT)", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "cdp_send", { profile_id: "p1" });
  assert.equal(isError, true);
  assert.equal(parsed.error.code, "INVALID_INPUT");
  assert.equal(spy.calls.length, 0);
  await client.close();
});

test("set_cookies rejects an empty cookie array via Zod", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "set_cookies", { profile_id: "p1", cookies: [] });
  assert.equal(isError, true);
  assert.equal(parsed.error.code, "INVALID_INPUT");
  await client.close();
});

test("evaluate_js rejects a missing expression via Zod", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "evaluate_js", { profile_id: "p1" });
  assert.equal(isError, true);
  assert.equal(parsed.error.code, "INVALID_INPUT");
  await client.close();
});

// ── the shipped MockBrowserDriver (standalone dev mode) ──────────────────────

test("MockBrowserDriver echoes the safe flag end-to-end through the server", async () => {
  const mock = new MockBrowserDriver();
  await mock.launch("p1"); // mark running without needing the profile manager
  const client = await connect(mock);

  const safe = await call(client, "cdp_send", {
    profile_id: "p1",
    method: "Runtime.evaluate",
    params: { expression: "1" },
  });
  assert.equal(safe.parsed.mock, true);
  assert.equal(safe.parsed.method, "Runtime.evaluate");
  assert.deepEqual(safe.parsed.params, { expression: "1" });
  assert.equal(safe.parsed.safe, true);

  const raw = await call(client, "cdp_send_no_safety", {
    profile_id: "p1",
    method: "Network.enable",
  });
  assert.equal(raw.parsed.safe, false);
  assert.equal(raw.parsed.method, "Network.enable");

  await client.close();
});

test("MockBrowserDriver rejects CDP tools for a profile that was never launched", async () => {
  const mock = new MockBrowserDriver();
  const client = await connect(mock);
  const { isError, parsed } = await call(client, "list_tabs", { profile_id: "p1" });
  assert.equal(isError, true);
  assert.match(parsed.error.message, /not running/i);
  await client.close();
});
