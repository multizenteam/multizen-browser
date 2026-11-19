import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";
import type { SyncObjectStore, TrustEntry } from "@multizen/mcp-gateway";
import { parseProjectConfig } from "@multizen/mcp-gateway";

import { GatewaySyncBridge } from "../GatewaySyncBridge.ts";
import { GatewayService } from "../GatewayService.ts";
import { GatewayController } from "../GatewayController.ts";
import { GatewayVault } from "../GatewayVault.ts";
import { fakeStdioFactory, MemoryVault } from "./testSupport.ts";

/**
 * GENUINE two-device tests.
 *
 * The distinction that matters: a real second device has its OWN vault, so its
 * own Ed25519 signing key AND its own config-sync salt. The pre-existing
 * "salt reuse" test built a second bridge over the SAME vault, which shares both
 * — a second bridge instance with one device identity, proving far less than it
 * appeared to. Everything here uses two separate `MemoryVault`s over one shared
 * store and one shared password, which is exactly the real topology.
 *
 * What these tests establish:
 *   - device B decrypts A's configs with only the password, because the KDF salt
 *     travels in the authenticated envelope header;
 *   - B adopts A's trust registry rather than forking a second root;
 *   - B's own publishes are refused until A approves B — and, critically, that
 *     refusal must not destroy B's local copy.
 */

const PREFIX = "repo/control";
const PASSWORD = "operator-encryption-password";

function project(id: string, enabled = true, env: Record<string, string> = {}) {
  return parseProjectConfig({
    configVersion: 1,
    id,
    enabled,
    localAuth: { enabled: false },
    servers: [
      { transport: "stdio", id: "s1", disabled: false, command: "echo", args: [], env },
    ],
  });
}

/** One device: its own vault (own salt + own signing key) over a shared store. */
async function device(store: SyncObjectStore, password = PASSWORD) {
  const vault = new MemoryVault();
  const gv = new GatewayVault(vault);
  const signingKey = await gv.getOrCreateSigningKey();
  const saltHex = await gv.getOrCreateSaltHex();
  const bridge = new GatewaySyncBridge({
    store,
    controlPrefix: PREFIX,
    password,
    saltHex,
    signingKey,
  });
  return { bridge, vault, signingKey, saltHex };
}

function sharedStore(): SyncObjectStore {
  return new InMemoryConditionalObjectStore() as unknown as SyncObjectStore;
}

test("two devices genuinely differ: separate signing keys and separate salts", async () => {
  const store = sharedStore();
  const a = await device(store);
  const b = await device(store);

  assert.notEqual(a.signingKey.deviceId, b.signingKey.deviceId);
  assert.notEqual(a.signingKey.publicKeyHex, b.signingKey.publicKeyHex);
  assert.notEqual(a.saltHex, b.saltHex, "a real second device derives its own salt");
});

test("a second device restores every project with only the shared password", async () => {
  const store = sharedStore();
  const a = await device(store);
  await a.bridge.ensureTrustRegistry();
  await a.bridge.publish(project("alpha"), 1);
  await a.bridge.publish(project("beta", false), 1);

  // Device B has a DIFFERENT salt. It can still decrypt, because `open()`
  // derives the key from the salt carried in the authenticated envelope header.
  const b = await device(store);
  const restored = await b.bridge.restoreAll();

  assert.deepEqual(
    restored.applied.map((x) => x.projectId).sort(),
    ["alpha", "beta"],
    "both enabled and disabled projects come back",
  );
  assert.equal(restored.quarantined.length, 0);
  assert.equal(
    restored.applied.find((x) => x.projectId === "beta")?.config.enabled,
    false,
    "desired state is preserved, not normalised to enabled",
  );
});

test("a second device adopts the existing trust root instead of forking one", async () => {
  const store = sharedStore();
  const a = await device(store);
  const rootA = await a.bridge.ensureTrustRegistry();

  const b = await device(store);
  const seenByB = await b.bridge.ensureTrustRegistry();

  assert.equal(seenByB.revision, rootA.revision);
  assert.deepEqual(
    seenByB.entries.map((e) => e.deviceId),
    [a.signingKey.deviceId],
    "B adopts A's registry and does NOT add itself",
  );
  assert.ok(
    !seenByB.entries.some((e) => e.deviceId === b.signingKey.deviceId),
    "an unapproved device is not silently trusted",
  );
});

test("an unapproved second device cannot self-approve", async () => {
  const store = sharedStore();
  const a = await device(store);
  await a.bridge.ensureTrustRegistry();
  const b = await device(store);
  await b.bridge.ensureTrustRegistry();

  await assert.rejects(
    () =>
      b.bridge.approveDevice([
        { deviceId: a.signingKey.deviceId, publicKeyHex: a.signingKey.publicKeyHex, role: "trusted" },
        { deviceId: b.signingKey.deviceId, publicKeyHex: b.signingKey.publicKeyHex, role: "trusted" },
      ] as TrustEntry[]),
    /not an active trusted admin/,
    "promotion must come from an already-trusted device",
  );
});

test("device B's publishes are quarantined until A approves B, then apply", async () => {
  const store = sharedStore();
  const a = await device(store);
  await a.bridge.ensureTrustRegistry();
  const b = await device(store);
  await b.bridge.publish(project("fromb"), 1);

  // Before approval: A refuses B's record and names the reason.
  const before = await a.bridge.restoreAll();
  const q = before.quarantined.find((x) => x.projectId === "fromb");
  assert.equal(q?.code, "unknown-signer");
  assert.ok(
    q?.reason.includes(b.signingKey.deviceId),
    `the refusal should name the untrusted device, got: ${q?.reason}`,
  );

  // A approves B.
  const updated = await a.bridge.approveDevice([
    { deviceId: a.signingKey.deviceId, publicKeyHex: a.signingKey.publicKeyHex, role: "trusted" },
    { deviceId: b.signingKey.deviceId, publicKeyHex: b.signingKey.publicKeyHex, role: "trusted" },
  ] as TrustEntry[]);
  assert.equal(updated.revision, 2);

  // After approval the same stored record applies with no republish.
  const after = await a.bridge.restoreAll();
  assert.ok(
    after.applied.some((x) => x.projectId === "fromb"),
    "approval retroactively accepts the already-published record",
  );
  assert.equal(after.quarantined.length, 0);
});

test("a revoked device's records stop being accepted", async () => {
  const store = sharedStore();
  const a = await device(store);
  await a.bridge.ensureTrustRegistry();
  const b = await device(store);
  await a.bridge.approveDevice([
    { deviceId: a.signingKey.deviceId, publicKeyHex: a.signingKey.publicKeyHex, role: "trusted" },
    { deviceId: b.signingKey.deviceId, publicKeyHex: b.signingKey.publicKeyHex, role: "trusted" },
  ] as TrustEntry[]);
  await b.bridge.publish(project("fromb"), 1);
  assert.ok((await a.bridge.restoreAll()).applied.some((x) => x.projectId === "fromb"));

  await a.bridge.approveDevice([
    { deviceId: a.signingKey.deviceId, publicKeyHex: a.signingKey.publicKeyHex, role: "trusted" },
    { deviceId: b.signingKey.deviceId, publicKeyHex: b.signingKey.publicKeyHex, role: "revoked" },
  ] as TrustEntry[]);

  const after = await a.bridge.restoreAll();
  assert.equal(after.applied.length, 0);
  assert.equal(after.quarantined.find((x) => x.projectId === "fromb")?.code, "revoked-signer");
});

test("a wrong password fails cleanly as a decrypt quarantine, not a crash", async () => {
  const store = sharedStore();
  const a = await device(store);
  await a.bridge.ensureTrustRegistry();
  await a.bridge.publish(project("alpha"), 1);

  // Same bucket, same trust registry, WRONG password.
  const wrong = await device(store, "not-the-operator-password");
  const restored = await wrong.bridge.restoreAll();

  assert.equal(restored.applied.length, 0, "nothing is applied on a bad password");
  const q = restored.quarantined.find((x) => x.projectId === "alpha");
  assert.equal(q?.code, "decrypt");
  assert.ok(
    !q?.reason.includes(PASSWORD) && !q?.reason.includes("not-the-operator-password"),
    "the failure must not echo either password",
  );
});

test("a restoring device receives references only — never a credential value", async () => {
  const store = sharedStore();
  const a = await device(store);
  await a.bridge.ensureTrustRegistry();
  // The config only ever holds ${NAME}; the value lives in A's local keychain.
  await a.bridge.publish(project("alpha", true, { API_TOKEN: "${MULTIZEN_S1_API_TOKEN_AB12CD}" }), 1);

  const b = await device(store);
  const restored = await b.bridge.restoreAll();
  const serialized = JSON.stringify(restored.applied);

  assert.match(serialized, /\$\{MULTIZEN_S1_API_TOKEN_AB12CD\}/, "the reference travels");
  assert.ok(!serialized.includes("sk-"), "no credential value is present");
  // And nothing in the bucket carries a value either.
  const page = await store.list(`${PREFIX}/`, { maxKeys: 1000 });
  for (const key of page.keys) {
    const got = await store.get(key);
    const text = Buffer.from(got.bytes).toString("utf8");
    assert.ok(!text.includes("sk-"), `object ${key} must not contain a credential value`);
  }
});

// ── service-level consequences ───────────────────────────────────────────────

function makeService(dataDir: string, vault: MemoryVault, store: SyncObjectStore) {
  return new GatewayService({
    dataDir,
    vault,
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    syncMaterials: async () => ({
      store,
      controlPrefix: PREFIX,
      password: PASSWORD,
      deviceId: "test-device",
    }),
  });
}

test("an unapproved device does NOT lose its own local project to quarantine", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "gw-xdev-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "gw-xdev-b-"));
  try {
    const store = sharedStore();

    // Device A establishes the trust root so B is definitively not trusted.
    const a = await device(store);
    await a.bridge.ensureTrustRegistry();

    // Device B: create a project locally. It publishes, signed by B's key.
    const svcB = makeService(dirB, new MemoryVault(), store);
    await svcB.start();
    const ctlB = new GatewayController(svcB, {
      baseUrl: svcB.baseUrl,
      routesServed: () => true,
    });
    const created = await ctlB.createProject({ id: "mine", enabled: true });
    assert.equal(created.ok, true);
    await ctlB.addServer("mine", {
      transport: "stdio",
      id: "srv",
      command: "echo",
      args: [],
    });
    assert.equal(svcB.configOf("mine")?.id, "mine");

    // Now B syncs again. Its own remote record is signed by an untrusted device,
    // so verification refuses it. Refusing a REMOTE record must never delete the
    // LOCAL config that this device authored and is actively serving.
    await svcB.syncNow();

    assert.notEqual(
      svcB.configOf("mine"),
      null,
      "B must keep serving its own project while it waits for approval",
    );
    const listed = await ctlB.listProjects();
    assert.ok(
      listed.ok && listed.value.some((p) => p.id === "mine"),
      "the project must remain visible in the UI",
    );
    // The refusal is still reported, so the operator can see why it is not shared.
    const q = ctlB.quarantine();
    assert.ok(q.ok && q.value.some((x) => x.projectId === "mine"));
    assert.equal(
      q.ok && q.value.find((x) => x.projectId === "mine")?.localRetained,
      true,
      "the record is marked as refused-remotely-but-kept-locally",
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("a hostile head written by a bucket writer cannot delete a local project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-xdev-dos-"));
  try {
    const store = sharedStore();
    const svc = makeService(dir, new MemoryVault(), store);
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });
    await ctl.createProject({ id: "mine", enabled: true });
    await ctl.addServer("mine", {
      transport: "stdio",
      id: "srv",
      command: "echo",
      args: [],
    });
    await svc.syncNow();
    assert.notEqual(svc.configOf("mine"), null, "baseline: the project is live");

    // Someone with bucket WRITE access but no signing key overwrites the head
    // with garbage. Previously this deleted the local config — a denial of
    // service against a project by anyone who can write the bucket.
    const headKey = `${PREFIX}/mcp/projects/mine/state.json`;
    const existing = await store.get(headKey);
    await store.putCompareAndSwap(
      headKey,
      new TextEncoder().encode('{"recordVersion":1,"garbage":true}'),
      existing.etag,
    );

    await svc.syncNow();

    assert.notEqual(
      svc.configOf("mine"),
      null,
      "a garbage remote record must not take the local project down",
    );
    const q = ctl.quarantine();
    assert.equal(q.ok && q.value.find((x) => x.projectId === "mine")?.localRetained, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a quarantined project with no local copy still never starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-xdev-remote-"));
  try {
    const store = sharedStore();
    // Device A owns the trust root; device B publishes something A will refuse.
    const a = await device(store);
    await a.bridge.ensureTrustRegistry();
    const b = await device(store);
    await b.bridge.publish(project("theirs"), 1);

    // A restores: "theirs" has no local copy, so there is nothing to retain and
    // it must stay inert.
    const svc = makeService(dir, a.vault, store);
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });

    assert.equal(svc.configOf("theirs"), null, "never applied");
    assert.equal(svc.runtime.status().length, 0, "nothing started");
    const q = ctl.quarantine();
    const rec = q.ok ? q.value.find((x) => x.projectId === "theirs") : undefined;
    assert.equal(rec?.code, "unknown-signer");
    assert.equal(rec?.localRetained, false, "there was no local copy to keep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("retry composes sync when Cloud Sync became ready AFTER the gateway started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-late-sync-"));
  try {
    const store = sharedStore();
    // Another device has already published a project into the bucket.
    const a = await device(store);
    await a.bridge.ensureTrustRegistry();
    await a.bridge.publish(project("published"), 1);

    // This device starts with Cloud Sync NOT ready — the ordinary first-run
    // sequence, since the gateway comes up before the operator has configured a
    // bucket. Previously this left projects local-only until an app restart.
    let ready = false;
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      syncMaterials: async () =>
        ready
          ? { store, controlPrefix: PREFIX, password: PASSWORD, deviceId: "late" }
          : null,
    });
    await svc.start();

    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });
    const before = ctl.syncStatus();
    assert.equal(before.ok && before.value.ready, false, "nothing composed yet");
    assert.equal(svc.configOf("published"), null, "and nothing restored");

    // The operator configures Cloud Sync, then presses Retry.
    ready = true;
    const after = await ctl.syncRetry();

    assert.equal(after.ok && after.value.ready, true, "retry composed the bridge");
    assert.equal(after.ok && after.value.applied, 1);
    assert.notEqual(
      svc.configOf("published"),
      null,
      "the remote project is restored without an app restart",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retry is safe when Cloud Sync is still not configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-no-sync-"));
  try {
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
    });
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });

    const res = await ctl.syncRetry();
    assert.equal(res.ok, true, "retry reports a state rather than throwing");
    assert.equal(res.ok && res.value.ready, false);
    assert.equal(res.ok && res.value.lastError, null, "not-configured is not an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ── automatic re-sync ────────────────────────────────────────────────────────

/** A service with an injectable clock and no background timer, for the scheduler. */
function makeSchedulable(
  dataDir: string,
  store: SyncObjectStore,
  clock: { now: number },
  opts: { minIntervalMs?: number; materialsReady?: () => boolean } = {},
) {
  return new GatewayService({
    dataDir,
    vault: new MemoryVault(),
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    // The timer is disabled so these tests drive maybeSync() directly instead of
    // sleeping; the timer itself is covered by the shutdown test below.
    autoSync: { intervalMs: 0, ...(opts.minIntervalMs !== undefined ? { minIntervalMs: opts.minIntervalMs } : {}) },
    now: () => clock.now,
    syncMaterials: async () =>
      (opts.materialsReady?.() ?? true)
        ? { store, controlPrefix: PREFIX, password: PASSWORD, deviceId: "sched" }
        : null,
  });
}

test("a remote change is picked up without a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-auto-"));
  try {
    const store = sharedStore();
    const a = await device(store);
    await a.bridge.ensureTrustRegistry();

    const clock = { now: 1_000_000 };
    const svc = makeSchedulable(dir, store, clock);
    await svc.start();
    assert.equal(svc.configOf("later"), null, "not there at startup");

    // Another device publishes while this one is already running.
    await a.bridge.publish(project("later"), 1);

    clock.now += 60_000;
    assert.equal(await svc.maybeSync("timer"), true);
    assert.notEqual(svc.configOf("later"), null, "the new project arrived on its own");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("focus passes are rate limited, but the timer is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-auto-rate-"));
  try {
    const store = sharedStore();
    const a = await device(store);
    await a.bridge.ensureTrustRegistry();
    const clock = { now: 1_000_000 };
    const svc = makeSchedulable(dir, store, clock, { minIntervalMs: 30_000 });
    await svc.start();

    assert.equal(await svc.maybeSync("focus"), true, "the first focus pass runs");
    clock.now += 5_000;
    assert.equal(
      await svc.maybeSync("focus"),
      false,
      "refocusing inside the floor must not hit the bucket again",
    );
    clock.now += 30_000;
    assert.equal(await svc.maybeSync("focus"), true, "past the floor it runs again");

    // The background timer is the scheduled cadence and is not floored.
    assert.equal(await svc.maybeSync("timer"), true);
    assert.equal(await svc.maybeSync("timer"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit retry is never blocked by the focus floor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-auto-retry-"));
  try {
    const store = sharedStore();
    const a = await device(store);
    await a.bridge.ensureTrustRegistry();
    const clock = { now: 1_000_000 };
    const svc = makeSchedulable(dir, store, clock, { minIntervalMs: 60_000 });
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });

    await svc.maybeSync("focus");
    await a.bridge.publish(project("urgent"), 1);
    // Still well inside the floor — a user-initiated retry must ignore it.
    const res = await ctl.syncRetry();
    assert.equal(res.ok && res.value.applied, 1);
    assert.notEqual(svc.configOf("urgent"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent triggers collapse onto a single pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-auto-single-"));
  try {
    const store = sharedStore();
    const a = await device(store);
    await a.bridge.ensureTrustRegistry();
    await a.bridge.publish(project("alpha"), 1);

    // Count how many discovery listings reach the store: one pass lists once.
    let listCalls = 0;
    const counting: SyncObjectStore = {
      get: (k) => store.get(k),
      putCreate: (k, b) => store.putCreate(k, b),
      putCompareAndSwap: (k, b, e) => store.putCompareAndSwap(k, b, e),
      putImmutable: (k, b) => store.putImmutable(k, b),
      list: (p, o) => {
        if (p.includes("/mcp/projects/")) listCalls += 1;
        return store.list(p, o);
      },
    };

    const clock = { now: 1_000_000 };
    const svc = makeSchedulable(dir, counting, clock);
    await svc.start();
    const baseline = listCalls;

    await Promise.all([
      svc.maybeSync("timer"),
      svc.maybeSync("timer"),
      svc.maybeSync("timer"),
      svc.syncNow(),
    ]);

    assert.equal(
      listCalls - baseline,
      1,
      "three triggers plus a direct call collapse onto one in-flight pass",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic sync composes once Cloud Sync becomes ready, with no retry press", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-auto-compose-"));
  try {
    const store = sharedStore();
    const a = await device(store);
    await a.bridge.ensureTrustRegistry();
    await a.bridge.publish(project("waiting"), 1);

    let ready = false;
    const clock = { now: 1_000_000 };
    const svc = makeSchedulable(dir, store, clock, { materialsReady: () => ready });
    await svc.start();
    assert.equal(svc.syncStatusView().ready, false);
    assert.equal(await svc.maybeSync("timer"), false, "nothing to do while unconfigured");

    // The operator configures Cloud Sync and does nothing else.
    ready = true;
    assert.equal(await svc.maybeSync("timer"), true);
    assert.equal(svc.syncStatusView().ready, true);
    assert.notEqual(svc.configOf("waiting"), null, "composed and restored unattended");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the background timer starts on start() and is cleared on shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-auto-timer-"));
  try {
    const store = sharedStore();
    const a = await device(store);
    await a.bridge.ensureTrustRegistry();

    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 15, minIntervalMs: 0 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "timer",
      }),
    });
    await svc.start();
    assert.equal(svc.autoSyncActive, true, "start() arms the timer");

    // A pass includes scrypt derivation, so poll rather than assume a fixed
    // window is enough. This proves the timer really drives a pass unattended.
    await a.bridge.publish(project("ticked"), 1);
    const deadline = Date.now() + 10_000;
    while (svc.configOf("ticked") === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.notEqual(svc.configOf("ticked"), null, "the timer ran a pass unattended");

    await svc.shutdown();
    // Asserted on the handle, not by waiting to see nothing happen: a pass can
    // outlast any test window, which would make a "nothing appeared" assertion
    // pass even with a leaked timer.
    assert.equal(svc.autoSyncActive, false, "shutdown cleared the timer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startAutoSync is idempotent and a zero cadence disables the timer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-auto-idem-"));
  try {
    const store = sharedStore();
    const clock = { now: 1_000_000 };
    const svc = makeSchedulable(dir, store, clock);
    await svc.start();
    // makeSchedulable passes intervalMs: 0, so no timer is ever armed.
    assert.equal(svc.autoSyncActive, false, "a zero cadence means no timer");
    svc.startAutoSync();
    assert.equal(svc.autoSyncActive, false, "still nothing to arm");
    svc.stopAutoSync();
    svc.stopAutoSync();
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arming the timer twice does not leave a second interval behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-auto-double-"));
  try {
    const store = sharedStore();
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 5_000 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "double",
      }),
    });
    await svc.start();
    assert.equal(svc.autoSyncActive, true);
    svc.startAutoSync();
    svc.startAutoSync();
    // One stop must fully disarm: if a second interval had been created, the
    // first handle would be orphaned and keep firing forever.
    svc.stopAutoSync();
    assert.equal(svc.autoSyncActive, false, "a single stop disarms completely");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ── device discovery and approval ────────────────────────────────────────────

test("an unapproved device announces itself so an admin can find it", async () => {
  const store = sharedStore();
  const a = await device(store);
  await a.bridge.ensureTrustRegistry();

  const b = await device(store);
  await b.bridge.announceSelf("Bea’s laptop");

  // Device A can now discover B, which the registry alone could never tell it.
  const pending = await a.bridge.listPendingDevices();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.deviceId, b.signingKey.deviceId);
  assert.equal(pending[0]?.publicKeyHex, b.signingKey.publicKeyHex);
  assert.equal(pending[0]?.name, "Bea’s laptop");
});

test("an announcement carries no secret and grants no authority", async () => {
  const store = sharedStore();
  const a = await device(store);
  await a.bridge.ensureTrustRegistry();
  const b = await device(store);
  await b.bridge.announceSelf("Bea’s laptop");

  // Announcing does not make B trusted: its configs are still refused.
  await b.bridge.publish(project("fromb"), 1);
  const restored = await a.bridge.restoreAll();
  assert.equal(restored.quarantined.find((q) => q.projectId === "fromb")?.code, "unknown-signer");

  // And the announcement object holds nothing sensitive.
  const page = await store.list(`${PREFIX}/mcp/trust/pending/`, { maxKeys: 10 });
  assert.equal(page.keys.length, 1);
  const body = Buffer.from((await store.get(page.keys[0]!)).bytes).toString("utf8");
  assert.ok(!body.includes(PASSWORD));
  assert.ok(!body.includes("PRIVATE KEY"));
});

test("re-announcing updates the name instead of failing or duplicating", async () => {
  const store = sharedStore();
  const b = await device(store);
  await b.bridge.announceSelf("old name");
  await b.bridge.announceSelf("new name");

  const pending = await b.bridge.listPendingDevices();
  assert.equal(pending.length, 1, "one record per device");
  assert.equal(pending[0]?.name, "new name");
});

test("an announcement that lies about its device id is ignored", async () => {
  const store = sharedStore();
  const a = await device(store);
  await a.bridge.ensureTrustRegistry();
  const b = await device(store);
  await b.bridge.announceSelf("honest");

  // Rewrite the stored record to claim a different device id. The id is derived
  // from the public key, so the mismatch must be detected.
  const key = `${PREFIX}/mcp/trust/pending/${b.signingKey.deviceId}.json`;
  const got = await store.get(key);
  const tampered = JSON.parse(Buffer.from(got.bytes).toString("utf8")) as Record<string, unknown>;
  tampered.name = "impostor";
  await store.putCompareAndSwap(
    key,
    new TextEncoder().encode(JSON.stringify(tampered)),
    got.etag,
  );

  // The signature no longer covers the body, so the record is dropped entirely.
  assert.deepEqual(await a.bridge.listPendingDevices(), []);
});

test("the trust list merges registry roles with announced names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-trust-list-"));
  try {
    const store = sharedStore();
    const vaultA = new MemoryVault();
    const svc = new GatewayService({
      dataDir: dir,
      vault: vaultA,
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      deviceName: "Alpha workstation",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "a",
      }),
    });
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });

    // A second device announces itself but is not approved.
    const b = await device(store);
    await b.bridge.announceSelf("Bea’s laptop");

    const list = await ctl.trustList();
    assert.equal(list.ok, true);
    if (!list.ok) return;

    const self = list.value.find((d) => d.isSelf);
    assert.equal(self?.role, "trusted", "the bootstrapping device is the trust root");

    const pendingRow = list.value.find((d) => d.deviceId === b.signingKey.deviceId);
    assert.equal(pendingRow?.role, "pending", "an announced-but-absent device is pending");
    assert.equal(pendingRow?.name, "Bea’s laptop");
    assert.equal(pendingRow?.isSelf, false);
    assert.ok(pendingRow?.announcedAt !== undefined, "first-seen time is surfaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approving a pending device makes its refused records apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-trust-approve-"));
  try {
    const store = sharedStore();
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "a",
      }),
    });
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });

    const b = await device(store);
    await b.bridge.announceSelf("Bea’s laptop");
    await b.bridge.publish(project("fromb"), 1);
    await svc.syncNow();
    assert.equal(svc.configOf("fromb"), null, "refused before approval");

    const approved = await ctl.approveDevice(
      b.signingKey.deviceId,
      b.signingKey.publicKeyHex,
    );
    assert.equal(approved.ok, true);

    await svc.syncNow();
    assert.notEqual(
      svc.configOf("fromb"),
      null,
      "the already-published record applies after approval, with no republish",
    );
    const list = await ctl.trustList();
    assert.equal(
      list.ok && list.value.find((d) => d.deviceId === b.signingKey.deviceId)?.role,
      "trusted",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revoking stops accepting a device's later records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-trust-revoke-"));
  try {
    const store = sharedStore();
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "a",
      }),
    });
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });
    const b = await device(store);
    await ctl.approveDevice(b.signingKey.deviceId, b.signingKey.publicKeyHex);

    const revoked = await ctl.revokeDevice(b.signingKey.deviceId);
    assert.equal(revoked.ok, true);

    await b.bridge.publish(project("afterrevoke"), 1);
    await svc.syncNow();
    assert.equal(svc.configOf("afterrevoke"), null, "a revoked device is refused");
    const q = ctl.quarantine();
    assert.equal(
      q.ok && q.value.find((x) => x.projectId === "afterrevoke")?.code,
      "revoked-signer",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unapproved device's approval attempt is reported, not swallowed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-trust-notadmin-"));
  try {
    const store = sharedStore();
    // Another device owns the trust root, so this one is not an admin.
    const root = await device(store);
    await root.bridge.ensureTrustRegistry();

    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "b",
      }),
    });
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });

    const other = await device(store);
    const res = await ctl.approveDevice(other.signingKey.deviceId, other.signingKey.publicKeyHex);
    assert.equal(res.ok, false, "a non-admin cannot grant trust");
    assert.equal(res.ok === false && res.error.code, "trust");
    assert.match(
      res.ok === false ? res.error.message : "",
      /not an active trusted admin/,
      "the real reason is surfaced so the UI can explain it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a device that composes sync announces itself automatically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-trust-auto-announce-"));
  try {
    const store = sharedStore();
    // Someone else is the trust root, so this device starts unapproved.
    const root = await device(store);
    await root.bridge.ensureTrustRegistry();

    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      deviceName: "Auto announced",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "auto",
      }),
    });
    await svc.start();

    // The admin device sees it without anyone pressing anything.
    const pending = await root.bridge.listPendingDevices();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.name, "Auto announced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the trust root does not announce itself as pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-trust-root-"));
  try {
    const store = sharedStore();
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      deviceName: "First device",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "first",
      }),
    });
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });

    const list = await ctl.trustList();
    assert.equal(list.ok && list.value.length, 1, "only itself");
    assert.equal(list.ok && list.value[0]?.role, "trusted");
    assert.equal(list.ok && list.value[0]?.isSelf, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the current device can publish and persist a new display name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-trust-rename-"));
  try {
    const store = sharedStore();
    const persisted: string[] = [];
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      deviceName: "This device",
      onDeviceNameChanged: async (name) => {
        persisted.push(name);
      },
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "rename",
      }),
    });
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });

    assert.equal((await ctl.renameDevice("  Studio   Mac  ")).ok, true);
    assert.deepEqual(persisted, ["Studio Mac"]);
    const list = unwrap(await ctl.trustList());
    assert.equal(list.find((device) => device.isSelf)?.name, "Studio Mac");

    const empty = await ctl.renameDevice("   ");
    assert.equal(empty.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── conflicts ────────────────────────────────────────────────────────────────

/** Unwrap an ok envelope, failing the test if it is an error. */
function unwrap<T>(res: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  assert.equal(res.ok, true, res.ok ? "" : res.error.message);
  if (!res.ok) throw new Error("unreachable");
  return res.value;
}

/** A trusted pair of devices sharing one bucket, both able to publish. */
async function trustedPair(store: SyncObjectStore, dirA: string) {
  const svc = new GatewayService({
    dataDir: dirA,
    vault: new MemoryVault(),
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    autoSync: { intervalMs: 0 },
    syncMaterials: async () => ({
      store,
      controlPrefix: PREFIX,
      password: PASSWORD,
      deviceId: "a",
    }),
  });
  await svc.start();
  const ctl = new GatewayController(svc, {
    baseUrl: svc.baseUrl,
    routesServed: () => true,
  });
  // A bootstrapped the root; approve B so both can publish.
  const b = await device(store);
  await ctl.approveDevice(b.signingKey.deviceId, b.signingKey.publicKeyHex);
  return { svc, ctl, b };
}

test("a losing local edit is kept, not silently overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-conflict-keep-"));
  try {
    const store = sharedStore();
    const { svc, ctl, b } = await trustedPair(store, dir);

    await ctl.createProject({ id: "shared", label: "Mine", enabled: true });
    assert.equal(svc.lastRevision("shared"), 1);

    // Device B advances the remote past us.
    await b.bridge.publish(project("shared"), 2);

    // Now this device edits locally. The publish loses the CAS.
    const updated = await ctl.updateProject("shared", { label: "My local name" });
    assert.equal(updated.ok, true);

    const conflicts = ctl.conflicts();
    assert.equal(conflicts.ok, true);
    if (!conflicts.ok) return;
    assert.equal(conflicts.value.length, 1, "the clash is recorded for a decision");
    assert.equal(conflicts.value[0]?.projectId, "shared");
    assert.equal(conflicts.value[0]?.remoteRevision, 2);
    // The stored copy is never shipped to the renderer.
    assert.ok(!("losingConfigJson" in (conflicts.value[0] as object)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeping mine republishes the local edit so other devices pick it up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-conflict-mine-"));
  try {
    const store = sharedStore();
    const { svc, ctl, b } = await trustedPair(store, dir);
    await ctl.createProject({ id: "shared", label: "Original", enabled: true });
    await b.bridge.publish(project("shared"), 2);
    await ctl.updateProject("shared", { label: "My local name" });
    await svc.syncNow();

    // After the pass the remote version is authoritative locally.
    assert.equal(svc.configOf("shared")?.label, undefined, "B's copy has no label");

    const res = await ctl.resolveConflicts("shared", "mine");
    assert.equal(res.ok, true);

    // The local edit is back, published above the remote, and the clash is gone.
    assert.equal(svc.configOf("shared")?.label, "My local name");
    assert.equal(svc.lastRevision("shared"), 3);
    assert.equal(unwrap(ctl.conflicts()).length, 0);

    // And another device now sees the promoted version.
    const seen = await b.bridge.restoreAll();
    assert.equal(
      seen.applied.find((x) => x.projectId === "shared")?.config.label,
      "My local name",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("using theirs discards the local copy and clears the clash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-conflict-theirs-"));
  try {
    const store = sharedStore();
    const { svc, ctl, b } = await trustedPair(store, dir);
    await ctl.createProject({ id: "shared", label: "Original", enabled: true });
    await b.bridge.publish(project("shared"), 2);
    await ctl.updateProject("shared", { label: "My local name" });
    await svc.syncNow();

    const res = await ctl.resolveConflicts("shared", "theirs");
    assert.equal(res.ok, true);
    assert.equal(unwrap(ctl.conflicts()).length, 0);
    assert.equal(svc.configOf("shared")?.label, undefined, "the remote version stands");
    assert.equal(svc.lastRevision("shared"), 2, "no new revision was published");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a conflict summarises what keeping the local copy would change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-conflict-diff-"));
  try {
    const store = sharedStore();
    const { svc, ctl, b } = await trustedPair(store, dir);
    await ctl.createProject({ id: "shared", enabled: true });
    await ctl.addServer("shared", {
      transport: "stdio",
      id: "mineonly",
      command: "echo",
      args: [],
    });
    // B publishes a version with a DIFFERENT server and the project switched off.
    // Revisions must be contiguous: createProject was 1, addServer 2, so 3 next.
    await b.bridge.publish(project("shared", false), 3);
    await ctl.updateProject("shared", { label: "Renamed" });
    await svc.syncNow();

    const conflicts = ctl.conflicts();
    assert.equal(conflicts.ok, true);
    if (!conflicts.ok) return;
    const diffs = conflicts.value[0]?.differences ?? [];
    assert.ok(diffs.includes("name"), `expected a name change, got ${diffs.join(", ")}`);
    assert.ok(
      diffs.some((d) => d.includes("would switch it on")),
      `expected the enable difference, got ${diffs.join(", ")}`,
    );
    assert.ok(
      diffs.some((d) => d.includes("adds server mineonly")),
      `expected the added server, got ${diffs.join(", ")}`,
    );
    assert.ok(
      diffs.some((d) => d.includes("removes server s1")),
      `expected the removed server, got ${diffs.join(", ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conflicts survive a restart, so a decision is never lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-conflict-persist-"));
  try {
    const store = sharedStore();
    const { svc, ctl, b } = await trustedPair(store, dir);
    await ctl.createProject({ id: "shared", label: "Original", enabled: true });
    await b.bridge.publish(project("shared"), 2);
    await ctl.updateProject("shared", { label: "My local name" });
    assert.equal(unwrap(ctl.conflicts()).length, 1);
    await svc.shutdown();

    // A fresh service over the same data dir must still offer the same choice,
    // including the ability to keep the local copy.
    const svc2 = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
    });
    await svc2.start();
    const ctl2 = new GatewayController(svc2, {
      baseUrl: svc2.baseUrl,
      routesServed: () => true,
    });
    const after = ctl2.conflicts();
    assert.equal(unwrap(after).length, 1, "the clash persisted");
    assert.equal(unwrap(after)[0]?.projectId, "shared");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolving a project with no conflicts is a harmless no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-conflict-none-"));
  try {
    const store = sharedStore();
    const { ctl } = await trustedPair(store, dir);
    await ctl.createProject({ id: "calm", enabled: true });
    assert.equal((await ctl.resolveConflicts("calm", "mine")).ok, true);
    assert.equal((await ctl.resolveConflicts("calm", "theirs")).ok, true);
    assert.equal((await ctl.resolveConflicts("ghost", "mine")).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown resolution choice is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-conflict-bad-"));
  try {
    const store = sharedStore();
    const { ctl } = await trustedPair(store, dir);
    const res = await ctl.resolveConflicts("x", "sideways" as never);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.error.code, "invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releasing quarantine lets the next pass re-judge the record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-quarantine-release-"));
  try {
    const store = sharedStore();
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "a",
      }),
    });
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });

    // An untrusted device publishes; the record is refused.
    const b = await device(store);
    await b.bridge.publish(project("theirs"), 1);
    await svc.syncNow();
    assert.equal(unwrap(ctl.quarantine()).length, 1);

    // Dismissing clears the record; it stays refused until the device is trusted.
    assert.equal((await ctl.releaseQuarantine("theirs")).ok, true);
    assert.equal(unwrap(ctl.quarantine()).length, 0);
    await svc.syncNow();
    assert.equal(
      unwrap(ctl.quarantine()).length,
      1,
      "re-judged from scratch and refused again, which is the honest outcome",
    );

    // Once the device is approved, the same record applies.
    await ctl.approveDevice(b.signingKey.deviceId, b.signingKey.publicKeyHex);
    await ctl.releaseQuarantine("theirs");
    await svc.syncNow();
    assert.notEqual(svc.configOf("theirs"), null);
    assert.equal(unwrap(ctl.quarantine()).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-reading the already-applied cloud head does not create a rollback issue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-current-head-"));
  try {
    const store = sharedStore();
    const { svc, ctl } = await trustedPair(store, dir);
    await ctl.createProject({ id: "stable", enabled: true });

    await svc.syncNow();
    await svc.syncNow();

    assert.equal(unwrap(ctl.quarantine()).length, 0);
    assert.equal(svc.syncStatusView().quarantined, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── deletion propagation ─────────────────────────────────────────────────────

test("deleting a project propagates to another device", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "gw-tomb-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "gw-tomb-b-"));
  try {
    const store = sharedStore();
    const { ctl: ctlA } = await trustedPair(store, dirA);
    await ctlA.createProject({ id: "gone", enabled: true });

    // Device B (trusted by A's bootstrap? no — build it as a full service and
    // approve it) picks the project up.
    const svcB = new GatewayService({
      dataDir: dirB,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "b",
      }),
    });
    await svcB.start();
    assert.notEqual(svcB.configOf("gone"), null, "B has the project");

    // A deletes it.
    const deleted = await ctlA.deleteProject("gone");
    assert.equal(deleted.ok, true);

    // B picks up the deletion instead of restoring the project back.
    await svcB.syncNow();
    assert.equal(svcB.configOf("gone"), null, "the deletion propagated");
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("a deletion is not undone by the stale head that remains in the bucket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-tomb-stale-"));
  try {
    const store = sharedStore();
    const { svc, ctl } = await trustedPair(store, dir);
    await ctl.createProject({ id: "gone", enabled: true });
    await ctl.deleteProject("gone");

    // The head object is deliberately left in place; repeated passes must keep
    // honouring the tombstone rather than flip-flopping.
    await svc.syncNow();
    await svc.syncNow();
    assert.equal(svc.configOf("gone"), null, "still deleted after repeated passes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a project republished after deletion comes back", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "gw-tomb-resurrect-"));
  try {
    const store = sharedStore();
    const { svc, ctl, b } = await trustedPair(store, dirA);
    await ctl.createProject({ id: "phoenix", enabled: true });
    await ctl.deleteProject("phoenix");
    await svc.syncNow();
    assert.equal(svc.configOf("phoenix"), null);

    // Another device deliberately recreates it. The next revision must outrank
    // the tombstone: createProject was 1 and the deletion 2, so 3 recreates it.
    await b.bridge.publish(project("phoenix"), 3);
    await svc.syncNow();
    assert.notEqual(
      svc.configOf("phoenix"),
      null,
      "a newer publish outranks the tombstone",
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
  }
});

test("an unsigned deletion written straight into the bucket is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-tomb-forged-"));
  try {
    const store = sharedStore();
    const { svc, ctl } = await trustedPair(store, dir);
    await ctl.createProject({ id: "mine", enabled: true });
    await svc.syncNow();
    assert.notEqual(svc.configOf("mine"), null);

    // Someone with bucket write access forges a deletion. Accepting it would let
    // write access alone destroy a project on every device.
    await store.putCreate(
      `${PREFIX}/mcp/projects/mine/tombstone.json`,
      new TextEncoder().encode(
        JSON.stringify({
          tombstoneVersion: 1,
          project: "mine",
          revision: 99,
          signer: "dev_attacker",
          deletedAt: new Date().toISOString(),
          signature: "00",
        }),
      ),
    );

    await svc.syncNow();
    assert.notEqual(svc.configOf("mine"), null, "the forged deletion was refused");
    const q = unwrap(ctl.quarantine()).find((x) => x.projectId === "mine");
    assert.equal(q?.code, "unknown-signer");
    assert.match(q?.reason ?? "", /deletion refused/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deletion signed by a revoked device is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-tomb-revoked-"));
  try {
    const store = sharedStore();
    const { svc, ctl, b } = await trustedPair(store, dir);
    await ctl.createProject({ id: "mine", enabled: true });
    await ctl.revokeDevice(b.signingKey.deviceId);

    await b.bridge.publishTombstone("mine", 50);
    await svc.syncNow();

    assert.notEqual(svc.configOf("mine"), null, "a revoked device cannot delete");
    assert.equal(
      unwrap(ctl.quarantine()).find((x) => x.projectId === "mine")?.code,
      "revoked-signer",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed tombstone does not take the project down", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-tomb-malformed-"));
  try {
    const store = sharedStore();
    const { svc, ctl } = await trustedPair(store, dir);
    await ctl.createProject({ id: "mine", enabled: true });
    await store.putCreate(
      `${PREFIX}/mcp/projects/mine/tombstone.json`,
      new TextEncoder().encode("not json"),
    );

    await svc.syncNow();
    assert.notEqual(svc.configOf("mine"), null, "garbage is ignored, not obeyed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the receiving device cleans agent config files before forgetting the project", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "gw-tomb-agents-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "gw-tomb-agents-b-"));
  const workspace = mkdtempSync(join(tmpdir(), "gw-tomb-ws-"));
  try {
    const store = sharedStore();
    const { ctl: ctlA } = await trustedPair(store, dirA);
    await ctlA.createProject({ id: "gone", enabled: true });
    await ctlA.addServer("gone", {
      transport: "stdio",
      id: "srv",
      command: "echo",
      args: [],
    });

    const svcB = new GatewayService({
      dataDir: dirB,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
      syncMaterials: async () => ({
        store,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "b",
      }),
    });
    await svcB.start();
    const ctlB = new GatewayController(svcB, {
      baseUrl: svcB.baseUrl,
      routesServed: () => true,
    });
    // B installs the project into a local folder for Cursor.
    await ctlB.setDirectoryAgents("gone", workspace, ["cursor"]);
    const cursorFile = join(workspace, ".cursor", "mcp.json");
    assert.ok(readFileSync(cursorFile, "utf8").includes("m_gone_srv"));

    // A deletes the project; B must strip its entries from the agent file.
    await ctlA.deleteProject("gone");
    await svcB.syncNow();

    const after = JSON.parse(readFileSync(cursorFile, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    assert.deepEqual(
      Object.keys(after.mcpServers ?? {}),
      [],
      "the deleted project's entries are gone from the agent config",
    );
    assert.equal(svcB.configOf("gone"), null);
    assert.deepEqual(
      await svcB.workspaceBindings("gone"),
      [],
      "the folder binding is forgotten too, not left pointing at a dead project",
    );
    void ctlB;
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a local delete is refused when the deletion cannot be published", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-tomb-nopublish-"));
  try {
    const store = sharedStore();
    // A store that accepts everything except the tombstone write.
    const blocking: SyncObjectStore = {
      get: (k) => store.get(k),
      putCreate: (k, b) => {
        if (k.endsWith("/tombstone.json")) {
          return Promise.reject(Object.assign(new Error("denied"), { kind: "AuthFailed" }));
        }
        return store.putCreate(k, b);
      },
      putCompareAndSwap: (k, b, e) => store.putCompareAndSwap(k, b, e),
      putImmutable: (k, b) => store.putImmutable(k, b),
      list: (p, o) => store.list(p, o),
    };
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
      syncMaterials: async () => ({
        store: blocking,
        controlPrefix: PREFIX,
        password: PASSWORD,
        deviceId: "a",
      }),
    });
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });
    await ctl.createProject({ id: "stuck", enabled: true });

    const res = await ctl.deleteProject("stuck");
    assert.equal(res.ok, false, "the delete must not half-succeed");
    assert.equal(res.ok === false && res.error.code, "sync-failed");
    assert.match(
      res.ok === false ? res.error.message : "",
      /would just restore it on the next sync/,
      "the reason explains why the project was kept",
    );
    assert.notEqual(svc.configOf("stuck"), null, "the project is still here");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a local-only gateway still deletes without any tombstone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-tomb-local-"));
  try {
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: "http://127.0.0.1:7777",
      makeBoundServer: () => {
        throw new Error("no browser in this test");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
      autoSync: { intervalMs: 0 },
    });
    await svc.start();
    const ctl = new GatewayController(svc, {
      baseUrl: svc.baseUrl,
      routesServed: () => true,
    });
    await ctl.createProject({ id: "solo", enabled: true });
    assert.equal((await ctl.deleteProject("solo")).ok, true);
    assert.equal(svc.configOf("solo"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed project upload survives restart and is published once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-pending-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = sharedStore();
  const vault = new MemoryVault();
  const first = makeService(dir, vault, store);
  await first.start();
  const create = store.putCreate.bind(store);
  store.putCreate = async (key, bytes) => {
    if (key.endsWith("/state.json"))
      throw Object.assign(new Error("offline"), { kind: "Unreachable" });
    return create(key, bytes);
  };
  await first.saveConfig(project("offline"));
  assert.equal(first.syncStatusView().pending, 1);
  await first.shutdown();
  store.putCreate = create;
  const second = makeService(dir, vault, store);
  t.after(() => second.shutdown());
  await second.start();
  await second.syncNow();
  assert.equal(second.lastRevision("offline"), 1);
  assert.equal(second.syncStatusView().pending, 0);
});

test("a lost write acknowledgment followed by another edit advances exactly twice", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-ack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = sharedStore();
  const svc = makeService(dir, new MemoryVault(), store);
  await svc.start();
  t.after(() => svc.shutdown());
  const create = store.putCreate.bind(store);
  store.putCreate = async (key, bytes) => {
    const result = await create(key, bytes);
    if (key.endsWith("/state.json")) throw new Error("response lost");
    return result;
  };
  await svc.saveConfig(project("ack", false));
  assert.equal(svc.syncStatusView().pending, 1);
  await svc.saveConfig(project("ack", true));
  await svc.syncNow();
  assert.equal(svc.lastRevision("ack"), 2);
  assert.equal(svc.configOf("ack")?.enabled, true);
  assert.equal(svc.syncStatusView().pending, 0);
  assert.equal(svc.syncStatusView().conflicts, 0);
});

test("per-project read failures do not quarantine a good project or hide invalid records", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-read-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = sharedStore();
  const svc = makeService(dir, new MemoryVault(), store);
  await svc.start();
  t.after(() => svc.shutdown());
  await svc.saveConfig(project("network"));
  await svc.saveConfig(project("broken"));
  const get = store.get.bind(store);
  store.get = async (key) => {
    if (key.endsWith("/network/tombstone.json"))
      throw Object.assign(new Error("offline"), { kind: "Unreachable" });
    const obj = await get(key);
    if (key.endsWith("/broken/state.json")) return { ...obj, bytes: new Uint8Array() };
    return obj;
  };
  await svc.syncNow();
  assert.equal(svc.syncStatusView().unreadable, 1);
  assert.match(svc.syncStatusView().lastError!, /network.*Unreachable/);
  assert.deepEqual(
    svc.quarantineList().map((q) => q.projectId),
    ["broken"],
  );
  assert.ok(svc.configOf("network"));
  store.get = get;
  await svc.syncNow();
  assert.equal(svc.syncStatusView().unreadable, 0);
  assert.equal(svc.syncStatusView().lastError, null);
});

test("first sync recovers legacy projects, preserves divergent and deleted copies and resumes after a read error", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = sharedStore();
  const vault = new MemoryVault();
  const local = makeService(dir, vault, store);
  await local.start();
  for (const id of ["equal", "different", "deleted", "missing", "retry"]) {
    await local.saveConfig(project(id));
  }
  await local.shutdown();
  const statePath = join(dir, "mcp-gateway", "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  // A genuine pre-outbox state file, including remembered revisions.
  writeFileSync(statePath, JSON.stringify({ revisions: state.revisions }));
  const gv = new GatewayVault(vault);
  const signingKey = await gv.getOrCreateSigningKey();
  const saltHex = await gv.getOrCreateSaltHex();
  const bridge = new GatewaySyncBridge({
    store,
    password: PASSWORD,
    controlPrefix: PREFIX,
    signingKey,
    saltHex,
  });
  await bridge.publish(project("different", false), 2);
  await bridge.publishTombstone("deleted", 2);
  await store.deleteStrict!(`${PREFIX}/mcp/projects/missing/state.json`);
  const get = store.get.bind(store);
  store.get = async (key) => {
    if (key.endsWith("/retry/state.json"))
      throw Object.assign(new Error("offline"), { kind: "Unreachable" });
    return get(key);
  };
  const migrated = makeService(dir, vault, store);
  t.after(() => migrated.shutdown());
  await migrated.start();
  assert.equal(migrated.syncStatusView().unreadable, 1);
  assert.equal(migrated.configOf("different")?.enabled, false);
  assert.equal(migrated.configOf("deleted"), null);
  assert.deepEqual(
    migrated
      .conflictList()
      .map((c) => c.projectId)
      .sort(),
    ["deleted", "different"],
  );
  store.get = get;
  await migrated.syncNow();
  assert.equal(migrated.syncStatusView().unreadable, 0);
  assert.equal(migrated.lastRevision("equal"), 1);
  assert.equal((await bridge.inspect("missing")).applied[0]?.revision, 1);
  assert.equal(migrated.conflictList().length, 2);
});

test("a second local edit reaches disk while the first acknowledgment is outstanding", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-inflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = sharedStore();
  const svc = makeService(dir, new MemoryVault(), store);
  await svc.start();
  t.after(() => svc.shutdown());
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const create = store.putCreate.bind(store);
  store.putCreate = async (key, bytes) => {
    const result = await create(key, bytes);
    if (key.endsWith("/flight/state.json")) {
      entered();
      await gate;
    }
    return result;
  };
  const first = svc.saveConfig(project("flight", false));
  await started;
  const second = svc.saveConfig(project("flight", true));
  try {
    const deadline = Date.now() + 3000;
    while (svc.configOf("flight")?.enabled !== true && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(svc.configOf("flight")?.enabled, true);
    const saved = JSON.parse(
      readFileSync(join(dir, "mcp-gateway", "projects", "flight.json"), "utf8"),
    );
    assert.equal(saved.enabled, true);
  } finally {
    finish();
    await Promise.all([first, second]);
  }
  assert.equal(svc.lastRevision("flight"), 2);
  assert.equal(svc.syncStatusView().pending, 0);
  assert.equal(svc.syncStatusView().conflicts, 0);
});

test("pending updates stay with their original bucket across target changes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-target-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stores = [sharedStore(), sharedStore()];
  let target = 0;
  const svc = new GatewayService({
    dataDir: dir,
    vault: new MemoryVault(),
    allowedHosts: ["localhost"],
    baseUrl: "http://localhost",
    makeBoundServer: () => {
      throw new Error("unused");
    },
    autoSync: { intervalMs: 0 },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    syncMaterials: async () => ({
      store: stores[target]!,
      targetId: "bucket-" + target,
      controlPrefix: PREFIX,
      password: PASSWORD,
      deviceId: "test",
    }),
  });
  await svc.start();
  t.after(() => svc.shutdown());
  const a = stores[0]!;
  const create = a.putCreate.bind(a);
  a.putCreate = async () => {
    throw new Error("offline");
  };
  await svc.saveConfig(project("privateproject"));
  target = 1;
  await svc.composeSyncIfReady();
  await svc.syncNow();
  const b = await device(stores[1]!);
  assert.equal((await b.bridge.inspect("privateproject")).absent.length, 1);
  a.putCreate = create;
  target = 0;
  await svc.composeSyncIfReady();
  await svc.syncNow();
  assert.equal(svc.lastRevision("privateproject"), 1);
  assert.equal(svc.syncStatusView().pending, 0);
});

test("a remote deletion preserves an offline edit and never republishes it automatically", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-delete-pending-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = sharedStore();
  const { svc, b } = await trustedPair(store, dir);
  t.after(() => svc.shutdown());
  await svc.saveConfig(project("removed"));
  const cas = store.putCompareAndSwap.bind(store);
  store.putCompareAndSwap = async () => {
    throw new Error("offline");
  };
  await svc.saveConfig(project("removed", false));
  store.putCompareAndSwap = cas;
  await b.bridge.publishTombstone("removed", 2);
  await svc.syncNow();
  await svc.syncNow();
  assert.equal(svc.configOf("removed"), null);
  assert.equal(svc.conflictList().length, 1);
  assert.equal(svc.syncStatusView().pending, 0);
  await svc.resolveConflicts("removed", "mine");
  assert.equal(svc.configOf("removed")?.enabled, false);
  assert.equal(svc.lastRevision("removed"), 3);
});

test("a deletion tied with a committed concurrent edit keeps the edit for recovery", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-delete-tie-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = sharedStore();
  const { svc, b } = await trustedPair(store, dir);
  t.after(() => svc.shutdown());
  await svc.saveConfig(project("tied"));
  await svc.saveConfig(project("tied", false));
  await b.bridge.publishTombstone("tied", 2);
  await svc.syncNow();
  await svc.syncNow();
  assert.equal(svc.configOf("tied"), null);
  assert.equal(svc.conflictList().length, 1);
  await svc.resolveConflicts("tied", "mine");
  assert.equal(svc.configOf("tied")?.enabled, false);
  assert.equal(svc.lastRevision("tied"), 3);
});

test("restart completes a local install interrupted after the durable edit was recorded", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-local-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = sharedStore();
  const vault = new MemoryVault();
  const first = makeService(dir, vault, store);
  await first.start();
  // Fail the second disk write, after the intent has been committed to state.json.
  const { store: local } = first as unknown as { store: { save(): Promise<void> } };
  local.save = async () => { throw new Error("disk full"); };
  await assert.rejects(first.saveConfig(project("journal")), /disk full/);
  await first.shutdown();
  const recovered = makeService(dir, vault, store);
  t.after(() => recovered.shutdown());
  await recovered.start();
  assert.equal(recovered.configOf("journal")?.enabled, true);
  assert.equal(recovered.lastRevision("journal"), 1);
  assert.equal(recovered.syncStatusView().pending, 0);
});
