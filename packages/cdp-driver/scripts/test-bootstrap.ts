/**
 * Standalone target-bootstrap regression checks (no browser/test runner needed).
 * From the repository root:
 *   yarn workspace @multizen/mcp-server exec tsx ../cdp-driver/scripts/test-bootstrap.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CdpSession } from "../src/CdpSession.ts";

type Target = { targetId: string; type: "page" | "iframe" };
type Call = { method: string; params?: Record<string, unknown>; sessionId?: string };

function harness(engine: string, targets: Target[] = []) {
  const calls: Call[] = [];
  let serial = 0;
  const client = Object.assign(new EventEmitter(), {
    send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      calls.push({ method, params, sessionId });
      return {};
    },
    close: async () => {},
    Target: {
      getTargets: async () => ({ targetInfos: targets }),
      attachToTarget: async ({ targetId }: { targetId: string }) => {
        const sessionId = `attached-${++serial}`;
        client.emit("Target.attachedToTarget", {
          sessionId,
          targetInfo: targets.find((t) => t.targetId === targetId) ?? { targetId, type: "page" },
        });
        return { sessionId };
      },
      setDiscoverTargets: async () => {
        calls.push({ method: "Target.setDiscoverTargets" });
      },
      setAutoAttach: async () => {
        // CDP may emit the attachment before acknowledging setAutoAttach.
        client.emit("Target.attachedToTarget", {
          sessionId: "auto-frame",
          targetInfo: { targetId: "auto-frame-target", type: "iframe" },
        });
      },
    },
  });
  const session = new CdpSession({ port: 0, engine });
  (session as unknown as { client: unknown }).client = client;
  const start = () =>
    session.bootstrapTargets(
      async (send, ctx) => {
        await send("Test.setup", { ...ctx });
      },
      {
        onPageLoad: async (send, ctx) => {
          await send("Test.load", { ...ctx });
        },
      },
    );
  return { client, calls, session, start };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("initial targets receive correct contexts and auto-attach is armed before its response", async () => {
  const h = harness("cloakbrowser", [
    { targetId: "page", type: "page" },
    { targetId: "frame", type: "iframe" },
  ]);
  await h.start();
  await flush();
  assert.deepEqual(
    h.calls.filter((c) => c.method === "Test.setup").map((c) => c.params),
    [
      { isRoot: true, type: "page" },
      { isRoot: false, type: "page" },
      { isRoot: false, type: "iframe" },
      { isRoot: false, type: "iframe" },
    ],
  );
  assert.ok(
    h.calls.some(
      (c) => c.method === "Runtime.runIfWaitingForDebugger" && c.sessionId === "auto-frame",
    ),
  );
  await h.session.close();
});

test("new page discovery configures each attachment once and page-load skips iframes", async () => {
  const h = harness("cloakbrowser");
  await h.start();
  h.client.emit("Target.targetCreated", { targetInfo: { targetId: "new-page", type: "page" } });
  await flush();
  assert.equal(
    h.calls.filter((c) => c.method === "Test.setup" && c.sessionId === "attached-1").length,
    1,
  );
  h.client.emit("Page.loadEventFired", {}, "attached-1");
  h.client.emit("Page.loadEventFired", {}, "auto-frame");
  h.client.emit("Page.loadEventFired", {});
  await flush();
  assert.deepEqual(
    h.calls.filter((c) => c.method === "Test.load").map((c) => c.sessionId),
    ["attached-1", undefined],
  );
  await h.session.close();
});

for (const engine of ["cft", "cloakbrowser"]) {
  test(`${engine}: reattached target receives setup and page-load hook in the new session`, async () => {
    const h = harness(engine, [{ targetId: "page", type: "page" }]);
    await h.start();
    h.client.emit("Target.detachedFromTarget", { sessionId: "attached-1", targetId: "page" });
    h.client.emit("Target.attachedToTarget", {
      sessionId: "replacement",
      targetInfo: { targetId: "page", type: "page" },
    });
    await flush();
    assert.equal(
      h.calls.filter((c) => c.method === "Test.setup" && c.sessionId === "replacement").length,
      1,
    );
    h.client.emit("Page.loadEventFired", {}, "replacement");
    h.client.emit("Page.loadEventFired", {}, "attached-1");
    await flush();
    assert.deepEqual(
      h.calls.filter((c) => c.method === "Test.load").map((c) => c.sessionId),
      ["replacement"],
    );
    assert.equal(
      h.calls.some((c) => c.method === "Target.setDiscoverTargets"),
      engine === "cloakbrowser",
    );
    await h.session.close();
  });
}

test("destroyed target sessions no longer receive page-load hooks", async () => {
  const h = harness("cloakbrowser", [{ targetId: "page", type: "page" }]);
  await h.start();
  h.client.emit("Target.targetDestroyed", { targetId: "page" });
  h.client.emit("Page.loadEventFired", {}, "attached-1");
  await flush();
  assert.equal(h.calls.filter((c) => c.method === "Test.load").length, 0);
  await h.session.close();
});

test("a replacement iframe session is configured before it is resumed", async () => {
  const h = harness("cft");
  await h.start();
  await flush();
  h.client.emit("Target.detachedFromTarget", { sessionId: "auto-frame" });
  h.client.emit("Target.attachedToTarget", {
    sessionId: "replacement-frame",
    targetInfo: { targetId: "auto-frame-target", type: "iframe" },
  });
  await flush();
  assert.deepEqual(
    h.calls.filter((c) => c.sessionId === "replacement-frame").map((c) => c.method),
    ["Test.setup", "Runtime.runIfWaitingForDebugger"],
  );
  await h.session.close();
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n${String(e)}`);
  }
}
console.log(`${tests.length - failures}/${tests.length} passed`);
if (failures) process.exitCode = 1;
