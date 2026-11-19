/**
 * GatewayService — the cohesive main-process MCP gateway.
 *
 * Owns and wires together:
 *   - the atomic {@link ProjectConfigStore} (one file per project under
 *     `<userData>/mcp-gateway/projects/`);
 *   - the {@link GatewayVault} device signing key + per-project local-auth
 *     tokens + sync salt (behind the OS-secure {@link CredentialVault});
 *   - the {@link GatewayRuntime} desired-state reconciliation of stdio/http
 *     upstreams and relay sessions;
 *   - the {@link GatewayHttpRouter} same-port route dispatch, exposed as the
 *     app's single HttpTransport `gatewayHandler`;
 *   - profile-bound browser servers (one cached per bound project);
 *   - optional {@link GatewaySyncBridge} S3 config sync (composed lazily when
 *     Cloud Sync becomes ready) with local-only fallback;
 *   - durable local revision / quarantine / conflict state.
 *
 * Startup: load local configs → (if sync ready) restore/verify remote → persist
 * accepted → reconcile runtime for enabled+trusted+env-resolvable servers.
 * Shutdown: tear down every relay session and upstream (no child/session
 * survives) and close bound servers.
 *
 * NEVER returns expanded env/header/token/private-key material anywhere.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

import {
  hashConfig,
  parseProjectConfig,
  ProjectConfigStore,
  projectConfigToJson,
  referencedEnvNames as gatewayReferencedEnvNames,
  SyncedDocumentStore,
  storeErrorKind,
  type DocumentPublishResult,
  type DocumentReadResult,
  type DocumentScope,
  type HistoryEntry,
  type JsonValue,
  type ProjectConfig,
  type ProjectAuthPolicy,
  type ServerConfig,
  EnvResolver,
} from "@multizen/mcp-gateway";

import type { CredentialVault } from "../sync/CredentialVault.ts";
import { GatewayVault, managedRefName } from "./GatewayVault.ts";
import { OAuthManager } from "./OAuthManager.ts";
import { probeReferencedNames, probeServer } from "./ServerProbe.ts";
import { GatewayRuntime, type GatewayRuntimeOptions } from "./GatewayRuntime.ts";
import { GatewayHttpRouter } from "./GatewayHttpRouter.ts";
import { WorkspaceBindingStore } from "./WorkspaceBindingStore.ts";
import { AgentConfigManager, type InstallFailure } from "./AgentConfigManager.ts";
import { ConfigFileTransactor } from "./ConfigFileTransactor.ts";
import {
  browserEntryKey,
  projectTokenEnvName,
  proxyEntryKey,
  type DesiredEndpoint,
} from "./agentAdapters.ts";
import {
  createProfileBoundServer,
  type ProfileBoundServer,
  type ProfileBoundServerOptions,
} from "./ProfileBoundServer.ts";
import { GatewaySyncBridge } from "./GatewaySyncBridge.ts";
import type {
  BindableProfileView,
  ConflictView,
  GatewaySyncStatusView,
  ProbeResultView,
  QuarantineView,
  ReconcileResultView,
  SecretRefStatusView,
  WorkspaceBindingView,
} from "./types.ts";

interface PendingEdit {
  id: string;
  base: number;
  config: ReturnType<typeof projectConfigToJson>;
  hash: string;
  // A prior write may have reached storage before its response was lost.
  attemptedHash?: string;
  installLocally: boolean;
  recreatesDeletion: boolean;
}

interface ProjectLedger {
  pending: Record<string, PendingEdit>;
  migrated: Record<string, boolean>;
}

/** Durable per-project sync/verification state (never carries secrets). */
interface GatewayState {
  target?: string;
  ledgers: Record<string, ProjectLedger>;
  targetStates: Record<
    string,
    Pick<GatewayState, "revisions" | "conflicts" | "quarantine" | "documentRevisions">
  >;
  /** projectId -> last applied config revision (rollback protection). */
  revisions: Record<string, number>;
  /** projectId -> quarantine record. */
  quarantine: Record<string, QuarantineView>;
  /** projectId -> conflict copies (keep-both). */
  conflicts: Record<string, ConflictRecord[]>;
  /** Synced-document slot -> last applied revision (rollback protection). */
  documentRevisions: Record<string, number>;
}

/**
 * A conflict copy as PERSISTED, which keeps the losing local config itself.
 *
 * The IPC view ({@link ConflictView}) deliberately omits it: the renderer only
 * needs a summary and a choice, and shipping whole configs to it would widen the
 * surface for no benefit. Storing it here is what makes "keep-both" true —
 * previously only metadata was recorded, so the losing local edit was
 * unrecoverable and the next sync pass silently overwrote it with the remote.
 */
interface ConflictRecord extends ConflictView {
  /** Verified winner, used to finish applying a same-revision conflict after a restart. */
  readonly winnerHash?: string;
  /** Canonical JSON of the local config that lost the race. */
  readonly losingConfigJson: unknown;
}

const EMPTY_STATE: GatewayState = {
  ledgers: {},
  targetStates: {},
  revisions: {},
  quarantine: {},
  conflicts: {},
  documentRevisions: {},
};

/** Background re-sync cadence, and the floor between opportunistic passes. */
const DEFAULT_AUTO_SYNC_INTERVAL_MS = 5 * 60_000;
const DEFAULT_AUTO_SYNC_MIN_INTERVAL_MS = 30_000;

function oauthFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    message === "OAuth sign-in timed out." ||
    message === "OAuth sign-in was cancelled or denied."
  )
    return message;
  if (message === "Sign-in is already in progress for this server.") return message;
  if (message === "Could not open the sign-in tab in the project profile.") return message;
  return "OAuth sign-in could not be completed. Check the server URL and try again.";
}

export interface GatewayServiceDeps {
  /** Root data directory (typically app.getPath("userData")). */
  readonly dataDir: string;
  /** OS-secure credential vault (shared with Cloud Sync). */
  readonly vault: CredentialVault;
  /** Loopback host authorities the HTTP router accepts (e.g. "127.0.0.1:7777"). */
  readonly allowedHosts: readonly string[];
  /**
   * Base URL of the gateway's endpoints, e.g. "http://127.0.0.1:7777". Used both
   * for the copyable endpoint views and for the URLs written into agent files.
   */
  readonly baseUrl: string;
  /** Build a profile-bound browser server for a project (browserDriver etc.). */
  readonly makeBoundServer: (
    projectId: string,
    boundProfileId: string,
  ) => Omit<ProfileBoundServerOptions, "boundProfileId">;
  /**
   * Resolve browser-profile display names for the binding selector. Optional so
   * tests can omit it; the gateway never mutates profiles through this.
   */
  readonly listProfiles?: () => ReadonlyArray<{ id: string; name: string }>;
  /** Open an authorization page in a project's bound browser profile. */
  readonly openOAuthUrl?: (profileId: string, url: string) => Promise<void>;
  /** Optional runtime options (env allowlist, injected factories for tests). */
  readonly runtimeOptions?: GatewayRuntimeOptions;
  /**
   * Source of host environment values for approved references. Defaults to
   * `process.env`; injectable so tests need not mutate the real environment.
   */
  readonly envSource?: Readonly<Record<string, string | undefined>>;
  /** App version, reported to an upstream during a connection test. */
  readonly appVersion?: string;
  /**
   * Automatic re-sync cadence. Project sync previously ran only at startup, so a
   * change made on another device never appeared without restarting the app, and
   * configuring Cloud Sync after launch left the channel composed-as-off.
   *
   * `intervalMs` is the background pass cadence (0 disables the timer);
   * `minIntervalMs` is the floor between opportunistic passes (window focus), so
   * refocusing the app repeatedly cannot hammer the bucket. An explicit Retry
   * always bypasses the floor.
   */
  readonly autoSync?: {
    readonly intervalMs?: number;
    readonly minIntervalMs?: number;
  };
  /** Clock, injectable so the rate limiter is testable without sleeping. */
  readonly now?: () => number;
  /**
   * Operator-facing name for THIS device, used in its trust announcement so the
   * approval prompt on another machine is recognisable rather than a bare id.
   */
  readonly deviceName?: string;
  /** Persist a user-selected name after its signed announcement is published. */
  readonly onDeviceNameChanged?: (name: string) => Promise<void>;
  /**
   * Called after anything that changes this device's folder/agent bindings or its
   * environment approvals, so the per-device backup can be refreshed.
   *
   * A callback rather than a direct dependency because the backup is built ON TOP
   * of this service (it reads through `publishDocument`), so wiring it inward
   * would be circular. Implementations must not throw.
   */
  readonly onBindingsChanged?: () => void;
  /**
   * Called after anything that changes a credential the opt-in bundle may carry,
   * so the backup can be refreshed. `purgeProjects` names projects whose secrets
   * should be dropped from the backup outright — the one case the merge cannot
   * infer, because a deleted project stops being "held here" at the same moment
   * its secrets should disappear.
   *
   * A callback for the same reason as {@link onBindingsChanged}: the backup is
   * built on top of this service. Implementations must not throw.
   */
  readonly onSecretsChanged?: (change?: { purgeProjects?: readonly string[] }) => void;
  /**
   * Provide S3 sync materials when Cloud Sync is ready, else null. Called at
   * startup and on explicit re-sync. The password never leaves the returned
   * object's use inside {@link GatewaySyncBridge}.
   */
  readonly syncTarget?: () => string | undefined;
  readonly syncMaterials?: () => Promise<{
    targetId?: string;
    store: import("@multizen/mcp-gateway").SyncObjectStore;
    controlPrefix: string;
    password: string;
    deviceId: string;
  } | null>;
}

export class GatewayService {
  private readonly store: ProjectConfigStore;
  private readonly vault: GatewayVault;
  readonly runtime: GatewayRuntime;
  readonly httpRouter: GatewayHttpRouter;
  /** Device-local directory associations + agent install bookkeeping. */
  readonly workspaces: WorkspaceBindingStore;
  /** Installs this device's projects into their directories' agent configs. */
  readonly agentConfigs: AgentConfigManager;
  private readonly stateFile: string;
  private readonly envSource: Readonly<Record<string, string | undefined>>;
  private state: GatewayState = { ...EMPTY_STATE };
  /** Latest verified/desired config per project id. */
  private readonly configs = new Map<string, ProjectConfig>();
  /** Cached profile-bound servers keyed by projectId. */
  private readonly boundServers = new Map<string, ProfileBoundServer>();
  readonly oauth: OAuthManager;
  private sync: GatewaySyncBridge | null = null;
  private documents: SyncedDocumentStore | null = null;
  private syncStatus: GatewaySyncStatusView = {
    ready: false,
    lastSyncAt: null,
    lastError: null,
    applied: 0,
    quarantined: 0,
    conflicts: 0,
    running: false,
  };
  private projectWork: Promise<void> = Promise.resolve();
  private uploads: Promise<void> = Promise.resolve();
  private stateWrites: Promise<void> = Promise.resolve();

  // Local saves can commit while storage is acknowledging an earlier edit.
  // Destructive changes, target switches and remote application drain uploads first.
  private sequence<T>(work: () => Promise<T>, waitForUploads = true): Promise<T> {
    const task = this.projectWork.then(async () => {
      if (waitForUploads) await this.uploads;
      return work();
    });
    this.projectWork = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private ledger(): ProjectLedger {
    const key = this.state.target ?? "unconfigured";
    return (this.state.ledgers[key] ??= { pending: {}, migrated: {} });
  }

  private syncInFlight: Promise<void> | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private lastAutoSyncAt = 0;
  private deviceName: string;

  constructor(private readonly deps: GatewayServiceDeps) {
    const root = path.join(deps.dataDir, "mcp-gateway");
    this.store = new ProjectConfigStore(path.join(root, "projects"));
    this.stateFile = path.join(root, "state.json");
    this.workspaces = new WorkspaceBindingStore(path.join(root, "workspaces.json"));
    this.vault = new GatewayVault(deps.vault, () => deps.onSecretsChanged?.());
    this.oauth = new OAuthManager(
      this.vault,
      deps.openOAuthUrl ??
        (async () => {
          throw new Error("Opening a browser profile is unavailable.");
        }),
    );
    this.envSource = deps.envSource ?? process.env;
    this.deviceName = deps.deviceName?.trim() || "This device";
    this.runtime = new GatewayRuntime({
      ...deps.runtimeOptions,
      oauthProviderFor: (projectId, server) => this.oauth.providerFor(projectId, server),
      // Prefer a MultiZen-managed vault value; otherwise read an APPROVED host
      // environment variable. Values exist only for the duration of a launch.
      secretResolver: {
        resolve: async (projectId, names) => {
          const out: Record<string, string> = {};
          for (const name of names) {
            const managed = await this.vault.getManagedSecret(projectId, name).catch(() => null);
            if (managed !== null) {
              out[name] = managed;
              continue;
            }
            if (!this.workspaces.isEnvApproved(name)) continue;
            const v = this.envSource[name];
            if (v !== undefined) out[name] = v;
          }
          return out;
        },
      },
    });
    this.httpRouter = new GatewayHttpRouter({
      runtime: this.runtime,
      allowedHosts: deps.allowedHosts,
      authPolicyFor: (projectId) => this.authPolicyFor(projectId),
      projectEnabled: (projectId) => {
        const c = this.configs.get(projectId);
        return c !== undefined && c.enabled && !this.quarantineSuppresses(projectId);
      },
      boundServerFor: (projectId) => this.boundServerFor(projectId),
    });
    this.agentConfigs = new AgentConfigManager({
      workspaces: this.workspaces,
      transactor: new ConfigFileTransactor({
        // Backups live under userData, never inside a user's project directory.
        backupDir: path.join(root, "agent-config-backups"),
      }),
      desiredFor: (projectId) => this.desiredEndpointsFor(projectId),
    });
  }

  /** Base URL of the gateway's endpoints. */
  get baseUrl(): string {
    return this.deps.baseUrl;
  }

  /**
   * The endpoints a project should currently expose: one per ENABLED upstream
   * server plus the browser route when a profile is bound. A disabled or
   * quarantined project yields none, which uninstalls it from every agent file.
   */
  desiredEndpointsFor(projectId: string): DesiredEndpoint[] {
    const config = this.configs.get(projectId);
    if (!config || !config.enabled || this.quarantineSuppresses(projectId)) return [];
    const base = this.deps.baseUrl.replace(/\/$/, "");
    // When the project requires a bearer token, agent files reference the
    // token's environment variable NAME — never the token itself.
    const authEnvName = config.localAuth.enabled ? projectTokenEnvName(projectId) : undefined;
    const out: DesiredEndpoint[] = [];
    for (const server of config.servers) {
      if (server.disabled) continue;
      out.push({
        key: proxyEntryKey(projectId, server.id),
        url: `${base}/mcp/proxies/${projectId}/${server.id}`,
        ...(authEnvName !== undefined ? { authEnvName } : {}),
      });
    }
    if (config.browserProfileId !== undefined) {
      out.push({
        key: browserEntryKey(projectId),
        url: `${base}/mcp/projects/${projectId}/browser`,
        ...(authEnvName !== undefined ? { authEnvName } : {}),
      });
    }
    return out;
  }

  /** The HttpTransport `gatewayHandler` binding. */
  get gatewayHandler(): (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => Promise<boolean> {
    return (req, res) => this.httpRouter.handle(req, res);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the gateway: init store, load local configs, compose sync if ready,
   * restore/verify remote, persist accepted, then reconcile the runtime.
   */
  async start(): Promise<void> {
    await this.store.init();
    await this.workspaces.load();
    await this.loadState();
    for (const ledger of Object.values(this.state.ledgers)) {
      for (const edit of Object.values(ledger.pending)) {
        if (!edit.installLocally) continue;
        await this.store.save(parseProjectConfig(edit.config));
        edit.installLocally = false;
        await this.saveState();
      }
    }
    await this.loadLocalConfigs();
    // Compose S3 sync if Cloud Sync is ready; local-only otherwise.
    await this.composeSyncIfReady();
    await this.syncNow().catch(() => {});
    await this.reconcile();
    const legacyProjects = new Set(this.workspaces.listAll()
      .filter(binding => binding.agents.some(agent =>
        agent.ownedKeys.some(key => key.startsWith("multizen_"))))
      .map(binding => binding.projectId));
    for (const id of legacyProjects) {
      if (this.configs.has(id)) await this.agentConfigs.reconcileProject(id);
    }
    this.startAutoSync();
  }

  /** Shut down: tear down router sessions, runtime upstreams, bound servers. */
  async shutdown(): Promise<void> {
    // Stop the scheduler first so a tick cannot start a pass mid-teardown.
    this.stopAutoSync();
    await this.projectWork;
    await this.uploads;
    await this.stateWrites;
    await this.httpRouter.shutdown().catch(() => {});
    await this.runtime.shutdown().catch(() => {});
    for (const bound of this.boundServers.values()) {
      await bound.close().catch(() => {});
    }
    this.boundServers.clear();
  }

  // ── automatic re-sync ───────────────────────────────────────────────────

  /**
   * Start the background pass timer. Idempotent, and a no-op when the cadence is
   * zero. The handle is unref'd so it never holds the process open.
   */
  private clock(): number {
    return (this.deps.now ?? Date.now)();
  }

  startAutoSync(): void {
    const intervalMs = this.deps.autoSync?.intervalMs ?? DEFAULT_AUTO_SYNC_INTERVAL_MS;
    if (intervalMs <= 0 || this.autoSyncTimer !== null) return;
    const timer = setInterval(() => {
      void this.maybeSync("timer");
    }, intervalMs);
    timer.unref?.();
    this.autoSyncTimer = timer;
  }

  /** Stop the background pass timer. Idempotent. */
  stopAutoSync(): void {
    if (this.autoSyncTimer === null) return;
    clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = null;
  }

  /**
   * True while the background pass timer is armed. Exposed so shutdown can be
   * asserted deterministically — waiting to observe that no further pass happens
   * is unreliable, because a single pass includes scrypt derivation and can
   * outlast any reasonable test window.
   */
  get autoSyncActive(): boolean {
    return this.autoSyncTimer !== null;
  }

  /**
   * Opportunistic sync, used by the timer and by window focus.
   *
   * Two jobs beyond running a pass. First, it re-attempts composition when the
   * bridge is absent, so Cloud Sync configured after launch starts working on its
   * own rather than only via an explicit Retry. Second, it enforces a minimum gap
   * between passes so refocusing the window repeatedly cannot hammer the bucket.
   *
   * Returns true when a pass actually ran. Concurrent callers collapse onto the
   * existing in-flight pass via {@link syncNow}.
   */
  async maybeSync(reason: "timer" | "focus"): Promise<boolean> {
    if (this.sync === null) {
      // Cheap when still unconfigured: syncMaterials returns null and we stop.
      const composed = await this.composeSyncIfReady().catch(() => false);
      if (!composed) return false;
    }
    const now = this.clock();
    const floor = this.deps.autoSync?.minIntervalMs ?? DEFAULT_AUTO_SYNC_MIN_INTERVAL_MS;
    if (reason === "focus" && now - this.lastAutoSyncAt < floor) return false;
    this.lastAutoSyncAt = now;
    await this.syncNow();
    return true;
  }

  /**
   * Publish a synced document, tracking its revision so callers do not have to.
   *
   * Returns null when Cloud Sync is not composed — publishing is best-effort by
   * design, since every document also has an authoritative local copy. A lost
   * compare-and-swap is returned as a conflict rather than resolved here: the
   * document's owner decides, because only it knows whether two versions merge.
   */
  async publishDocument(
    scope: DocumentScope,
    name: string,
    value: JsonValue,
  ): Promise<DocumentPublishResult | null> {
    const docs = this.documents;
    if (!docs) return null;
    const slot = this.documentSlot(scope, name);
    const next = (this.state.documentRevisions[slot] ?? 0) + 1;
    const result = await docs.publish(scope, name, value, next);
    if (result.kind === "published") {
      this.state.documentRevisions[slot] = result.revision;
      await this.saveState();
    } else {
      // Adopt the remote revision so the next attempt is contiguous instead of
      // retrying the same losing number forever.
      this.state.documentRevisions[slot] = result.remoteRevision;
      await this.saveState();
    }
    return result;
  }

  /** Replace an explicitly rejected document from an authoritative local copy. */
  async replaceDocument(
    scope: DocumentScope,
    name: string,
    value: JsonValue,
  ): Promise<DocumentPublishResult | null> {
    const docs = this.documents;
    if (!docs) return null;
    const result = await docs.replaceCurrent(scope, name, value);
    const slot = this.documentSlot(scope, name);
    this.state.documentRevisions[slot] =
      result.kind === "published" ? result.revision : result.remoteRevision;
    await this.saveState();
    return result;
  }

  /**
   * Read a synced document. Returns null when Cloud Sync is not composed.
   *
   * `expectFresh` applies rollback protection using the last revision this device
   * applied; pass false during an explicit restore, where re-applying the current
   * revision onto a blank device is exactly what is wanted.
   */
  async readDocument<T>(
    scope: DocumentScope,
    name: string,
    options: { deviceId?: string; expectFresh?: boolean } = {},
  ): Promise<DocumentReadResult<T> | null> {
    const docs = this.documents;
    if (!docs || !this.sync) return null;
    const registry = await this.sync.fetchTrustRegistry();
    if (!registry) return null;
    const slot = this.documentSlot(scope, name, options.deviceId);
    const last = options.expectFresh === false ? 0 : (this.state.documentRevisions[slot] ?? 0);
    const result = await docs.read<T>(scope, name, registry, {
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      lastAppliedRevision: last,
    });
    if (result.kind === "loaded") {
      this.state.documentRevisions[slot] = result.document.revision;
      await this.saveState();
    }
    return result;
  }

  /** Stable local key for a document's revision counter. */
  private documentSlot(scope: DocumentScope, name: string, deviceId?: string): string {
    if (scope === "shared") return `shared:${name}`;
    return `device:${deviceId ?? this.documents?.selfDeviceId ?? "self"}:${name}`;
  }

  /** The document store, or null when Cloud Sync is not composed. */
  get documentStore(): SyncedDocumentStore | null {
    return this.documents;
  }

  /**
   * Every folder binding on this device as (project, directory, agent kinds).
   *
   * Deliberately NOT `WorkspaceBindingView`: install status, hashes and owned
   * entry keys describe files on disk, and the disk is the authority for those.
   * A backup carries only the operator's intent — which folders, which agents.
   */
  allBindingIntents(): Array<{
    projectId: string;
    directory: string;
    agents: import("./types.ts").AgentKind[];
  }> {
    return this.workspaces.listAll().map((b) => ({
      projectId: b.projectId,
      directory: b.directory,
      agents: b.agents.map((a) => a.agent),
    }));
  }

  /** Environment variable names approved for expansion on this device. */
  approvedEnvNames(): string[] {
    return this.workspaces.approvedEnv();
  }

  // ── configuration history ───────────────────────────────────────────────

  /**
   * A project's revision timeline. Empty when Cloud Sync is not composed: history
   * is a property of the bucket, so a device-only project genuinely has none.
   */
  async projectHistory(projectId: string): Promise<HistoryEntry[]> {
    if (!this.sync) return [];
    return this.sync.history(projectId);
  }

  /**
   * Roll a project back to an archived revision by PUBLISHING that content as the
   * newest revision.
   *
   * Deliberately not a rewrite of history: republishing forward means other
   * devices see an ordinary edit and accept it, whereas resetting the head to an
   * older number would look like exactly the rollback attack their replay
   * protection exists to refuse. The old revision also stays in the archive, so
   * undoing the undo is possible.
   */
  async restoreProjectRevision(
    projectId: string,
    revision: number,
  ): Promise<{ restored: true; revision: number } | { restored: false; reason: string }> {
    if (!this.sync) {
      return { restored: false, reason: "not-syncing" };
    }
    const archived = await this.sync.readRevision(projectId, revision);
    if (archived === null) return { restored: false, reason: "absent" };
    const current = this.configs.get(projectId);
    if (current !== undefined && hashConfig(current) === hashConfig(archived.config)) {
      return { restored: false, reason: "unchanged" };
    }
    // Goes through the normal save path, so it is persisted locally, published at
    // head+1, and reconciled into the runtime exactly like any other edit.
    await this.saveConfig(archived.config);
    return { restored: true, revision: this.lastRevision(projectId) };
  }

  /**
   * True when a quarantine record should stop this project running locally.
   *
   * A record with `localRetained` means only the REMOTE copy was refused: this
   * device holds its own config and keeps serving it, so the project is not
   * suppressed. Anything else — including a legacy record written before this
   * field existed — suppresses, which is the safe direction.
   */
  private quarantineSuppresses(projectId: string): boolean {
    const q = this.state.quarantine[projectId];
    return q !== undefined && q.localRetained !== true;
  }

  private async loadLocalConfigs(): Promise<void> {
    const { projects } = await this.store.loadAll();
    this.configs.clear();
    for (const { config } of projects) {
      if (this.quarantineSuppresses(config.id)) continue;
      this.configs.set(config.id, config);
    }
  }

  /** Reconcile the runtime against the current non-quarantined enabled configs. */
  async reconcile(): Promise<void> {
    const desired = [...this.configs.values()].filter((c) => !this.quarantineSuppresses(c.id));
    await this.runtime.reconcile(desired);
  }

  // ── S3 config sync ──────────────────────────────────────────────────────

  /** Compose the S3 sync bridge if Cloud Sync materials are available. */
  composeSyncIfReady(): Promise<boolean> {
    return this.sequence(() => this.composeBridge());
  }

  private async composeBridge(): Promise<boolean> {
    if (!this.deps.syncMaterials) {
      this.sync = null;
      this.documents = null;
      this.syncStatus = { ...this.syncStatus, ready: false };
      return false;
    }
    const mats = await this.deps.syncMaterials().catch(() => null);
    const target =
      mats?.targetId ?? this.deps.syncTarget?.() ?? (mats && JSON.stringify([mats.controlPrefix]));
    if (target && this.state.target !== target) {
      if (this.state.target) {
        const { revisions, conflicts, quarantine, documentRevisions } = this.state;
        this.state.targetStates[this.state.target] = {
          revisions,
          conflicts,
          quarantine,
          documentRevisions,
        };
        Object.assign(
          this.state,
          this.state.targetStates[target] ?? {
            revisions: {},
            conflicts: {},
            quarantine: {},
            documentRevisions: {},
          },
        );
      } else {
        const local = this.state.ledgers.unconfigured;
        if (local) this.state.ledgers[target] = local;
        delete this.state.ledgers.unconfigured;
      }
      this.state.target = target;
      await this.saveState();
    }
    if (!mats) {
      this.sync = null;
      this.documents = null;
      this.syncStatus = { ...this.syncStatus, ready: false };
      return false;
    }
    const signingKey = await this.vault.getOrCreateSigningKey();
    const saltHex = await this.vault.getOrCreateSaltHex();
    this.sync = new GatewaySyncBridge({
      store: mats.store,
      controlPrefix: mats.controlPrefix,
      password: mats.password,
      saltHex,
      signingKey,
    });
    // The document store shares the same bucket, password, salt and signing key
    // as project sync, so settings/bindings/credentials inherit every guarantee
    // the project channel already has instead of re-deriving them.
    this.documents = new SyncedDocumentStore({
      store: mats.store,
      controlPrefix: mats.controlPrefix,
      password: mats.password,
      saltHex,
      signingKey,
    });
    this.syncStatus = { ...this.syncStatus, ready: true };
    // If this device is not an entry in the registry it cannot publish anything,
    // and an admin on another device has no way to discover it. Announce so the
    // approval UI has something to act on. Best-effort: failing to announce must
    // never stop the gateway working locally.
    await this.announceSelfIfUntrusted().catch(() => undefined);
    return true;
  }

  /**
   * Publish this device's self-announcement unless it is already a registry
   * entry (trusted or revoked — a revoked device must not be able to re-list
   * itself as merely "pending" and invite a careless re-approval).
   */
  private async announceSelfIfUntrusted(): Promise<void> {
    if (!this.sync) return;
    const registry = await this.sync.fetchTrustRegistry();
    const selfId = this.sync.selfDeviceId;
    if (registry?.entries.some((e) => e.deviceId === selfId) === true) return;
    await this.sync.announceSelf(this.deviceName);
  }

  /** Rename this device and republish its self-signed discovery record. */
  async renameSelf(name: string): Promise<void> {
    const normalized = name.trim().replace(/\s+/g, " ");
    if (normalized.length === 0) throw new Error("Device name cannot be empty");
    if (normalized.length > 80) throw new Error("Device name must be 80 characters or fewer");
    if (!this.sync) throw new Error("Cloud Sync is not ready");

    await this.sync.announceSelf(normalized);
    await this.deps.onDeviceNameChanged?.(normalized);
    this.deviceName = normalized;
  }

  /**
   * Single-flight whole-library config sync: restore/verify remote, persist
   * accepted (respecting rollback), record quarantine, then reconcile runtime.
   * A no-op (local-only) when no sync bridge is composed.
   */
  async syncNow(): Promise<void> {
    if (!this.sync) return;
    if (this.syncInFlight) return this.syncInFlight;
    const run = this.sequence(() => this.doSync()).finally(() => {
      this.syncInFlight = null;
    });
    this.syncInFlight = run;
    return run;
  }

  private async doSync(): Promise<void> {
    if (!this.sync) return;
    this.syncStatus = { ...this.syncStatus, running: true };
    try {
      const known = new Map(Object.entries(this.state.revisions));
      const ledger = this.ledger();
      const otherPending = new Set(
        Object.entries(this.state.ledgers)
          .filter(([target]) => target !== this.state.target)
          .flatMap(([, other]) => Object.keys(other.pending)),
      );
      const candidates = [...this.configs.keys()].filter(
        (id) => !ledger.migrated[id] && !otherPending.has(id),
      );
      const result = await this.sync.restoreAll(known, [
        ...this.configs.keys(),
        ...Object.keys(ledger.pending),
      ]);
      const migrating = new Set(candidates);
      const publishErrors: string[] = [];
      for (const id of result.absent) {
        const local = this.configs.get(id);
        if (!ledger.pending[id] && migrating.has(id) && local) this.stageEdit(local, 0, false);
        const edit = ledger.pending[id];
        if (edit) {
          if (edit.base > 0) {
            // A previously acknowledged head disappeared. Do not restart its revision history.
            publishErrors.push(id);
            continue;
          }
          await this.saveState();
          if (!(await this.publishPending(id))) publishErrors.push(id);
        }
      }
      // Persist accepted configs locally (never overwriting a newer local
      // revision) and update the runtime desired set.
      for (const applied of result.applied) {
        if (otherPending.has(applied.projectId) && !ledger.pending[applied.projectId]) continue;
        const prior = this.state.revisions[applied.projectId] ?? 0;
        if (applied.revision < prior) continue;
        const id = applied.projectId;
        const localConfig = this.configs.get(id);
        const edit = ledger.pending[id];
        const remoteHash = hashConfig(applied.config);
        const legacy = migrating.has(id) && !edit && localConfig !== undefined;
        let installRemote = false;
        if (edit) {
          if (remoteHash === edit.hash && applied.revision >= edit.base) {
            delete ledger.pending[id];
            ledger.migrated[id] = true;
          } else if (
            applied.revision === edit.base ||
            (applied.revision === edit.base + 1 &&
              remoteHash === edit.attemptedHash &&
              applied.signer === this.sync.selfDeviceId)
          ) {
            edit.base = applied.revision;
            this.state.revisions[id] = applied.revision;
            await this.saveState();
            if (!(await this.publishPending(id))) publishErrors.push(id);
            continue;
          } else {
            this.keepConflict(id, edit, applied.revision, applied.signer, remoteHash);
            installRemote = true;
          }
        } else if (legacy && hashConfig(localConfig) !== remoteHash) {
          this.keepConflict(
            id,
            this.stageEdit(localConfig, prior, false),
            applied.revision,
            applied.signer,
            remoteHash,
          );
          installRemote = true;
        }
        ledger.migrated[id] = true;
        if (installRemote) await this.saveState();
        const savedConflict = this.state.conflicts[id]?.some(
          (record) =>
            record.remoteRevision === applied.revision && record.winnerHash === remoteHash &&
            localConfig &&
            hashConfig(parseProjectConfig(record.losingConfigJson)) === hashConfig(localConfig),
        );
        if (applied.revision === prior && !installRemote && !savedConflict) {
          const local = this.configs.get(applied.projectId);
          if (local !== undefined && hashConfig(local) === hashConfig(applied.config)) {
            // Normal idempotent re-read of the cloud head already applied here.
            // It is not a rollback and must not re-create a dismissed issue.
            delete this.state.quarantine[applied.projectId];
            continue;
          }
          if (local !== undefined) {
            // A trusted signer presenting different bytes at the same revision
            // is equivocation, not an ordinary repeat. Keep the known local copy.
            this.state.quarantine[applied.projectId] = {
              projectId: applied.projectId,
              reason: `Revision ${applied.revision} differs from the version already applied`,
              code: "rollback",
              detectedAt: new Date().toISOString(),
              localRetained: true,
            };
            continue;
          }
        }
        await this.store.save(applied.config);
        await this.pruneOAuthForConfigChange(this.configs.get(applied.projectId), applied.config);
        this.configs.set(applied.projectId, applied.config);
        this.state.revisions[applied.projectId] = applied.revision;
        delete this.state.quarantine[applied.projectId];
      }
      // Deletions made on another device. Local cleanup runs BEFORE the project
      // is forgotten, so agent config files never keep entries for a project that
      // no longer exists; a cleanup failure is reported and retried rather than
      // orphaning them.
      for (const d of result.deleted) {
        if (otherPending.has(d.projectId) && !ledger.pending[d.projectId]) continue;
        const prior = this.state.revisions[d.projectId] ?? 0;
        if (d.revision < prior) continue;
        const edit = ledger.pending[d.projectId];
        if (edit && edit.base === d.revision && edit.recreatesDeletion) {
          // Explicit recreation after a deletion already applied on this device.
          if (!(await this.publishPending(d.projectId))) publishErrors.push(d.projectId);
          continue;
        }
        if (d.revision === prior && !this.configs.has(d.projectId)) continue;
        const local = this.configs.get(d.projectId);
        const pending =
          ledger.pending[d.projectId] ??
          ((migrating.has(d.projectId) || d.revision === prior) && local
            ? this.stageEdit(local, prior, false) : undefined);
        if (pending) this.keepConflict(d.projectId, pending, d.revision, d.signer);
        ledger.migrated[d.projectId] = true;
        await this.saveState();
        const failures = await this.agentConfigs
          .uninstallProject(d.projectId)
          .catch((err: unknown) => [
            { directory: "", agent: "cursor" as const, message: (err as Error).message },
          ]);
        if (failures.length > 0) {
          this.state.quarantine[d.projectId] = {
            projectId: d.projectId,
            reason: `deleted on ${d.signer} but this device could not clean up: ${failures
              .map((f) => `${f.agent} in ${f.directory}: ${f.message}`)
              .join("; ")}`,
            code: "cleanup-failed",
            detectedAt: new Date().toISOString(),
            localRetained: true,
          };
          continue;
        }
        await this.agentConfigs.forgetProject(d.projectId);
        await this.removeConfig(d.projectId, d.revision, true);
      }

      for (const q of result.quarantined) {
        // Refusing a remote record must NOT destroy local state. If this device
        // already holds the project — because it authored it and is waiting for
        // approval, or because it applied a good revision earlier — the local
        // copy stays authoritative here and keeps serving. Otherwise there is
        // nothing to retain and the project stays inert.
        //
        // Deleting on refusal would hand a denial of service to anyone who can
        // write the bucket: publishing a garbage head under a project id would
        // take that project down on every device.
        const localRetained = this.configs.has(q.projectId);
        this.state.quarantine[q.projectId] = {
          projectId: q.projectId,
          reason: q.reason,
          code: q.code,
          detectedAt: new Date().toISOString(),
          localRetained,
        };
        if (!localRetained) this.configs.delete(q.projectId);
      }
      await this.saveState();
      await this.reconcile();
      this.syncStatus = {
        ready: true,
        lastSyncAt: Date.now(),
        lastError: result.readErrors.length
          ? result.readErrors
              .map((e) => `${e.projectId}: ${e.kind}`)
              .join(", ")
              .slice(0, 200)
          : publishErrors.length
            ? (this.syncStatus.lastError ?? "Project upload pending. Retry Cloud Sync.")
            : null,
        unreadable: result.readErrors.length,
        applied: result.applied.length,
        quarantined: result.quarantined.length,
        conflicts: this.totalConflicts(),
        running: false,
      };
    } catch (err) {
      this.syncStatus = {
        ...this.syncStatus,
        running: false,
        lastError:
          err && typeof err === "object" && "kind" in err && err.kind === "AuthFailed"
            ? "Cloud storage rejected the credentials."
            : "Cloud Sync could not complete. Retry Cloud Sync.",
      };
    }
  }

  private stageEdit(config: ProjectConfig, base: number, installLocally: boolean): PendingEdit {
    const ledger = this.ledger();
    const previous = ledger.pending[config.id];
    const edit: PendingEdit = {
      id: randomBytes(12).toString("hex"),
      base: previous?.base ?? base,
      config: projectConfigToJson(config),
      hash: hashConfig(config),
      installLocally,
      recreatesDeletion: previous?.recreatesDeletion ?? (base > 0 && !this.configs.has(config.id)),
      ...(previous?.attemptedHash ? { attemptedHash: previous.attemptedHash } : {}),
    };
    ledger.pending[config.id] = edit;
    return edit;
  }

  private keepConflict(id: string, edit: PendingEdit, revision: number, signer: string, winnerHash?: string): void {
    const list = (this.state.conflicts[id] ??= []);
    const alreadySaved = list.some(record => record.remoteRevision === revision &&
      record.remoteSigner === signer && hashConfig(parseProjectConfig(record.losingConfigJson)) === edit.hash);
    if (!alreadySaved) list.push({
      winnerHash,
      projectId: id,
      attemptedRevision: edit.base + 1,
      remoteRevision: revision,
      localSigner: this.sync!.selfDeviceId,
      remoteSigner: signer,
      detectedAt: new Date().toISOString(),
      reason: "remote-newer",
      losingConfigJson: edit.config,
    });
    delete this.ledger().pending[id];
    this.ledger().migrated[id] = true;
  }

  private async publishPending(id: string): Promise<boolean> {
    const bridge = this.sync;
    const ledger = this.ledger();
    const edit = ledger.pending[id];
    if (!bridge || !edit || edit.installLocally) return false;
    if (edit.attemptedHash && edit.attemptedHash !== edit.hash) {
      // The old edit may be the committed parent of this newer one.
      const verified = await bridge.inspect(id).catch(() => null);
      if (!verified || verified.readErrors.length || verified.quarantined.length) return false;
      const head = verified.applied[0];
      if (
        head?.revision === edit.base + 1 &&
        head.signer === bridge.selfDeviceId &&
        hashConfig(head.config) === edit.attemptedHash
      ) {
        edit.base = head.revision;
        this.state.revisions[id] = head.revision;
      }
    }
    if (ledger.pending[id]?.id !== edit.id) return false;
    edit.attemptedHash = edit.hash;
    await this.saveState();
    const result = await bridge
      .publish(parseProjectConfig(edit.config), edit.base + 1, edit.recreatesDeletion)
      .catch((error) => {
        const kind = storeErrorKind(error) ?? "PublishFailed";
        this.syncStatus = {
          ...this.syncStatus,
          lastError: `${id}: upload ${kind}. Retry Cloud Sync.`,
        };
        return null;
      });
    if (!result) return false;
    if (GatewaySyncBridge.isConflict(result)) {
      // Re-read and verify before interpreting an ambiguous acknowledgment or a concurrent edit.
      const verified = await bridge.inspect(id).catch(() => null);
      if (!verified) return false;
      const head = verified.applied.find((p) => p.projectId === id);
      const deleted = verified.deleted.find((p) => p.projectId === id);
      if (!head && !deleted) return false;
      if (head?.revision === edit.base + 1 && hashConfig(head.config) === edit.hash) {
        this.state.revisions[id] = head.revision;
      } else {
        const winner = (head ?? deleted)!;
        if (ledger.pending[id]?.id !== edit.id) return false;
        this.keepConflict(id, edit, winner.revision, winner.signer, head && hashConfig(head.config));
      }
    } else {
      this.state.revisions[id] = result.revision;
    }
    const current = ledger.pending[id];
    if (current?.id === edit.id) delete ledger.pending[id];
    else if (current && this.state.revisions[id] === edit.base + 1) {
      current.base = edit.base + 1;
      delete current.attemptedHash;
    }
    ledger.migrated[id] = true;
    await this.saveState();
    return true;
  }

  /**
   * Stable comparable shape for one server. Field order is normalised so a
   * cosmetic key reordering never reads as a change.
   */
  private static serverComparable(s: ProjectConfig["servers"][number]): unknown {
    return s.transport === "stdio"
      ? {
          transport: s.transport,
          id: s.id,
          label: s.label ?? null,
          disabled: s.disabled,
          command: s.command,
          args: [...s.args],
          env: Object.fromEntries(Object.entries(s.env).sort()),
          cwd: s.cwd ?? null,
        }
      : {
          transport: s.transport,
          id: s.id,
          label: s.label ?? null,
          disabled: s.disabled,
          url: s.url,
          headers: Object.fromEntries(Object.entries(s.headers).sort()),
        };
  }

  private totalConflicts(): number {
    return Object.values(this.state.conflicts).reduce((n, c) => n + c.length, 0);
  }

  // ── auth policy ────────────────────────────────────────────────────────

  /**
   * Resolve a project's inbound auth policy for the router. Default OFF. When a
   * project enables localAuth we read its device-local token from the vault for
   * the constant-time compare done inside the core Router; the token value is
   * used only there and never returned.
   */
  private async authPolicyFor(projectId: string): Promise<ProjectAuthPolicy | undefined> {
    const config = this.configs.get(projectId);
    if (!config || !config.localAuth.enabled) return { authRequired: false };
    const token = await this.vault.getProjectToken(projectId);
    if (!token) {
      // Auth enabled but no token stored — fail closed (require, but no valid
      // token exists so every request is rejected).
      return { authRequired: true };
    }
    return { authRequired: true, expectedToken: token };
  }

  // ── profile-bound browser servers ───────────────────────────────────────

  private async boundServerFor(projectId: string): Promise<ProfileBoundServer | null> {
    const config = this.configs.get(projectId);
    if (!config || !config.browserProfileId) return null;
    const cached = this.boundServers.get(projectId);
    if (cached && cached.boundProfileId === config.browserProfileId) return cached;
    if (cached) await cached.close().catch(() => {});
    const opts = this.deps.makeBoundServer(projectId, config.browserProfileId);
    const bound = await createProfileBoundServer({
      ...opts,
      boundProfileId: config.browserProfileId,
    });
    this.boundServers.set(projectId, bound);
    return bound;
  }

  // ── config CRUD (used by the controller) ─────────────────────────────────

  /** Snapshot of a project's verified/desired config, or null. */
  configOf(projectId: string): ProjectConfig | null {
    return this.configs.get(projectId) ?? null;
  }

  /** All non-quarantined configs. */
  allConfigs(): ProjectConfig[] {
    return [...this.configs.values()];
  }

  /** Persist a validated config, update runtime, publish if syncing. */
  async saveConfig(config: ProjectConfig): Promise<void> {
    const { upload } = await this.sequence(async () => {
      await this.saveConfigInternal(config);
      const upload = this.uploads.then(async () => {
        await this.publishPending(config.id);
      });
      this.uploads = upload.catch(() => {});
      return { upload };
    }, false);
    await upload;
  }

  private async saveConfigInternal(
    config: ProjectConfig,
    resolvedRevision?: number,
  ): Promise<void> {
    const validated = parseProjectConfig(projectConfigToJson(config));
    const edit = this.stageEdit(
      validated,
      resolvedRevision ?? this.state.revisions[validated.id] ?? 0,
      true,
    );
    if (resolvedRevision !== undefined) delete this.state.conflicts[validated.id];
    await this.saveState();
    await this.store.save(validated);
    edit.installLocally = false;
    await this.pruneOAuthForConfigChange(this.configs.get(validated.id), validated);
    this.configs.set(validated.id, validated);
    delete this.state.quarantine[validated.id];
    await this.saveState();
    // Drop values for references this project no longer has, so removing a
    // server or a header does not leave its secret behind in the keychain.
    await this.pruneManagedSecrets(validated.id).catch(() => undefined);
    await this.reconcile();
    // Any change to a project's servers, enable state, auth, or profile binding
    // changes what its directories should contain. Never throws: per-target
    // failures are recorded for retry.
    await this.agentConfigs.reconcileProject(validated.id).catch(() => undefined);
  }

  private async pruneOAuthForConfigChange(
    previous: ProjectConfig | undefined,
    next: ProjectConfig,
  ): Promise<void> {
    for (const old of previous?.servers ?? []) {
      if (old.transport !== "streamable-http" || old.auth !== "oauth") continue;
      const replacement = next.servers.find((server) => server.id === old.id);
      if (
        replacement?.transport === "streamable-http" &&
        replacement.auth === "oauth" &&
        replacement.url === old.url
      )
        continue;
      await this.vault.deleteOAuthForServer(next.id, old.id).catch(() => undefined);
      this.oauth.discardExcept(
        next.id,
        old.id,
        replacement?.transport === "streamable-http" && replacement.auth === "oauth"
          ? replacement.url
          : undefined,
      );
    }
  }

  // ── local directories + agent configuration ─────────────────────────────

  /** Associate a directory with a project and install the selected agents. */
  async setDirectoryAgents(
    projectId: string,
    directory: string,
    agents: readonly import("./types.ts").AgentKind[],
  ): Promise<void> {
    await this.agentConfigs.setDirectoryAgents(projectId, directory, agents);
    this.deps.onBindingsChanged?.();
  }

  /** Unlink a directory, removing MultiZen's entries from its agent files. */
  async removeDirectory(projectId: string, directory: string): Promise<void> {
    await this.agentConfigs.removeDirectory(projectId, directory);
    this.deps.onBindingsChanged?.();
  }

  /** Re-install a project into every associated directory. */
  async reconcileAgentConfigs(projectId: string): Promise<ReconcileResultView> {
    return this.agentConfigs.reconcileProject(projectId);
  }

  /** Retry one failed directory+agent target. */
  async retryAgentInstall(
    projectId: string,
    directory: string,
    agent: import("./types.ts").AgentKind,
  ): Promise<void> {
    await this.agentConfigs.retry(projectId, directory, agent);
  }

  /** Directory + agent install state for a project. */
  async workspaceBindings(projectId: string): Promise<WorkspaceBindingView[]> {
    return this.agentConfigs.bindings(projectId);
  }

  /**
   * Delete a project safely: MultiZen's entries are removed from every agent
   * file FIRST. If any file cannot be cleaned, the project is KEPT and the
   * failures are returned, so entries are never orphaned in a file belonging to
   * a project that no longer exists. Browser profiles are never touched.
   */
  async deleteProjectSafely(
    projectId: string,
  ): Promise<{ deleted: boolean; failures: InstallFailure[]; syncError?: string }> {
    return this.sequence(() => this.deleteProjectInternal(projectId));
  }

  private async deleteProjectInternal(projectId: string): Promise<{
    deleted: boolean;
    failures: InstallFailure[];
    syncError?: string;
  }> {
    if (!this.sync && this.state.target) {
      return {
        deleted: false,
        failures: [],
        syncError: "Reconnect Cloud Sync to publish the deletion.",
      };
    }
    const failures = await this.agentConfigs.uninstallProject(projectId);
    if (failures.length > 0) return { deleted: false, failures };

    // Announce the deletion BEFORE dropping local state. If the tombstone cannot
    // be published, stop: deleting locally would leave the remote head intact and
    // the very next sync pass would restore the project, which looks to the
    // operator like the delete silently failed to stick.
    let retainRevision: number | undefined;
    if (this.sync) {
      const next = (this.state.revisions[projectId] ?? 0) + 1;
      try {
        await this.sync.publishTombstone(projectId, next);
        retainRevision = next;
      } catch {
        await this.agentConfigs.reconcileProject(projectId);
        return {
          deleted: false,
          failures: [],
          syncError: "The deletion could not be confirmed. Retry Cloud Sync.",
        };
      }
    }

    await this.agentConfigs.forgetProject(projectId);
    await this.removeConfig(projectId, retainRevision);
    return { deleted: true, failures: [] };
  }

  /**
   * Remove a project's config + local state (never touches browser profiles).
   *
   * `retainRevision` keeps the project's revision counter at the deletion's
   * revision instead of forgetting it. That is what stops a stale remote head
   * from resurrecting the project on the next pass, and stops the tombstone from
   * being reprocessed as a fresh deletion every pass thereafter.
   */
  async removeConfig(
    projectId: string,
    retainRevision?: number,
    preserveConflicts = false,
  ): Promise<boolean> {
    const existed = await this.store.remove(projectId as never);
    this.configs.delete(projectId);
    if (retainRevision !== undefined) {
      this.state.revisions[projectId] = retainRevision;
      this.ledger().migrated[projectId] = true;
    } else delete this.state.revisions[projectId];
    delete this.state.quarantine[projectId];
    delete this.ledger().pending[projectId];
    if (!preserveConflicts) delete this.state.conflicts[projectId];
    const bound = this.boundServers.get(projectId);
    if (bound) {
      await bound.close().catch(() => {});
      this.boundServers.delete(projectId);
    }
    // Drop this project's vault credentials and its bearer token. Browser
    // profiles are NEVER touched — a profile outlives the project that bound it.
    await this.vault.deleteAllManagedSecrets(projectId).catch(() => {});
    await this.vault.deleteProjectToken(projectId).catch(() => {});
    await this.vault.deleteOAuthForProject(projectId).catch(() => {});
    this.oauth.discardProject(projectId);
    await this.saveState();
    await this.reconcile();
    // The project is gone, so its secrets must leave the shared backup too. This
    // is the one removal the backup merge cannot infer: every other path can tell
    // "deleted here" from "never present here" by whether the project is held
    // locally, but a deleted project is absent either way.
    this.deps.onSecretsChanged?.({ purgeProjects: [projectId] });
    return existed;
  }

  /** Invalidate a cached bound server (e.g. after a binding change). */
  async invalidateBoundServer(projectId: string): Promise<void> {
    const bound = this.boundServers.get(projectId);
    if (bound) {
      await bound.close().catch(() => {});
      this.boundServers.delete(projectId);
    }
  }

  // ── local state persistence ───────────────────────────────────────────

  private async loadState(): Promise<void> {
    try {
      const text = await fs.readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(text) as Partial<GatewayState>;
      this.state = {
        target: parsed.target,
        ledgers: parsed.ledgers ?? {},
        targetStates: parsed.targetStates ?? {},
        revisions: parsed.revisions ?? {},
        quarantine: parsed.quarantine ?? {},
        conflicts: parsed.conflicts ?? {},
        documentRevisions: parsed.documentRevisions ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.state = {
        ...EMPTY_STATE,
        targetStates: {},
        ledgers: {},
        revisions: {},
        quarantine: {},
        conflicts: {},
        documentRevisions: {},
      };
    }
  }

  private saveState(): Promise<void> {
    const body = JSON.stringify(this.state);
    const write = this.stateWrites.then(() => this.writeState(body));
    this.stateWrites = write.catch(() => {});
    return write;
  }

  private async writeState(body: string): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await fs.open(tmp, "wx");
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.stateFile);
  }

  // ── read models for the controller ───────────────────────────────────────

  get vaultAdapter(): GatewayVault {
    return this.vault;
  }

  syncStatusView(): GatewaySyncStatusView {
    return {
      ...this.syncStatus,
      pending: Object.keys(this.ledger().pending).length,
      conflicts: this.totalConflicts(),
    };
  }

  quarantineList(): QuarantineView[] {
    return Object.values(this.state.quarantine);
  }

  conflictList(): ConflictView[] {
    return Object.values(this.state.conflicts)
      .flat()
      .map(({ losingConfigJson, winnerHash: _winnerHash, ...view }) => ({
        ...view,
        // Summarised against what is authoritative NOW, because that is the
        // comparison the operator is actually making: "what changes if I keep
        // mine instead of what the other device published?"
        differences: this.summarizeConflict(view.projectId, losingConfigJson),
      }));
  }

  /**
   * Short, operator-facing list of what the losing local config would change if
   * it were kept. Compared against the currently-applied config.
   */
  private summarizeConflict(projectId: string, losingConfigJson: unknown): string[] {
    const current = this.configs.get(projectId);
    let losing: ProjectConfig;
    try {
      losing = parseProjectConfig(losingConfigJson);
    } catch {
      return ["the stored copy could not be read"];
    }
    if (!current) return ["this project no longer exists on this device"];
    const out: string[] = [];
    if (losing.label !== current.label) out.push("name");
    if (losing.enabled !== current.enabled) {
      out.push(losing.enabled ? "would switch it on" : "would switch it off");
    }
    if (losing.browserProfileId !== current.browserProfileId) out.push("browser profile");
    if (losing.localAuth.enabled !== current.localAuth.enabled) out.push("token requirement");

    const currentServers = new Map(current.servers.map((x) => [x.id, x]));
    const losingServers = new Map(losing.servers.map((x) => [x.id, x]));
    for (const id of losingServers.keys()) {
      if (!currentServers.has(id)) out.push(`adds server ${id}`);
    }
    for (const id of currentServers.keys()) {
      if (!losingServers.has(id)) out.push(`removes server ${id}`);
    }
    for (const [id, mine] of losingServers) {
      const theirs = currentServers.get(id);
      if (theirs === undefined) continue;
      if (
        JSON.stringify(GatewayService.serverComparable(mine)) !==
        JSON.stringify(GatewayService.serverComparable(theirs))
      ) {
        out.push(`changes server ${id}`);
      }
    }
    return out.length > 0 ? out : ["nothing — the two copies are identical"];
  }

  /**
   * Resolve a project's conflicts by explicit choice.
   *
   * `theirs` accepts what the other device published and discards the local copy
   * — the remote already won the race, so this only clears the records. `mine`
   * re-publishes the stored losing config as the next revision, making the local
   * edit authoritative. Either way nothing is decided implicitly: without this
   * call the records stay, which is the point of keep-both.
   */
  async resolveConflicts(projectId: string, keep: "mine" | "theirs" = "theirs"): Promise<void> {
    return this.sequence(() => this.resolveInternal(projectId, keep));
  }

  private async resolveInternal(projectId: string, keep: "mine" | "theirs"): Promise<void> {
    const records = this.state.conflicts[projectId] ?? [];
    if (records.length === 0) return;

    if (keep === "mine") {
      // Take the most recent losing copy: it is the latest thing the operator
      // actually asked for on this device.
      const latest = records[records.length - 1]!;
      let config: ProjectConfig;
      try {
        config = parseProjectConfig(latest.losingConfigJson);
      } catch {
        // An unreadable copy cannot be promoted. Leave the records in place
        // rather than silently discarding the operator's edit.
        throw new Error("the stored local copy could not be read");
      }
      // Clear first so the republish (which may itself conflict) records a fresh
      // conflict rather than being mistaken for one of the ones we just resolved.
      await this.saveConfigInternal(
        config,
        Math.max(latest.remoteRevision, this.lastRevision(projectId)),
      );
      await this.publishPending(projectId);
      return;
    }

    delete this.state.conflicts[projectId];
    await this.saveState();
  }

  /** Release a project from quarantine (re-verify on next sync). */
  async releaseQuarantine(projectId: string): Promise<void> {
    delete this.state.quarantine[projectId];
    this.syncStatus = {
      ...this.syncStatus,
      quarantined: Object.keys(this.state.quarantine).length,
    };
    await this.saveState();
    await this.loadLocalConfigs();
    await this.reconcile();
  }

  lastRevision(projectId: string): number {
    return this.state.revisions[projectId] ?? 0;
  }

  /** Access to the sync bridge for trust operations (null when local-only). */
  get syncBridge(): GatewaySyncBridge | null {
    return this.sync;
  }

  // ── exclusive browser-profile binding ───────────────────────────────────

  /**
   * Serializes profile-binding changes. Without this, two concurrent binds could
   * both read "profile is free" and both persist, leaving one profile bound to
   * two projects.
   */
  private bindChain: Promise<unknown> = Promise.resolve();

  private serializeBinding<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.bindChain.then(fn, fn);
    this.bindChain = next.catch(() => {});
    return next;
  }

  /** The project currently binding `profileId`, or null when it is free. */
  projectBoundTo(profileId: string): string | null {
    for (const config of this.configs.values()) {
      if (config.browserProfileId === profileId) return config.id;
    }
    return null;
  }

  /**
   * Apply a config mutation that may claim a browser profile, holding the
   * binding lock across the check AND the write so exclusivity cannot be raced.
   *
   * `desiredProfileId`: a string claims that profile, `null` clears a binding,
   * and `undefined` means the mutation does not touch the binding.
   */
  async applyWithBindingGuard(
    projectId: string,
    desiredProfileId: string | null | undefined,
    mutate: () => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; conflictProjectId: string }> {
    return this.serializeBinding(async () => {
      if (typeof desiredProfileId === "string") {
        const holder = this.projectBoundTo(desiredProfileId);
        if (holder !== null && holder !== projectId) {
          return { ok: false as const, conflictProjectId: holder };
        }
      }
      await mutate();
      return { ok: true as const };
    });
  }

  /**
   * Browser profiles offered in the binding selector. A profile bound to another
   * project is listed but marked unavailable, with the holder named, so the UI
   * can explain WHY it cannot be chosen instead of hiding it.
   */
  bindableProfiles(forProjectId?: string): BindableProfileView[] {
    const profiles = this.deps.listProfiles?.() ?? [];
    return profiles.map((p) => {
      const holder = this.projectBoundTo(p.id);
      return {
        profileId: p.id,
        name: p.name,
        ...(holder !== null ? { boundToProjectId: holder } : {}),
        available: holder === null || holder === forProjectId,
      };
    });
  }

  // ── `${NAME}` reference availability + provisioning ──────────────────────

  /** Every `${NAME}` a project's servers reference, de-duplicated and sorted. */
  referencedEnvNamesOf(projectId: string): string[] {
    const config = this.configs.get(projectId);
    if (!config) return [];
    const refs = new Set<string>();
    const collect = (v: string): void => {
      for (const n of gatewayReferencedEnvNames(v)) refs.add(n);
    };
    for (const s of config.servers) {
      if (s.transport === "stdio") {
        for (const v of Object.values(s.env)) collect(v);
      } else {
        collect(s.url);
        for (const v of Object.values(s.headers)) collect(v);
      }
    }
    return [...refs].sort();
  }

  /**
   * Availability of each reference: NAME, backing source, and presence booleans.
   * NEVER includes a value. A managed value takes precedence over the host
   * environment, matching what the runtime resolver actually does.
   */
  async secretRefStatus(projectId: string): Promise<SecretRefStatusView[]> {
    const names = this.referencedEnvNamesOf(projectId);
    const out: SecretRefStatusView[] = [];
    for (const name of names) {
      const managed = await this.vault.hasManagedSecret(projectId, name).catch(() => false);
      const approved = this.workspaces.isEnvApproved(name);
      const inEnv = this.envSource[name] !== undefined;
      const source: SecretRefStatusView["source"] = managed
        ? "managed"
        : approved && inEnv
          ? "environment"
          : null;
      out.push({
        name,
        source,
        present: managed || (approved && inEnv),
        approved,
        managed,
      });
    }
    return out;
  }

  /** Approve reading one NAME from this device's environment, then reconcile. */
  async approveEnvName(name: string): Promise<void> {
    await this.workspaces.approveEnv(name);
    await this.reconcile();
    this.deps.onBindingsChanged?.();
  }

  /** Revoke an environment approval, then reconcile (may deactivate servers). */
  async revokeEnvName(name: string): Promise<void> {
    await this.workspaces.revokeEnv(name);
    await this.reconcile();
    this.deps.onBindingsChanged?.();
  }

  /** Store a managed value for one reference (write-only), then reconcile. */
  async saveManagedSecret(projectId: string, name: string, value: string): Promise<void> {
    await this.vault.setManagedSecret(projectId, name, value);
    await this.reconcile();
    this.deps.onSecretsChanged?.();
  }

  /** Remove a managed value, then reconcile (may deactivate servers). */
  async deleteManagedSecret(projectId: string, name: string): Promise<void> {
    await this.vault.deleteManagedSecret(projectId, name);
    await this.reconcile();
    this.deps.onSecretsChanged?.();
  }

  /**
   * Mint a fresh bearer token for a project and return it for a one-shot reveal.
   *
   * Lives here rather than being called straight through to the vault so the
   * credential backup learns about the rotation: a token the operator has pasted
   * into an external agent config is exactly the kind of value a restore needs to
   * reproduce, and a backup holding the previous one would be actively misleading.
   */
  async rotateProjectToken(projectId: string): Promise<string> {
    const token = await this.vault.generateProjectToken(projectId);
    this.deps.onSecretsChanged?.();
    return token;
  }

  /**
   * Store raw values typed into a server's env/header fields and return the
   * `${NAME}` references that should take their place.
   *
   * The value goes straight from the argument into OS secure storage under a name
   * derived from (serverId, key); nothing is written to the project config here,
   * and the caller is expected to persist the returned references instead of the
   * values. No reconcile is triggered — the caller's `saveConfig` does one
   * immediately afterwards, and reconciling mid-way would briefly run the server
   * against a config that still lacks the reference.
   *
   * Deliberately NOT exposed on the IPC controller as a general-purpose writer:
   * the only way a value arrives is attached to the server it belongs to.
   */
  async storeInlineSecrets(
    projectId: string,
    serverId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<Record<string, string>> {
    const refs: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const name = managedRefName(serverId, key);
      await this.vault.setManagedSecret(projectId, name, value);
      refs[key] = `\${${name}}`;
    }
    if (Object.keys(refs).length > 0) this.deps.onSecretsChanged?.();
    return refs;
  }

  /**
   * Delete managed values whose reference no longer appears anywhere in the
   * project's servers.
   *
   * Only touches the managed-secret namespace, so the project's bearer token
   * (stored under a different credential name) is never at risk.
   */
  async pruneManagedSecrets(projectId: string): Promise<void> {
    const referenced = new Set(this.referencedEnvNamesOf(projectId));
    let pruned = false;
    for (const name of await this.vault.managedSecretNames(projectId)) {
      if (!referenced.has(name)) {
        await this.vault.deleteManagedSecret(projectId, name);
        pruned = true;
      }
    }
    if (pruned) this.deps.onSecretsChanged?.();
  }

  /**
   * Run a one-shot connection test against a server definition that may not be
   * saved yet.
   *
   * `overrides` carries values the operator has typed but not stored (NAME ->
   * value), so Test works before Save. Anything not overridden resolves exactly
   * as a launch would: a managed vault value first, then an APPROVED host
   * variable. `projectId` may be null while a project is still being created, in
   * which case only the overrides and approved environment are available.
   *
   * The probe borrows the runtime's own factories and base environment so a pass
   * here means the same thing a real launch would.
   */
  async testServerConnection(
    projectId: string | null,
    server: ServerConfig,
    overrides: Readonly<Record<string, string>> = {},
    profileIdOverride?: string,
  ): Promise<ProbeResultView> {
    const resolved: Record<string, string> = {};
    for (const name of probeReferencedNames(server)) {
      const override = overrides[name];
      if (override !== undefined) {
        resolved[name] = override;
        continue;
      }
      if (projectId !== null) {
        const managed = await this.vault.getManagedSecret(projectId, name).catch(() => null);
        if (managed !== null) {
          resolved[name] = managed;
          continue;
        }
      }
      if (!this.workspaces.isEnvApproved(name)) continue;
      const v = this.envSource[name];
      if (v !== undefined) resolved[name] = v;
    }
    const { stdioFactory, httpFactory, baseEnv } = this.runtime.launchPlumbing;
    if (server.transport === "streamable-http" && server.auth === "oauth") {
      const project = projectId === null ? undefined : this.configs.get(projectId);
      const selectedAvailable =
        projectId !== null &&
        project === undefined &&
        profileIdOverride !== undefined &&
        this.deps.listProfiles?.().some((profile) => profile.id === profileIdOverride) &&
        this.projectBoundTo(profileIdOverride) === null;
      const profileId =
        project?.browserProfileId ?? (selectedAvailable ? profileIdOverride : undefined);
      if (!profileId) {
        return {
          ok: false,
          durationMs: 0,
          error: "Bind a browser profile to this project before signing in.",
        };
      }
      const missing = probeReferencedNames(server).filter((name) => resolved[name] === undefined);
      if (missing.length > 0) {
        return {
          ok: false,
          durationMs: 0,
          missingRefs: missing,
          error: `no value is available for ${missing.join(", ")}`,
        };
      }
      const resolver = new EnvResolver({ base: resolved, allow: Object.keys(resolved) });
      const actual = {
        ...server,
        url: resolver.resolveTemplate(server.url, `server.${server.id}.url`),
        headers: resolver.resolveMap(server.headers, `server.${server.id}.headers`),
      };
      // `saved` means a matching OAuth server (same id, URL, auth) already
      // exists in the stored config, so the grant is persisted immediately.
      // For an UNSAVED draft the grant is held in memory keyed by the tested
      // `actual.url`; a later save promotes it only if the saved URL still
      // matches that key. Editing the URL between Test and Save therefore
      // discards the pending grant and the operator must sign in again.
      const saved = this.configs
        .get(projectId!)
        ?.servers.some(
          (item) =>
            item.id === server.id &&
            item.transport === "streamable-http" &&
            item.auth === "oauth" &&
            item.url === server.url,
        );
      try {
        await this.oauth.authorize(projectId!, actual, profileId, saved === true);
      } catch (error) {
        return { ok: false, durationMs: 0, error: oauthFailure(error) };
      }
      const factory = (spec: Parameters<typeof httpFactory>[0]) =>
        httpFactory({
          ...spec,
          authProvider: this.oauth.providerFor(projectId!, actual),
        });
      if (saved) await this.runtime.restartServer(projectId!, server.id);
      const tokens = await this.oauth.providerFor(projectId!, actual).tokens();
      return probeServer(
        { server, resolved },
        {
          stdioFactory,
          httpFactory: factory,
          baseEnv,
          redactValues: [tokens?.access_token ?? "", tokens?.refresh_token ?? ""],
        },
      );
    }
    return probeServer(
      { server, resolved },
      {
        stdioFactory,
        httpFactory,
        baseEnv,
        ...(this.deps.appVersion !== undefined ? { clientVersion: this.deps.appVersion } : {}),
      },
    );
  }

  async connectOAuthServer(projectId: string, serverId: string): Promise<void> {
    const project = this.configs.get(projectId);
    const server = project?.servers.find((item) => item.id === serverId);
    if (!project || !server || server.transport !== "streamable-http" || server.auth !== "oauth") {
      throw new Error("OAuth server was not found.");
    }
    if (!project.browserProfileId)
      throw new Error("Bind a browser profile to this project before signing in.");
    const values: Record<string, string> = {};
    for (const name of probeReferencedNames(server)) {
      const managed = await this.vault.getManagedSecret(projectId, name);
      if (managed !== null) values[name] = managed;
      else if (this.workspaces.isEnvApproved(name) && this.envSource[name] !== undefined)
        values[name] = this.envSource[name]!;
      else throw new Error(`No value is available for ${name}.`);
    }
    const resolver = new EnvResolver({ base: values, allow: Object.keys(values) });
    const actual = {
      ...server,
      url: resolver.resolveTemplate(server.url, `server.${server.id}.url`),
      headers: resolver.resolveMap(server.headers, `server.${server.id}.headers`),
    };
    try {
      await this.oauth.authorize(projectId, actual, project.browserProfileId, true, true);
    } catch (error) {
      throw new Error(oauthFailure(error));
    }
    const { stdioFactory, httpFactory, baseEnv } = this.runtime.launchPlumbing;
    const provider = this.oauth.providerFor(projectId, actual);
    const tokens = await provider.tokens();
    const checked = await probeServer(
      { server: actual, resolved: values },
      {
        stdioFactory,
        httpFactory: (spec) => httpFactory({ ...spec, authProvider: provider }),
        baseEnv,
        redactValues: [tokens?.access_token ?? "", tokens?.refresh_token ?? ""],
        ...(this.deps.appVersion !== undefined ? { clientVersion: this.deps.appVersion } : {}),
      },
    );
    if (!checked.ok) {
      throw new Error(
        `OAuth sign-in completed, but the MCP connection failed: ${checked.error ?? "unknown error"}`,
      );
    }
    await this.runtime.restartServer(projectId, serverId);
    if (!this.runtime.hasLiveServer(projectId, serverId)) {
      const status = this.runtime
        .status()
        .find((item) => item.projectId === projectId && item.serverId === serverId);
      throw new Error(
        `OAuth sign-in completed, but the live MCP connection failed: ${status?.lastError ?? "the server is not connected."}`,
      );
    }
  }
}

export type { GatewayState };
