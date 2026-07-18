/**
 * Standalone tsx verification for the MCP server CDP tool surface. No test
 * runner exists on master (project rule: do not add one) — this mirrors Phase 1:
 * a self-running script that connects a real MCP `Client` to the `Server` over
 * an in-memory transport and asserts every `tools/list` + `tools/call` round trip
 * against a recording `SpyDriver`. Exits non-zero on the first failed invariant.
 *
 * Run:
 *   node --import ./packages/mcp-server/node_modules/tsx/dist/loader.mjs \
 *        packages/mcp-server/scripts/test-cdp.ts
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMultizenMcpServer, type BrowserDriver } from "../src/server.ts";
import { MockBrowserDriver } from "../src/MockBrowserDriver.ts";
import type { ProfileManager } from "@multizen/profile-manager";
import type { LaunchedProfile, ProfileId } from "@multizen/types";

/** The 11 Phase-2 tools. `cdp_send_no_safety` is intentionally NOT here. */
const NEW_TOOLS = [
  "cdp_send",
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

class SpyDriver implements BrowserDriver {
  readonly running = new Set<string>();
  readonly calls: CdpCall[] = [];
  respond: (method: string, params?: Record<string, unknown>) => unknown = () => ({ ok: true });
  navigated: string[] = [];

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    this.running.add(profileId);
    return { id: profileId, cdpEndpoint: "http://127.0.0.1:0", pid: 1, startedAt: new Date().toISOString() };
  }
  async close(profileId: ProfileId): Promise<void> {
    this.running.delete(profileId);
  }
  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }
  async navigate(_profileId: ProfileId, url: string): Promise<{ url: string }> {
    this.navigated.push(url);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test harness reads arbitrary JSON
  parsed: any;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallResult> {
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

function assertNoDomainEnable(spy: SpyDriver): void {
  for (const c of spy.calls) {
    assert.ok(!/\.enable$/.test(c.method), `wrapper unexpectedly issued a domain enable: ${c.method}`);
  }
}

const tests: Array<[string, () => Promise<void>]> = [];
function test(name: string, fn: () => Promise<void>): void {
  tests.push([name, fn]);
}

// ── tools/list registration ─────────────────────────────────────────────────

test("tools/list exposes the 11 Phase-2 tools with object input schemas", async () => {
  const client = await connect(new SpyDriver());
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const name of NEW_TOOLS) {
    const tool = byName.get(name);
    assert.ok(tool, `tool ${name} is not registered`);
    assert.equal(typeof tool!.description, "string");
    assert.ok((tool!.description ?? "").length > 0, `tool ${name} has no description`);
    assert.equal((tool!.inputSchema as { type?: string }).type, "object");
  }
  await client.close();
});

test("cdp_send_no_safety is ABSENT from tools/list (gate #1)", async () => {
  const client = await connect(new SpyDriver());
  const { tools } = await client.listTools();
  assert.ok(!tools.some((t) => t.name === "cdp_send_no_safety"), "dropped tool must not be listed");
  await client.close();
});

test("cdp_send description no longer advertises cdp_send_no_safety", async () => {
  const client = await connect(new SpyDriver());
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "cdp_send");
  assert.ok(tool);
  assert.doesNotMatch(tool!.description ?? "", /cdp_send_no_safety/);
  await client.close();
});

// ── cdp_send composition (safe:true, verbatim) ───────────────────────────────

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

// ── convenience wrappers compose the right method, never enable ──────────────

test("evaluate_js composes Runtime.evaluate{returnByValue} (no domain enable)", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  await call(client, "evaluate_js", { profile_id: "p1", expression: "1 + 1", sessionId: "S2" });
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
  spy.respond = (method) => (method === "Runtime.evaluate" ? { result: { value: true } } : { ok: true });
  const client = await connect(spy);
  const { parsed } = await call(client, "wait_for_selector", { profile_id: "p1", selector: "#login" });
  assert.deepEqual(parsed, { found: true, selector: "#login" });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Runtime.evaluate");
  assert.equal(c.params?.expression, '!!document.querySelector("#login")');
  assert.equal(c.opts?.safe, true);
  assertNoDomainEnable(spy);
  await client.close();
});

test("get_cookies composes Network.getCookies with the required urls scope", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  await call(client, "get_cookies", { profile_id: "p1", urls: ["https://example.com"] });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Network.getCookies");
  assert.deepEqual(c.params, { urls: ["https://example.com"] });
  assert.equal(c.opts?.safe, true);
  assertNoDomainEnable(spy);
  await client.close();
});

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

test("list_tabs / new_tab / activate_tab / close_tab compose the right Target.* methods", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);

  await call(client, "list_tabs", { profile_id: "p1" });
  assert.equal(spy.calls.at(-1)!.method, "Target.getTargets");

  await call(client, "new_tab", { profile_id: "p1" });
  assert.deepEqual(spy.calls.at(-1)!.params, { url: "about:blank" });
  await call(client, "new_tab", { profile_id: "p1", url: "https://example.com" });
  assert.deepEqual(spy.calls.at(-1)!.params, { url: "https://example.com" });

  await call(client, "activate_tab", { profile_id: "p1", target_id: "T7" });
  assert.equal(spy.calls.at(-1)!.method, "Target.activateTarget");
  assert.deepEqual(spy.calls.at(-1)!.params, { targetId: "T7" });

  await call(client, "close_tab", { profile_id: "p1", target_id: "T7" });
  assert.equal(spy.calls.at(-1)!.method, "Target.closeTarget");
  assert.deepEqual(spy.calls.at(-1)!.params, { targetId: "T7" });

  assertNoDomainEnable(spy);
  await client.close();
});

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
    assert.equal(c.params?.expression, "document.readyState");
    assert.equal(c.opts?.safe, true);
    assertNoDomainEnable(spy);
    await client.close();
  });
}

// ── gate #2: method denylist (driver NOT called, code FORBIDDEN) ─────────────

for (const method of [
  "IO.read",
  "DOM.setFileInputFiles", // host-FS read via file input — hard blocker
  "Storage.getCookies",
  "Network.getAllCookies", // Network-domain alias of the bulk cookie dump — must also be denied
  "DOMStorage.getDOMStorageItems",
  "DOMStorage.setDOMStorageItem", // cross-origin storage write/tamper
  "IndexedDB.requestData",
  "IndexedDB.deleteDatabase", // cross-origin storage wipe
  "Browser.close",
  "Browser.crash", // DoS
  "Storage.clearCookies",
  "Network.clearBrowserCookies", // Network-domain destructive alias
  "Network.deleteCookies",
  "Network.clearBrowserCache",
  "Page.getResourceContent",
  "Page.searchInResource", // resource-content read (no enable needed) — hard blocker
  "Fetch.enable",
  "Fetch.requestPaused",
]) {
  test(`cdp_send denies ${method} → FORBIDDEN, driver not called`, async () => {
    const spy = new SpyDriver();
    spy.running.add("p1");
    const client = await connect(spy);
    const { isError, parsed } = await call(client, "cdp_send", { profile_id: "p1", method });
    assert.equal(isError, true);
    assert.equal(parsed.error.code, "FORBIDDEN");
    assert.equal(spy.calls.length, 0, "denied method must not reach the driver");
    await client.close();
  });
}

// ── gate #4 / #2: URL-scheme scan (incl. GURL bypass vectors) ────────────────

for (const url of ["file:///etc/passwd", "chrome://settings", "fi\tle:///x", "file:///x", "view-source:http://x"]) {
  test(`cdp_send{Page.navigate,url:${JSON.stringify(url)}} → FORBIDDEN, driver not called`, async () => {
    const spy = new SpyDriver();
    spy.running.add("p1");
    const client = await connect(spy);
    const { isError, parsed } = await call(client, "cdp_send", {
      profile_id: "p1",
      method: "Page.navigate",
      params: { url },
    });
    assert.equal(isError, true);
    assert.equal(parsed.error.code, "FORBIDDEN");
    assert.equal(spy.calls.length, 0, "blocked-scheme param must not reach the driver");
    await client.close();
  });

  test(`new_tab{url:${JSON.stringify(url)}} → FORBIDDEN, driver not called`, async () => {
    const spy = new SpyDriver();
    spy.running.add("p1");
    const client = await connect(spy);
    const { isError, parsed } = await call(client, "new_tab", { profile_id: "p1", url });
    assert.equal(isError, true);
    assert.equal(parsed.error.code, "FORBIDDEN");
    assert.equal(spy.calls.length, 0);
    await client.close();
  });
}

for (const url of ["file:///etc/passwd", "fi\tle:///x", "file:///x"]) {
  test(`navigate{url:${JSON.stringify(url)}} is rejected, driver.navigate not called`, async () => {
    const spy = new SpyDriver();
    spy.running.add("p1");
    const client = await connect(spy);
    const { isError, parsed } = await call(client, "navigate", { profile_id: "p1", url });
    assert.equal(isError, true);
    // file:/// parses as a URL (zod .url() passes) → FORBIDDEN via assertSafeUrl.
    assert.equal(parsed.error.code, "FORBIDDEN");
    assert.equal(spy.navigated.length, 0, "blocked navigate must not reach the driver");
    await client.close();
  });
}

// ── gate #3: get_cookies requires a non-empty urls scope ─────────────────────

test("get_cookies without urls → INVALID_INPUT, driver not called", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "get_cookies", { profile_id: "p1" });
  assert.equal(isError, true);
  assert.equal(parsed.error.code, "INVALID_INPUT");
  assert.equal(spy.calls.length, 0);
  await client.close();
});

test("get_cookies with an empty urls array → INVALID_INPUT", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "get_cookies", { profile_id: "p1", urls: [] });
  assert.equal(isError, true);
  assert.equal(parsed.error.code, "INVALID_INPUT");
  await client.close();
});

// ── pollUntil scoped-retry semantics ─────────────────────────────────────────

test("wait_for_selector returns found:false on a clean budget elapse", async () => {
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

test("wait_for_selector swallows transient navigation errors and resolves once the context returns", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  let attempts = 0;
  spy.respond = (method) => {
    if (method !== "Runtime.evaluate") return { ok: true };
    attempts += 1;
    if (attempts <= 2) throw new Error("Execution context was destroyed.");
    return { result: { value: true } };
  };
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "wait_for_selector", { profile_id: "p1", selector: "#login" });
  assert.equal(isError, false);
  assert.deepEqual(parsed, { found: true, selector: "#login" });
  assert.ok(attempts >= 3);
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
  const { isError, parsed } = await call(client, "wait_for_selector", {
    profile_id: "p1",
    selector: "foo[",
    timeout_ms: 30000,
  });
  assert.equal(isError, true);
  assert.match(parsed.error.message, /not a valid selector/i);
  assert.doesNotMatch(parsed.error.message, /timed out/i);
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
  assert.match(parsed.error.message, /Cannot find context/i);
  await client.close();
});

// ── running-profile guard + Zod validation ───────────────────────────────────

test("CDP tools require a running profile (driver not called otherwise)", async () => {
  const spy = new SpyDriver();
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "cdp_send", {
    profile_id: "ghost",
    method: "Runtime.evaluate",
  });
  assert.equal(isError, true);
  assert.match(parsed.error.message, /not running/i);
  assert.match(parsed.error.message, /launch_profile/i);
  assert.equal(spy.calls.length, 0);
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

// ── the shipped MockBrowserDriver echoes safe:true ──────────────────────────

test("MockBrowserDriver echoes the safe flag end-to-end through the server", async () => {
  const mock = new MockBrowserDriver();
  await mock.launch("p1");
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
  await client.close();
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
