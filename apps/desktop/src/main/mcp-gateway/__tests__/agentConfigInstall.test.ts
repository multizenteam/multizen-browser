import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse as tomlParse } from "@iarna/toml";

import { GatewayService } from "../GatewayService.ts";
import { GatewayController } from "../GatewayController.ts";
import { adapterFor } from "../agentAdapters.ts";
import type { AgentKind } from "../types.ts";
import { fakeStdioFactory, MemoryVault } from "./testSupport.ts";

const BASE = "http://127.0.0.1:7777";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "mz-install-")));
}

/** Create a workspace directory and return its canonical path. */
function mkws(root: string, name = "work"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

function makeService(dataDir: string, vault = new MemoryVault()): GatewayService {
  return new GatewayService({
    dataDir,
    vault,
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: BASE,
    envSource: {},
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
  });
}

function makeController(svc: GatewayService): GatewayController {
  return new GatewayController(svc, { baseUrl: svc.baseUrl, routesServed: () => true });
}

/** Path of one agent's config file inside a workspace. */
function configPath(workspace: string, agent: AgentKind): string {
  return join(workspace, ...adapterFor(agent).relativePath);
}

function jsonServers(file: string): Record<string, Record<string, unknown>> {
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return (doc.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
}

function tomlServers(file: string): Record<string, Record<string, unknown>> {
  const doc = tomlParse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return (doc.mcp_servers ?? {}) as Record<string, Record<string, unknown>>;
}

/** A project with one enabled stdio server, ready to install. */
async function seed(
  ctl: GatewayController,
  projectId = "proj",
  opts: { enabled?: boolean } = {},
): Promise<void> {
  const created = await ctl.createProject({ id: projectId, enabled: opts.enabled ?? true });
  assert.equal(created.ok, true, JSON.stringify(created));
  const added = await ctl.addServer(projectId, {
    transport: "stdio",
    id: "srv",
    command: "echo",
    args: [],
  });
  assert.equal(added.ok, true, JSON.stringify(added));
}

// ── directory association + install ─────────────────────────────────────────

test("associating a directory installs the project into the selected agents only", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);

    const res = await ctl.setDirectoryAgents("proj", ws, ["cursor", "codex"]);
    assert.equal(res.ok, true, JSON.stringify(res));
    if (res.ok) {
      assert.equal(res.value.length, 1);
      assert.deepEqual(
        res.value[0]?.agents.map((a) => a.agent).sort(),
        ["codex", "cursor"],
      );
      assert.equal(res.value[0]?.agents.every((a) => a.status === "current"), true);
    }

    // Only the selected agents' files exist.
    assert.equal(existsSync(configPath(ws, "cursor")), true);
    assert.equal(existsSync(configPath(ws, "codex")), true);
    assert.equal(existsSync(configPath(ws, "claude-code")), false);
    assert.equal(existsSync(configPath(ws, "kiro-cli")), false);

    assert.equal(
      jsonServers(configPath(ws, "cursor")).m_proj_srv?.url,
      `${BASE}/mcp/proxies/proj/srv`,
    );
    assert.equal(
      tomlServers(configPath(ws, "codex")).m_proj_srv?.url,
      `${BASE}/mcp/proxies/proj/srv`,
    );
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all four agents can be configured for one directory", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    const agents: AgentKind[] = ["claude-code", "cursor", "codex", "kiro-cli"];
    const res = await ctl.setDirectoryAgents("proj", ws, agents);
    assert.equal(res.ok, true, JSON.stringify(res));
    for (const agent of agents) {
      assert.equal(existsSync(configPath(ws, agent)), true, `${agent} file written`);
    }
    // Claude declares the transport explicitly; Codex uses a TOML table.
    assert.equal(jsonServers(configPath(ws, "claude-code")).m_proj_srv?.type, "http");
    assert.ok(tomlServers(configPath(ws, "codex")).m_proj_srv);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two directories may carry different agent selections", async () => {
  const dir = tmp();
  const a = mkws(dir, "a");
  const b = mkws(dir, "b");
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", a, ["cursor"]);
    await ctl.setDirectoryAgents("proj", b, ["codex", "kiro-cli"]);

    assert.equal(existsSync(configPath(a, "cursor")), true);
    assert.equal(existsSync(configPath(a, "codex")), false);
    assert.equal(existsSync(configPath(b, "codex")), true);
    assert.equal(existsSync(configPath(b, "kiro-cli")), true);
    assert.equal(existsSync(configPath(b, "cursor")), false);

    const dirs = await ctl.directories("proj");
    assert.equal(dirs.ok && dirs.value.length, 2);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same directory may be shared by two projects without clobbering", async () => {
  const dir = tmp();
  const ws = mkws(dir, "shared");
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl, "alpha");
    await seed(ctl, "beta");
    await ctl.setDirectoryAgents("alpha", ws, ["cursor"]);
    await ctl.setDirectoryAgents("beta", ws, ["cursor"]);

    const s = jsonServers(configPath(ws, "cursor"));
    assert.deepEqual(Object.keys(s).sort(), ["m_alpha_srv", "m_beta_srv"]);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── reconciliation on project change ────────────────────────────────────────

test("adding a server updates every associated directory automatically", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", ws, ["cursor", "codex"]);
    assert.equal(Object.keys(jsonServers(configPath(ws, "cursor"))).length, 1);

    const added = await ctl.addServer("proj", {
      transport: "streamable-http",
      id: "api",
      url: "https://api.example.com/mcp",
    });
    assert.equal(added.ok, true);
    assert.deepEqual(Object.keys(jsonServers(configPath(ws, "cursor"))).sort(), [
      "m_proj_api",
      "m_proj_srv",
    ]);
    assert.deepEqual(Object.keys(tomlServers(configPath(ws, "codex"))).sort(), [
      "m_proj_api",
      "m_proj_srv",
    ]);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disabling a server removes just that entry; disabling the project removes all", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.addServer("proj", {
      transport: "streamable-http",
      id: "api",
      url: "https://api.example.com/mcp",
    });
    await ctl.setDirectoryAgents("proj", ws, ["cursor"]);

    await ctl.setServerEnabled("proj", "api", false);
    assert.deepEqual(Object.keys(jsonServers(configPath(ws, "cursor"))), ["m_proj_srv"]);

    await ctl.updateProject("proj", { enabled: false });
    assert.deepEqual(Object.keys(jsonServers(configPath(ws, "cursor"))), [], "project disabled");

    // Re-enabling restores the enabled endpoints.
    await ctl.updateProject("proj", { enabled: true });
    assert.deepEqual(Object.keys(jsonServers(configPath(ws, "cursor"))), ["m_proj_srv"]);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binding a profile adds the browser endpoint; unbinding removes it", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", ws, ["kiro-cli"]);

    await ctl.bindProfile("proj", "profile-1");
    assert.equal(
      jsonServers(configPath(ws, "kiro-cli")).m_proj_browser?.url,
      `${BASE}/mcp/projects/proj/browser`,
    );

    await ctl.bindProfile("proj", null);
    assert.equal(
      jsonServers(configPath(ws, "kiro-cli")).m_proj_browser,
      undefined,
      "browser endpoint removed when unbound",
    );
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enabling auth adds an env REFERENCE in each agent's own syntax", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", ws, ["claude-code", "cursor", "codex", "kiro-cli"]);
    await ctl.setAuthEnabled("proj", true);
    const gen = await ctl.generateToken("proj");
    assert.equal(gen.ok, true);
    const token = gen.ok ? gen.value.token : "";

    const claude = readFileSync(configPath(ws, "claude-code"), "utf8");
    const cursor = readFileSync(configPath(ws, "cursor"), "utf8");
    const codex = readFileSync(configPath(ws, "codex"), "utf8");
    const kiro = readFileSync(configPath(ws, "kiro-cli"), "utf8");

    assert.match(claude, /Bearer \$\{MULTIZEN_PROJECT_PROJ_[0-9A-F]+_TOKEN\}/);
    assert.match(cursor, /Bearer \$\{env:MULTIZEN_PROJECT_PROJ_[0-9A-F]+_TOKEN\}/);
    assert.match(codex, /bearer_token_env_var = "MULTIZEN_PROJECT_PROJ_[0-9A-F]+_TOKEN"/);
    assert.match(kiro, /Bearer \$\{MULTIZEN_PROJECT_PROJ_[0-9A-F]+_TOKEN\}/);

    // The token VALUE must never reach a workspace file.
    for (const text of [claude, cursor, codex, kiro]) {
      assert.equal(text.includes(token), false, "a token value leaked into a workspace file");
    }
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciliation is idempotent: a second pass rewrites nothing", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", ws, ["cursor", "codex"]);
    const before = [configPath(ws, "cursor"), configPath(ws, "codex")].map((f) =>
      readFileSync(f, "utf8"),
    );

    const again = await ctl.reconcileDirectories("proj");
    assert.equal(again.ok, true);
    assert.equal(again.ok && again.value.allCurrent, true);
    const after = [configPath(ws, "cursor"), configPath(ws, "codex")].map((f) =>
      readFileSync(f, "utf8"),
    );
    assert.deepEqual(after, before, "byte-identical after a redundant reconcile");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── selection changes + unlink ──────────────────────────────────────────────

test("deselecting an agent removes its entries from that agent's file", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", ws, ["cursor", "codex"]);
    assert.equal(Object.keys(tomlServers(configPath(ws, "codex"))).length, 1);

    await ctl.setDirectoryAgents("proj", ws, ["cursor"]);
    assert.equal(
      Object.keys(tomlServers(configPath(ws, "codex"))).length,
      0,
      "Codex entries were uninstalled when it was deselected",
    );
    assert.equal(Object.keys(jsonServers(configPath(ws, "cursor"))).length, 1, "Cursor kept");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unlinking a directory removes MultiZen's entries and keeps unrelated ones", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  mkdirSync(join(ws, ".cursor"));
  writeFileSync(
    configPath(ws, "cursor"),
    JSON.stringify({ mcpServers: { theirs: { url: "https://theirs.example" } } }, null, 2),
  );
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", ws, ["cursor"]);
    assert.deepEqual(Object.keys(jsonServers(configPath(ws, "cursor"))).sort(), [
      "m_proj_srv",
      "theirs",
    ]);

    const removed = await ctl.removeDirectory("proj", ws);
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(removed.ok && removed.value.length, 0, "binding is gone");
    assert.deepEqual(
      Object.keys(jsonServers(configPath(ws, "cursor"))),
      ["theirs"],
      "the user's own server survived",
    );
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── failure isolation + retry ──────────────────────────────────────────────

test("one agent's malformed file does not stop the others, and retry recovers", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  mkdirSync(join(ws, ".cursor"));
  writeFileSync(configPath(ws, "cursor"), "{ not json at all");
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    const res = await ctl.setDirectoryAgents("proj", ws, ["cursor", "codex", "kiro-cli"]);
    assert.equal(res.ok, true, "a single bad target does not fail the whole operation");
    if (res.ok) {
      const byAgent = new Map(res.value[0]?.agents.map((a) => [a.agent, a]));
      assert.equal(byAgent.get("cursor")?.status, "error");
      assert.match(byAgent.get("cursor")?.error ?? "", /not valid JSON/);
      assert.equal(typeof byAgent.get("cursor")?.hint, "string");
      assert.equal(byAgent.get("codex")?.status, "current", "Codex still installed");
      assert.equal(byAgent.get("kiro-cli")?.status, "current", "Kiro still installed");
    }
    // The malformed file was never overwritten.
    assert.equal(readFileSync(configPath(ws, "cursor"), "utf8"), "{ not json at all");

    // Operator fixes the file; retry installs just that target.
    writeFileSync(configPath(ws, "cursor"), "{}");
    const retried = await ctl.retryDirectoryAgent("proj", ws, "cursor");
    assert.equal(retried.ok, true);
    if (retried.ok) {
      const cursorRow = retried.value[0]?.agents.find((a) => a.agent === "cursor");
      assert.equal(cursorRow?.status, "current");
      assert.equal(cursorRow?.error, undefined);
    }
    assert.ok(jsonServers(configPath(ws, "cursor")).m_proj_srv);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unowned same-named entry is reported as a collision and never replaced", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  mkdirSync(join(ws, ".cursor"));
  const hostile = JSON.stringify(
    { mcpServers: { m_proj_srv: { url: "https://not-ours.example" } } },
    null,
    2,
  );
  writeFileSync(configPath(ws, "cursor"), hostile);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    const res = await ctl.setDirectoryAgents("proj", ws, ["cursor"]);
    assert.equal(res.ok, true);
    if (res.ok) {
      const row = res.value[0]?.agents[0];
      assert.equal(row?.status, "error");
      assert.match(row?.error ?? "", /does not manage/);
    }
    assert.equal(readFileSync(configPath(ws, "cursor"), "utf8"), hostile, "untouched");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory that disappears is surfaced as an error, not a crash", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", ws, ["cursor"]);
    rmSync(ws, { recursive: true, force: true });

    const res = await ctl.reconcileDirectories("proj");
    assert.equal(res.ok, true, "reconcile never throws");
    if (res.ok) {
      assert.equal(res.value.allCurrent, false);
      const row = res.value.bindings[0]?.agents[0];
      assert.equal(row?.status, "error");
      assert.match(row?.error ?? "", /no longer exists/);
    }
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("out-of-date is derived: a stale row is never reported as current", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", ws, ["cursor"]);

    // Mutate the stored desired-hash out from under the row, simulating a
    // project change that failed to propagate.
    await svc.workspaces.updateAgentState("proj", ws, "cursor", { desiredHash: "stale" });
    const dirs = await ctl.directories("proj");
    assert.equal(dirs.ok && dirs.value[0]?.agents[0]?.status, "out-of-date");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── safe project deletion ──────────────────────────────────────────────────

test("deleting a project removes its entries from every agent file first", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  mkdirSync(join(ws, ".cursor"));
  writeFileSync(
    configPath(ws, "cursor"),
    JSON.stringify({ mcpServers: { theirs: { url: "u" } } }, null, 2),
  );
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", ws, ["cursor", "codex"]);

    const deleted = await ctl.deleteProject("proj");
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.deepEqual(Object.keys(jsonServers(configPath(ws, "cursor"))), ["theirs"]);
    assert.equal(Object.keys(tomlServers(configPath(ws, "codex"))).length, 0);
    assert.equal(readFileSync(configPath(ws, "codex"), "utf8").includes("multizen"), false);
    assert.equal(svc.configOf("proj"), null);
    assert.deepEqual(svc.workspaces.listForProject("proj"), [], "bindings forgotten");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deletion is refused (project kept) when an agent file cannot be cleaned", async () => {
  if (process.getuid?.() === 0) return; // root bypasses mode bits
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", ws, ["cursor"]);
    assert.ok(jsonServers(configPath(ws, "cursor")).m_proj_srv);

    // Make the .cursor directory unwritable so the cleanup write fails.
    chmodSync(join(ws, ".cursor"), 0o500);
    const deleted = await ctl.deleteProject("proj");
    assert.equal(deleted.ok, false, "deletion refused rather than orphaning entries");
    if (!deleted.ok) assert.equal(deleted.error.code, "cleanup-failed");
    assert.ok(svc.configOf("proj"), "the project was kept");

    // After fixing permissions the delete succeeds and cleans up.
    chmodSync(join(ws, ".cursor"), 0o700);
    const retry = await ctl.deleteProject("proj");
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(Object.keys(jsonServers(configPath(ws, "cursor"))).length, 0);
    assert.equal(svc.configOf("proj"), null);
    await svc.shutdown();
  } finally {
    try {
      chmodSync(join(dir, "work", ".cursor"), 0o700);
    } catch {
      /* already restored */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting a project never deletes the bound browser profile", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  let boundServerRequested = false;
  try {
    const svc = new GatewayService({
      dataDir: dir,
      vault: new MemoryVault(),
      allowedHosts: ["127.0.0.1:7777"],
      baseUrl: BASE,
      envSource: {},
      makeBoundServer: () => {
        boundServerRequested = true;
        throw new Error("browser driver must not be involved in deletion");
      },
      runtimeOptions: { stdioFactory: fakeStdioFactory() },
    });
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "proj", enabled: true, browserProfileId: "profile-keepme" });
    await ctl.setDirectoryAgents("proj", ws, ["cursor"]);

    const deleted = await ctl.deleteProject("proj");
    assert.equal(deleted.ok, true);
    assert.equal(
      boundServerRequested,
      false,
      "no browser/profile machinery was touched by deletion",
    );
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── persistence ────────────────────────────────────────────────────────────

test("directory associations and agent selections survive a restart", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  const vault = new MemoryVault();
  try {
    const a = makeService(dir, vault);
    await a.start();
    const ctlA = makeController(a);
    await seed(ctlA);
    await ctlA.setDirectoryAgents("proj", ws, ["codex", "kiro-cli"]);
    await a.shutdown();

    const b = makeService(dir, vault);
    await b.start();
    const ctlB = makeController(b);
    const dirs = await ctlB.directories("proj");
    assert.equal(dirs.ok, true);
    if (dirs.ok) {
      assert.equal(dirs.value.length, 1);
      assert.deepEqual(dirs.value[0]?.agents.map((x) => x.agent).sort(), [
        "codex",
        "kiro-cli",
      ]);
      assert.equal(
        dirs.value[0]?.agents.every((x) => x.status === "current"),
        true,
        "still current after restart (nothing changed)",
      );
      assert.equal(dirs.value[0]?.directory, ws);
    }
    await b.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory reached by a symlink canonicalizes to one binding", async () => {
  const dir = tmp();
  const real = mkws(dir, "real");
  const { symlinkSync } = await import("node:fs");
  const link = join(dir, "link");
  symlinkSync(real, link, "dir");
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    await ctl.setDirectoryAgents("proj", real, ["cursor"]);
    await ctl.setDirectoryAgents("proj", link, ["cursor"]);

    const dirs = await ctl.directories("proj");
    assert.equal(dirs.ok && dirs.value.length, 1, "both spellings are one binding");
    assert.equal(dirs.ok && dirs.value[0]?.directory, realpathSync(real));
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown agent in the selection is rejected", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await seed(ctl);
    const res = await ctl.setDirectoryAgents("proj", ws, ["nope" as AgentKind]);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "invalid");
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("directory operations on an unknown project report not-found", async () => {
  const dir = tmp();
  const ws = mkws(dir);
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    for (const res of [
      await ctl.directories("nope"),
      await ctl.setDirectoryAgents("nope", ws, ["cursor"]),
      await ctl.removeDirectory("nope", ws),
      await ctl.reconcileDirectories("nope"),
      await ctl.retryDirectoryAgent("nope", ws, "cursor"),
    ]) {
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.error.code, "not-found");
    }
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
