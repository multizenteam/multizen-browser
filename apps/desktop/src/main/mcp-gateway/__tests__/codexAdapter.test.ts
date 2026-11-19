import assert from "node:assert/strict";
import test from "node:test";

import { parse as tomlParse } from "@iarna/toml";

import { ConfigFileError } from "../ConfigFileTransactor.ts";
import {
  adapterFor,
  AGENT_ADAPTERS,
  browserEntryKey,
  codexAdapter,
  proxyEntryKey,
  type DesiredEndpoint,
} from "../agentAdapters.ts";
import { AGENT_KINDS } from "../types.ts";

const BASE = "http://127.0.0.1:7777";

function proxy(projectId: string, serverId: string, authEnvName?: string): DesiredEndpoint {
  return {
    key: proxyEntryKey(projectId, serverId),
    url: `${BASE}/mcp/proxies/${projectId}/${serverId}`,
    ...(authEnvName !== undefined ? { authEnvName } : {}),
  };
}

function browser(projectId: string): DesiredEndpoint {
  return { key: browserEntryKey(projectId), url: `${BASE}/mcp/projects/${projectId}/browser` };
}

function render(args: {
  projectId: string;
  current: string | null;
  desired: readonly DesiredEndpoint[];
  ownedKeys?: readonly string[];
}): string {
  return codexAdapter.render({
    projectId: args.projectId,
    current: args.current,
    desired: args.desired,
    ownedKeys: args.ownedKeys ?? [],
  });
}

function servers(text: string): Record<string, Record<string, unknown>> {
  const doc = tomlParse(text) as Record<string, unknown>;
  return (doc.mcp_servers ?? {}) as Record<string, Record<string, unknown>>;
}

/** A realistic hand-written Codex config with comments and unrelated settings. */
const EXISTING = `# My Codex configuration
# Keep this file tidy.

model = "gpt-5"
mcp_optional_startup_grace_ms = 1500

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]  # docs lookup

# A remote server I set up by hand.
[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
`;

// ── shape + registry ────────────────────────────────────────────────────────

test("the Codex adapter targets .codex/config.toml and carries a trust hint", () => {
  assert.deepEqual(codexAdapter.relativePath, [".codex", "config.toml"]);
  assert.equal(codexAdapter.agent, "codex");
  assert.match(codexAdapter.postInstallHint ?? "", /trust/i);
});

test("every supported agent resolves to exactly one adapter", () => {
  for (const kind of AGENT_KINDS) {
    const adapter = adapterFor(kind);
    assert.equal(adapter.agent, kind, `adapterFor(${kind}) returns the right adapter`);
  }
  assert.equal(Object.keys(AGENT_ADAPTERS).length, AGENT_KINDS.length);
});

// ── install ─────────────────────────────────────────────────────────────────

test("installing into a missing file produces a valid, self-delimiting block", () => {
  const out = render({
    projectId: "zabit",
    current: null,
    desired: [proxy("zabit", "docs", "MULTIZEN_PROJECT_ZABIT_A1B2C3_TOKEN"), browser("zabit")],
  });
  assert.equal(
    out,
    `# >>> multizen:zabit — managed by MultiZen, do not edit inside this block
[mcp_servers.m_zabit_docs]
url = "${BASE}/mcp/proxies/zabit/docs"
bearer_token_env_var = "MULTIZEN_PROJECT_ZABIT_A1B2C3_TOKEN"

[mcp_servers.m_zabit_browser]
url = "${BASE}/mcp/projects/zabit/browser"

# <<< multizen:zabit
`,
  );
  // And it parses as real TOML with the expected tables.
  const s = servers(out);
  assert.equal(s.m_zabit_docs?.url, `${BASE}/mcp/proxies/zabit/docs`);
  assert.equal(
    s.m_zabit_docs?.bearer_token_env_var,
    "MULTIZEN_PROJECT_ZABIT_A1B2C3_TOKEN",
  );
  assert.equal(s.m_zabit_browser?.bearer_token_env_var, undefined);
});

test("auth is emitted as bearer_token_env_var, never as a token value", () => {
  const out = render({
    projectId: "p",
    current: null,
    desired: [proxy("p", "s", "MY_TOKEN_VAR")],
  });
  assert.equal(out.includes("bearer_token_env_var"), true);
  assert.equal(out.includes("MY_TOKEN_VAR"), true);
  assert.equal(/Bearer\s+\S/.test(out), false, "no inline Authorization header value");
});

test("existing comments and settings are preserved byte-for-byte outside the block", () => {
  const out = render({
    projectId: "zabit",
    current: EXISTING,
    desired: [proxy("zabit", "docs")],
  });
  // Everything the user wrote is still present, verbatim.
  assert.equal(out.startsWith(EXISTING.replace(/\n+$/, "\n")), true);
  assert.equal(out.includes("# My Codex configuration"), true);
  assert.equal(out.includes("# Keep this file tidy."), true);
  assert.equal(out.includes('args = ["-y", "@upstash/context7-mcp"]  # docs lookup'), true);
  assert.equal(out.includes("# A remote server I set up by hand."), true);
  assert.equal(out.includes('model = "gpt-5"'), true);
  assert.equal(out.includes("mcp_optional_startup_grace_ms = 1500"), true);

  const s = servers(out);
  assert.deepEqual(Object.keys(s).sort(), [
    "context7",
    "figma",
    "m_zabit_docs",
  ]);
  assert.equal(s.figma?.bearer_token_env_var, "FIGMA_OAUTH_TOKEN", "untouched");
});

test("the emitted document is valid TOML even alongside unrelated tables", () => {
  const out = render({
    projectId: "p",
    current: EXISTING,
    desired: [proxy("p", "a"), proxy("p", "b"), browser("p")],
  });
  assert.doesNotThrow(() => tomlParse(out));
  assert.equal(Object.keys(servers(out)).length, 5);
});

// ── update / idempotence ────────────────────────────────────────────────────

test("re-rendering an installed document is byte-identical (idempotent)", () => {
  const desired = [proxy("p", "s", "TOK"), browser("p")];
  const once = render({ projectId: "p", current: EXISTING, desired });
  const twice = render({
    projectId: "p",
    current: once,
    desired,
    ownedKeys: desired.map((d) => d.key),
  });
  assert.equal(twice, once);
});

test("an update replaces the block in place without moving it", () => {
  const withTrailing = `${EXISTING}\n# a trailing comment the user added\n`;
  const first = render({
    projectId: "p",
    current: withTrailing,
    desired: [proxy("p", "a")],
  });
  // Put the user's trailing comment AFTER our block to prove in-place replace.
  const reordered = first.replace(
    "# a trailing comment the user added\n",
    "",
  ) + "# a trailing comment the user added\n";
  const second = render({
    projectId: "p",
    current: reordered,
    desired: [proxy("p", "a"), proxy("p", "b")],
    ownedKeys: ["m_p_a"],
  });
  assert.equal(
    second.endsWith("# a trailing comment the user added\n"),
    true,
    "content after the block stays after it",
  );
  assert.deepEqual(Object.keys(servers(second)).sort(), [
    "context7",
    "figma",
    "m_p_a",
    "m_p_b",
  ]);
});

test("two projects keep independent blocks in one file", () => {
  let doc = render({ projectId: "alpha", current: EXISTING, desired: [proxy("alpha", "s")] });
  doc = render({ projectId: "beta", current: doc, desired: [proxy("beta", "s")] });
  assert.doesNotThrow(() => tomlParse(doc));
  assert.deepEqual(Object.keys(servers(doc)).sort(), [
    "context7",
    "figma",
    "m_alpha_s",
    "m_beta_s",
  ]);
  assert.equal(doc.includes("# >>> multizen:alpha"), true);
  assert.equal(doc.includes("# >>> multizen:beta"), true);

  // Removing alpha leaves beta's block and the user's content intact.
  const afterAlpha = render({
    projectId: "alpha",
    current: doc,
    desired: [],
    ownedKeys: ["m_alpha_s"],
  });
  assert.doesNotThrow(() => tomlParse(afterAlpha));
  assert.deepEqual(Object.keys(servers(afterAlpha)).sort(), [
    "context7",
    "figma",
    "m_beta_s",
  ]);
  assert.equal(afterAlpha.includes("multizen:alpha"), false, "alpha's markers are gone");
  assert.equal(afterAlpha.includes("# My Codex configuration"), true);
});

// ── removal ─────────────────────────────────────────────────────────────────

test("a full uninstall removes the block and restores the user's document", () => {
  const installed = render({
    projectId: "p",
    current: EXISTING,
    desired: [proxy("p", "a"), browser("p")],
  });
  const uninstalled = render({
    projectId: "p",
    current: installed,
    desired: [],
    ownedKeys: ["m_p_a", "m_p_browser"],
  });
  assert.equal(uninstalled.includes("multizen"), false, "no MultiZen trace remains");
  assert.deepEqual(Object.keys(servers(uninstalled)).sort(), ["context7", "figma"]);
  assert.equal(uninstalled.includes('model = "gpt-5"'), true);
  assert.doesNotThrow(() => tomlParse(uninstalled));
});

test("uninstalling when nothing was installed leaves the file untouched", () => {
  const out = render({ projectId: "p", current: EXISTING, desired: [], ownedKeys: [] });
  assert.equal(out, EXISTING, "byte-identical");
});

test("uninstalling from a missing file yields no file content", () => {
  const out = render({ projectId: "p", current: null, desired: [] });
  assert.equal(out, "");
});

// ── collisions + malformed ──────────────────────────────────────────────────

test("a table defined outside our block is refused, not replaced", () => {
  const hostile = `${EXISTING}
[mcp_servers.m_p_s]
url = "https://someone-elses.example.com/mcp"
`;
  assert.throws(
    () => render({ projectId: "p", current: hostile, desired: [proxy("p", "s")] }),
    (e: ConfigFileError) =>
      e instanceof ConfigFileError &&
      e.code === "collision" &&
      e.message.includes("m_p_s") &&
      typeof e.hint === "string",
  );
});

test("orphaned MultiZen tables whose markers were deleted are reported, not duplicated", () => {
  const orphaned = `${EXISTING}
[mcp_servers.m_p_a]
url = "${BASE}/mcp/proxies/p/a"
`;
  assert.throws(
    () =>
      render({
        projectId: "p",
        current: orphaned,
        desired: [],
        ownedKeys: ["m_p_a"],
      }),
    (e: ConfigFileError) => e.code === "collision" && /markers were removed/.test(e.message),
  );
});

test("malformed TOML is refused with an actionable hint and never rewritten", () => {
  for (const bad of ["[mcp_servers", 'key = = "x"', "[[[nope]]]"]) {
    assert.throws(
      () => render({ projectId: "p", current: bad, desired: [proxy("p", "s")] }),
      (e: ConfigFileError) =>
        e instanceof ConfigFileError && e.code === "malformed" && typeof e.hint === "string",
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test("a desired key belonging to another project is refused", () => {
  assert.throws(
    () =>
      codexAdapter.render({
        projectId: "mine",
        current: null,
        desired: [proxy("theirs", "s")],
        ownedKeys: [],
      }),
    (e: ConfigFileError) => e.code === "collision" && /does not belong/.test(e.message),
  );
});

test("marker corruption (a begin with no end) is treated as no block", () => {
  // A truncated begin marker must not swallow the rest of the file; without a
  // matching end marker the block is simply not found, and a fresh one appends.
  const corrupted = `${EXISTING}\n# >>> multizen:p — managed by MultiZen, do not edit inside this block\n`;
  const out = render({ projectId: "p", current: corrupted, desired: [proxy("p", "s")] });
  assert.doesNotThrow(() => tomlParse(out));
  assert.equal(servers(out).m_p_s?.url, `${BASE}/mcp/proxies/p/s`);
  assert.equal(out.includes("# My Codex configuration"), true, "user content survived");
});

test("values are TOML-escaped so an odd URL cannot break the document", () => {
  const out = codexAdapter.render({
    projectId: "p",
    current: null,
    desired: [{ key: "m_p_s", url: 'http://x/"quoted"\\path' }],
    ownedKeys: [],
  });
  assert.doesNotThrow(() => tomlParse(out));
  assert.equal(servers(out).m_p_s?.url, 'http://x/"quoted"\\path');
});

test("quoted/dotted identifiers elsewhere in the document survive a round trip", () => {
  const tricky = `[mcp_servers."weird.name"]
command = "x"

[plugins."sample@test".mcp_servers.sample]
enabled = true
`;
  const out = render({ projectId: "p", current: tricky, desired: [proxy("p", "s")] });
  assert.doesNotThrow(() => tomlParse(out));
  assert.equal(out.includes('[mcp_servers."weird.name"]'), true);
  assert.equal(out.includes('[plugins."sample@test".mcp_servers.sample]'), true);
  assert.ok(servers(out).m_p_s);
});
