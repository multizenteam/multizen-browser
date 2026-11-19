import assert from "node:assert/strict";
import test from "node:test";

import { ConfigFileError } from "../ConfigFileTransactor.ts";
import {
  browserEntryKey,
  claudeCodeAdapter,
  cursorAdapter,
  isMultizenKeyFor,
  kiroCliAdapter,
  projectTokenEnvName,
  proxyEntryKey,
  type AgentAdapter,
  type DesiredEndpoint,
} from "../agentAdapters.ts";

const BASE = "http://127.0.0.1:7777";
const JSON_ADAPTERS: AgentAdapter[] = [claudeCodeAdapter, cursorAdapter, kiroCliAdapter];

function proxy(projectId: string, serverId: string, authEnvName?: string): DesiredEndpoint {
  return {
    key: proxyEntryKey(projectId, serverId),
    url: `${BASE}/mcp/proxies/${projectId}/${serverId}`,
    ...(authEnvName !== undefined ? { authEnvName } : {}),
  };
}

function browser(projectId: string): DesiredEndpoint {
  return {
    key: browserEntryKey(projectId),
    url: `${BASE}/mcp/projects/${projectId}/browser`,
  };
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Render helper that infers `projectId` from the keys under test, so each case
 * exercises the adapter with the project its entries actually belong to.
 */
function render(
  adapter: AgentAdapter,
  args: { current: string | null; desired: readonly DesiredEndpoint[]; ownedKeys: readonly string[] },
): string {
  const sample = args.desired[0]?.key ?? args.ownedKeys[0] ?? "m_p_x";
  const projectId = /^m_(.+?)_/.exec(sample)?.[1] ?? "p";
  return adapter.render({ ...args, projectId });
}

function servers(text: string): Record<string, Record<string, unknown>> {
  return (parse(text).mcpServers ?? {}) as Record<string, Record<string, unknown>>;
}

// ── naming ──────────────────────────────────────────────────────────────────

test("entry keys are deterministic, namespaced, and recognizable", () => {
  assert.equal(proxyEntryKey("proj", "srv"), "m_proj_srv");
  assert.equal(browserEntryKey("proj"), "m_proj_browser");
  assert.equal(isMultizenKeyFor("proj", "m_proj_srv"), true);
  assert.equal(isMultizenKeyFor("proj", "m_other_srv"), false);
  assert.equal(isMultizenKeyFor("proj", "someones_server"), false);
  // Keys use only characters every agent accepts for a server name.
  assert.match(proxyEntryKey("my-proj", "my-srv"), /^[A-Za-z0-9_-]+$/);
});

test("the token env name is a legal variable, stable, and collision-free", () => {
  const a = projectTokenEnvName("zabit");
  assert.match(a, /^[A-Z_][A-Z0-9_]*$/, "a legal POSIX environment variable name");
  assert.equal(a, projectTokenEnvName("zabit"), "stable across calls/devices");
  assert.equal(a.includes("ZABIT"), true, "still readable");
  // The lossy `-`→`_` mapping must not make two distinct ids share a variable.
  assert.notEqual(projectTokenEnvName("a-b"), projectTokenEnvName("a_b"));
  assert.match(projectTokenEnvName("a-b"), /^[A-Z_][A-Z0-9_]*$/);
});

// ── per-agent shape ─────────────────────────────────────────────────────────

test("Claude Code writes .mcp.json with an explicit http type", () => {
  assert.deepEqual(claudeCodeAdapter.relativePath, [".mcp.json"]);
  const out = render(claudeCodeAdapter, {
    current: null,
    desired: [proxy("proj", "srv")],
    ownedKeys: [],
  });
  const entry = servers(out)["m_proj_srv"];
  assert.equal(entry?.type, "http", "a url entry without a type is a Claude config error");
  assert.equal(entry?.url, `${BASE}/mcp/proxies/proj/srv`);
  assert.equal(entry?.headers, undefined, "no auth header when the project has no auth");
});

test("Cursor writes .cursor/mcp.json and uses ${env:NAME} interpolation", () => {
  assert.deepEqual(cursorAdapter.relativePath, [".cursor", "mcp.json"]);
  const out = render(cursorAdapter, {
    current: null,
    desired: [proxy("proj", "srv", "MULTIZEN_PROJECT_PROJ_ABC123_TOKEN")],
    ownedKeys: [],
  });
  const entry = servers(out)["m_proj_srv"];
  assert.equal(entry?.url, `${BASE}/mcp/proxies/proj/srv`);
  assert.deepEqual(entry?.headers, {
    Authorization: "Bearer ${env:MULTIZEN_PROJECT_PROJ_ABC123_TOKEN}",
  });
});

test("Kiro writes .kiro/settings/mcp.json and uses ${NAME} interpolation", () => {
  assert.deepEqual(kiroCliAdapter.relativePath, [".kiro", "settings", "mcp.json"]);
  const out = render(kiroCliAdapter, {
    current: null,
    desired: [proxy("proj", "srv", "TOK")],
    ownedKeys: [],
  });
  const entry = servers(out)["m_proj_srv"];
  assert.deepEqual(entry?.headers, { Authorization: "Bearer ${TOK}" });
});

test("only a reference is written — never a token value", () => {
  const token = "real-bearer-token-value";
  for (const adapter of JSON_ADAPTERS) {
    const out = render(adapter, {
      current: null,
      desired: [proxy("proj", "srv", "MY_TOKEN_VAR")],
      ownedKeys: [],
    });
    assert.equal(out.includes(token), false, `${adapter.agent} leaked a value`);
    assert.equal(out.includes("MY_TOKEN_VAR"), true, `${adapter.agent} must reference the name`);
  }
});

// ── install into missing / empty / existing files ───────────────────────────

test("a missing file yields a complete, minimal document", () => {
  for (const adapter of JSON_ADAPTERS) {
    const out = render(adapter, { current: null, desired: [proxy("p", "s")], ownedKeys: [] });
    assert.deepEqual(Object.keys(parse(out)), ["mcpServers"], adapter.agent);
    assert.equal(out.endsWith("\n"), true, "a trailing newline by default");
  }
});

test("an empty or whitespace-only file is treated as an empty document", () => {
  for (const current of ["", "   \n\t "]) {
    for (const adapter of JSON_ADAPTERS) {
      const out = render(adapter, { current, desired: [proxy("p", "s")], ownedKeys: [] });
      assert.equal(Object.keys(servers(out)).length, 1, adapter.agent);
    }
  }
});

test("unrelated servers AND unrelated top-level fields are preserved", () => {
  const current = JSON.stringify(
    {
      $schema: "https://example.com/schema.json",
      someFutureField: { nested: [1, 2, 3] },
      mcpServers: {
        theirServer: { command: "npx", args: ["-y", "their-mcp"] },
        anotherRemote: { url: "https://api.example.com/mcp" },
      },
    },
    null,
    2,
  );
  for (const adapter of JSON_ADAPTERS) {
    const out = render(adapter, {
      current,
      desired: [proxy("proj", "srv")],
      ownedKeys: [],
    });
    const doc = parse(out);
    assert.equal(doc.$schema, "https://example.com/schema.json", adapter.agent);
    assert.deepEqual(doc.someFutureField, { nested: [1, 2, 3] }, adapter.agent);
    const s = servers(out);
    assert.deepEqual(s.theirServer, { command: "npx", args: ["-y", "their-mcp"] });
    assert.deepEqual(s.anotherRemote, { url: "https://api.example.com/mcp" });
    assert.ok(s.m_proj_srv, "ours was added alongside");
  }
});

test("existing key order is preserved and new entries append", () => {
  const current = JSON.stringify(
    { mcpServers: { alpha: { url: "u1" }, beta: { url: "u2" } } },
    null,
    2,
  );
  const out = render(claudeCodeAdapter, {
    current,
    desired: [proxy("p", "s")],
    ownedKeys: [],
  });
  assert.deepEqual(Object.keys(servers(out)), ["alpha", "beta", "m_p_s"]);
});

test("an updated owned entry keeps its original position (minimal diff)", () => {
  const first = render(claudeCodeAdapter, {
    current: JSON.stringify({ mcpServers: { alpha: { url: "u1" } } }, null, 2),
    desired: [proxy("p", "s")],
    ownedKeys: [],
  });
  assert.deepEqual(Object.keys(servers(first)), ["alpha", "m_p_s"]);
  // Re-render with a changed URL; position must not move to the end.
  const second = render(claudeCodeAdapter, {
    current: first,
    desired: [{ key: "m_p_s", url: `${BASE}/mcp/proxies/p/s2` }],
    ownedKeys: ["m_p_s"],
  });
  assert.deepEqual(Object.keys(servers(second)), ["alpha", "m_p_s"]);
  assert.equal(servers(second)["m_p_s"]?.url, `${BASE}/mcp/proxies/p/s2`);
});

test("re-rendering an already-installed file is byte-identical (idempotent)", () => {
  for (const adapter of JSON_ADAPTERS) {
    const desired = [proxy("p", "s", "TOK"), browser("p")];
    const once = render(adapter, { current: null, desired, ownedKeys: [] });
    const twice = render(adapter, {
      current: once,
      desired,
      ownedKeys: desired.map((d) => d.key),
    });
    assert.equal(twice, once, `${adapter.agent} is not idempotent`);
  }
});

test("the existing file's indentation and newline style are respected", () => {
  const fourSpace = '{\n    "mcpServers": {\n        "alpha": {\n            "url": "u"\n        }\n    }\n}\n';
  const out = render(claudeCodeAdapter, {
    current: fourSpace,
    desired: [proxy("p", "s")],
    ownedKeys: [],
  });
  assert.equal(out.includes('\n    "mcpServers"'), true, "kept 4-space indentation");

  const noTrailing = '{\n  "mcpServers": {}\n}';
  const out2 = render(claudeCodeAdapter, {
    current: noTrailing,
    desired: [proxy("p", "s")],
    ownedKeys: [],
  });
  assert.equal(out2.endsWith("\n"), false, "kept the missing trailing newline");
});

// ── update / removal ────────────────────────────────────────────────────────

test("owned entries no longer desired are removed; others are untouched", () => {
  const installed = render(claudeCodeAdapter, {
    current: JSON.stringify({ mcpServers: { theirs: { url: "u" } } }, null, 2),
    desired: [proxy("p", "a"), proxy("p", "b"), browser("p")],
    ownedKeys: [],
  });
  assert.deepEqual(Object.keys(servers(installed)).sort(), [
    "m_p_a",
    "m_p_b",
    "m_p_browser",
    "theirs",
  ]);

  // Server "b" disabled and the browser profile unbound.
  const updated = render(claudeCodeAdapter, {
    current: installed,
    desired: [proxy("p", "a")],
    ownedKeys: ["m_p_a", "m_p_b", "m_p_browser"],
  });
  assert.deepEqual(Object.keys(servers(updated)).sort(), ["m_p_a", "theirs"]);
});

test("a full uninstall removes every owned entry and leaves the rest intact", () => {
  const installed = render(kiroCliAdapter, {
    current: JSON.stringify(
      { extra: true, mcpServers: { theirs: { command: "x" } } },
      null,
      2,
    ),
    desired: [proxy("p", "a"), browser("p")],
    ownedKeys: [],
  });
  const uninstalled = render(kiroCliAdapter, {
    current: installed,
    desired: [],
    ownedKeys: ["m_p_a", "m_p_browser"],
  });
  assert.deepEqual(Object.keys(servers(uninstalled)), ["theirs"]);
  assert.equal(parse(uninstalled).extra, true, "unrelated top-level field survived");
});

test("removal only touches THIS project's owned keys", () => {
  let doc = render(claudeCodeAdapter, {
    current: null,
    desired: [proxy("alpha", "s")],
    ownedKeys: [],
  });
  doc = render(claudeCodeAdapter, {
    current: doc,
    desired: [proxy("beta", "s")],
    ownedKeys: [],
  });
  assert.deepEqual(Object.keys(servers(doc)).sort(), ["m_alpha_s", "m_beta_s"]);

  // Uninstalling project alpha must leave project beta installed.
  const afterAlphaRemoved = render(claudeCodeAdapter, {
    current: doc,
    desired: [],
    ownedKeys: ["m_alpha_s"],
  });
  assert.deepEqual(Object.keys(servers(afterAlphaRemoved)), ["m_beta_s"]);
});

test("a disabled project (no desired endpoints) with no prior install is a clean no-op", () => {
  const current = JSON.stringify({ mcpServers: { theirs: { url: "u" } } }, null, 2);
  const out = render(claudeCodeAdapter, { current, desired: [], ownedKeys: [] });
  assert.deepEqual(Object.keys(servers(out)), ["theirs"]);
});

// ── collisions and malformed input ──────────────────────────────────────────

test("a same-named entry MultiZen does not own is refused, not overwritten", () => {
  const current = JSON.stringify(
    { mcpServers: { m_p_s: { command: "not-ours", args: [] } } },
    null,
    2,
  );
  for (const adapter of JSON_ADAPTERS) {
    assert.throws(
      () => render(adapter, { current, desired: [proxy("p", "s")], ownedKeys: [] }),
      (e: ConfigFileError) =>
        e instanceof ConfigFileError &&
        e.code === "collision" &&
        typeof e.hint === "string" &&
        e.message.includes("m_p_s"),
      adapter.agent,
    );
  }
});

test("an owned key IS allowed to be replaced", () => {
  const current = JSON.stringify(
    { mcpServers: { m_p_s: { type: "http", url: "old" } } },
    null,
    2,
  );
  const out = render(claudeCodeAdapter, {
    current,
    desired: [proxy("p", "s")],
    ownedKeys: ["m_p_s"],
  });
  assert.equal(servers(out)["m_p_s"]?.url, `${BASE}/mcp/proxies/p/s`);
});

test("malformed JSON is refused with an actionable hint and never rewritten", () => {
  for (const adapter of JSON_ADAPTERS) {
    assert.throws(
      () =>
        render(adapter, {
          current: '{ "mcpServers": { oops }',
          desired: [proxy("p", "s")],
          ownedKeys: [],
        }),
      (e: ConfigFileError) =>
        e instanceof ConfigFileError && e.code === "malformed" && typeof e.hint === "string",
      adapter.agent,
    );
  }
});

test("a non-object document or non-object mcpServers is refused", () => {
  for (const adapter of JSON_ADAPTERS) {
    assert.throws(
      () => render(adapter, { current: "[1,2,3]", desired: [], ownedKeys: [] }),
      (e: ConfigFileError) => e.code === "malformed",
      adapter.agent,
    );
    assert.throws(
      () =>
        render(adapter, {
          current: '{ "mcpServers": "nope" }',
          desired: [],
          ownedKeys: [],
        }),
      (e: ConfigFileError) => e.code === "malformed",
      adapter.agent,
    );
  }
});

// ── golden fixtures ─────────────────────────────────────────────────────────

test("golden: Claude Code full install with auth + browser", () => {
  const out = render(claudeCodeAdapter, {
    current: null,
    desired: [proxy("zabit", "docs", "MULTIZEN_PROJECT_ZABIT_A1B2C3_TOKEN"), browser("zabit")],
    ownedKeys: [],
  });
  assert.equal(
    out,
    `{
  "mcpServers": {
    "m_zabit_docs": {
      "type": "http",
      "url": "${BASE}/mcp/proxies/zabit/docs",
      "headers": {
        "Authorization": "Bearer \${MULTIZEN_PROJECT_ZABIT_A1B2C3_TOKEN}"
      }
    },
    "m_zabit_browser": {
      "type": "http",
      "url": "${BASE}/mcp/projects/zabit/browser"
    }
  }
}
`,
  );
});

test("golden: Cursor full install with auth + browser", () => {
  const out = render(cursorAdapter, {
    current: null,
    desired: [proxy("zabit", "docs", "MULTIZEN_PROJECT_ZABIT_A1B2C3_TOKEN"), browser("zabit")],
    ownedKeys: [],
  });
  assert.equal(
    out,
    `{
  "mcpServers": {
    "m_zabit_docs": {
      "url": "${BASE}/mcp/proxies/zabit/docs",
      "headers": {
        "Authorization": "Bearer \${env:MULTIZEN_PROJECT_ZABIT_A1B2C3_TOKEN}"
      }
    },
    "m_zabit_browser": {
      "url": "${BASE}/mcp/projects/zabit/browser"
    }
  }
}
`,
  );
});

test("golden: Kiro full install with auth + browser", () => {
  const out = render(kiroCliAdapter, {
    current: null,
    desired: [proxy("zabit", "docs", "MULTIZEN_PROJECT_ZABIT_A1B2C3_TOKEN"), browser("zabit")],
    ownedKeys: [],
  });
  assert.equal(
    out,
    `{
  "mcpServers": {
    "m_zabit_docs": {
      "url": "${BASE}/mcp/proxies/zabit/docs",
      "headers": {
        "Authorization": "Bearer \${MULTIZEN_PROJECT_ZABIT_A1B2C3_TOKEN}"
      }
    },
    "m_zabit_browser": {
      "url": "${BASE}/mcp/projects/zabit/browser"
    }
  }
}
`,
  );
});

test("agents that impose an extra precondition carry an operator hint", () => {
  assert.equal(typeof claudeCodeAdapter.postInstallHint, "string", "project approval");
  assert.equal(typeof kiroCliAdapter.postInstallHint, "string", "approved env vars");
  assert.equal(cursorAdapter.postInstallHint, undefined, "Cursor needs no extra step");
});

test("long identifiers stay bounded and the browser route has its own name", () => {
  const id = "a".repeat(64);
  assert.ok(proxyEntryKey(id, id).length <= 25);
  assert.notEqual(proxyEntryKey(id, "browser"), browserEntryKey(id));
  assert.notEqual(proxyEntryKey("a_b", "c"), proxyEntryKey("a", "b_c"));
});

test("migration removes only recorded legacy entries", () => {
  const result = cursorAdapter.render({
    projectId: "proj",
    current: JSON.stringify({ mcpServers: { multizen_proj_srv: {}, multizen_proj_custom: {} } }),
    desired: [proxy("proj", "srv")],
    ownedKeys: ["multizen_proj_srv"],
  });
  assert.deepEqual(Object.keys(servers(result)).sort(), ["m_proj_srv", "multizen_proj_custom"]);
});
