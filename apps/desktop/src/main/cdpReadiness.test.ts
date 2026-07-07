import { test } from "node:test";
import assert from "node:assert/strict";

import {
  waitForCdpSessionReady,
  type ReadinessDeps,
  type ReadinessResponseLike,
} from "./cdpReadiness.ts";

/**
 * Coverage for the staged CDP readiness ladder. `fetch` and `sleep` are
 * injected so each stage's success and budget-exhaustion paths can be checked
 * deterministically without a real Chromium DevTools endpoint. A small real
 * (capped) sleep lets the wall-clock budget actually elapse.
 */

function ok(json: unknown): ReadinessResponseLike {
  return { ok: true, json: async () => json };
}
function notOk(): ReadinessResponseLike {
  return { ok: false, json: async () => ({}) };
}

function makeDeps(opts: {
  version?: () => ReadinessResponseLike;
  list?: () => ReadinessResponseLike;
}): { deps: ReadinessDeps; fetches: string[] } {
  const fetches: string[] = [];
  const deps: ReadinessDeps = {
    fetch: async (url: string) => {
      fetches.push(url);
      if (url.includes("/json/version")) return opts.version ? opts.version() : notOk();
      if (url.includes("/json/list")) return opts.list ? opts.list() : notOk();
      return notOk();
    },
    // Capped real delay so Date.now()-based budgets elapse without a busy spin.
    sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  };
  return { deps, fetches };
}

test("resolves once /json/version, a page target, and connect() all succeed", async () => {
  const { deps, fetches } = makeDeps({
    version: () => ok({}),
    list: () => ok([{ type: "page" }]),
  });
  let connects = 0;
  const session = {
    connect: async () => {
      connects += 1;
    },
  };
  await assert.doesNotReject(waitForCdpSessionReady(9300, session, 1000, deps));
  assert.equal(connects, 1);
  assert.ok(fetches.some((u) => u.includes("/json/version")));
  assert.ok(fetches.some((u) => u.includes("/json/list")));
});

test("throws a stage-1 error when /json/version never answers within the budget", async () => {
  const { deps } = makeDeps({
    version: () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const session = { connect: async () => {} };
  await assert.rejects(waitForCdpSessionReady(9301, session, 60, deps), (e: unknown) => {
    const msg = (e as Error).message;
    assert.match(msg, /\/json\/version not ready/);
    assert.match(msg, /60ms/);
    return true;
  });
});

test("throws a stage-2 error when no page target appears within the budget", async () => {
  const { deps } = makeDeps({
    version: () => ok({}),
    list: () => ok([{ type: "browser" }]), // a target, but never a page
  });
  const session = { connect: async () => {} };
  await assert.rejects(
    waitForCdpSessionReady(9302, session, 60, deps),
    /No CDP page target/,
  );
});

test("throws a stage-3 error when connect()/attach keeps failing within the budget", async () => {
  const { deps } = makeDeps({
    version: () => ok({}),
    list: () => ok([{ type: "page" }]),
  });
  const session = {
    connect: async () => {
      throw new Error("attach refused");
    },
  };
  await assert.rejects(
    waitForCdpSessionReady(9303, session, 60, deps),
    /connect\/attach failed/,
  );
});

test("retries connect() and succeeds on a later attempt (idempotent connect)", async () => {
  const { deps } = makeDeps({
    version: () => ok({}),
    list: () => ok([{ type: "page" }]),
  });
  let attempts = 0;
  const session = {
    connect: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("not attached yet");
    },
  };
  await assert.doesNotReject(waitForCdpSessionReady(9304, session, 2000, deps));
  assert.equal(attempts, 3);
});
