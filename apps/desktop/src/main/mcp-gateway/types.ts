/**
 * Serializable view types for the MCP Gateway IPC surface.
 *
 * Every value crossing IPC to the renderer is defined here. The cardinal rule
 * mirrors the Cloud Sync controller: NEVER return an expanded env value, a
 * resolved header value, a resolved bearer token, or any private-key material.
 * Configs carry only `${NAME}` references (the safe, persisted form) and the
 * views below carry only reference NAMES, redacted markers, and booleans.
 */

/** Transport kinds an upstream server can use. */
export type GatewayTransportKind = "stdio" | "streamable-http";

/** A stdio upstream, as shown/edited in the UI. env values are `${NAME}` refs. */
export interface StdioServerView {
  readonly transport: "stdio";
  readonly id: string;
  readonly label?: string;
  readonly disabled: boolean;
  readonly command: string;
  readonly args: readonly string[];
  /** Child-visible name -> `${NAME}` reference. NEVER an expanded value. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** A streamable-http upstream. header values are `${NAME}` refs. */
export interface HttpServerView {
  readonly transport: "streamable-http";
  readonly id: string;
  readonly label?: string;
  readonly disabled: boolean;
  readonly auth?: "headers" | "oauth";
  /** URL template; may contain `${NAME}` refs. */
  readonly url: string;
  /** Header name -> `${NAME}` reference. NEVER an expanded value. */
  readonly headers: Readonly<Record<string, string>>;
}

export type ServerView = StdioServerView | HttpServerView;

/** Per-project auth policy view. The token itself is never returned. */
export interface LocalAuthView {
  /** Default false — the project route requires no inbound bearer. */
  readonly enabled: boolean;
  /** `${NAME}` reference to the expected token (never the token value). */
  readonly tokenRef?: string;
  /** True when a device-local token secret is stored for this project. */
  readonly tokenPresent: boolean;
}

/** A full project as shown/edited in the UI. */
export interface ProjectView {
  readonly id: string;
  readonly label?: string;
  readonly enabled: boolean;
  readonly browserProfileId?: string;
  readonly localAuth: LocalAuthView;
  readonly servers: readonly ServerView[];
}

/** Runtime phase for one upstream server. */
export type ServerRuntimePhase =
  | "idle"
  | "starting"
  | "running"
  | "backoff"
  | "circuit-open"
  | "stopped"
  | "connecting"
  | "connected"
  | "terminated"
  | "disabled"
  | "env-error"
  | "auth-required"
  | "failed";

/** Runtime status for one server (never carries resolved secrets). */
export interface ServerRuntimeView {
  readonly projectId: string;
  readonly serverId: string;
  readonly transport: GatewayTransportKind;
  readonly phase: ServerRuntimePhase;
  readonly restarts: number;
  readonly consecutiveFailures: number;
  /** Redacted last error message (no secrets). */
  readonly lastError?: string;
  /** Env variable NAMES that are referenced but missing/forbidden. */
  readonly missingEnv: readonly string[];
  /** Open downstream sessions relayed to this server. */
  readonly sessions: number;
  readonly toolCount?: number;
}

/** Runtime status for one project. */
export interface ProjectRuntimeView {
  readonly projectId: string;
  readonly enabled: boolean;
  readonly bootstrapped: boolean;
  readonly servers: readonly ServerRuntimeView[];
}

/** The two route templates a project exposes (informational, copyable). */
export interface ProjectEndpointsView {
  readonly projectId: string;
  readonly baseUrl: string;
  /** `${base}/mcp/proxies/:project/:server` for each server. */
  readonly proxies: ReadonlyArray<{ serverId: string; url: string }>;
  /** `${base}/mcp/projects/:project/browser` (present only if bound). */
  readonly browser?: string;
  /** True when the project requires a bearer token. */
  readonly authRequired: boolean;
  /**
   * True when these URLs are actually being served. The gateway manages
   * projects and agent files even with the MCP HTTP transport disabled, in
   * which case the URLs are informational until it is enabled.
   */
  readonly served: boolean;
}

/** A bounded, redacted diagnostic log line for a server's stderr / lifecycle. */
export interface RuntimeLogView {
  readonly projectId: string;
  readonly serverId: string;
  readonly at: number;
  /** Already redacted: no env/header/token/command expansions. */
  readonly line: string;
}

/** A trusted/revoked device entry (public keys + roles only). */
export interface TrustDeviceView {
  readonly deviceId: string;
  readonly publicKeyHex: string;
  /**
   * `pending` means the device announced itself but is not a registry entry, so
   * it cannot publish anything until an admin approves it. It is not a value the
   * signed registry ever stores — it is derived from "announced but absent".
   */
  readonly role: "trusted" | "revoked" | "pending";
  /** True when this row is THIS device. */
  readonly isSelf: boolean;
  /** Operator-facing name from the device's announcement, when it announced. */
  readonly name?: string;
  /** ISO time the device announced itself. */
  readonly announcedAt?: string;
}

/** A durable conflict copy (keep-both) surfaced for explicit resolution. */
export interface ConflictView {
  readonly projectId: string;
  readonly attemptedRevision: number;
  readonly remoteRevision: number;
  readonly localSigner: string;
  readonly remoteSigner: string;
  readonly detectedAt: string;
  readonly reason: string;
  /**
   * Operator-facing summary of what keeping the local copy would change,
   * compared against whatever is authoritative right now. Computed on read, so
   * it stays accurate after later sync passes.
   *
   * The losing config itself is stored on disk but deliberately NOT sent here:
   * the renderer only needs to describe the choice and make it.
   */
  readonly differences?: readonly string[];
}

/** A quarantined project (bad signature/trust/rollback) — never auto-starts. */
export interface QuarantineView {
  readonly projectId: string;
  readonly reason: string;
  readonly code: string;
  readonly detectedAt: string;
  /**
   * True when this device already held a local copy of the project, so the
   * refused REMOTE record was ignored and the local copy is still being served.
   *
   * Refusing a remote record must never delete local state. Two situations make
   * this essential: a second device that has not been approved yet would
   * otherwise lose the projects it just created, and anyone with write access to
   * the bucket could otherwise take a project down on every device by publishing
   * a garbage head under its id.
   *
   * When false there was no local copy, so nothing is applied and nothing runs.
   */
  readonly localRetained: boolean;
}

/** Whole-gateway sync status. */
export interface GatewaySyncStatusView {
  readonly pending?: number;
  readonly unreadable?: number;
  /** True when Cloud Sync is configured + ready for project sync. */
  readonly ready: boolean;
  readonly lastSyncAt: number | null;
  readonly lastError: string | null;
  readonly applied: number;
  readonly quarantined: number;
  readonly conflicts: number;
  readonly running: boolean;
}

/** Health/status snapshot for the whole gateway. */
export interface GatewayHealthView {
  readonly composed: boolean;
  readonly baseUrl: string | null;
  readonly projects: number;
  readonly runningServers: number;
  readonly openSessions: number;
  readonly sync: GatewaySyncStatusView;
}

/** Serializable op-result envelope (never throws across IPC). */
export type GatewayOpResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

/**
 * Raw secret values typed directly into a server's env/header fields, keyed by
 * the SAME key as `env`/`headers`.
 *
 * This is the one place a value (rather than a `${NAME}` reference) crosses IPC.
 * The controller stores each one in OS secure storage under a derived name and
 * replaces the field with `${NAME}` before any config is built, so a value never
 * reaches the persisted — and synced — project config. A key present here wins
 * over the same key in `env`/`headers`.
 *
 * Omitting a key leaves whatever reference is already configured untouched, which
 * is how an edit avoids clobbering a stored value the operator did not retype.
 */
export type InlineSecretValues = Readonly<Record<string, string>>;

/** Input for creating/updating a stdio server (env values are `${NAME}` refs). */
export interface StdioServerInput {
  readonly transport: "stdio";
  readonly id: string;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** See {@link InlineSecretValues}. */
  readonly secretValues?: InlineSecretValues;
}

/** Input for creating/updating an http server (header values are `${NAME}` refs). */
export interface HttpServerInput {
  readonly transport: "streamable-http";
  readonly id: string;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly url: string;
  readonly auth?: "headers" | "oauth";
  readonly headers?: Readonly<Record<string, string>>;
  /** See {@link InlineSecretValues}. */
  readonly secretValues?: InlineSecretValues;
}

export type ServerInput = StdioServerInput | HttpServerInput;

/**
 * Outcome of a one-shot connection test against a server definition.
 *
 * `ok` means the MCP handshake completed — the command ran (or the URL answered),
 * authentication was accepted, and the server described itself. It says nothing
 * about whether the server is well-behaved beyond that.
 */
export interface ProbeResultView {
  readonly ok: boolean;
  /** Server-reported name/version from the initialize result, when it gave them. */
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly protocolVersion?: string;
  /** Tools the server advertises. Absent when it exposes no tools capability. */
  readonly toolCount?: number;
  /** First handful of tool names, for a recognisable confirmation. */
  readonly toolNames?: readonly string[];
  /** Milliseconds from launch to a completed handshake. */
  readonly durationMs: number;
  /** Redacted failure reason when `ok` is false. */
  readonly error?: string;
  /** What to try next, when the failure has an actionable cause. */
  readonly hint?: string;
  /** Reference NAMES that had no value, when that is why the test could not run. */
  readonly missingRefs?: readonly string[];
  /**
   * Bounded, redacted stderr from a stdio child. Almost always the only useful
   * diagnostic when a command fails to start, so it is surfaced rather than
   * swallowed.
   */
  readonly stderr?: readonly string[];
}

/** Input for creating a project. */
export interface CreateProjectInput {
  readonly id: string;
  readonly label?: string;
  readonly enabled?: boolean;
  readonly browserProfileId?: string;
}

/** Input for patching a project's top-level fields. */
export interface UpdateProjectInput {
  readonly label?: string;
  readonly enabled?: boolean;
  /** null clears the binding; a string sets it; omitted leaves unchanged. */
  readonly browserProfileId?: string | null;
}

// ── Local workspace directories + agent configuration ─────────────────────
//
// A project may be associated with 0..N LOCAL directories. For each directory
// the operator selects any subset of supported coding agents; MultiZen then
// installs that project's enabled endpoints into each selected agent's
// workspace MCP configuration file.
//
// Absolute directory paths and installation state are DEVICE-LOCAL: they are
// persisted next to (never inside) the signed/synced ProjectConfig, so a synced
// project never carries another machine's filesystem layout.

/** The coding agents whose workspace MCP configuration MultiZen can manage. */
export type AgentKind = "claude-code" | "cursor" | "codex" | "kiro-cli";

/** Every supported agent, in stable display order. */
export const AGENT_KINDS: readonly AgentKind[] = ["claude-code", "cursor", "codex", "kiro-cli"];

/** Human-readable agent labels for the UI. */
export const AGENT_LABELS: Readonly<Record<AgentKind, string>> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  "kiro-cli": "Kiro CLI",
};

/** Installation state of one directory+agent pair. */
export type AgentInstallStatus =
  /** The desired entries are present and match what we last verified. */
  | "current"
  /** The project's desired endpoints changed since the last successful write. */
  | "out-of-date"
  /** The last attempt failed; `error` explains why and a retry is offered. */
  | "error";

/** Per-agent installation state for one directory (never carries secrets). */
export interface AgentInstallStateView {
  readonly agent: AgentKind;
  readonly status: AgentInstallStatus;
  /** Absolute path of the agent's workspace config file in this directory. */
  readonly configPath: string;
  /** Epoch ms of the last verified successful write, or null if never. */
  readonly lastInstalledAt: number | null;
  /** Redacted failure reason when `status` is "error". */
  readonly error?: string;
  /** Actionable recovery hint for a known agent-specific precondition. */
  readonly hint?: string;
}

/** One local directory associated with a project, plus its agent selection. */
export interface WorkspaceBindingView {
  readonly projectId: string;
  /** Canonical (realpath-resolved) absolute directory path. */
  readonly directory: string;
  /** Selected agents and their current installation state. */
  readonly agents: readonly AgentInstallStateView[];
}

/** Result of one reconcile pass over a project's directories. */
export interface ReconcileResultView {
  readonly projectId: string;
  /** True when every selected directory+agent pair is "current". */
  readonly allCurrent: boolean;
  readonly bindings: readonly WorkspaceBindingView[];
}

/** Source backing a `${NAME}` reference used by a server env/header value. */
export type SecretSource =
  /** Read from MultiZen's own process environment (device-local approval). */
  | "environment"
  /** Stored by MultiZen in OS secure storage; value never leaves the vault. */
  | "managed";

/**
 * Availability of one `${NAME}` reference. Carries the NAME, the source, and
 * presence booleans only — NEVER the value.
 */
export interface SecretRefStatusView {
  /** The referenced environment variable NAME (no `${}` wrapper). */
  readonly name: string;
  /** Where the value would be read from, or null when unresolvable. */
  readonly source: SecretSource | null;
  /** True when a value is currently resolvable from `source`. */
  readonly present: boolean;
  /** True when the operator approved reading this name from the environment. */
  readonly approved: boolean;
  /** True when a MultiZen-managed value is stored for this name. */
  readonly managed: boolean;
}

/** Input describing one directory and the agents selected for it. */
export interface WorkspaceBindingInput {
  /** Absolute directory path (canonicalized by the main process). */
  readonly directory: string;
  readonly agents: readonly AgentKind[];
}

/** A single guided-setup request that creates a project and installs it. */
export interface ProjectSetupInput {
  readonly id: string;
  readonly label?: string;
  /** Exclusive browser-profile binding, or null/undefined for none. */
  readonly browserProfileId?: string | null;
  /** Optional first upstream server. */
  readonly server?: ServerInput;
  /** Zero or more directories with their per-directory agent selection. */
  readonly directories?: readonly WorkspaceBindingInput[];
  /** Enable the project once the save + install reconcile succeeds. */
  readonly enableWhenReady?: boolean;
}

/** Outcome of a guided setup: the project plus its install reconcile result. */
export interface ProjectSetupResultView {
  readonly project: ProjectView;
  readonly reconcile: ReconcileResultView;
  /** True when the project was enabled (save + all installs succeeded). */
  readonly enabled: boolean;
}

/** A browser profile as offered in the exclusive binding selector. */
export interface BindableProfileView {
  readonly profileId: string;
  readonly name: string;
  /** Project currently holding this profile, when bound elsewhere. */
  readonly boundToProjectId?: string;
  /** False when the profile is bound to a DIFFERENT project. */
  readonly available: boolean;
}

/**
 * State of the opt-in credential backup, as shown in settings.
 *
 * Carries no secret and no passphrase. `enabled` is derived from whether a bundle
 * passphrase is stored on this device, so it cannot disagree with the key
 * material the way a separate settings flag could.
 */
export interface CredentialBackupView {
  /** A bundle passphrase is stored on this device. */
  readonly enabled: boolean;
  /** How many credentials on this device are eligible for the backup. */
  readonly localCount: number;
  /**
   * Whether a bundle exists in the bucket. Null when that cannot be determined
   * — Cloud Sync is not composed, or the document could not be read.
   */
  readonly remotePresent: boolean | null;
  /**
   * Why the remote document could not be inspected. Contains validation
   * metadata only, never bundle contents or a passphrase.
   */
  readonly remoteIssue: {
    readonly code: string;
    readonly message: string;
    /** Device that signed the rejected document, when its envelope was readable. */
    readonly deviceId?: string;
  } | null;
  /** True when Cloud Sync is composed, so backup is possible at all. */
  readonly syncing: boolean;
  /**
   * Minimum passphrase length the main process will accept. Sent to the renderer
   * so the strength gate in the UI reads its hard floor from the one place that
   * enforces it, instead of keeping a second copy that can drift.
   */
  readonly minPassphraseLength: number;
}

/** Outcome of pulling the credential bundle onto this device. */
export interface CredentialRestoreView {
  /** Credentials written into the local vault. */
  readonly restored: number;
  /** Projects whose credentials were restored, sorted. */
  readonly projects: readonly string[];
}

/** Storage coordinates for a restore. Mirrors the non-secret sync config. */
export interface SetupStorageInput {
  readonly s3Bucket: string;
  readonly s3Endpoint?: string;
  readonly s3Region?: string;
  readonly s3Prefix?: string;
  readonly controlPrefix?: string;
  readonly s3ForcePathStyle?: boolean;
}

/**
 * Everything needed to rebuild this device from a bucket.
 *
 * Defined here rather than beside the orchestrator so the preload bridge, the
 * renderer and the main process all share ONE definition — a second copy of a
 * shape that carries secrets is how a field ends up silently dropped.
 */
export interface SetupFromBackupInput {
  readonly storage: SetupStorageInput;
  /** Bucket + repository secrets. Used during the call and not retained. */
  readonly secrets: {
    readonly kopiaPassword: string;
    readonly s3AccessKeyId: string;
    readonly s3SecretAccessKey: string;
  };
  /**
   * Passphrase for the credential bundle. Omit to skip restoring server secrets —
   * credential backup is opt-in and a device may legitimately decline it.
   */
  readonly credentialPassphrase?: string;
  /** Operator-facing name used in this device's trust announcement. */
  readonly deviceName?: string;
}

/** One stage of the "set up this device from backup" flow, as shown in the UI. */
export interface SetupStageView {
  readonly id: string;
  readonly status: "pending" | "running" | "done" | "skipped" | "failed";
  /** Short operator-facing outcome line. Never contains a secret. */
  readonly detail: string | null;
}

/**
 * Outcome of a setup run. Carries no secret: the passphrases and keys supplied as
 * input are used and discarded, and stage details are plain prose.
 */
export interface SetupResultView {
  /** True when no stage failed. Skipped stages are not failures. */
  readonly ok: boolean;
  readonly stages: readonly SetupStageView[];
  readonly deviceId: string | null;
  /**
   * False when this device restored successfully but may not publish yet, because
   * an administrator has not approved its signing key.
   */
  readonly canPublish: boolean;
  readonly awaitingApproval: boolean;
}

/** One entry in a project's configuration timeline, as shown in the UI. */
export interface ProjectHistoryEntryView {
  readonly revision: number;
  /**
   * ISO time from a signed stamp, or null when the revision predates stamping or
   * its stamp could not be verified. Null means "date unknown", never "now" — the
   * UI must not present a guess as a fact.
   */
  readonly archivedAt: string | null;
  readonly signer: string;
  /** True when this entry is the project's deletion rather than a config edit. */
  readonly deleted: boolean;
  /** True when this revision is the one currently applied on this device. */
  readonly current: boolean;
}

/** Outcome of rolling a project back to an archived revision. */
export interface ProjectRollbackView {
  /** The NEW revision the old content was published as. */
  readonly revision: number;
  /** The revision whose content was restored. */
  readonly fromRevision: number;
}
