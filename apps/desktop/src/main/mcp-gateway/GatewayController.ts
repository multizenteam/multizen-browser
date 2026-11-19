import { NEW_PROJECT_ID_LIMIT, shortenProjectName } from "./projectNames.ts";
/**
 * GatewayController — the serializable API surface behind the gateway IPC.
 *
 * Translates verified {@link ProjectConfig}s to redacted {@link ProjectView}s
 * (env/header values become reference NAMES only; tokens/private keys are never
 * returned) and applies strict, validated input mutations back through the
 * {@link GatewayService}. Every method returns a {@link GatewayOpResult} and
 * never throws across the boundary.
 *
 * Redaction invariants (mirrors the Cloud Sync controller):
 *   - env maps expose the child-visible name -> `${NAME}` reference verbatim
 *     (the reference is the safe persisted form; it is NOT an expanded secret).
 *   - header maps expose name -> `${NAME}` reference verbatim.
 *   - local-auth exposes only `enabled` + `tokenPresent` + the `${NAME}` ref;
 *     never the token value. A freshly generated token is revealed ONCE by the
 *     explicit generate endpoint and never persisted in any view.
 */

import {
  CONFIG_VERSION,
  isEnvName,
  MIN_BUNDLE_PASSPHRASE_LENGTH,
  parseProjectConfig,
  type ProjectConfig,
  type ServerConfig,
} from "@multizen/mcp-gateway";

import type { GatewayService } from "./GatewayService.ts";
import type { CredentialSync } from "./CredentialSync.ts";
import type { DeviceSetup, DeviceSetupInput } from "./DeviceSetup.ts";
import { ConfigFileError } from "./ConfigFileTransactor.ts";
import { projectTokenEnvName } from "./agentAdapters.ts";
import { managedRefName } from "./GatewayVault.ts";
import { AGENT_KINDS } from "./types.ts";
import type {
  AgentKind,
  BindableProfileView,
  ConflictView,
  CreateProjectInput,
  CredentialBackupView,
  CredentialRestoreView,
  ProjectHistoryEntryView,
  ProjectRollbackView,
  SetupResultView,
  GatewayOpResult,
  GatewaySyncStatusView,
  HttpServerView,
  LocalAuthView,
  ProbeResultView,
  ProjectEndpointsView,
  ProjectRuntimeView,
  ProjectSetupInput,
  ProjectSetupResultView,
  ProjectView,
  QuarantineView,
  ReconcileResultView,
  RuntimeLogView,
  SecretRefStatusView,
  ServerInput,
  ServerRuntimeView,
  ServerView,
  StdioServerView,
  TrustDeviceView,
  UpdateProjectInput,
  WorkspaceBindingView,
} from "./types.ts";

function ok<T>(value: T): GatewayOpResult<T> {
  return { ok: true, value };
}
function fail(code: string, message: string): GatewayOpResult<never> {
  return { ok: false, error: { code, message } };
}

/**
 * Convert a filesystem/adapter failure into a serializable envelope, keeping the
 * actionable hint so the UI can tell the operator what to fix.
 */
function failFromFileError(err: unknown): GatewayOpResult<never> {
  if (err instanceof ConfigFileError) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.hint !== undefined ? `${err.message} — ${err.hint}` : err.message,
      },
    };
  }
  return fail("io", err instanceof Error ? err.message : String(err));
}

/**
 * A browser profile can belong to only one project. The conflicting project is
 * named in both the code and the message so the UI can link straight to it.
 */
function profileConflict(conflictProjectId: string): GatewayOpResult<never> {
  return {
    ok: false,
    error: {
      code: `profile-bound:${conflictProjectId}`,
      message:
        `That browser profile is already bound to the project “${conflictProjectId}”. ` +
        `A profile can belong to only one project — unbind it there first.`,
    },
  };
}

/** Map a stored ServerConfig to its redacted view. */
function serverView(s: ServerConfig): ServerView {
  if (s.transport === "stdio") {
    const v: StdioServerView = {
      transport: "stdio",
      id: s.id,
      ...(s.label !== undefined ? { label: s.label } : {}),
      disabled: s.disabled,
      command: s.command,
      args: [...s.args],
      env: { ...s.env },
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
    };
    return v;
  }
  const v: HttpServerView = {
    transport: "streamable-http",
    id: s.id,
    ...(s.label !== undefined ? { label: s.label } : {}),
    disabled: s.disabled,
    auth: s.auth,
    url: s.url,
    headers: { ...s.headers },
  };
  return v;
}

/** Convert a validated ServerInput to a ServerConfig (parse enforces refs). */
function serverInputToConfig(input: ServerInput): ServerConfig {
  if (input.transport === "stdio") {
    return {
      transport: "stdio",
      id: input.id as ServerConfig["id"],
      ...(input.label !== undefined ? { label: input.label } : {}),
      disabled: input.disabled ?? false,
      command: input.command,
      args: input.args ? [...input.args] : [],
      env: { ...(input.env ?? {}) },
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    } as ServerConfig;
  }
  return {
    transport: "streamable-http",
    id: input.id as ServerConfig["id"],
    ...(input.label !== undefined ? { label: input.label } : {}),
    disabled: input.disabled ?? false,
    auth: input.auth ?? "headers",
    url: input.url,
    headers: { ...(input.headers ?? {}) },
  } as ServerConfig;
}

export interface GatewayControllerOptions {
  /** Base URL the endpoints view uses, e.g. "http://127.0.0.1:7777". */
  readonly baseUrl: string;
  /**
   * True when the gateway's HTTP routes are actually being served. The gateway
   * service runs even with the MCP HTTP transport disabled (so projects and
   * agent files stay manageable), so the UI must be told when the endpoint URLs
   * are informational rather than live.
   */
  readonly routesServed: () => boolean;
  /**
   * The credential backup channel, or null when it could not be composed.
   *
   * A getter rather than a value because the backup is constructed AFTER the
   * controller during startup (it is built on top of the service, which the
   * controller already wraps), so the controller has to read it lazily.
   */
  readonly credentials?: () => CredentialSync | null;
  /**
   * The set-up-from-backup orchestrator, or null when it could not be composed.
   * Lazy for the same reason as {@link credentials}: it is assembled after the
   * controller, from the same service.
   */
  readonly deviceSetup?: () => DeviceSetup | null;
}

export class GatewayController {
  private readonly baseUrl: string;
  private readonly routesServed: () => boolean;
  private readonly credentials: () => CredentialSync | null;
  private readonly deviceSetup: () => DeviceSetup | null;

  constructor(
    private readonly service: GatewayService,
    options: GatewayControllerOptions,
  ) {
    this.baseUrl = options.baseUrl;
    this.routesServed = options.routesServed;
    this.credentials = options.credentials ?? (() => null);
    this.deviceSetup = options.deviceSetup ?? (() => null);
  }

  private authView(config: ProjectConfig, tokenPresent: boolean): LocalAuthView {
    return {
      enabled: config.localAuth.enabled,
      ...(config.localAuth.tokenRef !== undefined ? { tokenRef: config.localAuth.tokenRef } : {}),
      tokenPresent,
    };
  }

  private async projectView(config: ProjectConfig): Promise<ProjectView> {
    const tokenPresent = await this.service.vaultAdapter.hasProjectToken(config.id);
    return {
      id: config.id,
      ...(config.label !== undefined ? { label: config.label } : {}),
      enabled: config.enabled,
      ...(config.browserProfileId !== undefined
        ? { browserProfileId: config.browserProfileId }
        : {}),
      localAuth: this.authView(config, tokenPresent),
      servers: config.servers.map(serverView),
    };
  }

  // ── project CRUD ──────────────────────────────────────────────────────

  async listProjects(): Promise<GatewayOpResult<ProjectView[]>> {
    const views = await Promise.all(this.service.allConfigs().map((c) => this.projectView(c)));
    return ok(views);
  }

  async getProject(projectId: string): Promise<GatewayOpResult<ProjectView>> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    return ok(await this.projectView(config));
  }

  async createProject(input: CreateProjectInput): Promise<GatewayOpResult<ProjectView>> {
    if (typeof input.id === "string" && input.id.length > NEW_PROJECT_ID_LIMIT) {
      return fail("invalid", `New project IDs allow at most ${NEW_PROJECT_ID_LIMIT} characters.`);
    }
    if (this.service.configOf(input.id)) {
      return fail("conflict", `project ${input.id} already exists`);
    }
    let config: ProjectConfig;
    try {
      config = parseProjectConfig({
        configVersion: CONFIG_VERSION,
        id: input.id,
        ...(input.label !== undefined ? { label: typeof input.label === "string" ? shortenProjectName(input.label) : input.label } : {}),
        enabled: input.enabled ?? false,
        ...(input.browserProfileId !== undefined
          ? { browserProfileId: input.browserProfileId }
          : {}),
        localAuth: { enabled: false },
        servers: [],
      });
    } catch (err) {
      return fail("invalid", (err as Error).message);
    }
    // A browser profile belongs to at most one project; check and claim it
    // atomically so two concurrent creates cannot both take it.
    const guarded = await this.service.applyWithBindingGuard(input.id, input.browserProfileId, () =>
      this.service.saveConfig(config),
    );
    if (!guarded.ok) return profileConflict(guarded.conflictProjectId);
    return ok(await this.projectView(config));
  }

  async updateProject(
    projectId: string,
    patch: UpdateProjectInput,
  ): Promise<GatewayOpResult<ProjectView>> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    const bindingChanged =
      patch.browserProfileId !== undefined &&
      patch.browserProfileId !== (config.browserProfileId ?? null);
    let rebuilt: ProjectConfig;
    try {
      const next = parseProjectConfig({
        ...toRaw(config),
        ...(patch.label !== undefined ? { label: typeof patch.label === "string" ? shortenProjectName(patch.label) : patch.label } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.browserProfileId !== undefined
          ? patch.browserProfileId === null
            ? {}
            : { browserProfileId: patch.browserProfileId }
          : {}),
      });
      // parseProjectConfig drops browserProfileId when omitted; when clearing,
      // rebuild without it (toRaw includes it, so delete explicitly).
      rebuilt = patch.browserProfileId === null ? stripBinding(next) : next;
    } catch (err) {
      return fail("invalid", (err as Error).message);
    }
    const guarded = await this.service.applyWithBindingGuard(
      projectId,
      patch.browserProfileId,
      () => this.service.saveConfig(rebuilt),
    );
    if (!guarded.ok) return profileConflict(guarded.conflictProjectId);
    if (bindingChanged) await this.service.invalidateBoundServer(projectId);
    return ok(await this.projectView(rebuilt));
  }

  async deleteProject(projectId: string): Promise<GatewayOpResult<{ deleted: string }>> {
    if (!this.service.configOf(projectId)) {
      // Already gone: report success so a double-delete is not an error.
      return ok({ deleted: projectId });
    }
    const result = await this.service.deleteProjectSafely(projectId);
    if (!result.deleted) {
      if (result.syncError !== undefined) {
        return fail(
          "sync-failed",
          `${result.syncError} The project was kept: deleting it here while the ` +
            `cloud copy remains would just restore it on the next sync.`,
        );
      }
      const first = result.failures[0];
      return fail(
        "cleanup-failed",
        `MultiZen could not remove its entries from ${first?.agent ?? "an agent"} in ` +
          `${first?.directory ?? "a directory"}: ${first?.message ?? "unknown error"}. ` +
          `The project was kept so nothing is left orphaned — fix the file and delete again.`,
      );
    }
    // Deleting a project config NEVER deletes its bound browser profile.
    return ok({ deleted: projectId });
  }

  async bindProfile(
    projectId: string,
    browserProfileId: string | null,
  ): Promise<GatewayOpResult<ProjectView>> {
    return this.updateProject(projectId, { browserProfileId });
  }

  /**
   * Browser profiles offered for binding. A profile held by another project is
   * listed as unavailable with the holder named, so the UI can explain why.
   */
  bindableProfiles(forProjectId?: string): GatewayOpResult<BindableProfileView[]> {
    return ok(this.service.bindableProfiles(forProjectId));
  }

  /**
   * Guided setup: create a project, optionally add its first server, associate
   * directories with their agent selections, install, and only THEN enable it.
   *
   * The project is deliberately created DISABLED so nothing is served or written
   * from a half-configured state. It is enabled at the end only when the durable
   * save and every requested installation succeeded. A failed agent write leaves
   * the project in place, disabled, with a retryable per-target status rather
   * than rolling back work the operator already did.
   */
  async setupProject(input: ProjectSetupInput): Promise<GatewayOpResult<ProjectSetupResultView>> {
    const created = await this.createProject({
      id: input.id,
      ...(input.label !== undefined ? { label: input.label } : {}),
      // Always start disabled; enabling is the last step.
      enabled: false,
      ...(typeof input.browserProfileId === "string"
        ? { browserProfileId: input.browserProfileId }
        : {}),
    });
    if (!created.ok) return created;

    if (input.server !== undefined) {
      const added = await this.addServer(input.id, input.server);
      if (!added.ok) return added;
    }

    for (const binding of input.directories ?? []) {
      const res = await this.setDirectoryAgents(input.id, binding.directory, binding.agents);
      // A bad directory (missing, symlinked, unwritable) must not abort setup:
      // the project and its other directories stay, and this one is reported.
      if (!res.ok && res.error.code === "not-found") return res;
    }

    // Enable last, so the first reconcile that actually writes endpoints happens
    // with the project in its final, intended state.
    let enabled = false;
    if (input.enableWhenReady !== false) {
      const turnedOn = await this.updateProject(input.id, { enabled: true });
      if (!turnedOn.ok) return turnedOn;
      enabled = turnedOn.value.enabled;
    }

    const reconcile = await this.service.reconcileAgentConfigs(input.id);
    const project = await this.getProject(input.id);
    if (!project.ok) return project;
    return ok({ project: project.value, reconcile, enabled });
  }

  // ── server CRUD ───────────────────────────────────────────────────────

  async addServer(projectId: string, input: ServerInput): Promise<GatewayOpResult<ProjectView>> {
    const prepared = await this.withStoredSecrets(projectId, input);
    if (!prepared.ok) return prepared;
    const result = await this.mutateServers(projectId, (servers) => {
      if (servers.some((s) => s.id === input.id)) {
        throw new Error(`server ${input.id} already exists`);
      }
      return [...servers, serverInputToConfig(prepared.value)];
    });
    if (result.ok && input.transport === "streamable-http" && input.auth === "oauth") {
      const server = this.service.configOf(projectId)?.servers.find((item) => item.id === input.id);
      if (server?.transport === "streamable-http")
        await this.service.oauth.promote(projectId, server);
    }
    return result;
  }

  async updateServer(projectId: string, input: ServerInput): Promise<GatewayOpResult<ProjectView>> {
    const prepared = await this.withStoredSecrets(projectId, input);
    if (!prepared.ok) return prepared;
    const result = await this.mutateServers(projectId, (servers) => {
      if (!servers.some((s) => s.id === input.id)) {
        throw new Error(`server ${input.id} not found`);
      }
      return servers.map((s) => (s.id === input.id ? serverInputToConfig(prepared.value) : s));
    });
    if (result.ok && input.transport === "streamable-http" && input.auth === "oauth") {
      const server = this.service.configOf(projectId)?.servers.find((item) => item.id === input.id);
      if (server?.transport === "streamable-http")
        await this.service.oauth.promote(projectId, server);
    }
    return result;
  }

  /**
   * Move any raw values in `secretValues` into OS secure storage and return the
   * same input with those fields replaced by `${NAME}` references.
   *
   * Done BEFORE the config is built, so no code path downstream of here — config
   * validation, persistence, signing, sync, agent-file rendering — ever sees a
   * value. The project is checked first so a typo cannot leave secrets in the
   * keychain for a project that does not exist.
   */
  private async withStoredSecrets(
    projectId: string,
    input: ServerInput,
  ): Promise<GatewayOpResult<ServerInput>> {
    const values = input.secretValues ?? {};
    const keys = Object.keys(values);
    if (keys.length === 0) return ok(input);
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    for (const key of keys) {
      if (values[key] === "") {
        return fail("invalid", `no value was given for “${key}”`);
      }
    }
    let refs: Record<string, string>;
    try {
      refs = await this.service.storeInlineSecrets(projectId, input.id, values);
    } catch (err) {
      return fail(
        "vault",
        `the value for “${keys[0]}” could not be stored securely: ${(err as Error).message}`,
      );
    }
    // Drop secretValues on the way out: what continues is references only.
    const { secretValues: _stored, ...rest } = input;
    return ok(
      rest.transport === "stdio"
        ? { ...rest, env: { ...(rest.env ?? {}), ...refs } }
        : { ...rest, headers: { ...(rest.headers ?? {}), ...refs } },
    );
  }

  async removeServer(projectId: string, serverId: string): Promise<GatewayOpResult<ProjectView>> {
    return this.mutateServers(projectId, (servers) => servers.filter((s) => s.id !== serverId));
  }

  async connectOAuthServer(
    projectId: string,
    serverId: string,
  ): Promise<GatewayOpResult<undefined>> {
    try {
      await this.service.connectOAuthServer(projectId, serverId);
      return ok(undefined);
    } catch (error) {
      return fail("oauth", error instanceof Error ? error.message : "OAuth sign-in failed.");
    }
  }

  async setServerEnabled(
    projectId: string,
    serverId: string,
    enabled: boolean,
  ): Promise<GatewayOpResult<ProjectView>> {
    return this.mutateServers(projectId, (servers) =>
      servers.map((s) => (s.id === serverId ? { ...s, disabled: !enabled } : s)),
    );
  }

  async restartServer(projectId: string, serverId: string): Promise<GatewayOpResult<undefined>> {
    await this.service.runtime.restartServer(projectId, serverId);
    return ok(undefined);
  }

  /**
   * Test a server definition's connection without saving anything.
   *
   * Raw values in `secretValues` are used for this attempt only and are NOT
   * stored, so a test can be run, adjusted, and re-run before the operator
   * commits. Crucially the derived reference names are computed exactly as
   * {@link withStoredSecrets} computes them, so a definition that passes here is
   * byte-for-byte the definition that gets saved — a green test cannot be
   * followed by a save that behaves differently.
   *
   * `projectId` may be null while a project is still being created; existing
   * stored values simply are not available to draw on in that case.
   */
  async testServer(
    projectId: string | null,
    input: ServerInput,
    profileIdOverride?: string,
  ): Promise<GatewayOpResult<ProbeResultView>> {
    const refs: Record<string, string> = {};
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.secretValues ?? {})) {
      const name = managedRefName(input.id, key);
      refs[key] = `\${${name}}`;
      overrides[name] = value;
    }
    const { secretValues: _unsaved, ...rest } = input;
    const withRefs: ServerInput =
      rest.transport === "stdio"
        ? { ...rest, env: { ...(rest.env ?? {}), ...refs } }
        : { ...rest, headers: { ...(rest.headers ?? {}), ...refs } };
    try {
      const server = parseProjectConfig({
        configVersion: CONFIG_VERSION,
        id: "probe",
        servers: [serverInputToConfig(withRefs)],
      }).servers[0]!;
      return ok(
        await this.service.testServerConnection(projectId, server, overrides, profileIdOverride),
      );
    } catch (err) {
      return fail("invalid", (err as Error).message);
    }
  }

  private async mutateServers(
    projectId: string,
    fn: (servers: ServerConfig[]) => ServerConfig[],
  ): Promise<GatewayOpResult<ProjectView>> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    try {
      const nextServers = fn([...config.servers]);
      const raw = { ...toRaw(config), servers: nextServers.map(serverToRaw) };
      const next = parseProjectConfig(raw);
      await this.service.saveConfig(next);
      return ok(await this.projectView(next));
    } catch (err) {
      return fail("invalid", (err as Error).message);
    }
  }

  // ── auth toggle / token ────────────────────────────────────────────────

  async setAuthEnabled(
    projectId: string,
    enabled: boolean,
  ): Promise<GatewayOpResult<LocalAuthView>> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    try {
      const raw = toRaw(config);
      raw.localAuth = enabled
        ? {
            enabled: true,
            // The SAME deterministic variable name the agent adapters emit, so
            // the operator sees exactly what their agent must have exported.
            tokenRef: `\${${projectTokenEnvName(projectId)}}`,
          }
        : { enabled: false };
      const next = parseProjectConfig(raw);
      await this.service.saveConfig(next);
      const present = await this.service.vaultAdapter.hasProjectToken(projectId);
      return ok(this.authView(next, present));
    } catch (err) {
      return fail("invalid", (err as Error).message);
    }
  }

  /**
   * Generate a fresh device-local bearer token for a project. Returns the token
   * ONCE (explicit one-shot reveal) so the operator can copy it into a client;
   * it is not persisted in any view and future reads only report presence.
   */
  async generateToken(projectId: string): Promise<GatewayOpResult<{ token: string }>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    const token = await this.service.rotateProjectToken(projectId);
    return ok({ token });
  }

  async authStatus(projectId: string): Promise<GatewayOpResult<LocalAuthView>> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    const present = await this.service.vaultAdapter.hasProjectToken(projectId);
    return ok(this.authView(config, present));
  }

  // ── endpoints / runtime / logs ───────────────────────────────────────────

  endpoints(projectId: string): GatewayOpResult<ProjectEndpointsView> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    const proxies = config.servers.map((s) => ({
      serverId: s.id,
      url: `${this.baseUrl}/mcp/proxies/${config.id}/${s.id}`,
    }));
    return ok({
      projectId: config.id,
      baseUrl: this.baseUrl,
      proxies,
      ...(config.browserProfileId !== undefined
        ? { browser: `${this.baseUrl}/mcp/projects/${config.id}/browser` }
        : {}),
      authRequired: config.localAuth.enabled,
      served: this.routesServed(),
    });
  }

  runtime(projectId: string): GatewayOpResult<ProjectRuntimeView> {
    const config = this.service.configOf(projectId);
    if (!config) return fail("not-found", `project ${projectId} not found`);
    const all = this.service.runtime.status();
    const servers: ServerRuntimeView[] = all
      .filter((s) => s.projectId === projectId)
      .map((s) => ({
        projectId: s.projectId,
        serverId: s.serverId,
        transport: s.transport,
        phase: s.phase as ServerRuntimeView["phase"],
        restarts: s.restarts,
        consecutiveFailures: s.consecutiveFailures,
        ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
        missingEnv: [...s.missingEnv],
        sessions: s.sessions,
        ...(s.toolCount !== undefined ? { toolCount: s.toolCount } : {}),
      }));
    return ok({
      projectId: config.id,
      enabled: config.enabled,
      bootstrapped: servers.some((s) => s.phase === "running" || s.phase === "connected"),
      servers,
    });
  }

  /** Redacted bounded stderr / lifecycle logs for a server. */
  logs(projectId: string, serverId: string): GatewayOpResult<RuntimeLogView[]> {
    const lines = this.service.runtime.serverLogs(projectId, serverId);
    const now = Date.now();
    return ok(lines.map((line) => ({ projectId, serverId, at: now, line })));
  }

  // ── local directories + agent configuration ─────────────────────────────

  /** Directory associations and per-agent install state for a project. */
  async directories(projectId: string): Promise<GatewayOpResult<WorkspaceBindingView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    return ok(await this.service.workspaceBindings(projectId));
  }

  /**
   * Associate a directory with the project and set which agents it installs.
   * An empty agent list keeps the directory but installs nothing.
   */
  async setDirectoryAgents(
    projectId: string,
    directory: string,
    agents: readonly AgentKind[],
  ): Promise<GatewayOpResult<WorkspaceBindingView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    const selection = agents.filter((a): a is AgentKind =>
      (AGENT_KINDS as readonly string[]).includes(a),
    );
    if (selection.length !== agents.length) {
      return fail("invalid", "unknown agent in selection");
    }
    try {
      await this.service.setDirectoryAgents(projectId, directory, selection);
      return ok(await this.service.workspaceBindings(projectId));
    } catch (err) {
      return failFromFileError(err);
    }
  }

  /** Unlink a directory, first removing MultiZen's entries from its files. */
  async removeDirectory(
    projectId: string,
    directory: string,
  ): Promise<GatewayOpResult<WorkspaceBindingView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    try {
      await this.service.removeDirectory(projectId, directory);
      return ok(await this.service.workspaceBindings(projectId));
    } catch (err) {
      return failFromFileError(err);
    }
  }

  /** Re-install the project into every associated directory. */
  async reconcileDirectories(projectId: string): Promise<GatewayOpResult<ReconcileResultView>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    return ok(await this.service.reconcileAgentConfigs(projectId));
  }

  /** Retry one failed directory+agent target. */
  async retryDirectoryAgent(
    projectId: string,
    directory: string,
    agent: AgentKind,
  ): Promise<GatewayOpResult<WorkspaceBindingView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    try {
      await this.service.retryAgentInstall(projectId, directory, agent);
      return ok(await this.service.workspaceBindings(projectId));
    } catch (err) {
      return failFromFileError(err);
    }
  }

  // ── `${NAME}` references: availability + provisioning ────────────────────
  /**
   * Availability of every `${NAME}` the project references. Returns NAMES,
   * sources, and presence booleans ONLY — never a value.
   */
  async secretRefs(projectId: string): Promise<GatewayOpResult<SecretRefStatusView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    return ok(await this.service.secretRefStatus(projectId));
  }

  /** Approve reading one environment NAME on this device. */
  async approveEnvName(name: string): Promise<GatewayOpResult<undefined>> {
    if (!isEnvName(name)) return fail("invalid", "not a valid environment variable name");
    await this.service.approveEnvName(name);
    return ok(undefined);
  }

  /** Revoke an environment approval (may deactivate dependent servers). */
  async revokeEnvName(name: string): Promise<GatewayOpResult<undefined>> {
    if (!isEnvName(name)) return fail("invalid", "not a valid environment variable name");
    await this.service.revokeEnvName(name);
    return ok(undefined);
  }

  /**
   * Store the value backing one reference in OS secure storage. WRITE-ONLY:
   * there is no counterpart that returns the value. An empty value is refused
   * so a secret cannot be silently blanked.
   */
  async saveManagedSecret(
    projectId: string,
    name: string,
    value: string,
  ): Promise<GatewayOpResult<SecretRefStatusView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    if (!isEnvName(name)) return fail("invalid", "not a valid environment variable name");
    if (typeof value !== "string" || value.length === 0) {
      return fail("invalid", "value must be a non-empty string");
    }
    await this.service.saveManagedSecret(projectId, name, value);
    return ok(await this.service.secretRefStatus(projectId));
  }

  /** Remove a managed value (may deactivate dependent servers). */
  async deleteManagedSecret(
    projectId: string,
    name: string,
  ): Promise<GatewayOpResult<SecretRefStatusView[]>> {
    if (!this.service.configOf(projectId)) {
      return fail("not-found", `project ${projectId} not found`);
    }
    if (!isEnvName(name)) return fail("invalid", "not a valid environment variable name");
    await this.service.deleteManagedSecret(projectId, name);
    return ok(await this.service.secretRefStatus(projectId));
  }

  // ── configuration history ─────────────────────────────────────────────

  /**
   * A project's revision timeline, newest first for display.
   *
   * An empty list is a legitimate answer: history lives in the bucket, so a
   * device-only project has none. That is reported as an empty list rather than an
   * error so the UI can say "no history yet" instead of "something went wrong".
   */
  async projectHistory(projectId: string): Promise<GatewayOpResult<ProjectHistoryEntryView[]>> {
    if (!this.service.configOf(projectId) && this.service.lastRevision(projectId) === 0) {
      return fail("not-found", `project ${projectId} not found`);
    }
    try {
      const entries = await this.service.projectHistory(projectId);
      const current = this.service.lastRevision(projectId);
      return ok(
        entries
          .map((e) => ({
            revision: e.revision,
            archivedAt: e.archivedAt,
            signer: e.signer,
            deleted: e.kind === "tombstone",
            current: e.revision === current,
          }))
          .sort((a, b) => b.revision - a.revision),
      );
    } catch (err) {
      return fail("io", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Roll a project back to an archived revision.
   *
   * The old content is republished as a NEW revision rather than rewinding the
   * head, so other devices see an ordinary edit instead of something that looks
   * like the rollback attack their replay protection is there to refuse.
   */
  async restoreProjectRevision(
    projectId: string,
    revision: number,
  ): Promise<GatewayOpResult<ProjectRollbackView>> {
    if (!Number.isInteger(revision) || revision < 1) {
      return fail("invalid", "Choose a revision to restore.");
    }
    try {
      const out = await this.service.restoreProjectRevision(projectId, revision);
      if (!out.restored) {
        switch (out.reason) {
          case "not-syncing":
            return fail(
              "not-syncing",
              "Configuration history needs Cloud Sync — this project exists only on this device.",
            );
          case "absent":
            return fail(
              "absent",
              `Revision ${revision} is no longer stored. It may have been pruned by the retention limit.`,
            );
          case "unchanged":
            return fail(
              "unchanged",
              `Revision ${revision} is identical to the current configuration.`,
            );
          default:
            return fail("io", "The revision could not be restored.");
        }
      }
      return ok({ revision: out.revision, fromRevision: revision });
    } catch (err) {
      return failFromFileError(err);
    }
  }

  // ── set up this device from backup ────────────────────────────────────

  /**
   * Run the whole restore flow: storage, trust, settings, projects, folder
   * bindings, credentials, browser profiles.
   *
   * Returns a per-stage report rather than a single boolean because partial
   * recovery is the common case and the operator needs to know which part is
   * missing. A failed stage is reported in place; only storage and trust stop the
   * run, since nothing after them could succeed.
   *
   * The supplied secrets travel in and are handed to Cloud Sync's vault; none is
   * echoed in the result.
   */
  async setupFromBackup(input: DeviceSetupInput): Promise<GatewayOpResult<SetupResultView>> {
    const setup = this.deviceSetup();
    if (!setup) {
      return fail(
        "unavailable",
        "Set-up-from-backup is unavailable on this device — OS secure storage could not be initialized.",
      );
    }
    if (typeof input?.storage?.s3Bucket !== "string" || input.storage.s3Bucket.trim() === "") {
      return fail("invalid", "Enter the bucket that holds your backup.");
    }
    for (const [label, value] of [
      ["encryption password", input.secrets?.kopiaPassword],
      ["S3 access key ID", input.secrets?.s3AccessKeyId],
      ["S3 secret access key", input.secrets?.s3SecretAccessKey],
    ] as const) {
      if (typeof value !== "string" || value.length === 0) {
        return fail("invalid", `Enter the ${label}.`);
      }
    }
    try {
      const result = await setup.run(input);
      return ok({
        ok: result.ok,
        stages: result.stages.map((s) => ({ id: s.id, status: s.status, detail: s.detail })),
        deviceId: result.deviceId,
        canPublish: result.canPublish,
        awaitingApproval: result.awaitingApproval,
      });
    } catch (err) {
      // A throw here is a bug rather than a stage failure, but it must still not
      // cross IPC as an exception.
      return fail("io", err instanceof Error ? err.message : String(err));
    }
  }

  // ── credential backup (opt-in) ────────────────────────────────────────

  /**
   * Current state of the credential backup. Safe to poll: no secret, no
   * passphrase, and no bundle is opened.
   */
  async credentialBackup(): Promise<GatewayOpResult<CredentialBackupView>> {
    await this.ensureDocumentSync();
    return ok(await this.credentialView());
  }

  /**
   * Turn credential backup on with `passphrase`.
   *
   * The passphrase travels renderer → main only. Nothing in the returned view
   * contains it, and no other channel can read it back out afterwards — the vault
   * accessor is main-process-internal by design.
   */
  async enableCredentialBackup(passphrase: string): Promise<GatewayOpResult<CredentialBackupView>> {
    await this.ensureDocumentSync();
    const creds = this.credentials();
    if (!creds) return fail("unavailable", "Credential backup is unavailable on this device.");
    if (typeof passphrase !== "string" || passphrase.length < MIN_BUNDLE_PASSPHRASE_LENGTH) {
      return fail(
        "weak-passphrase",
        `Use a passphrase of at least ${MIN_BUNDLE_PASSPHRASE_LENGTH} characters.`,
      );
    }
    let outcome: Awaited<ReturnType<CredentialSync["enable"]>>;
    try {
      outcome = await creds.enable(passphrase);
    } catch (err) {
      // Never let the failure text carry the input back out.
      return fail("vault", `The passphrase could not be stored: ${(err as Error).message}`);
    }
    if (!outcome.pushed) {
      const view = await this.credentialView();
      switch (outcome.reason) {
        case "not-syncing":
          return fail(
            "not-syncing",
            "Set up Cloud Sync first — there is nowhere to publish the backup yet.",
          );
        case "remote-unreadable":
          return fail(
            "wrong-passphrase",
            "A credential backup already exists and this passphrase does not open it. " +
              "Use the passphrase from the device that created it, or switch the backup off there first.",
          );
        case "rejected":
          return fail(
            "rejected",
            `The existing backup could not be trusted: ${outcome.rejection?.reason ?? "unknown reason"}`,
          );
        case "conflict":
          return fail("conflict", "Another device published first. Try again.");
        case "unchanged":
          // Already published and identical: switching on succeeded.
          return ok(view);
        default:
          return fail("io", "The backup could not be published.");
      }
    }
    return ok(await this.credentialView());
  }

  /**
   * Turn credential backup off: the published bundle is replaced with an explicit
   * empty marker and this device forgets the passphrase. Local credentials are
   * untouched — this stops backing them up, it does not delete them.
   */
  async disableCredentialBackup(): Promise<GatewayOpResult<CredentialBackupView>> {
    await this.ensureDocumentSync();
    const creds = this.credentials();
    if (!creds) return fail("unavailable", "Credential backup is unavailable on this device.");
    const outcome = await creds.disable();
    if (!outcome.purged && outcome.reason === "conflict") {
      return fail(
        "conflict",
        "Another device published first, so the stored backup was left in place. Try again.",
      );
    }
    // A "not-syncing" purge still forgot the local passphrase, which is the part
    // the operator asked for; there is simply no remote copy to clear.
    return ok(await this.credentialView());
  }

  /** Explicitly replace an untrusted remote backup from this Mac's local vault. */
  async replaceCredentialBackup(): Promise<GatewayOpResult<CredentialBackupView>> {
    await this.ensureDocumentSync();
    const creds = this.credentials();
    if (!creds) return fail("unavailable", "Credential backup is unavailable on this device.");
    const status = await creds.status();
    if (!status.enabled || status.localCount === 0 || status.remoteIssue === null) {
      return fail(
        "invalid",
        "Recovery requires an enabled backup, local credentials, and a rejected remote backup.",
      );
    }
    const outcome = await creds.replaceRejectedRemote();
    if (!outcome.pushed) {
      if (outcome.reason === "conflict") {
        return fail("conflict", "The remote backup changed. Refresh and try again.");
      }
      return fail("io", "The credential backup could not be replaced.");
    }
    return ok(await this.credentialView());
  }

  /** Pull the published credentials onto this device using `passphrase`. */
  async restoreCredentials(passphrase: string): Promise<GatewayOpResult<CredentialRestoreView>> {
    await this.ensureDocumentSync();
    const creds = this.credentials();
    if (!creds) return fail("unavailable", "Credential backup is unavailable on this device.");
    if (typeof passphrase !== "string" || passphrase.length === 0) {
      return fail("invalid", "Enter the credential passphrase.");
    }
    const outcome = await creds.restore(passphrase);
    switch (outcome.reason) {
      case undefined:
        return ok({ restored: outcome.restored, projects: outcome.projects });
      case "not-syncing":
        return fail("not-syncing", "Cloud Sync is not set up on this device.");
      case "absent":
        return fail("absent", "No credential backup has been published yet.");
      case "purged":
        return fail(
          "absent",
          "Credential backup was switched off, so there is nothing stored to restore.",
        );
      case "wrong-passphrase":
        return fail("wrong-passphrase", "That passphrase does not open the stored backup.");
      case "malformed":
        return fail("malformed", "The stored backup could not be read and may be damaged.");
      case "rejected":
        return fail(
          "rejected",
          `The stored backup could not be trusted: ${outcome.rejection?.reason ?? "unknown reason"}`,
        );
      default:
        return fail("io", "The credentials could not be restored.");
    }
  }

  /** Assemble the non-secret backup view, tolerating a missing channel. */
  private async credentialView(): Promise<CredentialBackupView> {
    const creds = this.credentials();
    const syncing = this.service.documentStore !== null;
    if (!creds) {
      return {
        enabled: false,
        localCount: 0,
        remotePresent: null,
        remoteIssue: null,
        syncing,
        minPassphraseLength: MIN_BUNDLE_PASSPHRASE_LENGTH,
      };
    }
    const status = await creds.status();
    return {
      enabled: status.enabled,
      localCount: status.localCount,
      remotePresent: status.remotePresent,
      remoteIssue:
        status.remoteIssue === null
          ? null
          : {
              code: status.remoteIssue.code,
              message: status.remoteIssue.reason,
              ...(status.remoteIssue.signer !== undefined
                ? { deviceId: status.remoteIssue.signer }
                : {}),
            },
      syncing,
      minPassphraseLength: MIN_BUNDLE_PASSPHRASE_LENGTH,
    };
  }

  /**
   * Cloud Sync can finish its startup probe after the gateway starts. Recompose
   * on demand so the credential screen does not remain stuck in the local-only
   * state until the five-minute background sync pass.
   */
  private async ensureDocumentSync(): Promise<void> {
    if (this.service.documentStore !== null) return;
    const composed = await this.service.composeSyncIfReady().catch(() => false);
    if (!composed) return;
    await this.service.syncNow().catch(() => undefined);
    await this.credentials()
      ?.reconcile()
      .catch(() => undefined);
  }

  // ── trust ────────────────────────────────────────────────────────────

  async trustList(): Promise<GatewayOpResult<TrustDeviceView[]>> {
    const bridge = this.service.syncBridge;
    if (!bridge) return ok([]);
    const registry = await bridge.fetchTrustRegistry().catch(() => null);
    const announced = await bridge.listPendingDevices().catch(() => []);
    const selfId = await this.service.vaultAdapter.deviceId();
    const names = new Map(announced.map((d) => [d.deviceId, d]));

    // Registry entries are authoritative for role; announcements contribute a
    // recognisable name and a first-seen time.
    const rows: TrustDeviceView[] = (registry?.entries ?? []).map((e) => {
      const seen = names.get(e.deviceId);
      return {
        deviceId: e.deviceId,
        publicKeyHex: e.publicKeyHex,
        role: e.role,
        isSelf: e.deviceId === selfId,
        ...(seen !== undefined ? { name: seen.name, announcedAt: seen.announcedAt } : {}),
      };
    });

    // Anything that announced itself but is not an entry yet is awaiting a
    // decision. This is the only way an admin can discover it.
    const known = new Set(rows.map((r) => r.deviceId));
    for (const d of announced) {
      if (known.has(d.deviceId)) continue;
      rows.push({
        deviceId: d.deviceId,
        publicKeyHex: d.publicKeyHex,
        role: "pending",
        isSelf: d.deviceId === selfId,
        name: d.name,
        announcedAt: d.announcedAt,
      });
    }
    return ok(rows);
  }

  async approveDevice(deviceId: string, publicKeyHex: string): Promise<GatewayOpResult<undefined>> {
    const bridge = this.service.syncBridge;
    if (!bridge) return fail("unavailable", "Cloud Sync is not ready");
    try {
      const current = await bridge.fetchTrustRegistry();
      const entries = current ? [...current.entries] : [];
      const filtered = entries.filter((e) => e.deviceId !== deviceId);
      filtered.push({
        deviceId,
        publicKeyHex: publicKeyHex as never,
        role: "trusted",
      });
      await bridge.approveDevice(filtered);
      return ok(undefined);
    } catch (err) {
      return fail("trust", (err as Error).message);
    }
  }

  async revokeDevice(deviceId: string): Promise<GatewayOpResult<undefined>> {
    const bridge = this.service.syncBridge;
    if (!bridge) return fail("unavailable", "Cloud Sync is not ready");
    try {
      const current = await bridge.fetchTrustRegistry();
      if (!current) return fail("not-found", "no trust registry");
      const entries = current.entries.map((e) =>
        e.deviceId === deviceId ? { ...e, role: "revoked" as const } : e,
      );
      await bridge.approveDevice(entries);
      return ok(undefined);
    } catch (err) {
      return fail("trust", (err as Error).message);
    }
  }

  async renameDevice(name: string): Promise<GatewayOpResult<undefined>> {
    try {
      await this.service.renameSelf(name);
      return ok(undefined);
    } catch (err) {
      return fail("invalid", (err as Error).message);
    }
  }

  // ── conflicts / quarantine / sync ────────────────────────────────────────

  conflicts(): GatewayOpResult<ConflictView[]> {
    return ok(this.service.conflictList());
  }

  async resolveConflicts(
    projectId: string,
    keep: "mine" | "theirs" = "theirs",
  ): Promise<GatewayOpResult<undefined>> {
    if (keep !== "mine" && keep !== "theirs") {
      return fail("invalid", `unknown resolution ${String(keep)}`);
    }
    try {
      await this.service.resolveConflicts(projectId, keep);
      return ok(undefined);
    } catch (err) {
      return fail("conflict", (err as Error).message);
    }
  }

  quarantine(): GatewayOpResult<QuarantineView[]> {
    return ok(this.service.quarantineList());
  }

  async releaseQuarantine(projectId: string): Promise<GatewayOpResult<undefined>> {
    await this.service.releaseQuarantine(projectId);
    return ok(undefined);
  }

  syncStatus(): GatewayOpResult<GatewaySyncStatusView> {
    return ok(this.service.syncStatusView());
  }

  async syncRetry(): Promise<GatewayOpResult<GatewaySyncStatusView>> {
    await this.service.composeSyncIfReady();
    await this.service.syncNow();
    return ok(this.service.syncStatusView());
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** A mutable raw JSON object from a validated config (round-trips through parse). */
function toRaw(config: ProjectConfig): Record<string, unknown> {
  return {
    configVersion: config.configVersion,
    id: config.id,
    ...(config.label !== undefined ? { label: config.label } : {}),
    enabled: config.enabled,
    ...(config.browserProfileId !== undefined ? { browserProfileId: config.browserProfileId } : {}),
    localAuth: {
      enabled: config.localAuth.enabled,
      ...(config.localAuth.tokenRef !== undefined ? { tokenRef: config.localAuth.tokenRef } : {}),
    },
    servers: config.servers.map(serverToRaw),
  };
}

function serverToRaw(s: ServerConfig): Record<string, unknown> {
  if (s.transport === "stdio") {
    return {
      transport: "stdio",
      id: s.id,
      ...(s.label !== undefined ? { label: s.label } : {}),
      disabled: s.disabled,
      command: s.command,
      args: [...s.args],
      env: { ...s.env },
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
    };
  }
  return {
    transport: "streamable-http",
    id: s.id,
    ...(s.label !== undefined ? { label: s.label } : {}),
    disabled: s.disabled,
    auth: s.auth,
    url: s.url,
    headers: { ...s.headers },
  };
}

/** Rebuild a config without its browserProfileId (clearing a binding). */
function stripBinding(config: ProjectConfig): ProjectConfig {
  const raw = toRaw(config);
  delete raw.browserProfileId;
  return parseProjectConfig(raw);
}
