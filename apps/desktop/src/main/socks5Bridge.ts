import { createServer, type Socket, type AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import { SocksClient } from "socks";
import type { ProfileId, ProxyConfig } from "@multizen/types";

/**
 * Local SOCKS5 → upstream-proxy bridge, per profile.
 *
 * Why this exists: with Chromium's `--proxy-server=http://localhost:port`
 * (an HTTP-CONNECT relay), DNS resolution leaks. Chromium does its own
 * DNS for prefetch, predictor, background networking, DoH, etc. — none
 * of which traverse the HTTP proxy. browserscan / pixelscan see 9+
 * different DNS resolver IPs and flag it as "DNS leak: yes".
 *
 * With `--proxy-server=socks5://localhost:port`, Chromium does *remote*
 * DNS resolution by spec — every hostname is sent to the SOCKS5 server
 * inside the SOCKS5 CONNECT command, and the server resolves it. Result:
 * the test sees one resolver IP (the proxy provider's egress) and the
 * leak disappears.
 *
 * This module spins up a tiny localhost SOCKS5 server per profile that
 * accepts no-auth handshakes (it's localhost-only — the OS firewall
 * keeps it private) and forwards every CONNECT either to:
 *   - an upstream HTTP/HTTPS proxy via HTTP CONNECT (with Proxy-Authorization)
 *   - an upstream SOCKS5 proxy via the `socks` library
 *
 * The host string from the SOCKS5 CONNECT is forwarded as-is — no local
 * DNS resolution happens on the MultiZen process side either.
 */

interface BridgeHandle {
  /** localhost port Chromium connects to */
  port: number;
  /** Upstream proxy config (kept so the GUI can render diagnostics) */
  upstream: ProxyConfig;
  close: () => Promise<void>;
}

const byProfile = new Map<ProfileId, BridgeHandle>();

/** Rate-limit the per-request bridge failure logs. A dead/blocked upstream
 *  proxy fails EVERY CONNECT (e.g. "403 Forbidden"), which floods stderr with
 *  identical lines. Log each distinct message at most once per 30s. */
const bridgeWarnAt = new Map<string, number>();
function warnBridgeThrottled(msg: string): void {
  const now = Date.now();
  if (now - (bridgeWarnAt.get(msg) ?? 0) < 30_000) return;
  bridgeWarnAt.set(msg, now);
  console.warn("[multizen] socks5 bridge:", msg);
}

export async function startBridgeForProfile(
  profileId: ProfileId,
  upstream: ProxyConfig,
): Promise<string> {
  const existing = byProfile.get(profileId);
  if (existing) return `socks5://127.0.0.1:${existing.port}`;

  const handle = await startBridge(upstream);
  byProfile.set(profileId, handle);
  return `socks5://127.0.0.1:${handle.port}`;
}

export async function stopBridgeForProfile(profileId: ProfileId): Promise<void> {
  const handle = byProfile.get(profileId);
  if (!handle) return;
  byProfile.delete(profileId);
  await handle.close().catch(() => {});
}

export async function stopAllBridges(): Promise<void> {
  const ids = [...byProfile.keys()];
  await Promise.all(ids.map((id) => stopBridgeForProfile(id)));
}

async function startBridge(upstream: ProxyConfig): Promise<BridgeHandle> {
  // Track live client sockets so close() can force-destroy them. Otherwise
  // net's server.close() waits for every open connection to end before its
  // callback fires — and the browser's socks connection stays open until the
  // browser itself dies, so close() would hang forever (blocking Stop).
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    sock.on("error", () => {
      /* swallow — pipes / close handlers will tear down */
    });
    handleSocksClient(sock, upstream).catch((e: unknown) => {
      const msg = (e as Error).message;
      if (
        /socket closed|ECONNRESET|EPIPE|This socket is closed|read ECONNRESET/i.test(
          msg,
        )
      ) {
        sock.destroy();
        return;
      }
      warnBridgeThrottled(msg);
      sock.destroy();
    });
  });

  server.on("error", (e) => {
    console.error("[multizen] socks5 bridge server error:", e);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;

  return {
    port: addr.port,
    upstream,
    close: () =>
      new Promise<void>((resolve) => {
        // Destroy live connections first so server.close() resolves promptly
        // instead of waiting on the browser's still-open socket.
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

async function handleSocksClient(client: Socket, upstream: ProxyConfig): Promise<void> {
  client.setNoDelay(true);
  const reader = new BufferedReader(client);

  // 1. Greeting: VER + NMETHODS + METHODS[NMETHODS]
  const greeting = await reader.read(2);
  if (greeting[0] !== 0x05) throw new Error(`unsupported SOCKS version ${greeting[0]}`);
  const nMethods = greeting[1] ?? 0;
  if (nMethods > 0) await reader.read(nMethods); // discard methods, we only do no-auth
  client.write(Buffer.from([0x05, 0x00]));

  // 2. Request: VER + CMD + RSV + ATYP + DST.ADDR + DST.PORT
  const head = await reader.read(4);
  if (head[0] !== 0x05) throw new Error("bad SOCKS version on request");
  const cmd = head[1];
  const atyp = head[3];
  if (cmd !== 0x01) {
    client.write(replyBuffer(0x07));
    client.end();
    return;
  }

  let targetHost: string;
  if (atyp === 0x01) {
    const b = await reader.read(4);
    targetHost = `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  } else if (atyp === 0x03) {
    const lenByte = await reader.read(1);
    const len = lenByte[0] ?? 0;
    const nameBuf = await reader.read(len);
    targetHost = nameBuf.toString("ascii");
  } else if (atyp === 0x04) {
    const b = await reader.read(16);
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
    targetHost = `[${groups.join(":")}]`;
  } else {
    client.write(replyBuffer(0x08));
    client.end();
    return;
  }
  const portBuf = await reader.read(2);
  const targetPort = portBuf.readUInt16BE(0);

  // 3. Open the upstream tunnel.
  let upstreamSock: Socket;
  try {
    upstreamSock =
      upstream.type === "socks5"
        ? await connectViaSocks5(targetHost, targetPort, upstream)
        : await connectViaHttpConnect(targetHost, targetPort, upstream);
  } catch (e) {
    client.write(replyBuffer(0x05)); // connection refused
    client.end();
    throw e;
  }

  // 4. Tell the SOCKS5 client we're ready.
  client.write(replyBuffer(0x00));

  // 5. Hand control over to byte-piping. Detach the buffered reader so
  //    Chromium's TLS bytes flow straight through; flush anything we
  //    already buffered.
  upstreamSock.setNoDelay(true);
  reader.detach((leftover) => {
    if (leftover.length > 0) upstreamSock.write(leftover);
    client.pipe(upstreamSock, { end: true });
  });
  upstreamSock.pipe(client, { end: true });

  const cleanup = (): void => {
    client.destroy();
    upstreamSock.destroy();
  };
  client.once("error", cleanup);
  client.once("close", cleanup);
  upstreamSock.once("error", cleanup);
  upstreamSock.once("close", cleanup);
}

function replyBuffer(status: number): Buffer {
  return Buffer.from([
    0x05,
    status,
    0x00,
    0x01, // IPv4 BND.ADDR
    0,
    0,
    0,
    0,
    0,
    0, // BND.PORT
  ]);
}

async function connectViaHttpConnect(
  targetHost: string,
  targetPort: number,
  upstream: ProxyConfig,
): Promise<Socket> {
  const sock = await openTcp(upstream.host, upstream.port);
  const reader = new BufferedReader(sock);
  const lines: string[] = [
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
    `Host: ${targetHost}:${targetPort}`,
  ];
  if (upstream.username) {
    const token = Buffer.from(
      `${upstream.username}:${upstream.password ?? ""}`,
      "utf8",
    ).toString("base64");
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  lines.push("Proxy-Connection: keep-alive", "", "");
  sock.write(lines.join("\r\n"));

  const statusLine = await readLine(reader);
  const m = /^HTTP\/1\.[01] (\d{3}) /.exec(statusLine);
  if (!m || !m[1]?.startsWith("2")) {
    sock.destroy();
    throw new Error(`upstream HTTP CONNECT failed: ${statusLine.trim()}`);
  }
  // Drain the rest of the headers — terminator is an empty line.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = await readLine(reader);
    if (line === "") break;
  }
  // Push any bytes the upstream may have sent past the CONNECT response
  // (rare with HTTP/1.1 CONNECT, but possible with some proxies).
  reader.detach((leftover) => {
    if (leftover.length > 0) sock.unshift(leftover);
  });
  return sock;
}

async function connectViaSocks5(
  targetHost: string,
  targetPort: number,
  upstream: ProxyConfig,
): Promise<Socket> {
  const info = await SocksClient.createConnection({
    proxy: {
      host: upstream.host,
      port: upstream.port,
      type: 5,
      userId: upstream.username,
      password: upstream.password,
    },
    command: "connect",
    destination: { host: targetHost, port: targetPort },
  });
  return info.socket as Socket;
}

function openTcp(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host, port });
    sock.once("connect", () => {
      sock.off("error", reject);
      resolve(sock);
    });
    sock.once("error", reject);
  });
}

/**
 * Pull-mode reader on top of a Socket. Adds a single permanent `data`
 * listener that accumulates into an internal buffer; consumers call
 * `read(n)` to await N bytes. Avoids the foot-guns of using `socket.
 * unshift()` / multiple `data` listeners (which can drop bytes during
 * handshake → pipe transitions).
 *
 * Call `detach(handler)` once you're ready to switch back to streaming
 * mode — the buffered reader stops listening, hands you any leftover
 * bytes, and from that point on you can `pipe()` the socket as normal.
 */
class BufferedReader {
  private buf = Buffer.alloc(0);
  private pending:
    | { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }
    | null = null;
  private closed = false;
  private err: Error | null = null;
  private detached = false;
  private readonly onData: (chunk: Buffer) => void;
  private readonly onClose: () => void;
  private readonly onError: (e: Error) => void;

  constructor(private readonly sock: Socket) {
    this.onData = (chunk: Buffer) => {
      if (this.detached) return;
      this.buf = Buffer.concat([this.buf, chunk]);
      this.pump();
    };
    this.onClose = () => {
      this.closed = true;
      this.pump();
    };
    this.onError = (e) => {
      this.err = e;
      this.pump();
    };
    sock.on("data", this.onData);
    sock.once("close", this.onClose);
    sock.once("error", this.onError);
  }

  read(n: number): Promise<Buffer> {
    if (n === 0) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve, reject) => {
      if (this.pending) {
        reject(new Error("BufferedReader: concurrent read not supported"));
        return;
      }
      this.pending = { n, resolve, reject };
      this.pump();
    });
  }

  /**
   * Stop intercepting `data` events. The handler is invoked with any
   * bytes still in the internal buffer — the caller decides how to
   * forward them (write to upstream, unshift, etc.).
   */
  detach(handler: (leftover: Buffer) => void): void {
    if (this.detached) return;
    this.detached = true;
    this.sock.off("data", this.onData);
    this.sock.off("close", this.onClose);
    this.sock.off("error", this.onError);
    handler(this.buf);
    this.buf = Buffer.alloc(0);
  }

  private pump(): void {
    if (!this.pending) return;
    const head = this.pending;
    if (this.buf.length >= head.n) {
      const slice = Buffer.from(this.buf.subarray(0, head.n));
      this.buf = this.buf.subarray(head.n);
      this.pending = null;
      head.resolve(slice);
      return;
    }
    if (this.err) {
      this.pending = null;
      head.reject(this.err);
      return;
    }
    if (this.closed) {
      this.pending = null;
      head.reject(new Error("socket closed before all bytes received"));
    }
  }
}

async function readLine(reader: BufferedReader): Promise<string> {
  const out: number[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const b = await reader.read(1);
    const ch = b[0] ?? 0;
    if (ch === 0x0a) {
      if (out[out.length - 1] === 0x0d) out.pop();
      return Buffer.from(out).toString("utf8");
    }
    out.push(ch);
    if (out.length > 8192) throw new Error("response line too long");
  }
}
