/**
 * Per-agent workspace MCP configuration adapters.
 *
 * A project's enabled endpoints are described once as {@link DesiredEndpoint}s
 * and then rendered into each agent's own file format. Every adapter obeys the
 * same ownership contract:
 *
 *   - It writes ONLY deterministic Sekvona-owned keys
 *     (short project/server aliases).
 *   - It removes previously-owned keys that are no longer desired.
 *   - It refuses (`collision`) to overwrite a same-named entry that Sekvona is
 *     not recorded as owning, so a user's or another tool's server is never
 *     silently replaced.
 *   - It preserves every unrelated entry AND every unrelated top-level field,
 *     including ones this version of Sekvona does not understand.
 *
 * Authentication is ALWAYS emitted as an environment-variable reference in the
 * syntax each agent understands. The bearer token itself is never written into a
 * workspace file — it stays in OS secure storage.
 *
 * Verified formats (see the plan's research table):
 *   Claude Code  `<ws>/.mcp.json`                 mcpServers, explicit type:"http"
 *   Cursor       `<ws>/.cursor/mcp.json`          mcpServers, ${env:NAME}
 *   Kiro CLI     `<ws>/.kiro/settings/mcp.json`   mcpServers, ${NAME}
 */

import { createHash } from "node:crypto";
import { parse as tomlParse } from "@iarna/toml";

import { ConfigFileError } from "./ConfigFileTransactor.ts";
import { AGENT_KINDS, type AgentKind } from "./types.ts";

/** One gateway endpoint Sekvona installs into an agent configuration. */
export interface DesiredEndpoint {
  /** Deterministic Sekvona-owned entry key. */
  readonly key: string;
  /** Streamable HTTP URL of the gateway route. */
  readonly url: string;
  /**
   * Environment variable NAME holding the project's bearer token, when the
   * project requires auth. Rendered as a reference, never as a value.
   */
  readonly authEnvName?: string;
}

/** Everything an adapter needs to produce a file's new content. */
export interface RenderArgs {
  /** The project whose endpoints are being installed. */
  readonly projectId: string;
  /** Current file text, or null when the file does not exist. */
  readonly current: string | null;
  /** Entries that should exist after the write. */
  readonly desired: readonly DesiredEndpoint[];
  /** Keys Sekvona wrote last time; the only keys it may replace or remove. */
  readonly ownedKeys: readonly string[];
}

/** One agent's file location and rendering rules. */
export interface AgentAdapter {
  readonly agent: AgentKind;
  /** Workspace-relative path segments of the config file. */
  readonly relativePath: readonly string[];
  /** Produce the file's complete new text. */
  render(args: RenderArgs): string;
  /**
   * Operator guidance for a precondition this agent imposes that Sekvona
   * cannot satisfy by writing the file (e.g. an approval prompt).
   */
  readonly postInstallHint?: string;
}

// ── deterministic naming ────────────────────────────────────────────────────

// Reserve underscores for separators and a leading hyphen for hashed components.
function shortId(id: string, reserved = ""): string {
  if (id !== reserved && /^[a-z0-9-]{1,8}$/.test(id)) return id;
  return "-" + createHash("sha256").update(id).digest("hex").slice(0, 10);
}

/** Entry key for one upstream proxy endpoint. */
export function proxyEntryKey(projectId: string, serverId: string): string {
  return `m_${shortId(projectId)}_${shortId(serverId, "browser")}`;
}

/** Entry key for a project's profile-bound browser endpoint. */
export function browserEntryKey(projectId: string): string {
  return `m_${shortId(projectId)}_browser`;
}

/** True when a key is one Sekvona could have generated for this project. */
export function isMultizenKeyFor(projectId: string, key: string): boolean {
  return key.startsWith(`m_${shortId(projectId)}_`);
}

/**
 * The environment variable NAME that carries a project's bearer token.
 *
 * Project ids allow `-`, which is illegal in an environment variable name, so
 * the id is upper-cased with `-` mapped to `_`. That mapping is lossy (`a-b` and
 * `a_b` both become `A_B`), which would make two projects share one token
 * variable, so a short digest of the EXACT id disambiguates. The result is
 * stable across devices because it depends only on the project id.
 */
export function projectTokenEnvName(projectId: string): string {
  const sanitized = projectId.toUpperCase().replace(/-/g, "_");
  const digest = createHash("sha256").update(projectId).digest("hex").slice(0, 6).toUpperCase();
  return `MULTIZEN_PROJECT_${sanitized}_${digest}_TOKEN`;
}

// ── shared JSON merge ───────────────────────────────────────────────────────

/** Detect an existing file's indentation so a rewrite does not reformat it. */
function detectIndent(text: string | null): string {
  if (text === null) return "  ";
  const m = /\n([ \t]+)"/.exec(text);
  const ws = m?.[1];
  if (ws === undefined || ws.length === 0) return "  ";
  return ws.includes("\t") ? "\t" : " ".repeat(Math.min(8, ws.length));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Defensive invariant: every key an adapter is asked to write must be one this
 * project owns. A violation would mean a caller built the desired set wrongly
 * and could otherwise clobber another project's entry.
 */
function assertDesiredKeysBelongTo(
  projectId: string,
  desired: readonly DesiredEndpoint[],
): void {
  for (const e of desired) {
    if (!isMultizenKeyFor(projectId, e.key)) {
      throw new ConfigFileError(
        `entry key "${e.key}" does not belong to project "${projectId}"`,
        "collision",
      );
    }
  }
}

/**
 * Merge desired entries into a JSON document that keys its servers under
 * `mcpServers`. Existing keys keep their position (insertion order is preserved
 * by mutating in place), so re-installing produces a minimal diff.
 */
function mergeJsonServers(
  args: RenderArgs,
  renderEntry: (endpoint: DesiredEndpoint) => Record<string, unknown>,
  fileLabel: string,
): string {
  const { current, desired, ownedKeys, projectId } = args;
  assertDesiredKeysBelongTo(projectId, desired);
  const trimmed = current?.trim() ?? "";

  let doc: Record<string, unknown>;
  if (trimmed.length === 0) {
    doc = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new ConfigFileError(
        `${fileLabel} is not valid JSON: ${(err as Error).message}`,
        "malformed",
        `Fix or remove ${fileLabel}, then retry. Sekvona will not overwrite a file it cannot parse.`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new ConfigFileError(
        `${fileLabel} must contain a JSON object at its top level`,
        "malformed",
        `Fix or remove ${fileLabel}, then retry.`,
      );
    }
    doc = parsed;
  }

  const existingServers = doc.mcpServers;
  if (existingServers !== undefined && !isPlainObject(existingServers)) {
    throw new ConfigFileError(
      `${fileLabel} has an "mcpServers" field that is not an object`,
      "malformed",
      `Fix ${fileLabel}'s "mcpServers" field, then retry.`,
    );
  }
  const servers: Record<string, unknown> = isPlainObject(existingServers)
    ? existingServers
    : {};

  const owned = new Set(ownedKeys);
  const desiredByKey = new Map(desired.map((e) => [e.key, e]));

  // Refuse to take over an entry we are not recorded as owning.
  for (const key of desiredByKey.keys()) {
    if (key in servers && !owned.has(key)) {
      throw new ConfigFileError(
        `${fileLabel} already defines an MCP server named "${key}" that Sekvona does not manage`,
        "collision",
        `Rename or remove the existing "${key}" entry in ${fileLabel}, then retry.`,
      );
    }
  }

  // Drop owned entries that are no longer desired (disabled server, unbound
  // browser, removed server, or a full uninstall).
  for (const key of owned) {
    if (!desiredByKey.has(key) && key in servers) delete servers[key];
  }

  // Upsert desired entries. Existing keys keep their original position.
  for (const endpoint of desired) {
    servers[endpoint.key] = renderEntry(endpoint);
  }

  doc.mcpServers = servers;

  const indent = detectIndent(current);
  const body = JSON.stringify(doc, null, indent);
  // Preserve the file's trailing-newline convention; default to having one.
  const hadTrailingNewline = current === null ? true : current.endsWith("\n");
  return hadTrailingNewline ? `${body}\n` : body;
}

// ── adapters ────────────────────────────────────────────────────────────────

/**
 * Claude Code — `<workspace>/.mcp.json`.
 *
 * A URL entry MUST declare its transport: Claude reads an entry with no `type`
 * as a stdio server and skips it with a configuration error. `${NAME}` expands
 * in `url` and `headers`.
 */
export const claudeCodeAdapter: AgentAdapter = {
  agent: "claude-code",
  relativePath: [".mcp.json"],
  postInstallHint:
    "Claude Code asks you to approve project-scoped servers the first time you " +
    "open this directory. Run `claude` there and approve Sekvona's servers.",
  render: (args) =>
    mergeJsonServers(
      args,
      (e) => ({
        type: "http",
        url: e.url,
        ...(e.authEnvName !== undefined
          ? { headers: { Authorization: `Bearer \${${e.authEnvName}}` } }
          : {}),
      }),
      ".mcp.json",
    ),
};

/**
 * Cursor — `<workspace>/.cursor/mcp.json`.
 *
 * Cursor interpolates environment variables with its own `${env:NAME}` syntax
 * (plain `${NAME}` is NOT expanded), and identifies a remote server by `url`.
 */
export const cursorAdapter: AgentAdapter = {
  agent: "cursor",
  relativePath: [".cursor", "mcp.json"],
  render: (args) =>
    mergeJsonServers(
      args,
      (e) => ({
        url: e.url,
        ...(e.authEnvName !== undefined
          ? { headers: { Authorization: `Bearer \${env:${e.authEnvName}}` } }
          : {}),
      }),
      ".cursor/mcp.json",
    ),
};

/**
 * Kiro CLI — `<workspace>/.kiro/settings/mcp.json`.
 *
 * Kiro accepts an HTTP endpoint on localhost and expands `${NAME}`, but only for
 * names the operator has approved in its own settings — hence the hint.
 */
export const kiroCliAdapter: AgentAdapter = {
  agent: "kiro-cli",
  relativePath: [".kiro", "settings", "mcp.json"],
  postInstallHint:
    "Kiro only expands environment variables you have approved. If this project " +
    "requires a token, add its variable under Kiro's “Mcp Approved Env Vars” setting.",
  render: (args) =>
    mergeJsonServers(
      args,
      (e) => ({
        url: e.url,
        ...(e.authEnvName !== undefined
          ? { headers: { Authorization: `Bearer \${${e.authEnvName}}` } }
          : {}),
      }),
      ".kiro/settings/mcp.json",
    ),
};

// ── Codex TOML ──────────────────────────────────────────────────────────────

const CODEX_FILE = ".codex/config.toml";

/** Begin marker for one project's managed block. */
function blockBegin(projectId: string): string {
  return `# >>> multizen:${projectId} — managed by MultiZen, do not edit inside this block`;
}
/** End marker for one project's managed block. */
function blockEnd(projectId: string): string {
  return `# <<< multizen:${projectId}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * TOML basic-string escaping for the only values we emit (URLs and env names).
 * Both are already constrained, but escaping keeps the emitted document correct
 * for any input rather than relying on that.
 */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Validate a TOML document, converting a parse failure into `malformed`. */
function assertValidToml(text: string, label: string): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const parsed = tomlParse(text);
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ConfigFileError(
      `${label} is not valid TOML: ${(err as Error).message}`,
      "malformed",
      `Fix or remove ${label}, then retry. Sekvona will not overwrite a file it cannot parse.`,
    );
  }
}

/**
 * Split a document around this project's managed block.
 *
 * Only the lines BETWEEN (and including) the markers are ours. Everything else —
 * comments, unrelated tables, blank lines, formatting — is carried through
 * verbatim, which is why Codex gets a marker-block strategy instead of a
 * parse-and-restringify one that would discard the user's comments.
 */
function splitAroundBlock(
  text: string,
  projectId: string,
): { before: string; after: string; found: boolean } {
  const begin = escapeRegExp(blockBegin(projectId));
  const end = escapeRegExp(blockEnd(projectId));
  const re = new RegExp(`${begin}[\\s\\S]*?${end}[^\\n]*\\n?`, "m");
  const match = re.exec(text);
  if (!match) return { before: text, after: "", found: false };
  return {
    before: text.slice(0, match.index),
    after: text.slice(match.index + match[0].length),
    found: true,
  };
}

/** Render one project's complete managed block. */
function renderCodexBlock(projectId: string, desired: readonly DesiredEndpoint[]): string {
  const lines: string[] = [blockBegin(projectId)];
  for (const e of desired) {
    lines.push(`[mcp_servers.${e.key}]`);
    lines.push(`url = ${tomlString(e.url)}`);
    if (e.authEnvName !== undefined) {
      // Codex reads the token from this environment variable at connect time;
      // the value is never written into the file.
      lines.push(`bearer_token_env_var = ${tomlString(e.authEnvName)}`);
    }
    lines.push("");
  }
  lines.push(blockEnd(projectId));
  return `${lines.join("\n")}\n`;
}

/**
 * Codex CLI — `<workspace>/.codex/config.toml`.
 *
 * Codex shares one configuration format between the CLI, IDE extension, and the
 * desktop app, and supports a project-scoped file for TRUSTED projects. Because
 * that file routinely carries hand-written settings and comments, Sekvona owns
 * only a delimited block and never reformats the rest of the document.
 */
export const codexAdapter: AgentAdapter = {
  agent: "codex",
  relativePath: [".codex", "config.toml"],
  postInstallHint:
    "Codex reads a project-scoped .codex/config.toml only for projects you have " +
    "trusted. If the servers do not appear, trust this directory in Codex.",
  render: ({ projectId, current, desired, ownedKeys }) => {
    assertDesiredKeysBelongTo(projectId, desired);
    const text = current ?? "";

    // Refuse to touch a document we cannot parse: rewriting it could destroy
    // settings we failed to understand.
    if (text.trim().length > 0) assertValidToml(text, CODEX_FILE);

    const { before, after, found } = splitAroundBlock(text, projectId);
    const remainder = `${before}${after}`;

    // Collision check against everything OUTSIDE our own block. A key defined
    // elsewhere in the document is not ours to replace, even if a stale
    // ownership record claims it.
    if (desired.length > 0 && remainder.trim().length > 0) {
      const parsed = assertValidToml(remainder, CODEX_FILE);
      const outside = parsed.mcp_servers;
      if (isPlainObject(outside)) {
        for (const e of desired) {
          if (e.key in outside) {
            throw new ConfigFileError(
              `${CODEX_FILE} already defines [mcp_servers.${e.key}] outside Sekvona's managed block`,
              "collision",
              `Remove or rename the [mcp_servers.${e.key}] table in ${CODEX_FILE}, then retry.`,
            );
          }
        }
      }
    }
    // A recorded owned key that now lives outside our block means the markers
    // were edited away; surface that rather than silently duplicating tables.
    if (found === false && ownedKeys.length > 0 && remainder.trim().length > 0) {
      const parsed = assertValidToml(remainder, CODEX_FILE);
      const outside = parsed.mcp_servers;
      if (isPlainObject(outside)) {
        const orphaned = ownedKeys.filter((k) => k in outside);
        if (orphaned.length > 0) {
          throw new ConfigFileError(
            `${CODEX_FILE} contains Sekvona tables (${orphaned.join(", ")}) whose managed-block markers were removed`,
            "collision",
            `Delete the [mcp_servers.${orphaned[0] as string}] table (and any other listed orphaned tables) from ${CODEX_FILE}, then retry.`,
          );
        }
      }
    }

    // Removing everything: drop the block and leave the rest byte-identical.
    if (desired.length === 0) {
      return found ? normalizeJoin(before, after) : text;
    }

    const block = renderCodexBlock(projectId, desired);
    if (found) {
      // Re-insert at the SAME position so the document's layout is stable.
      return `${ensureBlockBoundary(before)}${block}${after}`;
    }
    const base = text.length === 0 ? "" : ensureBlockBoundary(text);
    const result = `${base}${block}`;
    // Validate the document we are about to hand back.
    assertValidToml(result, CODEX_FILE);
    return result;
  },
};

/** Ensure the text preceding a block ends with exactly one blank separator. */
function ensureBlockBoundary(text: string): string {
  if (text.length === 0) return "";
  const trimmedEnd = text.replace(/\n+$/, "");
  return `${trimmedEnd}\n\n`;
}

/** Join the remainder after removing a block, collapsing the seam. */
function normalizeJoin(before: string, after: string): string {
  if (before.length === 0) return after.replace(/^\n+/, "");
  if (after.length === 0) return before.replace(/\n{3,}$/, "\n");
  return `${before.replace(/\n+$/, "\n")}${after.replace(/^\n+/, "")}`;
}


// ── registry ────────────────────────────────────────────────────────────────

/** Every adapter, keyed by agent. */
export const AGENT_ADAPTERS: Readonly<Record<AgentKind, AgentAdapter>> = {
  "claude-code": claudeCodeAdapter,
  cursor: cursorAdapter,
  codex: codexAdapter,
  "kiro-cli": kiroCliAdapter,
};

/** Look up the adapter for an agent. */
export function adapterFor(agent: AgentKind): AgentAdapter {
  return AGENT_ADAPTERS[agent];
}

/** Every supported agent has exactly one adapter (checked at module load). */
for (const kind of AGENT_KINDS) {
  if (AGENT_ADAPTERS[kind] === undefined) {
    throw new Error(`missing agent adapter for ${kind}`);
  }
}
