import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface HttpTransportOptions {
  port: number;
  host?: string;
  /** Optional bearer token; if set, requests must send Authorization: Bearer <token> */
  authToken?: string;
}

/** Cap on a single Streamable-HTTP request body (JSON-RPC messages are tiny). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** An error carrying the HTTP status the client should see. */
class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Embedded HTTP transport so external MCP clients can reach the running desktop
 * app without spawning a stdio child. Two transports are served side by side:
 *
 *   POST /mcp        — Streamable HTTP (the current MCP transport; Codex, Cursor,
 *                      modern clients connect here directly by URL, no bridge)
 *   GET  /sse        — open a legacy HTTP+SSE stream (kept for older clients /
 *                      Claude Desktop via `mcp-remote`)
 *   POST /messages   — send a message to the open SSE stream
 *   GET  /healthz    — liveness check
 *
 * The SSE path keeps one long-lived server instance (unchanged behaviour). The
 * Streamable HTTP path is STATELESS: each POST gets a fresh, ephemeral MCP
 * server + transport, so it never contends with the SSE stream for the single
 * low-level Server's transport slot. Every server is built from the same
 * factory and therefore shares one ActivityLog, so tool calls from either
 * transport still stream into the app's live feed.
 */
export class HttpTransport {
  private readonly server: HttpServer;
  private readonly opts: HttpTransportOptions;
  /** Host:port values accepted in the Host header (DNS-rebinding defence). */
  private readonly allowedHosts: string[];
  private sseTransport: SSEServerTransport | null = null;
  private createMcp: (() => McpServer) | null = null;
  private sseServer: McpServer | null = null;

  constructor(opts: HttpTransportOptions) {
    this.opts = opts;
    const host = opts.host ?? "127.0.0.1";
    // Only requests whose Host header names our own loopback endpoint are
    // served — this is what blocks a DNS-rebinding page from POSTing to
    // 127.0.0.1:<port>/mcp under an attacker hostname to drive the browser.
    this.allowedHosts = Array.from(
      new Set([`${host}:${opts.port}`, `127.0.0.1:${opts.port}`, `localhost:${opts.port}`]),
    );
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(createMcp: () => McpServer): Promise<void> {
    this.createMcp = createMcp;
    // One long-lived server instance backs the SSE path (behaviour unchanged
    // from when start() took a pre-built server). /mcp builds its own per call.
    this.sseServer = createMcp();
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
    if (this.sseTransport) {
      await this.sseTransport.close();
      this.sseTransport = null;
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.opts.authToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${this.opts.authToken}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }
    }

    const url = req.url ?? "/";

    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true, name: "multizen-mcp", connected: this.sseTransport !== null }),
      );
      return;
    }

    // Streamable HTTP (current MCP transport), stateless. Only POST carries a
    // JSON-RPC message; GET (server-push SSE) and DELETE (session teardown) are
    // meaningless without sessions, so reject them rather than spin up an
    // ephemeral server that would hold a never-closing stream open.
    if (url.startsWith("/mcp")) {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end("method not allowed");
        return;
      }
      await this.handleStreamable(req, res);
      return;
    }

    if (req.method === "GET" && url.startsWith("/sse")) {
      if (!this.sseServer) {
        res.writeHead(503).end("mcp not started");
        return;
      }
      const transport = new SSEServerTransport("/messages", res);
      this.sseTransport = transport;
      await this.sseServer.connect(transport);
      // SSE keeps the response open
      return;
    }

    if (req.method === "POST" && url.startsWith("/messages")) {
      if (!this.sseTransport) {
        res.writeHead(409).end("no SSE stream open");
        return;
      }
      try {
        await this.sseTransport.handlePostMessage(req, res);
      } catch (e) {
        res.writeHead(500).end((e as Error).message);
      }
      return;
    }

    res.writeHead(404).end("not found");
  }

  private async handleStreamable(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.createMcp) {
      res.writeHead(503).end("mcp not started");
      return;
    }
    const server = this.createMcp();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session to persist
      enableJsonResponse: true, // reply with a single JSON body, simplest for clients
      enableDnsRebindingProtection: true,
      allowedHosts: this.allowedHosts,
    });
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    };
    // The ephemeral server/transport live exactly as long as this request.
    res.on("close", cleanup);
    try {
      await server.connect(transport);
      const body = await readJsonBody(req);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      const status = e instanceof HttpError ? e.statusCode : 500;
      if (!res.headersSent) res.writeHead(status).end((e as Error).message);
      cleanup();
    }
  }
}

/**
 * Read + JSON-parse a POST body, bounded, so a malformed/oversized/aborted body
 * can't hang or OOM us. Rejects with an {@link HttpError} carrying the right
 * status (413 too-large, 400 bad/empty/aborted) instead of a bare 500.
 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onErr);
      req.off("close", onClose);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering; don't destroy the socket (that would race the
        // response write). The remaining upload is discarded when we reply.
        finish(() => reject(new HttpError(413, "request body too large")));
        return;
      }
      chunks.push(c);
    };
    const onEnd = (): void => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        finish(() => reject(new HttpError(400, "empty request body")));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        finish(() => reject(new HttpError(400, "invalid JSON body")));
        return;
      }
      finish(() => resolve(parsed));
    };
    const onErr = (e: Error): void => finish(() => reject(e));
    // Client dropped after headers but before the body finished — settle so the
    // awaiting promise (and its buffered bytes) can't linger forever.
    const onClose = (): void =>
      finish(() => reject(new HttpError(400, "request aborted before body completed")));

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onErr);
    req.on("close", onClose);
  });
}
