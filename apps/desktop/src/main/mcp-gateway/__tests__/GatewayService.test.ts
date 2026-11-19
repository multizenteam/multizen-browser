import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GatewayService } from "../GatewayService.ts";
import { GatewayController } from "../GatewayController.ts";
import { fakeStdioFactory, MemoryVault } from "./testSupport.ts";

function makeService(dataDir: string, vault = new MemoryVault()) {
  return new GatewayService({
    dataDir,
    vault,
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: { stdioFactory: fakeStdioFactory() },
    // No syncMaterials → local-only.
  });
}

/** Controller bound to a served gateway (route URLs are live). */
function makeController(svc: GatewayService): GatewayController {
  return new GatewayController(svc, {
    baseUrl: svc.baseUrl,
    routesServed: () => true,
  });
}

test("local-only: create/list/get project, atomic persistence across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);

    const created = await ctl.createProject({ id: "proj1", label: "Proj 1", enabled: true });
    assert.equal(created.ok, true);

    const added = await ctl.addServer("proj1", {
      transport: "stdio",
      id: "srv",
      command: "echo",
      args: ["hi"],
      env: { API_KEY: "${MY_KEY}" },
    });
    assert.equal(added.ok, true);
    await svc.shutdown();

    // Restart: config is loaded from disk.
    const svc2 = makeService(dir);
    await svc2.start();
    const ctl2 = makeController(svc2);
    const got = await ctl2.getProject("proj1");
    assert.equal(got.ok, true);
    if (got.ok) {
      assert.equal(got.value.label, "Proj 1");
      assert.equal(got.value.servers.length, 1);
    }
    await svc2.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serializable views redact env/header values to ${NAME} references only (no expansion)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "p", enabled: true });
    await ctl.addServer("p", {
      transport: "streamable-http",
      id: "h",
      url: "https://api.example.com",
      headers: { Authorization: "${UPSTREAM_TOKEN}" },
    });
    const view = await ctl.getProject("p");
    assert.equal(view.ok, true);
    if (view.ok) {
      const server = view.value.servers[0];
      assert.equal(server?.transport, "streamable-http");
      if (server?.transport === "streamable-http") {
        // The header value is the reference NAME form — never an expanded secret.
        assert.equal(server.headers.Authorization, "${UPSTREAM_TOKEN}");
      }
    }
    // Full serialization must not contain any expanded secret string.
    const json = JSON.stringify(view);
    assert.equal(json.includes("Bearer "), false);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth toggle + one-shot token reveal; views never carry the token value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "p", enabled: true });

    const enabled = await ctl.setAuthEnabled("p", true);
    assert.equal(enabled.ok, true);
    if (enabled.ok) {
      assert.equal(enabled.value.enabled, true);
      assert.equal(enabled.value.tokenPresent, false, "no token yet");
    }

    const gen = await ctl.generateToken("p");
    assert.equal(gen.ok, true);
    const token = gen.ok ? gen.value.token : "";
    assert.match(token, /^[0-9a-f]{64}$/);

    // authStatus reports presence but NEVER the token.
    const status = await ctl.authStatus("p");
    assert.equal(status.ok, true);
    if (status.ok) {
      assert.equal(status.value.tokenPresent, true);
      assert.equal(JSON.stringify(status.value).includes(token), false, "token never in a view");
    }
    // A full project view also never carries the token.
    const view = await ctl.getProject("p");
    assert.equal(JSON.stringify(view).includes(token), false);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("endpoints view lists proxy URLs + browser only when bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "p", enabled: true });
    await ctl.addServer("p", { transport: "stdio", id: "s", command: "echo", args: [], env: {} });
    let ep = ctl.endpoints("p");
    assert.equal(ep.ok, true);
    if (ep.ok) {
      assert.equal(ep.value.proxies[0]?.url, "http://127.0.0.1:7777/mcp/proxies/p/s");
      assert.equal(ep.value.browser, undefined, "no browser route until bound");
    }
    await ctl.bindProfile("p", "profile-xyz");
    ep = ctl.endpoints("p");
    if (ep.ok) {
      assert.equal(ep.value.browser, "http://127.0.0.1:7777/mcp/projects/p/browser");
    }
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a quarantined project (recorded in state) never auto-starts at startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  try {
    // Seed a valid config file + a state.json quarantining it.
    const root = join(dir, "mcp-gateway");
    mkdirSync(join(root, "projects"), { recursive: true });
    const config = {
      configVersion: 1,
      id: "bad",
      enabled: true,
      localAuth: { enabled: false },
      servers: [
        { transport: "stdio", id: "s", disabled: false, command: "echo", args: [], env: {} },
      ],
    };
    // canonical form the store writes is fine to approximate for load.
    writeFileSync(join(root, "projects", "bad.json"), JSON.stringify(config));
    writeFileSync(
      join(root, "state.json"),
      JSON.stringify({
        revisions: {},
        quarantine: {
          bad: {
            projectId: "bad",
            reason: "bad-signature",
            code: "bad-signature",
            detectedAt: "now",
          },
        },
        conflicts: {},
      }),
    );

    const svc = makeService(dir);
    await svc.start();
    // The quarantined project is not in the active config set, so nothing runs.
    assert.equal(svc.runtime.status().length, 0, "quarantined project started no servers");
    const ctl = makeController(svc);
    const q = ctl.quarantine();
    assert.equal(q.ok && q.value.length, 1);

    // Releasing quarantine re-loads + reconciles → the server now starts.
    await svc.releaseQuarantine("bad");
    assert.equal(svc.runtime.hasLiveServer("bad", "s"), true);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting a project config never couples to browser-profile deletion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  try {
    const svc = makeService(dir);
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "p", enabled: true, browserProfileId: "profile-1" });
    const del = await ctl.deleteProject("p");
    assert.equal(del.ok, true);
    // No browser driver / profile manager call is made by removeConfig — the
    // makeBoundServer factory (which would throw) is never invoked for delete.
    assert.equal(svc.configOf("p"), null);
    await svc.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth Connect reports failure when the probe succeeds but the live connection fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-oauth-"));
  let attempts = 0;
  const svc = new GatewayService({
    dataDir: dir,
    vault: new MemoryVault(),
    allowedHosts: ["127.0.0.1:7777"],
    baseUrl: "http://127.0.0.1:7777",
    makeBoundServer: () => {
      throw new Error("no browser in this test");
    },
    runtimeOptions: {
      httpFactory: () => {
        const attempt = ++attempts;
        return {
          async start() {},
          async close() {},
          async send(message) {
            if (!("method" in message) || !("id" in message)) return;
            if (attempt >= 3 && message.method === "tools/list") {
              this.onmessage?.({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32603, message: "secret upstream detail" },
              });
            } else
              this.onmessage?.({
                jsonrpc: "2.0",
                id: message.id,
                result:
                  message.method === "initialize"
                    ? {
                        protocolVersion: "2025-06-18",
                        capabilities: { tools: {} },
                        serverInfo: { name: "test", version: "1" },
                      }
                    : { tools: [] },
              });
          },
        };
      },
    },
  });
  try {
    await svc.start();
    const ctl = makeController(svc);
    await ctl.createProject({ id: "p", enabled: true, browserProfileId: "profile" });
    await ctl.addServer("p", {
      transport: "streamable-http",
      id: "sentry",
      auth: "oauth",
      url: "https://example.com/mcp",
      headers: {},
    });
    svc.oauth.authorize = async () => {};
    const result = await ctl.connectOAuthServer("p", "sentry");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /live MCP connection failed: MCP tools\/list failed/);
      assert.equal(result.error.message.includes("secret upstream detail"), false);
    }
    assert.equal(ctl.runtime("p").ok, true);
    assert.equal(svc.runtime.status()[0]?.phase, "failed");
    assert.match(svc.runtime.status()[0]?.lastError ?? "", /MCP tools\/list/);
  } finally {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new project ID limit and Unicode name shortening apply to create and rename", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-project-name-"));
  const svc = makeService(dir);
  await svc.start();
  t.after(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  const ctl = makeController(svc);
  const id = "p".repeat(24);
  assert.equal((await ctl.createProject({ id: id + "x" })).ok, false);
  assert.equal((await ctl.createProject({ id, label: "🦊".repeat(33) })).ok, true);
  assert.equal(svc.configOf(id)?.label, "🦊".repeat(32));
  assert.equal((await ctl.updateProject(id, { label: "a".repeat(40) })).ok, true);
  assert.equal(svc.configOf(id)?.label, "a".repeat(32));
});
