/** Interactive OAuth for remote MCP upstreams; grants may join opt-in credential backup. */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  createHttpTransportFactory,
  type HttpServerConfig,
  type HttpTransportFactory,
} from "@multizen/mcp-gateway";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import type { GatewayVault } from "./GatewayVault.ts";

interface OAuthRecord {
  updatedAt?: number;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  registeredRedirect?: string;
}

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export class OAuthManager {
  private readonly pending = new Map<string, OAuthRecord>();
  private readonly active = new Set<string>();

  constructor(
    private readonly vault: GatewayVault,
    private readonly openUrl: (profileId: string, url: string) => Promise<void>,
    private readonly transportFactory: HttpTransportFactory = createHttpTransportFactory(),
    private readonly timeoutMs = SIGN_IN_TIMEOUT_MS,
  ) {}

  private key(projectId: string, server: HttpServerConfig): string {
    return `${projectId}\u0000${server.id}\u0000${server.url}`;
  }

  private async read(projectId: string, server: HttpServerConfig): Promise<OAuthRecord> {
    const pending = this.pending.get(this.key(projectId, server));
    if (pending) return pending;
    const raw = await this.vault.getOAuth(projectId, server.id, server.url);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as OAuthRecord;
    } catch {
      return {};
    }
  }

  private async write(
    projectId: string,
    server: HttpServerConfig,
    record: OAuthRecord,
    persist: boolean,
  ): Promise<void> {
    record = { ...record, updatedAt: Date.now() };
    if (persist)
      await this.vault.setOAuth(projectId, server.id, server.url, JSON.stringify(record));
    else this.pending.set(this.key(projectId, server), record);
  }

  /**
   * A NON-INTERACTIVE provider for the runtime connector: it reads stored client
   * info and tokens and lets the SDK refresh an expired access token with the
   * refresh grant. It must NEVER drive an interactive sign-in. Its redirect URL
   * is the deliberately unreachable `http://127.0.0.1:1/callback` and its
   * `redirectToAuthorization` is a no-op (no `onRedirect`), so a flow that would
   * open a browser instead surfaces as `UnauthorizedError` and the server is
   * marked `auth-required`. Interactive sign-in only ever runs through
   * {@link authorize}, which stands up a real loopback callback server.
   */
  providerFor(projectId: string, server: HttpServerConfig): OAuthClientProvider {
    return this.provider(projectId, server, "http://127.0.0.1:1/callback", "auto");
  }

  private provider(
    projectId: string,
    server: HttpServerConfig,
    redirectUrl: string,
    persist: boolean | "auto",
    onRedirect?: (url: URL) => Promise<void>,
    stateValue?: string,
    ignoreTokens = false,
  ): OAuthClientProvider {
    const state = stateValue ?? randomBytes(32).toString("hex");
    const shouldPersist = (): boolean =>
      persist === "auto" ? !this.pending.has(this.key(projectId, server)) : persist;
    let verifier: string | undefined;
    return {
      redirectUrl,
      clientMetadata: {
        client_name: "Sekvona",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => state,
      clientInformation: async () => {
        const record = await this.read(projectId, server);
        // Re-register when a new interactive flow uses a different loopback port.
        return !onRedirect || record.registeredRedirect === redirectUrl ? record.client : undefined;
      },
      saveClientInformation: async (client) => {
        const record = await this.read(projectId, server);
        await this.write(
          projectId,
          server,
          { ...record, client, registeredRedirect: redirectUrl },
          shouldPersist(),
        );
      },
      tokens: async () => (ignoreTokens ? undefined : (await this.read(projectId, server)).tokens),
      saveTokens: async (tokens) => {
        const record = await this.read(projectId, server);
        await this.write(projectId, server, { ...record, tokens }, shouldPersist());
      },
      redirectToAuthorization: async (url) => {
        if (onRedirect) await onRedirect(url);
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => {
        if (!verifier) throw new Error("OAuth sign-in has expired. Try Connect again.");
        return verifier;
      },
    };
  }

  async authorize(
    projectId: string,
    server: HttpServerConfig,
    profileId: string,
    persist: boolean,
    force = false,
  ): Promise<void> {
    const key = this.key(projectId, server);
    const prefix = `${projectId}\u0000${server.id}\u0000`;
    if (this.active.has(prefix)) throw new Error("Sign-in is already in progress for this server.");
    for (const pendingKey of this.pending.keys()) {
      if (pendingKey.startsWith(prefix) && pendingKey !== key) this.pending.delete(pendingKey);
    }
    this.active.add(prefix);
    let completed = false;
    const listener = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
      });
      const port = (listener.address() as AddressInfo).port;
      const redirectUrl = `http://127.0.0.1:${port}/callback`;
      const expectedState = randomBytes(32).toString("hex");
      let callbackResolve!: (code: string) => void;
      let callbackReject!: (error: Error) => void;
      const callback = new Promise<string>((resolve, reject) => {
        callbackResolve = resolve;
        callbackReject = reject;
      });
      // Handled even if the SDK completes without opening a browser.
      void callback.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      listener.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", redirectUrl);
        if (request.method !== "GET" || url.pathname !== "/callback") {
          response.writeHead(404).end();
          return;
        }
        if (url.searchParams.get("state") !== expectedState) {
          response.writeHead(400).end("Invalid sign-in state. Return to Sekvona and try again.");
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          response
            .writeHead(400)
            .end("Sign-in was not completed. Return to Sekvona and try again.");
          callbackReject(new Error("OAuth sign-in was cancelled or denied."));
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<h2>Sign-in received</h2><p>Return to Sekvona to check the connection.</p>");
        callbackResolve(code);
      });
      const provider = this.provider(
        projectId,
        server,
        redirectUrl,
        false,
        async (url) => {
          if (
            url.protocol !== "https:" &&
            !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))
          ) {
            throw new Error("OAuth authorization URL must use HTTPS.");
          }
          await this.openUrl(profileId, url.toString());
          timer = setTimeout(
            () => callbackReject(new Error("OAuth sign-in timed out.")),
            this.timeoutMs,
          );
          await callback;
        },
        expectedState,
        force,
      );
      const transport = this.transportFactory({
        url: server.url,
        headers: server.headers,
        authProvider: provider,
      });
      try {
        await transport.start();
        await transport.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "Sekvona", version: "0.0.0" },
          },
        });
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
        const code = await callback;
        if (!transport.finishAuth) throw new Error("OAuth is unavailable for this transport.");
        await transport.finishAuth(code);
      } finally {
        if (timer) clearTimeout(timer);
        await transport.close().catch(() => undefined);
      }
      completed = true;
      if (persist) await this.promote(projectId, server);
    } finally {
      if (!completed) this.pending.delete(key);
      this.active.delete(prefix);
      // A callback server lives only for this one sign-in attempt.
      if (listener.listening) listener.close();
    }
  }

  async promote(projectId: string, server: HttpServerConfig): Promise<void> {
    const prefix = `${projectId}\u0000${server.id}\u0000`;
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(prefix)) continue;
      if (key === this.key(projectId, server)) {
        await this.vault.setOAuth(projectId, server.id, server.url, JSON.stringify(pending));
      }
      this.pending.delete(key);
    }
  }

  discardExcept(projectId: string, serverId: string, url?: string): void {
    const prefix = `${projectId}\u0000${serverId}\u0000`;
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix) && key !== `${prefix}${url ?? ""}`) this.pending.delete(key);
    }
  }

  discardProject(projectId: string): void {
    for (const key of this.pending.keys()) {
      if (key.startsWith(`${projectId}\u0000`)) this.pending.delete(key);
    }
  }
}
