/**
 * One-shot connection test for a single upstream MCP server definition.
 *
 * This is what the "Test connection" button runs. It deliberately does NOT go
 * through {@link GatewayRuntime}: the runtime is a supervisor with backoff, a
 * circuit breaker, restart-on-change, and a relay hub, all of which exist to keep
 * a server alive. A test wants the opposite — launch once, complete the MCP
 * handshake, ask what tools exist, and tear everything down, within a hard
 * deadline, reporting exactly why it failed.
 *
 * What it proves when it succeeds: the command actually ran (or the URL answered),
 * the credentials were accepted, and the server completed `initialize` and
 * described itself. It does not exercise any tool, so it makes no claim beyond
 * "this definition connects".
 *
 * Secret handling matches the runtime: references are resolved into a scoped
 * {@link EnvResolver} for the duration of the attempt and never returned. Only
 * the reference NAMES appear in the result, and the stdio child's stderr is
 * scanned for the resolved values before being surfaced, because a server that
 * echoes its own configuration would otherwise leak a token into the UI.
 */

import {
  buildBaseEnv,
  EnvResolver,
  EnvResolutionError,
  referencedEnvNames,
  type GatewayTransport,
  type HttpTransportFactory,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type ServerConfig,
  type StdioTransportFactory,
} from "@multizen/mcp-gateway";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import type { ProbeResultView } from "./types.ts";

/** Hard ceiling on a whole attempt, including spawn and teardown. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Tool names shown back to the operator — enough to recognise, not a dump. */
const MAX_TOOL_NAMES = 8;
/** Bound on captured stderr lines. */
const MAX_STDERR_LINES = 40;

export interface ServerProbeOptions {
  readonly stdioFactory: StdioTransportFactory;
  readonly httpFactory: HttpTransportFactory;
  /** Allowlisted host environment the stdio child inherits, as at launch. */
  readonly baseEnv?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /** Reported to the upstream as the connecting client. */
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Additional credential values (such as OAuth tokens) to redact from diagnostics. */
  readonly redactValues?: readonly string[];
}

export interface ServerProbeRequest {
  /** The server definition to test, with `${NAME}` references intact. */
  readonly server: ServerConfig;
  /** Resolved reference values, NAME -> value. Never logged or returned. */
  readonly resolved: Readonly<Record<string, string>>;
}

/** Every `${NAME}` a server definition's launch spec references. */
export function probeReferencedNames(server: ServerConfig): string[] {
  const refs = new Set<string>();
  const collect = (v: string): void => {
    for (const n of referencedEnvNames(v)) refs.add(n);
  };
  if (server.transport === "stdio") {
    for (const v of Object.values(server.env)) collect(v);
  } else {
    collect(server.url);
    for (const v of Object.values(server.headers)) collect(v);
  }
  return [...refs].sort();
}

/**
 * Launch, handshake, list tools, tear down. Never throws: every failure mode is
 * reported in the returned view.
 */
export async function probeServer(
  request: ServerProbeRequest,
  options: ServerProbeOptions,
): Promise<ProbeResultView> {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = now();
  const elapsed = (): number => now() - started;

  const { server, resolved } = request;

  // A reference with no value cannot be guessed at. Say which names are missing
  // rather than launching the server with a blank credential and reporting a
  // confusing authentication failure.
  const names = probeReferencedNames(server);
  const missingRefs = names.filter((n) => resolved[n] === undefined);
  if (missingRefs.length > 0) {
    return {
      ok: false,
      durationMs: elapsed(),
      missingRefs,
      error: `no value is available for ${missingRefs.join(", ")}`,
      hint: "Enter a value for it below, or approve reading it from this device's environment.",
    };
  }

  const secretValues = [...Object.values(resolved), ...(options.redactValues ?? [])].filter(
    (v) => v.length >= 8,
  );
  const scrub = (text: string): string => {
    let out = text;
    for (const v of secretValues) out = out.split(v).join("«hidden»");
    return out;
  };

  const resolver = new EnvResolver({ base: resolved, allow: Object.keys(resolved) });
  const stderr: string[] = [];
  let transport: GatewayTransport | null = null;

  try {
    if (server.transport === "stdio") {
      const env = resolver.resolveMap(server.env, `server.${server.id}.env`);
      const wrapper = options.stdioFactory({
        command: server.command,
        args: [...server.args],
        env: { ...(options.baseEnv ?? buildBaseEnv({})), ...env },
        ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
      });
      wrapper.onStderr = (chunk): void => {
        for (const line of scrub(chunk).split(/\r?\n/)) {
          if (line.trim().length === 0) continue;
          if (stderr.length < MAX_STDERR_LINES) stderr.push(line.slice(0, 300));
        }
      };
      transport = wrapper;
    } else {
      transport = options.httpFactory({
        url: resolver.resolveTemplate(server.url, `server.${server.id}.url`),
        headers: resolver.resolveMap(server.headers, `server.${server.id}.headers`),
      });
    }
  } catch (err) {
    // Resolution is the only thing that can fail before a transport exists.
    return {
      ok: false,
      durationMs: elapsed(),
      error:
        err instanceof EnvResolutionError
          ? "a reference could not be resolved"
          : scrub(messageOf(err)),
      hint: "Check the environment variable names used in this server's settings.",
    };
  }

  const pending = new Map<number, (r: JsonRpcResponse) => void>();
  let transportError: string | null = null;
  let closedEarly = false;

  transport.onmessage = (m: JsonRpcMessage): void => {
    if (!("id" in m) || m.id === null || m.id === undefined) return;
    if ("method" in m) return; // a server->client request; a probe answers none
    const resolve = pending.get(Number(m.id));
    if (resolve) {
      pending.delete(Number(m.id));
      resolve(m as JsonRpcResponse);
    }
  };
  transport.onerror = (e: Error): void => {
    transportError ??= scrub(messageOf(e));
  };
  transport.onclose = (): void => {
    closedEarly = true;
    // Unblock anything still waiting; the deadline would otherwise have to expire.
    for (const [, resolve] of pending) {
      resolve({ jsonrpc: "2.0", id: 0, error: { code: 0, message: "connection closed" } });
    }
    pending.clear();
  };

  /** Deadline shared by the whole attempt, so a hang cannot outlive the test. */
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_res, rej) => {
    timer = setTimeout(() => rej(new ProbeTimeout()), timeoutMs);
    timer.unref?.();
  });

  const call = async (id: number, method: string, params?: unknown): Promise<JsonRpcResponse> => {
    const answered = new Promise<JsonRpcResponse>((res) => pending.set(id, res));
    await transport!.send({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    return Promise.race([answered, deadline]);
  };

  try {
    await Promise.race([transport.start(), deadline]);

    const init = await call(1, "initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: options.clientName ?? "Sekvona",
        version: options.clientVersion ?? "0.0.0",
      },
    });
    if ("error" in init) {
      const hint = hintForRpc(init.error.message);
      return {
        ok: false,
        durationMs: elapsed(),
        error: scrub(init.error.message) || "the server refused the connection",
        ...(hint !== null ? { hint } : {}),
        ...(stderr.length > 0 ? { stderr } : {}),
      };
    }

    const result = (init.result ?? {}) as {
      protocolVersion?: unknown;
      capabilities?: Record<string, unknown>;
      serverInfo?: { name?: unknown; version?: unknown };
    };
    if (typeof result.protocolVersion === "string") {
      transport.setProtocolVersion?.(result.protocolVersion);
    }

    // Completing the handshake means telling the server we are ready. Skipped
    // silently on failure: the connection is already proven and we are about to
    // close it anyway.
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});

    let tools: { toolCount: number; toolNames: string[] } | null = null;
    if (result.capabilities?.["tools"] !== undefined) {
      const listed = await call(2, "tools/list");
      if ("error" in listed) {
        return {
          ok: false,
          durationMs: elapsed(),
          error: scrub(listed.error.message) || "the server refused to list tools",
        };
      }
      const raw = (listed.result as { tools?: unknown })?.tools;
      const arr = Array.isArray(raw) ? raw : [];
      tools = {
        toolCount: arr.length,
        toolNames: arr
          .slice(0, MAX_TOOL_NAMES)
          .map((t) => scrub(String((t as { name?: unknown })?.name ?? "?"))),
      };
    }

    return {
      ok: true,
      durationMs: elapsed(),
      ...(typeof result.serverInfo?.name === "string"
        ? { serverName: scrub(result.serverInfo.name) }
        : {}),
      ...(typeof result.serverInfo?.version === "string"
        ? { serverVersion: scrub(result.serverInfo.version) }
        : {}),
      ...(typeof result.protocolVersion === "string"
        ? { protocolVersion: result.protocolVersion }
        : {}),
      ...(tools !== null ? tools : {}),
      ...(stderr.length > 0 ? { stderr } : {}),
    };
  } catch (err) {
    const timedOut = err instanceof ProbeTimeout;
    const reason = timedOut
      ? closedEarly
        ? "the server closed the connection without completing the handshake"
        : `no response within ${Math.round(timeoutMs / 1000)}s`
      : scrub(messageOf(err));
    const detail = transportError !== null && !timedOut ? transportError : reason;
    const hint = hintFor(detail, server.transport, timedOut);
    return {
      ok: false,
      durationMs: elapsed(),
      error: detail,
      ...(hint !== null ? { hint } : {}),
      ...(stderr.length > 0 ? { stderr } : {}),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    pending.clear();
    // Always tear down: a probe must not leave a child process or an SSE stream
    // behind, including when it timed out or threw.
    await transport?.close().catch(() => {});
  }
}

class ProbeTimeout extends Error {
  constructor() {
    super("timed out");
    this.name = "ProbeTimeout";
  }
}

function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.slice(0, 300);
}

/** Actionable advice for a JSON-RPC-level refusal. */
function hintForRpc(message: string): string | null {
  if (/unsupported|protocol.?version/i.test(message)) {
    return "The server may speak a different MCP protocol version than this build of Sekvona.";
  }
  return null;
}

/** Actionable advice for a transport-level failure, by its recognisable cause. */
function hintFor(
  detail: string,
  transport: "stdio" | "streamable-http",
  timedOut: boolean,
): string | null {
  if (/ENOENT|not found|no such file/i.test(detail)) {
    return "The command could not be found. Check it is installed and on PATH, or give an absolute path.";
  }
  if (/EACCES|permission denied/i.test(detail)) {
    return "The command exists but is not executable.";
  }
  if (/ECONNREFUSED/i.test(detail)) {
    return "Nothing is listening at that address. Check the URL and that the server is running.";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(detail)) {
    return "That host could not be resolved. Check the URL.";
  }
  if (/certificate|self.signed|SSL|TLS/i.test(detail)) {
    return "The server's TLS certificate was rejected.";
  }
  if (/\b401\b|unauthorized/i.test(detail)) {
    return "The server rejected the credentials. Check the header value below.";
  }
  if (/\b403\b|forbidden/i.test(detail)) {
    return "The credentials were understood but not permitted for this endpoint.";
  }
  if (/\b404\b/.test(detail)) {
    return "That path does not exist on the server. Many servers expose MCP at /mcp.";
  }
  if (timedOut) {
    return transport === "stdio"
      ? "The command started but never answered. Check it speaks MCP on stdout, and that it does not print anything else there."
      : "The server accepted the connection but never answered. Check the URL is the MCP endpoint.";
  }
  return null;
}
