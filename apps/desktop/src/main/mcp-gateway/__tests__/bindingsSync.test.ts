import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryConditionalObjectStore } from "@multizen/s3-coordinator";
import type { SyncObjectStore } from "@multizen/mcp-gateway";

import { GatewayService } from "../GatewayService.ts";
import { GatewayController } from "../GatewayController.ts";
import { GatewayVault } from "../GatewayVault.ts";
import { BindingsSync, BINDINGS_DOCUMENT, parseBindingsDocument } from "../BindingsSync.ts";
import { fakeStdioFactory, MemoryVault } from "./testSupport.ts";

/**
 * Folder/agent bindings are backed up PER DEVICE.
 *
 * Restoring onto the same device is a real restore (the paths are that machine's
 * paths). Restoring from a different device can only be a proposal, because an
 * absolute path from another machine means nothing here — writing agent config
 * into whatever occupies it would be wrong.
 */

const PREFIX = "repo/control";
const PASSWORD = "operator-encryption-password";

/**
 * A temp directory with its REAL path. The binding store canonicalizes every
 * directory through realpath, and on macOS `/var` is a symlink to `/private/var`,
 * so a raw mkdtemp path never matches what gets stored.
 */
function workspaceDir(tag: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), tag)));
}

function sharedStore(): SyncObjectStore {
  return new InMemoryConditionalObjectStore() as unknown as SyncObjectStore;
}

async function device(store: SyncObjectStore, vault = new MemoryVault()) {
  const dir = mkdtempSync(join(tmpdir(), "gw-bind-"));
  const svc = new GatewayService({
    dataDir: dir,
    vault,
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
      deviceId: "d",
    }),
  });
  await svc.start();
  const ctl = new GatewayController(svc, {
    baseUrl: svc.baseUrl,
    routesServed: () => true,
  });
  return {
    dir,
    svc,
    ctl,
    vault,
    bindings: new BindingsSync({ service: svc }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Seed a project with one stdio server so an install has something to write. */
async function seedProject(ctl: GatewayController, id: string): Promise<void> {
  await ctl.createProject({ id, enabled: true });
  await ctl.addServer(id, { transport: "stdio", id: "srv", command: "echo", args: [] });
}

test("a device's bindings round-trip through backup and restore", async () => {
  const store = sharedStore();
  const vault = new MemoryVault();
  const a = await device(store, vault);
  const workspace = workspaceDir("gw-bind-ws-");
  try {
    await seedProject(a.ctl, "alpha");
    await a.ctl.setDirectoryAgents("alpha", workspace, ["cursor", "codex"]);
    await a.ctl.approveEnvName("SHARED_TOKEN");
    assert.equal(await a.bindings.push(), true);

    // Simulate a reinstall: the SAME device identity, a blank data directory.
    const fresh = await device(store, vault);
    try {
      await seedProject(fresh.ctl, "alpha");
      const outcome = await fresh.bindings.restoreOwn({ expectFresh: false });

      assert.equal(outcome.restored.length, 1);
      assert.equal(outcome.restored[0]?.directory, workspace);
      assert.deepEqual([...(outcome.restored[0]?.agents ?? [])].sort(), ["codex", "cursor"]);
      assert.deepEqual(outcome.approvedEnv, ["SHARED_TOKEN"]);
      assert.equal(outcome.skipped.length, 0);

      // The agent config files were actually rewritten, not just recorded.
      assert.match(
        readFileSync(join(workspace, ".cursor", "mcp.json"), "utf8"),
        /m_alpha_srv/,
      );
      assert.match(
        readFileSync(join(workspace, ".codex", "config.toml"), "utf8"),
        /m_alpha_srv/,
      );
      // And the approval came back, so references can resolve again.
      assert.deepEqual(fresh.svc.approvedEnvNames(), ["SHARED_TOKEN"]);
    } finally {
      fresh.cleanup();
    }
  } finally {
    a.cleanup();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("install status, hashes and owned keys are NOT published", async () => {
  const store = sharedStore();
  const a = await device(store);
  const workspace = workspaceDir("gw-bind-ws2-");
  try {
    await seedProject(a.ctl, "alpha");
    await a.ctl.setDirectoryAgents("alpha", workspace, ["cursor"]);

    const snapshot = await a.bindings.snapshot();
    const serialized = JSON.stringify(snapshot);
    // The backup carries intent only. Ownership and hashes describe files on
    // disk; a restored ownedKeys could claim entries MultiZen never wrote.
    for (const forbidden of ["ownedKeys", "desiredHash", "fileHash", "lastInstalledAt", "status"]) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} must not be published`);
    }
    assert.deepEqual(Object.keys(snapshot.bindings[0] ?? {}).sort(), [
      "agents",
      "directory",
      "projectId",
    ]);
  } finally {
    a.cleanup();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a folder that no longer exists is reported, not thrown", async () => {
  const store = sharedStore();
  const vault = new MemoryVault();
  const a = await device(store, vault);
  const workspace = workspaceDir("gw-bind-gone-");
  try {
    await seedProject(a.ctl, "alpha");
    await a.ctl.setDirectoryAgents("alpha", workspace, ["cursor"]);
    await a.bindings.push();
    // The folder is deleted before the restore happens.
    rmSync(workspace, { recursive: true, force: true });

    const fresh = await device(store, vault);
    try {
      await seedProject(fresh.ctl, "alpha");
      const outcome = await fresh.bindings.restoreOwn({ expectFresh: false });
      assert.equal(outcome.restored.length, 0);
      assert.equal(outcome.skipped.length, 1);
      assert.match(outcome.skipped[0]?.reason ?? "", /no longer exists/);
    } finally {
      fresh.cleanup();
    }
  } finally {
    a.cleanup();
  }
});

test("a binding for a project this device does not have is skipped with a reason", async () => {
  const store = sharedStore();
  const a = await device(store);
  try {
    // Publish a bindings document naming a project that exists nowhere — not
    // locally and not in the bucket. Deleting a real project would not do: a
    // deletion propagates, so the binding would be gone too.
    await a.svc.publishDocument("device", BINDINGS_DOCUMENT, {
      version: 1,
      bindings: [{ projectId: "ghostproject", directory: a.dir, agents: ["cursor"] }],
      approvedEnv: [],
    });

    const outcome = await a.bindings.restoreOwn({ expectFresh: false });
    assert.equal(outcome.restored.length, 0);
    assert.equal(outcome.skipped.length, 1);
    assert.match(
      outcome.skipped[0]?.reason ?? "",
      /project ghostproject is not on this device/,
    );
  } finally {
    a.cleanup();
  }
});

test("another device's bindings are proposals and write nothing", async () => {
  const store = sharedStore();
  const a = await device(store);
  const workspaceA = workspaceDir("gw-bind-a-");
  const shared = workspaceDir("gw-bind-both-");
  try {
    await seedProject(a.ctl, "alpha");
    await a.ctl.setDirectoryAgents("alpha", workspaceA, ["cursor"]);
    await a.ctl.setDirectoryAgents("alpha", shared, ["codex"]);
    await a.bindings.push();
    const aDeviceId = await a.svc.vaultAdapter.deviceId();

    // Device B, approved so it can verify A's documents.
    const b = await device(store, new MemoryVault());
    try {
      const bKey = await new GatewayVault(b.vault).getOrCreateSigningKey();
      await a.ctl.approveDevice(bKey.deviceId, bKey.publicKeyHex);
      await seedProject(b.ctl, "alpha");

      const { proposals } = await b.bindings.proposalsFrom(aDeviceId);
      assert.equal(proposals.length, 2);
      const forShared = proposals.find((p) => p.directory === shared);
      assert.equal(forShared?.directoryExists, true, "this path happens to exist here");
      assert.equal(forShared?.fromDeviceId, aDeviceId);

      // Crucially: nothing was written and nothing was linked.
      assert.deepEqual(
        await b.svc.workspaceBindings("alpha"),
        [],
        "a cross-device restore proposes, it does not apply",
      );
    } finally {
      b.cleanup();
    }
  } finally {
    a.cleanup();
    rmSync(workspaceA, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("a proposal marks a path that does not exist on this machine", async () => {
  const store = sharedStore();
  const a = await device(store);
  const workspace = workspaceDir("gw-bind-vanish-");
  try {
    await seedProject(a.ctl, "alpha");
    await a.ctl.setDirectoryAgents("alpha", workspace, ["cursor"]);
    await a.bindings.push();
    const aDeviceId = await a.svc.vaultAdapter.deviceId();
    rmSync(workspace, { recursive: true, force: true });

    const b = await device(store, new MemoryVault());
    try {
      const bKey = await new GatewayVault(b.vault).getOrCreateSigningKey();
      await a.ctl.approveDevice(bKey.deviceId, bKey.publicKeyHex);
      const { proposals } = await b.bindings.proposalsFrom(aDeviceId);
      assert.equal(proposals[0]?.directoryExists, false);
    } finally {
      b.cleanup();
    }
  } finally {
    a.cleanup();
  }
});

test("bindings land in the DEVICE scope, so no absolute path is ever shared", async () => {
  const store = sharedStore();
  const a = await device(store);
  const workspace = workspaceDir("gw-bind-scope-");
  try {
    await seedProject(a.ctl, "alpha");
    await a.ctl.setDirectoryAgents("alpha", workspace, ["cursor"]);
    await a.bindings.push();

    const page = await store.list(`${PREFIX}/mcp/shared/`, { maxKeys: 100 });
    for (const key of page.keys) {
      const text = Buffer.from((await store.get(key)).bytes).toString("utf8");
      assert.ok(
        !text.includes(BINDINGS_DOCUMENT),
        `the shared scope must not hold bindings (${key})`,
      );
    }
    // And the device-scoped object exists.
    const devices = await store.list(`${PREFIX}/mcp/devices/`, { maxKeys: 100 });
    assert.ok(
      devices.keys.some((k) => k.endsWith(`/${BINDINGS_DOCUMENT}.json`)),
      "the bindings document is device-scoped",
    );
  } finally {
    a.cleanup();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("no document yet is absent, and a gateway without sync says so", async () => {
  const store = sharedStore();
  const a = await device(store);
  try {
    assert.equal((await a.bindings.restoreOwn()).reason, "absent");
  } finally {
    a.cleanup();
  }

  const dir = mkdtempSync(join(tmpdir(), "gw-bind-local-"));
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
    const bindings = new BindingsSync({ service: svc });
    assert.equal(await bindings.push(), false);
    assert.equal((await bindings.restoreOwn()).reason, "not-syncing");
    assert.equal((await bindings.proposalsFrom("dev_other")).reason, "not-syncing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── document validation ──────────────────────────────────────────────────────

test("a malformed bindings document degrades instead of throwing", () => {
  assert.deepEqual(parseBindingsDocument(null), {
    version: 1,
    bindings: [],
    approvedEnv: [],
  });
  assert.deepEqual(parseBindingsDocument("nope").bindings, []);
  assert.deepEqual(parseBindingsDocument({ bindings: "no" }).bindings, []);
});

test("invalid entries and unknown agents are dropped, valid neighbours survive", () => {
  const doc = parseBindingsDocument({
    bindings: [
      { projectId: "", directory: "/a", agents: ["cursor"] },
      { projectId: "ok", directory: "", agents: ["cursor"] },
      { projectId: "ok", directory: "/a", agents: "cursor" },
      { projectId: "good", directory: "/b", agents: ["cursor", "notanagent", 7] },
    ],
    approvedEnv: ["VALID_NAME", "not-a-valid-name", 42, "ALSO_OK"],
  });
  assert.deepEqual(doc.bindings, [
    { projectId: "good", directory: "/b", agents: ["cursor"] },
  ]);
  assert.deepEqual(doc.approvedEnv, ["VALID_NAME", "ALSO_OK"]);
});
