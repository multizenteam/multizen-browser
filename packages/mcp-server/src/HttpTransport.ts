import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export interface HttpTransportOptions {
  port: number;
  host?: string;
  /** Optional bearer token; if set, requests must send Authorization: Bearer <token> */
  authToken?: string;
  /**
   * Factory that builds a FRESH MCP server for each session. A single
   * `Server` instance can only be bound to one transport at a time, so every
   * connection gets its own — sharing the heavy deps (ProfileManager,
   * BrowserDriver, ActivityLog) via the closure that creates them.
   */
  createServer: () => McpServer;
  /**
   * SSE keep-alive heartbeat interval in ms. A comment line is written to each
   * open SSE stream so idle connections aren't silently dropped by the OS /
   * intermediaries. Set to 0 to disable. Default 15000.
   */
  heartbeatMs?: number;
}

interface SseSession {
  transport: SSEServerTransport;
  server: McpServer;
  heartbeat?: ReturnType<typeof setInterval>;
}

interface StreamableSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * HTTP transport so external MCP clients (Cursor, Claude Desktop) can connect
 * to the running desktop app, not just spawn a stdio child.
 *
 * Supports both transports:
 *   - Streamable HTTP (primary): POST/GET/DELETE /mcp
 *   - HTTP+SSE (legacy/back-compat): GET /sse + POST /messages?sessionId=…
 *   - GET /healthz — liveness + per-transport session counts
 *
 * Every connection is bound to its own freshly-created `Server` and tracked by
 * session id, so a reconnect can never clobber the active session's binding
 * (the bug behind "MCP accepts the SSE connection but never initialises") and a
 * second client cannot wedge the first. On shutdown all sockets are forcibly
 * destroyed so `before-quit` can never hang waiting on a keep-alive SSE stream.
 */
export class HttpTransport {
  private readonly server: HttpServer;
  private readonly opts: HttpTransportOptions;
  private readonly heartbeatMs: number;
  private readonly allowedHosts: string[];
  private readonly sseSessions = new Map<string, SseSession>();
  private readonly streamableSessions = new Map<string, StreamableSession>();
  private stopping = false;

  constructor(opts: HttpTransportOptions) {
    this.opts = opts;
    this.heartbeatMs = opts.heartbeatMs ?? 15000;
    const host = opts.host ?? "127.0.0.1";
    // Only requests whose Host header names our own loopback endpoint are
    // accepted (DNS-rebinding defence). Pair with authToken — the Host
    // allowlist alone no longer protects it.
    this.allowedHosts = Array.from(
      new Set([`${host}:${opts.port}`, `127.0.0.1:${opts.port}`, `localhost:${opts.port}`]),
    );
    this.server = createHttpServer((req, res) => {
      void this.handle(req, res).catch((e) => {
        process.stderr.write(`[mcp-http] unhandled request error: ${String(e)}\n`);
        if (!res.headersSent) res.writeHead(500).end("internal error");
        else res.end();
      });
    });
  }

  async start(): Promise<void> {
    // Guardrail: this server exposes browser-control tools on loopback. Warn
    // loudly if started without a token rather than failing silently open.
    if (!this.opts.authToken) {
      process.stderr.write(
        "[multizen] WARNING: MCP HTTP transport starting WITHOUT an auth token — " +
          "the local control port is UNAUTHENTICATED and any local process can drive it.\n",
      );
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.opts.port, this.opts.host ?? "127.0.0.1");
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;

    // Close every tracked session. Closing the transport ends its HTTP
    // response and fires its onclose, which tears down the bound server and
    // clears the heartbeat. Snapshot first so the onclose-driven map deletes
    // don't mutate what we're iterating.
    for (const session of [...this.sseSessions.values()]) {
      await session.transport.close().catch(() => {});
    }
    this.sseSessions.clear();

    for (const session of [...this.streamableSessions.values()]) {
      await session.transport.close().catch(() => {});
    }
    this.streamableSessions.clear();

    // Forcibly destroy any lingering keep-alive sockets so the close callback
    // actually fires. Without this, an open SSE stream keeps `server.close()`
    // pending forever and the app can only be killed via Task Manager.
    this.server.closeAllConnections?.();

    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Snapshot of live sessions — surfaced via /healthz for diagnostics. */
  status(): { sse: number; streamable: number } {
    return { sse: this.sseSessions.size, streamable: this.streamableSessions.size };
  }

  /** Constant-time bearer check; false if no/incorrect token when one is required. */
  private authOk(req: IncomingMessage): boolean {
    const token = this.opts.authToken;
    if (!token) return true; // auth disabled
    const expected = Buffer.from(`Bearer ${token}`);
    const got = Buffer.from(req.headers.authorization ?? "");
    // Length check first — timingSafeEqual throws on unequal lengths, and the
    // length itself isn't the secret.
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  /** Host header must name our own loopback endpoint (DNS-rebinding defence). */
  private hostAllowed(req: IncomingMessage): boolean {
    return this.allowedHosts.includes((req.headers.host ?? "").toLowerCase());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.stopping) {
      res.writeHead(503).end("shutting down");
      return;
    }

    if (!this.authOk(req)) {
      res.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: "unauthorized",
          detail:
            "Send 'Authorization: Bearer <token>'. The token is shown in MultiZen → Settings → MCP, or in the 'mcp-token' file in the app data directory.",
        }),
      );
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    // /healthz stays auth-gated above but skips Host checks so local probes work.
    if (pathname === "/healthz") {
      const status = this.status();
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          ok: true,
          name: "multizen-mcp",
          sessions: status,
          connected: status.sse + status.streamable > 0,
        }),
      );
      return;
    }

    // Streamable HTTP (primary) — single endpoint for GET/POST/DELETE.
    // DNS-rebinding defence: Host must name our loopback endpoint.
    if (pathname === "/mcp") {
      if (!this.hostAllowed(req)) {
        res.writeHead(403).end("forbidden host");
        return;
      }
      await this.handleStreamable(req, res);
      return;
    }

    // Legacy HTTP+SSE.
    if (pathname === "/sse" && req.method === "GET") {
      if (!this.hostAllowed(req)) {
        res.writeHead(403).end("forbidden host");
        return;
      }
      await this.handleSseConnect(req, res);
      return;
    }
    if (pathname === "/messages" && req.method === "POST") {
      if (!this.hostAllowed(req)) {
        res.writeHead(403).end("forbidden host");
        return;
      }
      await this.handleSsePost(req, res, url);
      return;
    }

    res.writeHead(404).end("not found");
  }

  // ── Streamable HTTP ──────────────────────────────────────────────────────
  private async handleStreamable(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = headerValue(req.headers["mcp-session-id"]);

    if (sessionId) {
      const existing = this.streamableSessions.get(sessionId);
      if (!existing) {
        jsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    // No session id → only valid as an initialization POST that opens one.
    if (req.method !== "POST") {
      jsonRpcError(res, 400, -32000, "Bad Request: missing mcp-session-id");
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      jsonRpcError(res, 400, -32700, `Parse error: ${(e as Error).message}`);
      return;
    }

    if (!isInitializeRequest(body)) {
      jsonRpcError(res, 400, -32000, "Bad Request: no valid session ID provided");
      return;
    }

    const server = this.opts.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        this.streamableSessions.set(sid, { transport, server });
      },
      enableDnsRebindingProtection: true,
      allowedHosts: this.allowedHosts,
    });
    // Idempotent teardown. server.close() closes the transport, whose onclose
    // re-enters here — the guard stops that from recursing into a stack
    // overflow while still releasing the per-session server exactly once.
    let torndown = false;
    transport.onclose = () => {
      if (torndown) return;
      torndown = true;
      const sid = transport.sessionId;
      if (sid) this.streamableSessions.delete(sid);
      void server.close().catch(() => {});
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      await transport.close().catch(() => {});
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
      else res.end();
      process.stderr.write(`[mcp-http] streamable init failed: ${String(e)}\n`);
    }
  }

  // ── Legacy HTTP+SSE ──────────────────────────────────────────────────────
  private async handleSseConnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const server = this.opts.createServer();
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    const session: SseSession = { transport, server };

    // Single idempotent teardown shared by transport.onclose and res 'close'.
    let torndown = false;
    const cleanup = (): void => {
      if (torndown) return;
      torndown = true;
      if (session.heartbeat) clearInterval(session.heartbeat);
      this.sseSessions.delete(sessionId);
      void server.close().catch(() => {});
    };
    transport.onclose = cleanup;
    res.on("close", cleanup);

    this.sseSessions.set(sessionId, session);

    try {
      // connect() calls transport.start(), which writes 200 + `event: endpoint`.
      await server.connect(transport);
    } catch (e) {
      cleanup();
      if (!res.headersSent) res.writeHead(500).end("failed to start SSE session");
      else res.end();
      process.stderr.write(`[mcp-http] SSE connect failed: ${String(e)}\n`);
      return;
    }

    if (this.heartbeatMs > 0) {
      session.heartbeat = setInterval(() => {
        // A comment line is a no-op for the client but keeps the socket warm
        // and surfaces a broken pipe so we can tear the session down.
        try {
          res.write(": ping\n\n");
        } catch {
          cleanup();
        }
      }, this.heartbeatMs);
      // Don't let the heartbeat timer hold the process open on its own.
      session.heartbeat.unref?.();
    }
  }

  private async handleSsePost(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const sessionId = url.searchParams.get("sessionId");
    const session = sessionId ? this.sseSessions.get(sessionId) : undefined;
    if (!session) {
      res.writeHead(404).end("no SSE session for sessionId");
      return;
    }
    try {
      await session.transport.handlePostMessage(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end((e as Error).message);
      else res.end();
    }
  }
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function jsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(httpStatus, { "content-type": "application/json" }).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
  );
}

function readJsonBody(req: IncomingMessage, limitBytes = 4 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on("error", (e) => reject(e));
  });
}
