import { useCallback, useState, type JSX } from "react";
import { CheckCircle2, PlugZap, Plus, X, XCircle } from "lucide-react";

import type { ProbeResultView, ServerInput } from "../../types";
import { Button } from "../atoms/Button";
import { cn } from "../../lib/cn";

/**
 * Editor for one upstream MCP server, shared by the creation wizard and the
 * project detail pane.
 *
 * A credential can be given two ways, and the distinction matters:
 *
 *   - **Paste the value.** Sekvona puts it in OS secure storage and writes only
 *     a `${NAME}` reference into the project config, so the value never lands in
 *     a config file and never syncs to another device. This is the default,
 *     because it is what most operators actually want.
 *   - **Name an environment variable.** Nothing is stored; the value is read from
 *     the host environment at launch, on whichever device is running.
 *
 * Either way the persisted, portable form is a reference — the two options differ
 * only in where the value comes from. A pasted value is write-only: once stored
 * there is no control anywhere that reads it back, so an existing row shows
 * "stored" rather than the secret, and leaving it untouched keeps it.
 */

/** How a row's value is supplied. */
export type RefMode = "value" | "reference";

/** One `name -> value | ${SOURCE}` row (a child env var, or an HTTP header). */
export interface RefRow {
  /** The child-visible variable name, or the HTTP header name. */
  readonly key: string;
  /** Whether the value is pasted here or read from the environment. */
  readonly mode: RefMode;
  /**
   * In `reference` mode, the environment variable NAME to read from. In `value`
   * mode this carries the existing reference name of an already-stored value, so
   * an untouched row can keep pointing at it.
   */
  readonly from: string;
  /** The raw secret, in `value` mode. Empty means "keep what is stored". */
  readonly value: string;
  /** True when a value is already in secure storage for this row. */
  readonly stored: boolean;
}

/** A blank row. Pasting a value is the default because it is the common case. */
export function emptyRefRow(): RefRow {
  return { key: "", mode: "value", from: "", value: "", stored: false };
}

export interface ServerDraft {
  readonly transport: "stdio" | "streamable-http";
  readonly id: string;
  readonly label: string;
  /** stdio */
  readonly command: string;
  /** One argument per line, so arguments containing spaces stay intact. */
  readonly argsText: string;
  readonly cwd: string;
  /** streamable-http */
  readonly url: string;
  readonly auth?: "headers" | "oauth";
  /** env refs for stdio; header refs for streamable-http. */
  readonly refs: readonly RefRow[];
}

export function emptyServerDraft(transport: ServerDraft["transport"] = "stdio"): ServerDraft {
  return {
    transport,
    id: "",
    label: "",
    command: "",
    argsText: "",
    cwd: "",
    url: "",
    auth: "headers",
    refs: [],
  };
}

/** The gateway's server-id grammar: 1–64 chars of [a-z0-9_-]. */
export function isValidServerId(id: string): boolean {
  return /^[a-z0-9_-]{1,64}$/.test(id);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** HTTP header field-name token per RFC 7230. */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validate a draft, returning the first problem as operator-facing text, or null
 * when the draft is ready to submit.
 */
export function validateServerDraft(draft: ServerDraft): string | null {
  if (!isValidServerId(draft.id)) {
    return "A server id may use only lower-case letters, digits, hyphens, and underscores.";
  }
  if (draft.transport === "stdio") {
    if (draft.command.trim().length === 0) return "Enter the command that starts the server.";
  } else {
    const url = draft.url.trim();
    if (url.length === 0) return "Enter the server’s URL.";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "That URL is not valid.";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "The URL must use http or https.";
    }
    if (draft.auth === "oauth" && url.includes("${")) {
      return "OAuth server URLs cannot contain environment references.";
    }
  }
  for (const row of draft.refs) {
    const key = row.key.trim();
    if (key.length === 0 && row.from.trim().length === 0 && row.value.length === 0) continue;
    if (draft.transport === "stdio") {
      if (!ENV_NAME.test(key)) return `“${key}” is not a valid environment variable name.`;
    } else if (!HEADER_TOKEN.test(key)) {
      return `“${key}” is not a valid HTTP header name.`;
    }
    if (draft.transport === "streamable-http" && draft.auth === "oauth") {
      return "OAuth servers cannot set manual headers.";
    }
    if (row.mode === "reference") {
      const from = row.from.trim();
      if (!ENV_NAME.test(from)) {
        return `“${from}” is not a valid environment variable name.`;
      }
    } else if (row.value.length === 0 && !row.stored) {
      return `Paste a value for “${key}”, or read it from an environment variable instead.`;
    }
  }
  return null;
}

/**
 * Convert a validated draft into the `ServerInput` the backend accepts.
 *
 * Reference rows become `${NAME}` in env/headers. Rows with a pasted value go
 * into `secretValues` instead, and the backend stores each one and substitutes
 * the reference — the renderer never has to know the derived name. A row whose
 * value is already stored and was not retyped contributes only its existing
 * reference, so saving an unrelated field cannot wipe the credential.
 */
export function serverDraftToInput(draft: ServerDraft): ServerInput {
  const refs: Record<string, string> = {};
  const secretValues: Record<string, string> = {};
  for (const row of draft.refs) {
    const key = row.key.trim();
    if (key.length === 0) continue;
    if (row.mode === "reference") {
      const from = row.from.trim();
      if (from.length === 0) continue;
      refs[key] = `\${${from}}`;
      continue;
    }
    if (row.value.length > 0) {
      secretValues[key] = row.value;
      continue;
    }
    // Untouched stored value: keep pointing at the reference it already uses.
    if (row.stored && row.from.length > 0) refs[key] = `\${${row.from}}`;
  }
  const label = draft.label.trim();
  const secrets =
    Object.keys(secretValues).length > 0 ? { secretValues } : {};
  if (draft.transport === "stdio") {
    const args = draft.argsText
      .split("\n")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    const cwd = draft.cwd.trim();
    return {
      transport: "stdio",
      id: draft.id,
      ...(label.length > 0 ? { label } : {}),
      command: draft.command.trim(),
      args,
      env: refs,
      ...(cwd.length > 0 ? { cwd } : {}),
      ...secrets,
    };
  }
  return {
    transport: "streamable-http",
    id: draft.id,
    ...(label.length > 0 ? { label } : {}),
    url: draft.url.trim(),
    ...(draft.auth === "oauth" ? { auth: "oauth" as const } : {}),
    headers: refs,
    ...secrets,
  };
}

/**
 * Rebuild an editable draft from an existing server view.
 *
 * `managedNames` are the reference names that currently have a value in secure
 * storage, so a row can be shown as a stored value rather than as an environment
 * reference. Taking it as an argument — instead of guessing from the shape of the
 * name — keeps this honest when naming rules change.
 */
export function draftFromServerInput(
  input: ServerInput,
  managedNames: readonly string[] = [],
): ServerDraft {
  const managed = new Set(managedNames);
  const refs: RefRow[] = Object.entries(
    input.transport === "stdio" ? (input.env ?? {}) : (input.headers ?? {}),
  ).map(([key, ref]) => {
    // Stored values are pure `${NAME}` references; strip the wrapper for editing.
    const name = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(ref)?.[1] ?? ref;
    const stored = managed.has(name);
    return {
      key,
      mode: stored ? ("value" as const) : ("reference" as const),
      from: name,
      value: "",
      stored,
    };
  });
  return {
    transport: input.transport,
    id: input.id,
    label: input.label ?? "",
    command: input.transport === "stdio" ? input.command : "",
    argsText: input.transport === "stdio" ? [...(input.args ?? [])].join("\n") : "",
    cwd: input.transport === "stdio" ? (input.cwd ?? "") : "",
    url: input.transport === "streamable-http" ? input.url : "",
    auth: input.transport === "streamable-http" ? (input.auth ?? "headers") : "headers",
    refs,
  };
}

const INPUT_STYLE = {
  height: 32,
  padding: "0 10px",
  borderRadius: 8,
  background: "rgba(0,0,0,0.25)",
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
} as const;

export interface ServerFormProps {
  readonly draft: ServerDraft;
  readonly onChange: (next: ServerDraft) => void;
  /** False when editing an existing server — ids are immutable once created. */
  readonly idEditable?: boolean;
  /**
   * Project the server belongs to, or null while a project is still being
   * created. Only affects which already-stored credentials a test can draw on.
   */
  readonly projectId?: string | null;
  /** Selected profile while the project is still being created. */
  readonly oauthProfileId?: string | null;
}

export function ServerForm({
  draft,
  onChange,
  idEditable = true,
  projectId = null,
  oauthProfileId = null,
}: ServerFormProps): JSX.Element {
  const patch = useCallback(
    (part: Partial<ServerDraft>) => onChange({ ...draft, ...part }),
    [draft, onChange],
  );

  const setRef = useCallback(
    (index: number, part: Partial<RefRow>) => {
      const refs = draft.refs.map((r, i) => (i === index ? { ...r, ...part } : r));
      onChange({ ...draft, refs });
    },
    [draft, onChange],
  );

  const isStdio = draft.transport === "stdio";

  // A result is only meaningful for the exact definition that produced it, so it
  // is discarded the moment any field changes. A green tick left over from an
  // earlier draft would be worse than no result at all.
  const [tested, setTested] = useState<{ forDraft: string; result: ProbeResultView } | null>(
    null,
  );
  const [testing, setTesting] = useState(false);
  const draftKey = JSON.stringify(draft);
  const result = tested?.forDraft === draftKey ? tested.result : null;
  const blocking = validateServerDraft(draft);

  const test = useCallback(async () => {
    setTesting(true);
    try {
      const res = await window.multizen.gateway.testServer(
        projectId,
        serverDraftToInput(draft),
        ...(oauthProfileId ? [oauthProfileId] : []),
      );
      setTested({
        forDraft: draftKey,
        result: res.ok
          ? res.value
          : { ok: false, durationMs: 0, error: res.error.message },
      });
    } finally {
      setTesting(false);
    }
  }, [draft, draftKey, projectId, oauthProfileId]);

  return (
    <div className="space-y-3">
      {/* transport */}
      <div>
        <FieldLabel>Transport</FieldLabel>
        <div className="flex gap-1.5" role="radiogroup" aria-label="Transport">
          {(
            [
              ["stdio", "Local command (stdio)"],
              ["streamable-http", "Remote URL (HTTP)"],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={draft.transport === value}
              onClick={() => patch({ transport: value })}
              className={cn(
                "text-[12px] transition-colors",
                draft.transport === value
                  ? "text-purple-200"
                  : "text-slate-400 hover:text-slate-200",
              )}
              style={{
                height: 30,
                padding: "0 11px",
                borderRadius: 8,
                background:
                  draft.transport === value
                    ? "rgba(180,226,255,0.12)"
                    : "rgba(255,255,255,0.03)",
                boxShadow:
                  draft.transport === value
                    ? "inset 0 0 0 1px rgba(180,226,255,0.25)"
                    : "inset 0 0 0 1px rgba(255,255,255,0.06)",
              }}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <FieldLabel>Server id</FieldLabel>
          <input
            type="text"
            value={draft.id}
            readOnly={!idEditable}
            onChange={(e) => patch({ id: e.target.value })}
            placeholder="docs"
            aria-label="Server id"
            className="w-full mono text-[12px] text-slate-200 outline-none"
            style={{ ...INPUT_STYLE, opacity: idEditable ? 1 : 0.6 }}
          />
        </label>
        <label className="block">
          <FieldLabel>Label (optional)</FieldLabel>
          <input
            type="text"
            value={draft.label}
            onChange={(e) => patch({ label: e.target.value })}
            placeholder="Docs lookup"
            aria-label="Server label"
            className="w-full text-[12px] text-slate-200 outline-none"
            style={INPUT_STYLE}
          />
        </label>
      </div>

      {isStdio ? (
        <>
          <label className="block">
            <FieldLabel>Command</FieldLabel>
            <input
              type="text"
              value={draft.command}
              onChange={(e) => patch({ command: e.target.value })}
              placeholder="npx"
              aria-label="Command"
              className="w-full mono text-[12px] text-slate-200 outline-none"
              style={INPUT_STYLE}
            />
          </label>
          <label className="block">
            <FieldLabel>Arguments — one per line</FieldLabel>
            <textarea
              value={draft.argsText}
              onChange={(e) => patch({ argsText: e.target.value })}
              placeholder={"-y\n@upstash/context7-mcp"}
              aria-label="Arguments"
              rows={3}
              className="w-full mono text-[12px] text-slate-200 outline-none"
              style={{
                ...INPUT_STYLE,
                height: "auto",
                padding: "8px 10px",
                resize: "vertical",
              }}
            />
          </label>
          <label className="block">
            <FieldLabel>Working directory (optional)</FieldLabel>
            <input
              type="text"
              value={draft.cwd}
              onChange={(e) => patch({ cwd: e.target.value })}
              aria-label="Working directory"
              className="w-full mono text-[12px] text-slate-200 outline-none"
              style={INPUT_STYLE}
            />
          </label>
        </>
      ) : (
        <div className="space-y-3">
          <label className="block">
            <FieldLabel>URL</FieldLabel>
            <input
              type="text"
              value={draft.url}
              onChange={(e) => patch({ url: e.target.value })}
              placeholder="https://mcp.example.com/mcp"
              aria-label="Server URL"
              className="w-full mono text-[12px] text-slate-200 outline-none"
              style={INPUT_STYLE}
            />
          </label>
          <div>
            <FieldLabel>Authentication</FieldLabel>
            <div className="flex gap-1.5" role="radiogroup" aria-label="Authentication">
              {([["headers", "Headers / none"], ["oauth", "OAuth sign-in"]] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={(draft.auth ?? "headers") === value}
                  onClick={() => patch({ auth: value, ...(value === "oauth" ? { refs: [] } : {}) })}
                  className={cn(
                    "text-[12px] transition-colors",
                    (draft.auth ?? "headers") === value ? "text-purple-200" : "text-slate-400 hover:text-slate-200",
                  )}
                  style={{
                    height: 30,
                    padding: "0 11px",
                    borderRadius: 8,
                    background: (draft.auth ?? "headers") === value ? "rgba(180,226,255,0.12)" : "rgba(255,255,255,0.03)",
                    boxShadow: (draft.auth ?? "headers") === value ? "inset 0 0 0 1px rgba(180,226,255,0.25)" : "inset 0 0 0 1px rgba(255,255,255,0.06)",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {draft.auth === "oauth" && (
              <p className="text-[11px] text-slate-500 mt-1.5">
                Test connection opens sign-in in this project's browser profile.
              </p>
            )}
          </div>
        </div>
      )}

      {/* env / header references */}
      <div hidden={!isStdio && draft.auth === "oauth"}>
        <div className="flex items-center gap-2 mb-1.5">
          <FieldLabel className="mb-0">
            {isStdio ? "Environment variables" : "Headers"}
          </FieldLabel>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Plus size={12} />}
            onClick={() => onChange({ ...draft, refs: [...draft.refs, emptyRefRow()] })}
          >
            Add
          </Button>
        </div>
        {draft.refs.length === 0 ? (
          <div className="text-[11px] text-slate-500 leading-relaxed">
            {isStdio
              ? "Add a variable when the server needs a token. Paste the value and Sekvona keeps it in your OS keychain, or point at an environment variable instead."
              : "Add a header when the server needs authentication. Paste the value and Sekvona keeps it in your OS keychain, or point at an environment variable instead."}
          </div>
        ) : (
          <div className="space-y-2">
            {draft.refs.map((row, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={row.key}
                      onChange={(e) => {
                        // In reference mode keep the source name in step while it
                        // mirrors the key, so the common "same name" case needs
                        // one field rather than two.
                        const mirrored = row.mode === "reference" && row.from === row.key;
                        setRef(i, {
                          key: e.target.value,
                          ...(mirrored ? { from: e.target.value } : {}),
                        });
                      }}
                      placeholder={isStdio ? "API_TOKEN" : "Authorization"}
                      aria-label={`${isStdio ? "Variable" : "Header"} name ${i + 1}`}
                      className="flex-1 min-w-0 mono text-[12px] text-slate-200 outline-none"
                      style={INPUT_STYLE}
                    />
                    <div
                      className="flex gap-0.5 flex-shrink-0"
                      role="radiogroup"
                      aria-label={`How to supply ${row.key.trim().length > 0 ? row.key.trim() : `entry ${i + 1}`}`}
                      style={{
                        padding: 2,
                        borderRadius: 8,
                        background: "rgba(0,0,0,0.25)",
                        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                      }}
                    >
                      {(
                        [
                          ["value", "Value"],
                          ["reference", "Variable"],
                        ] as const
                      ).map(([mode, text]) => (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={row.mode === mode}
                          onClick={() =>
                            setRef(i, {
                              mode,
                              // Switching to a variable seeds the name from the
                              // key, since they usually match; without this the
                              // row silently becomes invalid on the mode change.
                              ...(mode === "reference" && row.from.length === 0
                                ? { from: row.key.trim() }
                                : {}),
                            })
                          }
                          className={cn(
                            "text-[11px] transition-colors",
                            row.mode === mode
                              ? "text-purple-200"
                              : "text-slate-500 hover:text-slate-300",
                          )}
                          style={{
                            height: 24,
                            padding: "0 9px",
                            borderRadius: 6,
                            background:
                              row.mode === mode ? "rgba(180,226,255,0.14)" : "transparent",
                          }}
                        >
                          {text}
                        </button>
                      ))}
                    </div>
                  </div>

                  {row.mode === "value" ? (
                    <>
                      <input
                        type="password"
                        value={row.value}
                        autoComplete="off"
                        onChange={(e) => setRef(i, { value: e.target.value })}
                        placeholder={row.stored ? "Stored — type to replace" : "Paste the value"}
                        aria-label={`Value ${i + 1}`}
                        className="w-full mono text-[12px] text-slate-200 outline-none"
                        style={INPUT_STYLE}
                      />
                      <div className="text-[10.5px] text-slate-500 leading-relaxed">
                        {row.stored && row.value.length === 0
                          ? "A value is stored in your OS keychain. Leave this blank to keep it."
                          : "Kept in your OS keychain. The project config stores only a reference, so this is never written to a file or synced."}
                      </div>
                    </>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={row.from}
                        onChange={(e) => setRef(i, { from: e.target.value })}
                        placeholder="API_TOKEN"
                        aria-label={`Source variable ${i + 1}`}
                        className="w-full mono text-[12px] text-slate-200 outline-none"
                        style={INPUT_STYLE}
                      />
                      <div className="text-[10.5px] text-slate-500 leading-relaxed">
                        Read from this environment variable at launch. You approve the name
                        in References, and each device supplies its own value.
                      </div>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onChange({ ...draft, refs: draft.refs.filter((_, j) => j !== i) })
                  }
                  aria-label={`Remove reference ${i + 1}`}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-slate-500 hover:text-red-300 hover:bg-white/[0.06] transition-colors flex-shrink-0"
                  style={{ marginTop: 3 }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <TestPanel
        busy={testing}
        blocking={blocking}
        result={result}
        onTest={() => void test()}
      />
    </div>
  );
}

/**
 * The "Test connection" control and its outcome.
 *
 * A pass means the server was launched (or the URL answered), the credentials
 * were accepted, and it completed the MCP handshake — so the next step really is
 * to save. A failure shows the reason, what to do about it, and the child's
 * stderr, which is usually the only thing that explains why a command died.
 *
 * Testing is never a precondition for saving: a server that legitimately cannot
 * connect right now — offline, or waiting on a credential supplied elsewhere —
 * must still be configurable.
 */
function TestPanel({
  busy,
  blocking,
  result,
  onTest,
}: {
  busy: boolean;
  blocking: string | null;
  result: ProbeResultView | null;
  onTest: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        marginTop: 2,
        paddingTop: 12,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      <div className="flex items-center gap-2.5">
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<PlugZap size={13} />}
          disabled={busy || blocking !== null}
          onClick={onTest}
        >
          {busy ? "Connecting…" : "Test connection"}
        </Button>
        <span className="text-[11px] text-slate-500 leading-relaxed flex-1 min-w-0">
          {blocking !== null
            ? "Complete the fields above to test."
            : "Checks the server once, then disconnects. OAuth may open a sign-in tab in this project's browser profile."}
        </span>
      </div>

      {result !== null && (
        <div
          role="status"
          className="mt-2.5 px-3 py-2.5 text-[11.5px] leading-relaxed"
          style={{
            borderRadius: 9,
            background: result.ok ? "rgba(16,185,129,0.06)" : "rgba(239,68,68,0.06)",
            boxShadow: `inset 0 0 0 1px ${
              result.ok ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.25)"
            }`,
          }}
        >
          {result.ok ? (
            <>
              <div className="flex items-center gap-1.5 text-emerald-200 font-medium">
                <CheckCircle2 size={13} />
                Connected
                {result.serverName !== undefined && (
                  <span className="text-slate-400 font-normal">
                    to {result.serverName}
                    {result.serverVersion !== undefined ? ` ${result.serverVersion}` : ""}
                  </span>
                )}
              </div>
              <div className="text-slate-400 mt-1">
                {result.toolCount === undefined
                  ? "It completed the handshake but advertises no tools."
                  : `${result.toolCount} ${result.toolCount === 1 ? "tool" : "tools"}${
                      result.toolNames !== undefined && result.toolNames.length > 0
                        ? `: ${result.toolNames.join(", ")}${
                            result.toolCount > result.toolNames.length ? ", …" : ""
                          }`
                        : ""
                    }`}
                {` · ${result.durationMs}ms`}
              </div>
              <div className="text-slate-500 mt-1">Save to apply these settings.</div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 text-red-200 font-medium">
                <XCircle size={13} />
                Could not connect
              </div>
              <div className="text-red-200/90 mono text-[11px] mt-1 break-words">
                {result.error ?? "unknown failure"}
              </div>
              {result.hint !== undefined && (
                <div className="text-slate-400 mt-1">{result.hint}</div>
              )}
              {result.missingRefs !== undefined && result.missingRefs.length > 0 && (
                <div className="text-slate-400 mt-1">
                  Waiting on {result.missingRefs.join(", ")}.
                </div>
              )}
              {result.stderr !== undefined && result.stderr.length > 0 && (
                <details className="mt-2">
                  <summary className="text-[11px] text-slate-400 cursor-pointer select-none">
                    Output from the server ({result.stderr.length}{" "}
                    {result.stderr.length === 1 ? "line" : "lines"})
                  </summary>
                  <pre
                    className="mono text-[10.5px] text-slate-400 mt-1.5 overflow-auto"
                    style={{
                      maxHeight: 160,
                      padding: 8,
                      borderRadius: 7,
                      background: "rgba(0,0,0,0.3)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {result.stderr.join("\n")}
                  </pre>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FieldLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        "block text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5",
        className,
      )}
    >
      {children}
    </span>
  );
}
