/**
 * SyncController — orchestrates manual two-Mac Cloud Sync on the desktop.
 *
 * Responsibilities:
 *   - hold non-secret config (from settings) + secrets (from the vault),
 *   - talk to the conditional-write S3/R2 state {@link Coordinator} (no Worker,
 *     no Cloudflare Access) built lazily from current config + vault,
 *   - drive Kopia (connect → snapshot / restore) via the adapter factory,
 *   - keep an in-memory lease per profile with auto-renew timers,
 *   - gate profile launches (`beforeLaunch`) and mark profiles dirty,
 *   - preserve unsynced/MCP behavior (only synced profiles are coupled).
 *
 * Design notes:
 *   - The controller NEVER merges Chromium state. On divergence it preserves
 *     both by creating a local conflict copy before a canonical restore.
 *   - Publish only clears `dirty` after the coordinator accepts the revision.
 *   - Release/backup/restore refuse while the profile's Chromium is running.
 *   - Initial coordinator not-found is treated as revision 0.
 *   - Control objects live in the SAME bucket as the Kopia repo but under a
 *     SEPARATE, validated control prefix — never inside Kopia's key namespace.
 *
 * All fs / network / Kopia dependencies are injectable so the controller is
 * testable without Electron.
 */

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionConfig, Profile } from "@multizen/types";
import type { ProfileManager } from "@multizen/profile-manager";
import {
  SyncErrorCode,
  isSyncError,
  syncError,
  toManifest,
  assertManifestSafe,
  decideLaunch,
  decidePublish,
  conflictCopyName,
  MANIFEST_VERSION,
  NO_REVISION,
  type SyncError,
} from "@multizen/sync-core";
import {
  atomicSwap,
  sameVolumeSync,
  type KopiaAdapter,
  type KopiaSecrets,
} from "@multizen/kopia-adapter";
import type { AppSettings, SettingsStore, SyncConfig } from "@multizen/settings-store";
import type { CredentialVault } from "./CredentialVault.ts";
import {
  StorageCoordinatorFactory,
  assertSafeControlPrefix,
  type Coordinator,
  type CoordinatorConfig,
  type CoordinatorCredentials,
  type StorageCoordinatorFactoryDeps,
} from "./StorageCoordinator.ts";
import { normalizeEndpoint, isStoreError } from "@multizen/s3-coordinator";
import { ProfileQuiescenceGuard, type QuiescenceDriver } from "./ProfileQuiescenceGuard.ts";
import { resolveKopiaBinary, createKopiaAdapter, KOPIA_PINNED_VERSION } from "./kopiaFactory.ts";
import { redact, redactError } from "./redaction.ts";
import { storeEntryDir } from "../extensions/extensionStore.ts";
import type {
  BootstrapProfileResult,
  BootstrapSummary,
  DisableProfileSyncResult,
  ProfileDiagnosticsView,
  ProfileSyncStatusView,
  SecretKind,
  StorageTestResult,
  SyncConfigView,
  SyncDiagnostics,
  SyncDiagnosticsExport,
  SyncOperationView,
  SyncProgressEvent,
} from "./types.ts";

/** An in-memory lease the controller holds for a profile. */
interface HeldLease {
  profileId: string;
  leaseId: string;
  fencingToken: number;
  expiresAtMs: number;
  renewTimer: NodeJS.Timeout;
  /** True while a synced-owned Chromium is open under this lease. */
  browserOpen: boolean;
}

const SECRET_KINDS: SecretKind[] = ["kopiaPassword", "s3AccessKeyId", "s3SecretAccessKey"];
const DEFAULT_KOPIA_PREFIX = "multizen-kopia";

export interface SyncControllerDeps {
  settingsStore: SettingsStore;
  getSettings: () => AppSettings;
  /**
   * Ownership-boundary callback. `SettingsStore.update` REPLACES its internal
   * cache object identity and returns a brand-new {@link AppSettings}; it never
   * mutates the previous object in place. The controller does not own the
   * settings cache — it only reads it through {@link getSettings}. So whenever
   * `updateConfig` persists a change it MUST hand the returned object back to
   * the owner through this callback, otherwise the owner's cached reference
   * (and therefore `getSettings`) stays pinned to the pre-update object and
   * `configView()` reports stale values (e.g. the master `enabled` switch snaps
   * back to its old state). Required so the contract is explicit in production
   * and in tests; production always supplies it (see main/index.ts).
   */
  onSettingsUpdated: (next: AppSettings) => void;
  onSyncMaterialsChanged?: () => void;
  profileManager: ProfileManager;
  vault: CredentialVault;
  driver: QuiescenceDriver & {
    close(profileId: string): Promise<void>;
  };
  /** Absolute root under which profiles live (for staging same-volume swaps). */
  profilesRoot: string;
  /** Kopia config file path default (under userData). */
  kopiaConfigDefault: string;
  /** process.resourcesPath in packaged builds; undefined in dev. */
  resourcesPath?: string;
  /** App version string (from app.getVersion()), for diagnostics export. */
  appVersion?: string;
  /** Host platform/arch, injectable for tests. Defaults to process values. */
  platform?: string;
  arch?: string;
  /** Existence probe for the resolved Kopia binary. Defaults to fs.existsSync. */
  binExists?: (p: string) => boolean;
  /** Emit a progress/error event to the renderer. */
  emit?: (event: SyncProgressEvent) => void;
  /** Secret-safe diagnostic logger. Defaults to the main-process console. */
  logger?: Pick<Console, "error">;
  /**
   * Injectable coordinator (tests). When set, it is used verbatim and no
   * storage-coordinator factory is consulted — the controller treats it as the
   * always-current coordinator for every config.
   */
  coordinator?: Coordinator;
  /** Injectable storage-coordinator factory deps (tests). */
  coordinatorFactoryDeps?: StorageCoordinatorFactoryDeps;
  /** Injectable Kopia adapter factory (tests). */
  makeKopia?: (secrets: KopiaSecrets, configFile: string) => KopiaAdapter;
  /** Injectable same-volume check (tests). Defaults to fs statSync device id. */
  sameVolume?: (a: string, b: string) => boolean;
}

export class SyncController {
  private readonly profileJobs = new Map<string, Promise<unknown>>();
  private readonly renewals = new WeakSet<HeldLease>();

  private withProfile<T>(id: string, work: () => Promise<T>, closeBackup = false): Promise<T> {
    if (this.disposed || this.suppressAutoBackup || (this.quitting && !closeBackup)) {
      return Promise.reject(syncError(SyncErrorCode.SyncDisabled, "Cloud Sync is stopping"));
    }
    const previous = this.profileJobs.get(id) ?? Promise.resolve();
    const job = previous.then(work, work);
    this.profileJobs.set(id, job);
    const finish = () => {
      if (this.profileJobs.get(id) === job) this.profileJobs.delete(id);
    };
    void job.then(finish, finish);
    return job;
  }

  launch<T>(id: string, start: () => Promise<T>): Promise<T> {
    return this.withProfile(id, async () => {
      const previous = this.leases.get(id);
      try {
        await this.prepareLaunch(id);
        const lease =
          this.cfg().enabled && this.deps.profileManager.getSyncState(id)?.syncEnabled
            ? this.requireOwnedLease(id)
            : undefined;
        const result = await start();
        if (lease && (this.leases.get(id) !== lease || lease.expiresAtMs <= Date.now())) {
          await this.deps.driver.close(id);
          throw syncError(SyncErrorCode.LeaseExpired, "Lease lost during launch");
        }
        return result;
      } catch (error) {
        if (this.leases.get(id) !== previous && !this.deps.driver.isRunning(id)) {
          await this.releaseAndDropLease(id).catch(() => {});
        }
        throw error;
      }
    });
  }

  private readonly leases = new Map<string, HeldLease>();
  private readonly coordinatorFactory: StorageCoordinatorFactory;
  /** Test-injected coordinator that bypasses the factory entirely. */
  private readonly injectedCoordinator: Coordinator | null;
  private lastStoreHealth: boolean | null = null;
  private lastCapability: { ok: boolean; failedCheck: string | null } | null = null;
  /** Last redacted sync error message (never a secret), for diagnostics. */
  private lastSyncError: string | null = null;
  private disposed = false;
  /**
   * When true, close-triggered auto backups are suppressed. Set while
   * {@link stopCoordination} winds down leases during a global true→false
   * disable: those forced closes must NOT kick off a backup because the leases
   * are already being released (any backup would just fail on a released lease).
   */
  private pauses = 0;
  private quitting = false;

  private get suppressAutoBackup(): boolean {
    return this.pauses > 0;
  }
  /**
   * In-flight close-triggered auto backups, keyed by profile id. Used to
   * deduplicate concurrent close events for the same profile (one snapshot +
   * publish, not N) and to let manual backup / beforeLaunch / release / shutdown
   * JOIN the same promise instead of racing it. The stored promise never
   * rejects — auto backup swallows + logs its own errors — so awaiting it can
   * never turn a caller into an unhandled rejection.
   */
  private readonly autoBackups = new Map<string, Promise<void>>();

  /**
   * Single-flight whole-library bootstrap. `bootstrapPromise` is non-null while
   * a bootstrap runs; concurrent triggers (startup + a readiness change) JOIN
   * it instead of starting a second run. `bootstrapSummary` caches the last (or
   * in-flight) run for status/UI. `lastReadyFingerprint` records the readiness
   * inputs of the last successful trigger so a no-op config write does not
   * re-run, but a genuine readiness change (bucket/secret/test) does.
   */
  private bootstrapPromise: Promise<BootstrapSummary> | null = null;
  private bootstrapProbePromise: Promise<StorageTestResult> | null = null;
  private bootstrapSummary: BootstrapSummary = {
    phase: "idle",
    running: false,
    startedAt: null,
    finishedAt: null,
    remoteDiscovered: 0,
    restored: 0,
    uploaded: 0,
    deferred: 0,
    reconciled: 0,
    failed: 0,
    remoteTruncated: false,
    results: [],
    error: null,
  };
  private lastReadyFingerprint: string | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Keep closed profiles current while the app remains open.
   *
   * Uses `force: true` on purpose: a profile going dirty does not change the
   * readiness fingerprint, so a non-forced `autoBootstrap` would short-circuit
   * and never publish the change. Forcing bypasses only that dedup gate — the
   * run is still bounded by `maybeBootstrap`'s single-flight join, so overlapping
   * ticks collapse onto one in-flight pass rather than stacking.
   */
  startAutoSync(intervalMs = 30_000): void {
    if (this.disposed || this.autoSyncTimer) return;
    this.autoSyncTimer = setInterval(() => {
      void this.autoBootstrap({ force: true }).catch(() => undefined);
    }, intervalMs);
    this.autoSyncTimer.unref?.();
  }

  /**
   * Serializes destructive per-profile remote-disable (delete) operations so
   * two deletes (or a delete racing a bootstrap upload) never interleave. Keyed
   * by profile id; a second delete of the same profile joins the first.
   */
  private readonly disableInFlight = new Map<string, Promise<DisableProfileSyncResult>>();

  /** Wait for a close-triggered backup of this profile, if one is active. */
  private async waitForAutoBackup(profileId: string): Promise<void> {
    const inFlight = this.autoBackups.get(profileId);
    if (inFlight) await inFlight;
  }
  constructor(private readonly deps: SyncControllerDeps) {
    this.injectedCoordinator = deps.coordinator ?? null;
    this.coordinatorFactory = new StorageCoordinatorFactory(deps.coordinatorFactoryDeps);
  }

  private cfg(): SyncConfig {
    return this.deps.getSettings().sync;
  }

  private emit(event: SyncProgressEvent): void {
    if (event.phase === "error") this.lastSyncError = event.message;
    this.deps.emit?.(event);
  }

  /** All currently-known secret values, for redaction. */
  private async secretValuesForRedaction(): Promise<(string | null)[]> {
    const c = this.cfg();
    return Promise.all([
      this.deps.vault.get(c.kopiaPasswordRef),
      this.deps.vault.get(c.s3AccessKeyIdRef),
      this.deps.vault.get(c.s3SecretAccessKeyRef),
    ]);
  }

  /** S3 credentials only; connection testing must never require/read the backup password. */
  private async storageSecretValuesForRedaction(): Promise<(string | null)[]> {
    const c = this.cfg();
    return Promise.all([
      this.deps.vault.get(c.s3AccessKeyIdRef),
      this.deps.vault.get(c.s3SecretAccessKeyRef),
    ]);
  }

  /**
   * The single effective-endpoint normalization rule for the whole controller.
   *
   * Reuses the public {@link normalizeEndpoint} from `@multizen/s3-coordinator`
   * — the SAME rule the S3 connection test applies — so legacy settings
   * persisted with a path/query are reduced to one safe origin. The coordinator
   * and diagnostics use that origin; {@link repoTarget} derives the bare
   * host[:port] Kopia requires for `--endpoint`.
   *
   * Empty/omitted stays empty (AWS default resolution). A malformed or
   * non-http(s) endpoint is NOT silently coerced into something unsafe — the
   * provider {@link StoreError} is wrapped into an actionable, user-facing
   * {@link SyncErrorCode.InvalidInput}. The error message never echoes the raw
   * endpoint (which could carry userinfo/query), only a fixed reason.
   */
  private effectiveEndpoint(raw: string | undefined): string {
    try {
      return normalizeEndpoint(raw) ?? "";
    } catch (err) {
      if (isStoreError(err)) {
        throw syncError(
          SyncErrorCode.InvalidInput,
          "S3 endpoint is invalid — enter a host or an http(s) URL (e.g. https://<account>.r2.cloudflarestorage.com)",
        );
      }
      throw err;
    }
  }

  /**
   * Non-throwing effective endpoint for diagnostics. A diagnostics export must
   * never throw just because a legacy setting is malformed, so on a normalize
   * failure we fall back to {@link safeStorageEndpoint}, which strips
   * userinfo/query/fragment while keeping actionable host context. Never logs or
   * returns the raw endpoint's secret-bearing parts.
   */
  private safeEffectiveEndpoint(raw: string): string {
    try {
      return normalizeEndpoint(raw) ?? "";
    } catch {
      return safeStorageEndpoint(raw);
    }
  }

  /**
   * Build the effective non-secret coordinator config from current settings.
   * Validates + normalizes the control prefix so control objects never nest
   * inside Kopia's key namespace and can never collide with the bucket root.
   */
  private coordinatorConfig(): CoordinatorConfig {
    const c = this.cfg();
    const controlPrefix = assertSafeControlPrefix(
      c.controlPrefix,
      c.s3Prefix || DEFAULT_KOPIA_PREFIX,
    );
    return {
      endpoint: this.effectiveEndpoint(c.s3Endpoint),
      region: c.s3Region,
      bucket: c.s3Bucket,
      controlPrefix,
      s3ForcePathStyle: c.s3ForcePathStyle,
      deviceId: c.deviceId,
      leaseTtlMs: c.leaseTtlMs,
      renewalMs: c.renewalMs,
      clockSkewSafetyMs: c.clockSkewSafetyMs,
    };
  }

  /** Load the S3/R2 credentials from the vault (never persisted elsewhere). */
  private async coordinatorCredentials(): Promise<CoordinatorCredentials> {
    const c = this.cfg();
    const [accessKeyId, secretAccessKey] = await Promise.all([
      this.deps.vault.get(c.s3AccessKeyIdRef),
      this.deps.vault.get(c.s3SecretAccessKeyRef),
    ]);
    if (!accessKeyId || !secretAccessKey) {
      throw syncError(
        SyncErrorCode.InvalidInput,
        "S3 access key ID and secret access key are required to coordinate",
      );
    }
    return { accessKeyId, secretAccessKey };
  }

  /**
   * Lazily obtain the current coordinator, rebuilding it whenever the effective
   * config or credential version changes. A test-injected coordinator bypasses
   * the factory. A missing bucket is rejected deterministically BEFORE any
   * credential read so an unconfigured store never spawns SDK work.
   */
  private async coordinator(): Promise<Coordinator> {
    if (this.injectedCoordinator) return this.injectedCoordinator;
    const config = this.coordinatorConfig();
    if (!config.bucket.trim()) {
      throw syncError(
        SyncErrorCode.StorageUnreachable,
        "Storage bucket is not configured — set it before coordinating",
      );
    }
    const credentials = await this.coordinatorCredentials();
    return this.coordinatorFactory.get(config, credentials);
  }

  /**
   * Narrow, main-process-only accessor used by the MCP gateway to compose its
   * OWN project-config sync over the SAME bucket, under the reserved `mcp/`
   * control subtree (never the browser-profile namespace). Returns null unless
   * Cloud Sync is fully ready (enabled + bucket + S3 keypair + password + a
   * successful capability probe).
   *
   * SECURITY: the returned `password` is the operator encryption password (the
   * Kopia repo password), reused as the config-sync KDF password. It is handed
   * ONLY to the in-process gateway sync bridge for AES-256-GCM sealing and is
   * NEVER serialized, logged, or returned across IPC. The `store` is a fresh
   * conditional object store bound to the same credentials/bucket; the gateway
   * writes only under `<controlPrefix>/mcp/…`.
   */
  gatewayTargetId(): string | undefined {
    const c = this.cfg();
    if (!c.s3Bucket.trim()) return undefined;
    return JSON.stringify([
      this.safeEffectiveEndpoint(c.s3Endpoint),
      c.s3Bucket.trim(),
      c.controlPrefix.trim().replace(/^\/+|\/+$/g, ""),
    ]);
  }

  async gatewaySyncMaterials(): Promise<{
    targetId: string;
    store: import("@multizen/s3-coordinator").S3ConditionalObjectStore;
    controlPrefix: string;
    password: string;
    deviceId: string;
  } | null> {
    if (!(await this.isCloudSyncReady())) return null;
    const c = this.cfg();
    const config = this.coordinatorConfig();
    const targetId = this.gatewayTargetId()!;
    const credentials = await this.coordinatorCredentials();
    const password = await this.deps.vault.get(c.kopiaPasswordRef);
    if (!password) return null;
    const { S3ConditionalObjectStore, createS3Deps } = await import("@multizen/s3-coordinator");
    const s3Deps = await createS3Deps();
    const store = new S3ConditionalObjectStore(
      {
        bucket: config.bucket,
        region: config.region || undefined,
        endpoint: config.endpoint || undefined,
        forcePathStyle: config.s3ForcePathStyle,
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
        },
      },
      s3Deps,
    );
    if (targetId !== this.gatewayTargetId()) return null;
    return {
      targetId,
      store,
      controlPrefix: config.controlPrefix,
      password,
      deviceId: config.deviceId,
    };
  }

  /** True when Cloud Sync is ready for the gateway to compose config sync. */
  async isReadyForGateway(): Promise<boolean> {
    return this.isCloudSyncReady();
  }

  // ── Config + secrets ───────────────────────────────────────────────────

  configView(): SyncConfigView {
    const c = this.cfg();
    return {
      enabled: c.enabled,
      s3Endpoint: c.s3Endpoint,
      s3Region: c.s3Region,
      s3Bucket: c.s3Bucket,
      s3Prefix: c.s3Prefix,
      controlPrefix: c.controlPrefix,
      s3ForcePathStyle: c.s3ForcePathStyle,
      leaseTtlMs: c.leaseTtlMs,
      renewalMs: c.renewalMs,
      clockSkewSafetyMs: c.clockSkewSafetyMs,
      deviceId: c.deviceId,
      deviceDisplayName: c.deviceDisplayName,
      kopiaConfigPath: c.kopiaConfigPath,
      kopiaBinPath: c.kopiaBinPath,
    };
  }

  /** Update non-secret config. Never accepts secret values. */
  async updateConfig(patch: Partial<SyncConfigView>): Promise<SyncConfigView> {
    const wasEnabled = this.cfg().enabled;
    // Whitelist non-secret keys only; deviceId is immutable identity.
    const allowed: Partial<SyncConfig> = {};
    if (typeof patch.enabled === "boolean") allowed.enabled = patch.enabled;
    if (typeof patch.s3Endpoint === "string")
      // Persist the normalized origin the S3 test uses and Kopia derives from,
      // so a copied R2 "S3 API" URL like https://<acct>.r2.cloudflarestorage.com/bucket?x=y
      // is stored as its origin (scheme added, path/query/fragment/userinfo
      // dropped). Empty stays empty; malformed → actionable InvalidInput.
      allowed.s3Endpoint = this.effectiveEndpoint(patch.s3Endpoint);
    if (typeof patch.s3Region === "string") allowed.s3Region = patch.s3Region.trim();
    if (typeof patch.s3Bucket === "string") allowed.s3Bucket = patch.s3Bucket.trim();
    if (typeof patch.s3Prefix === "string") allowed.s3Prefix = patch.s3Prefix.trim();
    if (typeof patch.controlPrefix === "string") allowed.controlPrefix = patch.controlPrefix.trim();
    if (typeof patch.s3ForcePathStyle === "boolean")
      allowed.s3ForcePathStyle = patch.s3ForcePathStyle;
    if (
      typeof patch.leaseTtlMs === "number" &&
      Number.isInteger(patch.leaseTtlMs) &&
      patch.leaseTtlMs > 0
    )
      allowed.leaseTtlMs = patch.leaseTtlMs;
    if (
      typeof patch.renewalMs === "number" &&
      Number.isInteger(patch.renewalMs) &&
      patch.renewalMs > 0
    )
      allowed.renewalMs = patch.renewalMs;
    if (
      typeof patch.clockSkewSafetyMs === "number" &&
      Number.isInteger(patch.clockSkewSafetyMs) &&
      patch.clockSkewSafetyMs > 0
    )
      allowed.clockSkewSafetyMs = patch.clockSkewSafetyMs;
    if (typeof patch.deviceDisplayName === "string")
      allowed.deviceDisplayName = patch.deviceDisplayName.trim() || "This device";
    if (typeof patch.kopiaConfigPath === "string")
      allowed.kopiaConfigPath = patch.kopiaConfigPath.trim();
    if (typeof patch.kopiaBinPath === "string") allowed.kopiaBinPath = patch.kopiaBinPath.trim();

    const invalidatesCapability =
      allowed.s3Endpoint !== undefined ||
      allowed.s3Region !== undefined ||
      allowed.s3Bucket !== undefined ||
      allowed.controlPrefix !== undefined ||
      allowed.s3ForcePathStyle !== undefined;

    const disabling = wasEnabled && allowed.enabled === false;
    if (disabling) this.pauses++;
    try {
      if (disabling) await this.stopCoordination();
      const nextSettings = await this.deps.settingsStore.update({ sync: allowed as SyncConfig });
      this.deps.onSettingsUpdated(nextSettings);
    } finally {
      if (disabling) this.pauses--;
    }
    // Config changed → the cached coordinator (if any) may be stale; the next
    // coordinator() call rebuilds it lazily when the effective fingerprint
    // differs. Reset defensively so a bucket/prefix change is never missed.
    this.coordinatorFactory.reset();
    if (invalidatesCapability) {
      this.lastStoreHealth = null;
      this.lastCapability = null;
    }
    this.lastReadyFingerprint = null;
    this.deps.onSyncMaterialsChanged?.();
    // Automatically probe + bootstrap once all required settings/secrets exist.
    void this.autoBootstrap().catch(() => undefined);
    return this.configView();
  }

  /** Save a secret to the vault. The value is never persisted elsewhere. */
  async saveSecret(kind: SecretKind, value: string): Promise<void> {
    const ref = this.refForKind(kind);
    if (value.length === 0) {
      await this.deps.vault.delete(ref);
    } else {
      await this.deps.vault.set(ref, value);
    }
    // A credential change invalidates the cached coordinator.
    this.coordinatorFactory.reset();
    if (kind === "s3AccessKeyId" || kind === "s3SecretAccessKey") {
      this.lastStoreHealth = null;
      this.lastCapability = null;
    }
    this.lastReadyFingerprint = null;
    this.deps.onSyncMaterialsChanged?.();
    void this.autoBootstrap().catch(() => undefined);
  }

  async deleteSecret(kind: SecretKind): Promise<void> {
    await this.deps.vault.delete(this.refForKind(kind));
    this.coordinatorFactory.reset();
    if (kind === "s3AccessKeyId" || kind === "s3SecretAccessKey") {
      this.lastStoreHealth = null;
      this.lastCapability = null;
    }
    this.lastReadyFingerprint = null;
    this.deps.onSyncMaterialsChanged?.();
  }

  /** Report which secrets are present (never their values). */
  async secretsPresent(): Promise<SyncDiagnostics["secretsPresent"]> {
    const c = this.cfg();
    const [kp, ak, sk] = await Promise.all([
      this.deps.vault.has(c.kopiaPasswordRef),
      this.deps.vault.has(c.s3AccessKeyIdRef),
      this.deps.vault.has(c.s3SecretAccessKeyRef),
    ]);
    return {
      kopiaPassword: kp,
      s3AccessKeyId: ak,
      s3SecretAccessKey: sk,
    };
  }

  private refForKind(kind: SecretKind): string {
    const c = this.cfg();
    switch (kind) {
      case "kopiaPassword":
        return c.kopiaPasswordRef;
      case "s3AccessKeyId":
        return c.s3AccessKeyIdRef;
      case "s3SecretAccessKey":
        return c.s3SecretAccessKeyRef;
    }
  }

  /**
   * Test storage coordination: probe store reachability, then run a FORCED
   * conditional-write capability probe, and report whether conditional writes
   * are supported. Refreshes the cached health/capability values for
   * diagnostics. Never throws for a probe failure — it reports it.
   */
  async testStorageCoordination(
    opts: { scheduleBootstrap?: boolean } = {},
  ): Promise<StorageTestResult> {
    this.requireGlobalEnabled();
    // The repository password is deliberately excluded: this test validates
    // S3 only and must not require or even read backup-encryption material.
    const secrets = await this.storageSecretValuesForRedaction();
    let coordinator: Coordinator;
    try {
      coordinator = await this.coordinator();
    } catch (err) {
      // No bucket / missing credentials → surface as an unhealthy, unsupported
      // result rather than throwing across IPC. Preserve structured SyncError
      // messages instead of degrading them to "[object Object]".
      this.lastStoreHealth = false;
      this.lastCapability = { ok: false, failedCheck: "unconfigured" };
      const result: StorageTestResult = {
        healthy: false,
        capability: {
          ok: false,
          failedCheck: "unconfigured",
          message: redact(describeStorageError(err), secrets),
        },
        conditionalWritesSupported: false,
      };
      this.logStorageTestFailure(result);
      return result;
    }

    let healthy: boolean;
    let probe: Awaited<ReturnType<Coordinator["capabilityProbe"]>>;
    try {
      healthy = await coordinator.health();
      probe = await coordinator.capabilityProbe(true);
    } catch (err) {
      // Capability probes normally return a failed result. This fallback keeps
      // unexpected provider/SDK failures useful in both UI and terminal.
      this.lastStoreHealth = false;
      this.lastCapability = { ok: false, failedCheck: "probe-error" };
      const result: StorageTestResult = {
        healthy: false,
        capability: {
          ok: false,
          failedCheck: "probe-error",
          message: redact(describeStorageError(err), secrets),
        },
        conditionalWritesSupported: false,
      };
      this.logStorageTestFailure(result);
      return result;
    }

    this.lastStoreHealth = healthy;
    this.lastCapability = { ok: probe.ok, failedCheck: probe.failedCheck ?? null };
    const result: StorageTestResult = {
      healthy,
      capability: {
        ok: probe.ok,
        failedCheck: probe.failedCheck ?? null,
        message: probe.message ? redact(probe.message, secrets) : null,
      },
      conditionalWritesSupported: healthy && probe.ok,
    };
    if (!result.conditionalWritesSupported) this.logStorageTestFailure(result);
    // A successful probe can be the last input that flips Cloud Sync readiness
    // (bucket + credentials + password were already present). Fire-and-forget a
    // single-flight whole-library bootstrap; it no-ops when still not ready.
    if (result.conditionalWritesSupported && opts.scheduleBootstrap !== false) {
      void this.maybeBootstrap().catch(() => undefined);
    }
    return result;
  }

  /** Log only non-secret connection context so terminal failures are actionable. */
  private logStorageTestFailure(result: StorageTestResult): void {
    const c = this.cfg();
    (this.deps.logger ?? console).error("[Cloud Sync] S3 connection test failed", {
      endpoint: safeStorageEndpoint(c.s3Endpoint),
      region: c.s3Region || "(default)",
      bucket: c.s3Bucket,
      controlPrefix: c.controlPrefix,
      healthy: result.healthy,
      failedCheck: result.capability.failedCheck,
      message: result.capability.message,
    });
  }

  /** Log sanitized Kopia context so packaged-build failures are diagnosable. */
  private logKopiaFailure(
    profileId: string,
    stage: string,
    err: unknown,
    secrets: readonly (string | null)[],
  ): void {
    const c = this.cfg();
    const target = this.repoTarget();
    const result = (err as { result?: Record<string, unknown> } | null)?.result;
    (this.deps.logger ?? console).error("[Cloud Sync] Kopia operation failed", {
      stage,
      profileId,
      deviceId: c.deviceId,
      kopiaBinary: resolveKopiaBinary({
        overridePath: c.kopiaBinPath,
        resourcesPath: this.deps.resourcesPath,
      }),
      kopiaConfig: c.kopiaConfigPath.trim() || this.deps.kopiaConfigDefault,
      pinnedVersion: KOPIA_PINNED_VERSION,
      target: {
        bucket: c.s3Bucket,
        endpoint: target.endpoint ?? "(AWS default)",
        disableTls: target.disableTls === true,
        region: c.s3Region || "(default)",
        prefix: target.prefix ?? DEFAULT_KOPIA_PREFIX,
      },
      error: redactError(err, secrets),
      exitCode: typeof result?.code === "number" ? result.code : null,
      signal: typeof result?.signal === "string" ? result.signal : null,
      timedOut: result?.timedOut === true,
      stderr: typeof result?.stderr === "string" ? redact(result.stderr, secrets) : undefined,
      stdout: typeof result?.stdout === "string" ? redact(result.stdout, secrets) : undefined,
    });
  }

  async diagnostics(): Promise<SyncDiagnostics> {
    const c = this.cfg();
    const kopiaBin = resolveKopiaBinary({
      overridePath: c.kopiaBinPath,
      resourcesPath: this.deps.resourcesPath,
    });
    return {
      enabled: c.enabled,
      configured: Boolean(c.s3Bucket.trim()),
      secretsPresent: await this.secretsPresent(),
      storeHealthy: this.lastStoreHealth,
      capability: this.lastCapability,
      bucket: c.s3Bucket,
      controlPrefix: c.controlPrefix,
      deviceId: c.deviceId,
      deviceDisplayName: c.deviceDisplayName,
      kopiaBinPath: kopiaBin,
    };
  }

  /**
   * Build a fully-sanitized diagnostics bundle safe to export to disk / share.
   *
   * Hard guarantees (see also the canary redaction tests):
   *   - NO vault contents, repository password, or S3 secret/access keys appear
   *     anywhere.
   *   - NO SDK/client credentials leak (the coordinator/store never expose them,
   *     and this bundle carries only bucket/endpoint/region/prefixes + presence).
   *   - Any journal message is passed through {@link redact} against the live
   *     secret set as defense-in-depth, even though messages are already
   *     redacted at write time.
   *
   * `profileId` limits the export to a single profile; otherwise every
   * sync-enabled profile is included. Coordination owner/lease state is fetched
   * best-effort and omitted (null) on any failure — a diagnostics export must
   * never throw just because the store is unreachable.
   */
  async exportDiagnostics(profileId?: string): Promise<SyncDiagnosticsExport> {
    const c = this.cfg();
    const app = await this.diagnostics();
    const secrets = await this.secretValuesForRedaction();
    const binExists = this.deps.binExists ?? existsSync;
    const kopiaBinPresent = binExists(app.kopiaBinPath);

    const [hasAccessKey, hasSecretKey] = await Promise.all([
      this.deps.vault.has(c.s3AccessKeyIdRef),
      this.deps.vault.has(c.s3SecretAccessKeyRef),
    ]);

    const ids = profileId ? [profileId] : this.syncEnabledProfileIds();
    const profiles: ProfileDiagnosticsView[] = [];
    for (const id of ids) {
      profiles.push(await this.profileDiagnostics(id, secrets));
    }

    return {
      generatedAt: new Date().toISOString(),
      appVersion: this.deps.appVersion ?? "unknown",
      platform: this.deps.platform ?? process.platform,
      arch: this.deps.arch ?? process.arch,
      kopiaPinnedVersion: KOPIA_PINNED_VERSION,
      kopiaBinPresent,
      app,
      storage: {
        bucket: c.s3Bucket,
        // Report the normalized origin used by the coordinator and used to
        // derive Kopia's host-only endpoint. This stays useful for legacy
        // path-bearing settings without exposing userinfo or query values.
        endpoint: this.safeEffectiveEndpoint(c.s3Endpoint),
        region: c.s3Region,
        controlPrefix: c.controlPrefix,
        kopiaPrefix: c.s3Prefix || DEFAULT_KOPIA_PREFIX,
        credentialsPresent: hasAccessKey && hasSecretKey,
        healthy: this.lastStoreHealth,
        capability: this.lastCapability,
        lastError: this.lastSyncError ? redact(this.lastSyncError, secrets) : null,
      },
      profiles,
    };
  }

  /** Ids of every sync-enabled profile (best-effort; empty if PM lacks a lister). */
  private syncEnabledProfileIds(): string[] {
    const pm = this.deps.profileManager as unknown as {
      list?: () => Array<{ id: string }>;
    };
    const all = typeof pm.list === "function" ? pm.list() : [];
    return all
      .map((p) => p.id)
      .filter((id) => this.deps.profileManager.getSyncState(id)?.syncEnabled === true);
  }

  /** Build one profile's sanitized diagnostics slice. */
  private async profileDiagnostics(
    profileId: string,
    secrets: (string | null)[],
  ): Promise<ProfileDiagnosticsView> {
    const s = this.deps.profileManager.getSyncState(profileId);
    const held = this.leases.get(profileId);

    // Best-effort coordination owner/lease state (never throws, never carries secrets).
    let owner: ProfileDiagnosticsView["owner"] = null;
    if (s?.syncEnabled && this.cfg().s3Bucket.trim()) {
      try {
        const coordinator = await this.coordinator();
        const res = await coordinator.getState(profileId);
        if (res.kind === "state") {
          owner = {
            ownerDeviceId: res.state.ownerDeviceId,
            leaseExpiresAt: res.state.leaseExpiresAt,
            currentRevision: res.state.currentRevision,
            latestSnapshotId: res.state.latestSnapshotId,
            fencingToken: res.state.fencingToken,
          };
        }
      } catch {
        owner = null;
      }
    }

    // Newest journal entry, message re-redacted defensively.
    let lastOperation: SyncOperationView | null = null;
    const pm = this.deps.profileManager as unknown as {
      listSyncOperations?: (id: string, limit?: number) => SyncOperationView[];
    };
    if (typeof pm.listSyncOperations === "function") {
      const ops = pm.listSyncOperations(profileId, 1);
      const op = ops[0];
      if (op) {
        lastOperation = {
          id: op.id,
          kind: op.kind,
          status: op.status,
          fromRevision: op.fromRevision,
          toRevision: op.toRevision,
          snapshotId: op.snapshotId,
          message: op.message ? redact(op.message, secrets) : null,
          createdAt: op.createdAt,
          updatedAt: op.updatedAt,
        };
      }
    }

    return {
      profileId,
      syncEnabled: s?.syncEnabled ?? false,
      dirty: s?.dirty ?? false,
      localRevision: s?.localRevision ?? 0,
      baseRevision: s?.baseRevision ?? 0,
      remoteRevision: s?.remoteRevision ?? 0,
      latestSnapshotId: s?.latestSnapshotId ?? null,
      lastSyncedAt: s?.lastSyncedAt ?? null,
      hasLease: held !== undefined && held.expiresAtMs > Date.now(),
      localLeaseExpiresAt: held?.expiresAtMs ?? null,
      running: this.deps.driver.isRunning(profileId),
      owner,
      lastOperation,
    };
  }

  // ── Per-profile enable/disable + status ──────────────────────────────────

  enable(profileId: string, enabled: boolean): ProfileSyncStatusView {
    const profile = this.deps.profileManager.get(profileId);
    if (!profile) throw syncError(SyncErrorCode.InvalidInput, "profile not found", { profileId });
    // Enabling per-profile sync couples the profile to cloud coordination, so
    // it requires the master switch to be on. Disabling stays available so a
    // user can always decouple a profile even while Cloud Sync is globally off.
    if (enabled) this.requireGlobalEnabled();
    this.deps.profileManager.upsertSyncState({ profileId, syncEnabled: enabled });
    return this.status(profileId);
  }

  status(profileId: string): ProfileSyncStatusView {
    const s = this.deps.profileManager.getSyncState(profileId);
    const held = this.leases.get(profileId);
    return {
      profileId,
      globalEnabled: this.cfg().enabled,
      syncEnabled: s?.syncEnabled ?? false,
      dirty: s?.dirty ?? false,
      localRevision: s?.localRevision ?? 0,
      baseRevision: s?.baseRevision ?? 0,
      remoteRevision: s?.remoteRevision ?? 0,
      latestSnapshotId: s?.latestSnapshotId ?? null,
      lastSyncedAt: s?.lastSyncedAt ?? null,
      hasLease: held !== undefined && held.expiresAtMs > Date.now(),
      leaseExpiresAt: held?.expiresAtMs ?? null,
      running: this.deps.driver.isRunning(profileId),
    };
  }

  /** Conservatively mark a sync-enabled profile dirty (before writable launch). */
  markDirty(profileId: string): void {
    const s = this.deps.profileManager.getSyncState(profileId);
    if (!s?.syncEnabled) return;
    if (!s.dirty) this.deps.profileManager.markSyncDirty(profileId, true);
  }

  // ── Launch gate ──────────────────────────────────────────────────────────

  /**
   * Called before a launch. For unsynced profiles this is a no-op (returns
   * `allow`). For synced profiles it fetches remote state and applies the
   * sync-core launch decision:
   *   - `launch`             → allow (local current or only-local-dirty)
   *   - `restore-then-launch`→ restore latest, then allow
   *   - `conflict`           → refuse; the user must resolve (Restore w/ keep-local)
   *   - `blocked`            → refuse with the structured error
   *
   * Marks the profile dirty on allow (writable launch coming).
   */
  async beforeLaunch(profileId: string): Promise<void> {
    return this.withProfile(profileId, () => this.prepareLaunch(profileId));
  }

  private async prepareLaunch(profileId: string): Promise<void> {
    // The profile queue has drained any preceding close backup.
    const s = this.deps.profileManager.getSyncState(profileId);
    if (!s?.syncEnabled) return;

    // Global master switch off: Cloud Sync is fully decoupled. Allow the local
    // browser to launch WITHOUT requiring a lease or contacting storage. But
    // conservatively mark a sync-enabled profile dirty so that re-enabling
    // Cloud Sync later can never silently overwrite the local changes made
    // while the feature was off.
    if (!this.cfg().enabled) {
      this.markDirty(profileId);
      return;
    }

    // Single-writer invariant: a writable launch of a synced profile REQUIRES
    // an owned, unexpired in-memory lease. In the normal lifecycle the operator
    // no longer presses "Acquire" — beforeLaunch auto-acquires when this device
    // does not already hold an unexpired lease. acquire() fails closed against
    // an active peer lease (never steals it), so a profile currently open on
    // another device surfaces the peer-held error rather than a silent takeover.
    await this.ensureLeaseForLaunch(profileId);

    const remote = await this.fetchRemoteRevision(profileId);

    const decision = decideLaunch(
      {
        profileId,
        syncEnabled: s.syncEnabled,
        localRevision: s.localRevision,
        baseRevision: s.baseRevision,
        remoteRevision: remote.revision,
        dirty: s.dirty,
        latestSnapshotId: s.latestSnapshotId,
        lastSyncedAt: s.lastSyncedAt,
      },
      remote.revision,
    );

    // Persist best-known remote revision.
    this.deps.profileManager.updateSyncState(profileId, { remoteRevision: remote.revision });

    switch (decision.action) {
      case "launch":
        this.markDirty(profileId);
        return;
      case "restore-then-launch":
        // Keep-local is safe here: decideLaunch only returns this action when
        // the profile is NOT dirty, so there is no local state to preserve.
        await this.restoreInternal(profileId, { keepLocalAsConflict: false });
        this.markDirty(profileId);
        return;
      case "conflict":
        throw syncError(
          SyncErrorCode.ConflictDetected,
          "Local and remote diverged — resolve the conflict before launching",
          { baseRevision: decision.baseRevision, remoteRevision: decision.remoteRevision },
        );
      case "blocked":
        throw decision.error;
    }
  }

  /**
   * Assert this device currently owns an unexpired in-memory lease for the
   * profile. Missing lease → deterministic {@link SyncErrorCode.LeaseHeldByOther}.
   * Expired lease → {@link SyncErrorCode.LeaseExpired} and the stale lease is
   * dropped (its renew timer cleared) so it can never be reused. Returns the
   * validated lease on success.
   */
  private requireOwnedLease(profileId: string): HeldLease {
    const held = this.leases.get(profileId);
    if (!held) {
      throw syncError(
        SyncErrorCode.LeaseHeldByOther,
        "Acquire a lease before launching this synced profile",
        { profileId },
      );
    }
    if (held.expiresAtMs <= Date.now()) {
      this.dropLease(profileId);
      throw syncError(
        SyncErrorCode.LeaseExpired,
        "The lease for this synced profile has expired — acquire it again",
        { profileId },
      );
    }
    return held;
  }

  /**
   * Ensure this device holds an unexpired lease for the profile before a
   * writable launch, auto-acquiring one if needed. This is the normal-lifecycle
   * replacement for a manual "Acquire lease" button: if a valid lease is already
   * held it is reused; a stale (expired) held lease is dropped and re-acquired;
   * otherwise a fresh lease is acquired. `acquire` fails closed when another
   * device holds an active lease (fencing), so this never steals a peer's lease
   * — the peer-held error propagates to the caller. The acquired lease stays
   * held while the browser is open (the after-close backup releases it).
   */
  private async ensureLeaseForLaunch(profileId: string): Promise<void> {
    const held = this.leases.get(profileId);
    if (held && held.expiresAtMs > Date.now()) return; // already own a valid lease
    if (held) this.dropLease(profileId); // stale — drop before re-acquiring
    await this.acquireInternal(profileId);
  }

  // ── Coordination: acquire / renew / release ──────────────────────────────

  private async fetchRemoteRevision(
    profileId: string,
  ): Promise<{ revision: number; latestSnapshotId: string | null }> {
    const coordinator = await this.coordinator();
    const res = await coordinator.getState(profileId);
    if (res.kind === "not-found") {
      return { revision: NO_REVISION, latestSnapshotId: null };
    }
    return {
      revision: res.state.currentRevision,
      latestSnapshotId: res.state.latestSnapshotId,
    };
  }

  async acquire(profileId: string): Promise<ProfileSyncStatusView> {
    return this.withProfile(profileId, () => this.acquireInternal(profileId));
  }

  private async acquireInternal(profileId: string): Promise<ProfileSyncStatusView> {
    await this.requireEnabled(profileId);
    const coordinator = await this.coordinator();
    this.emit({ profileId, phase: "acquiring", message: "Acquiring lease…" });
    const result = await coordinator.acquire(profileId, this.newOperationId());
    this.installLease(profileId, {
      leaseId: result.lease.leaseId,
      fencingToken: result.lease.fencingToken,
      expiresAtMs: result.lease.leaseExpiresAt,
      renewalMs: result.lease.recommendedRenewalMs,
    });
    // Record best-known remote revision from acquire's state.
    this.deps.profileManager.updateSyncState(profileId, {
      remoteRevision: result.state.currentRevision,
    });
    this.emit({ profileId, phase: "done", message: "Lease acquired" });
    return this.status(profileId);
  }

  async release(profileId: string): Promise<ProfileSyncStatusView> {
    return this.withProfile(profileId, () => this.releaseInternal(profileId));
  }

  private async releaseInternal(profileId: string): Promise<ProfileSyncStatusView> {
    // Refuse if Chromium still running under this lease.
    if (this.deps.driver.isRunning(profileId)) {
      throw syncError(
        SyncErrorCode.BrowserStillRunning,
        "Close the browser before releasing the lease",
        { profileId },
      );
    }
    const held = this.leases.get(profileId);
    if (!held) return this.status(profileId);
    const coordinator = await this.coordinator();
    this.emit({ profileId, phase: "releasing", message: "Releasing lease…" });
    try {
      await coordinator.release(profileId, held.leaseId, held.fencingToken, this.newOperationId());
    } finally {
      this.dropLease(profileId);
    }
    this.emit({ profileId, phase: "done", message: "Lease released" });
    return this.status(profileId);
  }

  private installLease(
    profileId: string,
    lease: { leaseId: string; fencingToken: number; expiresAtMs: number; renewalMs: number },
  ): void {
    this.dropLease(profileId);
    const renewMs = Math.max(3_000, lease.renewalMs);
    const timer = setInterval(() => {
      void this.renewLease(profileId);
    }, renewMs);
    if (typeof timer.unref === "function") timer.unref();
    this.leases.set(profileId, {
      profileId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expiresAtMs: lease.expiresAtMs,
      renewTimer: timer,
      browserOpen: false,
    });
  }

  private dropLease(profileId: string): void {
    const held = this.leases.get(profileId);
    if (!held) return;
    clearInterval(held.renewTimer);
    this.leases.delete(profileId);
  }

  private async renewLease(profileId: string): Promise<void> {
    const held = this.leases.get(profileId);
    if (!held || this.renewals.has(held)) return;
    this.renewals.add(held);
    const token = held.fencingToken;
    try {
      const coordinator = await this.coordinator();
      const result = await coordinator.renew(
        profileId,
        held.leaseId,
        held.fencingToken,
        this.newOperationId(),
      );
      if (this.leases.get(profileId) !== held || held.fencingToken !== token) return;
      held.expiresAtMs = result.lease.leaseExpiresAt;
      held.fencingToken = result.lease.fencingToken;
    } catch (err) {
      // Lease renewal lost: conservatively close any owned synced browser and
      // invalidate the lease so a stale owner can't publish.
      if (this.leases.get(profileId) === held && held.fencingToken === token)
        await this.onLeaseLost(profileId, err);
    } finally {
      this.renewals.delete(held);
    }
  }

  /** Invoked on renewal loss or power suspend. Closes owned synced browsers. */
  async onLeaseLost(profileId: string, err?: unknown): Promise<void> {
    const held = this.leases.get(profileId);
    if (!held) return;
    this.dropLease(profileId);
    if (this.deps.driver.isRunning(profileId)) {
      await this.deps.driver.close(profileId).catch(() => {});
    }
    const secrets = await this.secretValuesForRedaction();
    this.emit({
      profileId,
      phase: "error",
      message: err
        ? redact(`Lease lost: ${redactError(err, secrets)}`, secrets)
        : "Lease lost; browser closed",
    });
  }

  /** On OS power suspend/resume, drop all leases and close owned synced browsers. */
  async onPowerSuspend(): Promise<void> {
    this.pauses++;
    try {
      for (const id of [...this.leases.keys()]) await this.onLeaseLost(id);
      await Promise.allSettled([...this.profileJobs.values()]);
      for (const id of [...this.leases.keys()]) await this.onLeaseLost(id);
    } finally {
      this.pauses--;
    }
  }

  // ── Backup + publish ─────────────────────────────────────────────────────

  /**
   * Snapshot the profile's data dir and publish a new revision. Requires:
   *   - sync enabled, profile clean-or-dirty (dirty is the normal case),
   *   - browser NOT running,
   *   - an owned, unexpired lease.
   * Only clears `dirty` after the backend accepts the commit.
   *
   * Public entrypoint (manual "Back up now"): if a close-triggered auto backup
   * for this profile is already in flight, JOIN it instead of racing a second
   * snapshot/publish, then return the resulting status. Otherwise run a fresh
   * backup. The internal core is called directly by the auto path to avoid a
   * self-join deadlock.
   */
  async backupAndPublish(profileId: string): Promise<ProfileSyncStatusView> {
    if (this.autoBackups.has(profileId)) {
      // Join the auto backup (its promise never rejects) then report status.
      // If the auto backup failed, dirty is still set and the caller sees it.
      await this.waitForAutoBackup(profileId);
      return this.status(profileId);
    }
    return this.withProfile(profileId, () => this.backupAndPublishInternal(profileId));
  }

  private async backupAndPublishInternal(profileId: string): Promise<ProfileSyncStatusView> {
    const profile = await this.requireEnabled(profileId);
    if (this.deps.driver.isRunning(profileId)) {
      throw syncError(SyncErrorCode.BrowserStillRunning, "Close the browser before backing up", {
        profileId,
      });
    }
    const held = this.leases.get(profileId);
    if (!held || held.expiresAtMs <= Date.now()) {
      throw syncError(SyncErrorCode.LeaseHeldByOther, "Acquire a lease before publishing", {
        profileId,
      });
    }

    const state = this.deps.profileManager.getSyncState(profileId);
    const op = this.deps.profileManager.recordSyncOperation({
      profileId,
      kind: "publish",
      status: "running",
      fromRevision: state?.baseRevision ?? 0,
    });
    const secrets = await this.secretValuesForRedaction();
    try {
      // Write the sanitized manifest next to the profile data.
      await this.writeManifest(profile);

      const kopia = await this.makeKopiaFor(profileId, "backing up");
      // First Backup & Publish auto-creates the encrypted repository if it does
      // not yet exist in the configured storage; subsequent backups just
      // connect. ensureRepository leaves this device connected either way.
      this.emit({
        profileId,
        phase: "snapshotting",
        message: "Preparing encrypted storage…",
      });
      const repoTarget = this.repoTarget();
      try {
        await kopia.ensureRepository(repoTarget);
      } catch (err) {
        // Defensive first-run fallback: the adapter normally handles this,
        // but an exact uninitialized-storage result must not strand a fresh
        // bucket if it escapes through an integration/runtime boundary.
        if (!isUninitializedKopiaRepositoryError(err)) throw err;
        await kopia.createRepository(repoTarget);
      }
      this.emit({ profileId, phase: "snapshotting", message: "Creating snapshot…" });
      // Validated, non-secret correlation tags on the snapshot. Values are
      // constrained to [A-Za-z0-9._-] by the adapter (validateTags); we sanitize
      // here too so a stray character can't reject the whole backup. baseRevision
      // is stringified; operationId reuses the journal op id.
      const snapshotJson = await kopia.snapshot(profileId, profile.dataDir, {
        profileId: sanitizeTagValue(profileId),
        deviceId: sanitizeTagValue(this.cfg().deviceId),
        baseRevision: String(state?.baseRevision ?? 0),
        operationId: sanitizeTagValue(op.id),
      });
      const snapshotId = extractSnapshotId(snapshotJson);
      if (!snapshotId) {
        throw syncError(SyncErrorCode.SnapshotIntegrityFailed, "could not extract snapshot id");
      }

      // Publish with expectedRevision + fencing token.
      const coordinator = await this.coordinator();
      const remoteState = await coordinator.getState(profileId);
      const remote =
        remoteState.kind === "not-found"
          ? { revision: NO_REVISION, latestSnapshotId: null as string | null }
          : {
              revision: remoteState.state.currentRevision,
              latestSnapshotId: remoteState.state.latestSnapshotId,
            };

      // Enforce the "never merge / on divergence keep both" invariant on the
      // direct Backup&Publish path (not just the launch gate): if the remote
      // advanced past this device's base, refuse and let the user resolve via
      // "Restore & keep local as conflict copy". Uses the same pure policy the
      // launch/close paths use (unit-tested in sync-core).
      const decision = decidePublish(
        {
          profileId,
          syncEnabled: state?.syncEnabled ?? true,
          localRevision: state?.localRevision ?? 0,
          baseRevision: state?.baseRevision ?? 0,
          remoteRevision: remote.revision,
          dirty: state?.dirty ?? false,
          latestSnapshotId: state?.latestSnapshotId ?? null,
          lastSyncedAt: state?.lastSyncedAt ?? null,
        },
        remote.revision,
        {
          browserExited: !this.deps.driver.isRunning(profileId),
          lease: {
            profileId,
            ownerDeviceId: this.cfg().deviceId,
            expiresAtMs: held.expiresAtMs,
            fencingToken: held.fencingToken,
          },
          nowMs: Date.now(),
          deviceId: this.cfg().deviceId,
        },
      );
      if (decision.action === "blocked") throw decision.error;

      this.emit({ profileId, phase: "publishing", message: "Publishing revision…" });
      const published = await coordinator.publish(profileId, {
        leaseId: held.leaseId,
        fencingToken: held.fencingToken,
        operationId: this.newOperationId(),
        // CAS anchor is this device's base revision — a concurrent peer publish
        // surfaces as REVISION_CONFLICT instead of silently fast-forwarding.
        expectedRevision: state?.baseRevision ?? 0,
        latestSnapshotId: snapshotId,
      });

      // Only NOW clear dirty — the commit is accepted.
      this.deps.profileManager.updateSyncState(profileId, {
        dirty: false,
        localRevision: published.revision,
        baseRevision: published.revision,
        remoteRevision: published.revision,
        latestSnapshotId: snapshotId,
        lastSyncedAt: new Date().toISOString(),
      });
      this.deps.profileManager.updateSyncOperation(op.id, {
        status: "succeeded",
        toRevision: published.revision,
        snapshotId,
      });
      this.emit({ profileId, phase: "done", message: `Published revision ${published.revision}` });
      return this.status(profileId);
    } catch (err) {
      this.deps.profileManager.updateSyncOperation(op.id, {
        status: "failed",
        message: redactError(err, secrets),
      });
      this.logKopiaFailure(profileId, "backup/publish", err, secrets);
      this.emit({ profileId, phase: "error", message: redactError(err, secrets) });
      throw normalizeError(err);
    }
  }

  // ── Automatic backup after browser close ──────────────────────────────────

  /**
   * Invoked by the main process from `browserDriver.on('running-changed')` ONLY
   * for `{ kind: 'closed' }` events (both a planned Stop and an external
   * window/⌘Q exit reach this event; `closing` does NOT). Starts a backup
   * automatically — the normal workflow no longer needs a manual "Back up now".
   *
   * Guarded so a close is a strict no-op (never contacts Kopia/storage) unless
   * EVERY precondition holds:
   *   - the controller is not disposed and auto backup is not suppressed
   *     (suppression means {@link stopCoordination} is already releasing leases
   *     for a global disable),
   *   - global Cloud Sync is enabled,
   *   - per-profile sync is enabled,
   *   - the profile is dirty (nothing to publish otherwise),
   *   - this device holds an unexpired in-memory lease (a lease-loss /
   *     power-suspend close drops the lease BEFORE closing, so those correctly
   *     skip here), and
   *   - the browser is no longer running.
   *
   * Deduplicates per-profile: a second close event while a backup is in flight
   * joins the existing one instead of starting a second snapshot/publish. The
   * returned promise never rejects (errors are swallowed + logged inside), so
   * the EventEmitter listener can `.catch` defensively without risking an
   * unhandled rejection.
   */
  async onBrowserClosed(profileId: string): Promise<void> {
    if (this.disposed || this.suppressAutoBackup) return;
    if (!this.cfg().enabled) return;
    const s = this.deps.profileManager.getSyncState(profileId);
    if (!s?.syncEnabled) return;
    if (!s.dirty) return;
    const held = this.leases.get(profileId);
    if (!held || held.expiresAtMs <= Date.now()) return;
    // A close event can fire before the process is fully reaped; only back up
    // once the browser is truly gone so quiescence/fencing hold.
    if (this.deps.driver.isRunning(profileId)) return;

    // Deduplicate: join an in-flight auto backup rather than double-publishing.
    const existing = this.autoBackups.get(profileId);
    if (existing) return existing;

    const task = this.withProfile(
      profileId,
      async () => {
        const current = this.deps.profileManager.getSyncState(profileId);
        if (!current?.syncEnabled || !current.dirty || this.deps.driver.isRunning(profileId))
          return;
        if (this.leases.get(profileId) !== held || held.expiresAtMs <= Date.now()) return;
        await this.runAutoBackup(profileId);
      },
      true,
    ).finally(() => {
      // Only clear if we are still the current in-flight entry for this id.
      if (this.autoBackups.get(profileId) === task) {
        this.autoBackups.delete(profileId);
      }
    });
    this.autoBackups.set(profileId, task);
    return task;
  }

  /**
   * The close-triggered auto backup body. Delegates to the SAME
   * {@link backupAndPublishInternal} logic used by the manual path — identical
   * encryption, quiescence, conflict/fencing, dirty, and revision semantics. On
   * success dirty is cleared and the revision advanced by the core, then the
   * lease is auto-released so the profile is free for another device to acquire
   * (the normal lifecycle needs no manual "Release"). Release happens ONLY after
   * a successful publish; on failure dirty AND the lease are preserved so the
   * next launch/close retries. Never steals an active peer lease (it only ever
   * releases a lease this device still owns). Errors are caught here and reduced
   * to a secret-redacted main-process log so the EventEmitter listener never
   * sees a rejection.
   */
  private async runAutoBackup(profileId: string): Promise<void> {
    try {
      await this.backupAndPublishInternal(profileId);
      // Publish accepted (dirty cleared by the core). Auto-release the lease so
      // the profile is no longer owned by this device once it is clean and
      // closed. Best-effort: a release failure must not resurrect dirty or throw.
      await this.releaseAndDropLease(profileId).catch(() => {});
    } catch (err) {
      const secrets = await this.secretValuesForRedaction().catch(() => [] as (string | null)[]);
      // describeStorageError unwraps structured SyncError messages (redactError
      // alone would stringify a plain SyncError object to "[object Object]").
      // The result is then redacted against the live secret set. Dirty + lease
      // are intentionally preserved for a retry on the next launch/close.
      (this.deps.logger ?? console).error(
        "[Cloud Sync] automatic backup after browser close failed",
        {
          profileId,
          message: redact(describeStorageError(err), secrets),
        },
      );
    }
  }

  // ── Restore ──────────────────────────────────────────────────────────────

  /**
   * Restore the latest remote snapshot into same-volume staging and atomically
   * swap it into the profile's data dir, rolling back on failure. When
   * `keepLocalAsConflict` is set and local state is dirty, the current local
   * data is first preserved as a new unsynced conflict-copy profile.
   */
  async restoreLatest(
    profileId: string,
    opts: { keepLocalAsConflict: boolean },
  ): Promise<ProfileSyncStatusView> {
    return this.withProfile(profileId, () => this.restoreInternal(profileId, opts));
  }

  private async restoreInternal(
    profileId: string,
    opts: { keepLocalAsConflict: boolean },
  ): Promise<ProfileSyncStatusView> {
    const profile = await this.requireEnabled(profileId);
    if (this.deps.driver.isRunning(profileId)) {
      throw syncError(SyncErrorCode.BrowserStillRunning, "Close the browser before restoring", {
        profileId,
      });
    }

    // Single-writer invariant: restore mutates local state, so it REQUIRES an
    // owned, unexpired lease. Validated before any remote fetch or filesystem
    // work. Expired leases are dropped and surface deterministically.
    this.requireOwnedLease(profileId);

    const state = this.deps.profileManager.getSyncState(profileId);

    // Never silently overwrite dirty local state. A normal restore
    // (keepLocalAsConflict=false) over a dirty profile would destroy unpushed
    // local edits — refuse it and force the caller to explicitly preserve
    // local as a conflict copy (keepLocalAsConflict=true).
    if (state?.dirty && !opts.keepLocalAsConflict) {
      throw syncError(
        SyncErrorCode.ConflictDetected,
        "Local profile has unpublished changes — restore with keep-local-as-conflict to preserve them",
        { profileId },
      );
    }

    const remote = await this.fetchRemoteRevision(profileId);
    if (remote.revision === NO_REVISION || !remote.latestSnapshotId) {
      throw syncError(SyncErrorCode.RevisionNotFound, "no remote snapshot to restore", {
        profileId,
      });
    }

    const op = this.deps.profileManager.recordSyncOperation({
      profileId,
      kind: "restore",
      status: "running",
      toRevision: remote.revision,
    });
    const secrets = await this.secretValuesForRedaction();

    // Rollback bookkeeping. Populated as the operation progresses so the catch
    // block can undo exactly what was done and no more.
    let stagingDir: string | null = null;
    let backupDir: string | null = null;
    let swapped = false; // live dir has been replaced by staging
    let conflictId: string | null = null; // conflict copy DB row, if created
    const prevState = state ? { ...state } : null;

    try {
      // Preserve divergent dirty local state as a conflict copy first. Track
      // its id so we can roll it back if the canonical restore later fails.
      if (opts.keepLocalAsConflict && state?.dirty) {
        conflictId = await this.preserveConflictCopy(profile, state.baseRevision, remote.revision);
      }

      const kopia = await this.makeKopiaFor(profileId, "restoring");
      await kopia.connect(this.repoTarget());

      // Stage on the same volume as the live dir so the swap is atomic.
      const stamp = Date.now();
      stagingDir = join(dirname(profile.dataDir), `.restore-${profileId}-${stamp}`);
      backupDir = join(dirname(profile.dataDir), `.backup-${profileId}-${stamp}`);
      const sameVol = this.deps.sameVolume ?? sameVolumeSync;
      await fsp.mkdir(stagingDir, { recursive: true });
      if (!sameVol(stagingDir, profile.dataDir)) {
        throw syncError(
          SyncErrorCode.Internal,
          "staging dir is not on the same volume as the profile",
        );
      }

      this.emit({ profileId, phase: "restoring", message: "Restoring snapshot…" });
      await kopia.restore(profileId, remote.latestSnapshotId, stagingDir);

      // Validate the restored manifest BEFORE it becomes the live directory.
      const manifest = await this.readManifestFrom(stagingDir);
      this.validateRestoredManifest(manifest, profileId);

      // Swap staging into the live dir; the previous live dir is retained at
      // backupDir. From here the backup is our rollback anchor and is NOT
      // deleted until BOTH the swap and the local DB update succeed.
      await atomicSwap({ stagingDir, liveDir: profile.dataDir, backupDir });
      swapped = true;
      // Staging no longer exists (renamed into live) — nothing to clean there.
      stagingDir = null;

      // Local sync DB update. If this throws, the catch block restores the
      // original live dir from backup so the profile is left byte-identical.
      this.deps.profileManager.updateSyncState(profileId, {
        dirty: false,
        localRevision: remote.revision,
        baseRevision: remote.revision,
        remoteRevision: remote.revision,
        latestSnapshotId: remote.latestSnapshotId,
        lastSyncedAt: new Date().toISOString(),
      });

      // BOTH the swap and DB update succeeded → the operation is durable.
      // Only now discard the backup (best-effort).
      if (backupDir) await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
      backupDir = null;

      this.deps.profileManager.updateSyncOperation(op.id, {
        status: "succeeded",
        snapshotId: remote.latestSnapshotId,
      });
      this.emit({ profileId, phase: "done", message: `Restored revision ${remote.revision}` });
      return this.status(profileId);
    } catch (err) {
      // ── Full rollback: leave on-disk data and the DB/profile set unchanged.
      // 1) If we swapped, restore the original live dir from backup.
      if (swapped && backupDir) {
        try {
          await fsp.rm(profile.dataDir, { recursive: true, force: true }).catch(() => {});
          await fsp.rename(backupDir, profile.dataDir);
          backupDir = null;
        } catch {
          // If restore-from-backup fails the original data still lives at
          // backupDir; surface it rather than silently discarding it.
        }
        // Revert the local sync-state row to its pre-restore values (in case
        // the DB update partially applied before failing).
        if (prevState) {
          this.deps.profileManager.updateSyncState(profileId, {
            dirty: prevState.dirty,
            localRevision: prevState.localRevision,
            baseRevision: prevState.baseRevision,
            remoteRevision: prevState.remoteRevision,
            latestSnapshotId: prevState.latestSnapshotId,
            lastSyncedAt: prevState.lastSyncedAt,
          });
        }
      }
      // 2) Delete any conflict copy we created so the whole op rolls back.
      if (conflictId) {
        try {
          this.deps.profileManager.delete(conflictId);
        } catch {
          /* best-effort */
        }
      }
      // 3) Always clean staging (unless it was renamed into live already).
      if (stagingDir) {
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      }

      this.deps.profileManager.updateSyncOperation(op.id, {
        status: "failed",
        message: redactError(err, secrets),
      });
      this.logKopiaFailure(profileId, "restore", err, secrets);
      this.emit({ profileId, phase: "error", message: redactError(err, secrets) });
      throw normalizeError(err);
    }
  }

  /**
   * Connect an existing remote profile (by its sync id) to this device.
   * Restores the latest snapshot into a fresh profile whose metadata comes
   * from the sanitized manifest, then inserts it via `insertImported`.
   *
   * Advanced/fallback entrypoint: the normal path is the whole-library
   * bootstrap ({@link bootstrapLibrary}), which restores every missing profile
   * automatically. This remains for manually pulling a single id. It uses a
   * TEMPORARY lease — acquired before the restore and released after — so it
   * never leaves this device holding a lease for a profile it is not actively
   * editing (the normal lifecycle re-acquires on launch).
   */
  async connectExisting(profileId: string): Promise<{ profileId: string }> {
    this.requireGlobalEnabled();
    const res = await this.withProfile(profileId, () =>
      this.restoreIntoNewProfile(profileId, { releaseLeaseAfter: true }),
    );
    return { profileId: res.profileId };
  }

  /**
   * Core restore-into-a-fresh-local-profile routine shared by the manual
   * "Connect existing" path and the whole-library bootstrap. Acquires a
   * TEMPORARY coordination lease, restores the latest snapshot into a
   * same-directory staging area, structurally validates the manifest, atomically
   * installs it, inserts the profile row + sync state, journals the restore, and
   * — when `releaseLeaseAfter` is true — releases the lease so bulk restore does
   * not accumulate ownership of every profile. On ANY failure the whole pairing
   * rolls back (staging cleaned, installed dir removed, lease released) and the
   * error is rethrown. Never overwrites an existing local data dir or a local
   * profile with the same id.
   *
   * NEVER steals an active peer lease: `acquire` fails closed via the
   * coordinator's fencing when another device holds an unexpired lease, so this
   * surfaces the peer-held error instead of forcing ownership.
   */
  private async restoreIntoNewProfile(
    profileId: string,
    opts: { releaseLeaseAfter: boolean },
  ): Promise<{ profileId: string; revision: number }> {
    // Path-traversal defense: the profile id becomes a single directory
    // segment under profilesRoot. Reject anything that is not a safe segment
    // BEFORE touching the filesystem, the backend, or the DB.
    assertSafePathSegment(profileId);

    if (this.deps.profileManager.get(profileId)) {
      throw syncError(SyncErrorCode.InvalidInput, "a local profile with that id already exists", {
        profileId,
      });
    }

    const coordinator = await this.coordinator();
    const remoteState = await coordinator.getState(profileId);
    const remote =
      remoteState.kind === "not-found"
        ? { revision: NO_REVISION, latestSnapshotId: null as string | null }
        : {
            revision: remoteState.state.currentRevision,
            latestSnapshotId: remoteState.state.latestSnapshotId,
          };
    if (remote.revision === NO_REVISION || !remote.latestSnapshotId) {
      throw syncError(SyncErrorCode.RevisionNotFound, "no remote snapshot for that id", {
        profileId,
      });
    }

    const secrets = await this.secretValuesForRedaction();
    const dataDir = join(this.deps.profilesRoot, profileId);
    const stagingDir = join(this.deps.profilesRoot, `.connect-${profileId}-${Date.now()}`);

    // Never destroy an unexpected pre-existing final data dir — a stray dir
    // there is not ours to reclaim. Refuse rather than rm -rf it.
    if (existsSync(dataDir)) {
      throw syncError(
        SyncErrorCode.LocalStateCorrupt,
        "target profile data directory already exists on disk — refusing to overwrite",
        { profileId },
      );
    }

    // Acquire the coordination lease BEFORE any download/restore so this device
    // is the single writer for the whole pairing. Install auto-renewal so a long
    // restore can't outlive the lease. acquire() fails closed against an active
    // peer lease (never steals it).
    this.emit({ profileId, phase: "acquiring", message: "Acquiring lease…" });
    const acquired = await coordinator.acquire(profileId, this.newOperationId());
    this.installLease(profileId, {
      leaseId: acquired.lease.leaseId,
      fencingToken: acquired.lease.fencingToken,
      expiresAtMs: acquired.lease.leaseExpiresAt,
      renewalMs: acquired.lease.recommendedRenewalMs,
    });

    // Rollback bookkeeping.
    let installed = false; // staging renamed into final dataDir
    let op: { id: string } | null = null; // journal row, created only after profile row exists

    try {
      const kopia = await this.makeKopiaFor(profileId, "restoring");
      await kopia.connect(this.repoTarget());
      await fsp.mkdir(stagingDir, { recursive: true });
      this.emit({ profileId, phase: "restoring", message: "Restoring snapshot…" });
      await kopia.restore(profileId, remote.latestSnapshotId, stagingDir);

      // Read + structurally validate the sanitized manifest the snapshot
      // carries. Reject malformed/mismatched manifests before final install.
      const manifest = await this.readManifestFrom(stagingDir);
      this.validateRestoredManifest(manifest, profileId);

      // Move staging into the final data dir (fresh install; guarded above so
      // no live dir exists — we never rm the final dir).
      await fsp.rename(stagingDir, dataDir);
      installed = true;

      // Re-materialise the extension list. Profile-scoped extensions live inside
      // the data directory we just restored, so their files are already here.
      // Shared-scope ones reference the device-wide store, which a fresh device
      // may not have; those are reported rather than dropped, so the operator
      // learns which extensions need reinstalling instead of quietly losing them.
      const { extensions: restoredExtensions, missing: missingExtensions } =
        this.reconcileRestoredExtensions(manifest.extensions);
      if (missingExtensions.length > 0) {
        this.emit({
          profileId,
          phase: "restoring",
          message: `Restored, but ${missingExtensions.length} extension${
            missingExtensions.length === 1 ? "" : "s"
          } need reinstalling: ${missingExtensions.join(", ")}`,
        });
      }

      const now = new Date().toISOString();
      const profile: Profile = {
        id: profileId,
        name: manifest.name as string,
        notes: manifest.notes as string | undefined,
        tags: (manifest.tags as string[]) ?? [],
        // Proxy from manifest carries no credentials; user re-enters them.
        proxy: manifestProxyToConfig(manifest.proxy),
        fingerprint: manifest.fingerprint as Profile["fingerprint"],
        extensions: restoredExtensions,
        icon: manifest.icon as string | undefined,
        startUrl: manifest.startUrl as string | undefined,
        searchProvider: manifest.searchProvider as string | undefined,
        engine: (manifest.engine as Profile["engine"]) ?? "cloakbrowser",
        dataDir,
        createdAt: (manifest.createdAt as string) ?? now,
        updatedAt: now,
        proxyCountry: manifest.proxyCountry as string | undefined,
      };

      // Insert the profile row + sync state FIRST. Only after a row exists can
      // we safely journal a sync operation (sync_operations has an FK to
      // profiles(id)); recording earlier would raise a FOREIGN KEY violation.
      this.deps.profileManager.insertImported(profile);
      this.deps.profileManager.upsertSyncState({
        profileId,
        syncEnabled: true,
        localRevision: remote.revision,
        baseRevision: remote.revision,
        remoteRevision: remote.revision,
        dirty: false,
        latestSnapshotId: remote.latestSnapshotId,
        lastSyncedAt: now,
      });

      // Now the row exists → record the successful restore operation.
      op = this.deps.profileManager.recordSyncOperation({
        profileId,
        kind: "restore",
        status: "succeeded",
        toRevision: remote.revision,
        snapshotId: remote.latestSnapshotId,
      });

      // Bulk restore must not hold every profile's lease: release the temporary
      // lease now that the install + DB writes are durable. A subsequent launch
      // re-acquires it. Best-effort — a release failure does not undo a
      // successful restore (the profile is fully installed and clean).
      if (opts.releaseLeaseAfter) {
        await this.releaseAndDropLease(profileId).catch(() => {});
      }

      this.emit({ profileId, phase: "done", message: "Connected existing profile" });
      return { profileId, revision: remote.revision };
    } catch (err) {
      // ── Rollback. Clean staging, remove a newly-installed dir, and release
      // the lease we acquired so no ownership or on-disk data leaks.
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (installed) {
        // Final rename succeeded but DB insert/upsert failed — remove the dir
        // we installed so the whole pairing rolls back atomically.
        await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
      }
      // Best-effort release + drop the acquired lease.
      await this.releaseAndDropLease(profileId).catch(() => {});
      // Journal the failure only if a profile row exists (op set means it did).
      if (op) {
        this.deps.profileManager.updateSyncOperation(op.id, {
          status: "failed",
          message: redactError(err, secrets),
        });
      }
      this.logKopiaFailure(profileId, "connect-existing", err, secrets);
      this.emit({ profileId, phase: "error", message: redactError(err, secrets) });
      throw normalizeError(err);
    }
  }

  /** Best-effort remote release of an owned lease, then drop it locally. */
  private async releaseAndDropLease(profileId: string): Promise<void> {
    const held = this.leases.get(profileId);
    if (!held) return;
    try {
      const coordinator = await this.coordinator();
      await coordinator.release(profileId, held.leaseId, held.fencingToken, this.newOperationId());
    } finally {
      this.dropLease(profileId);
    }
  }

  /**
   * Preserve the current (dirty, divergent) local data as a new UNSYNCED
   * conflict-copy profile before a canonical restore overwrites it. Copies the
   * live data dir into the conflict profile's dataDir with rollback on failure.
   */
  private async preserveConflictCopy(
    source: Profile,
    baseRevision: number,
    remoteRevision: number,
  ): Promise<string> {
    const conflictId = randomUUID();
    const conflictName = conflictCopyName(source.name, this.cfg().deviceDisplayName);
    const conflictDataDir = join(this.deps.profilesRoot, conflictId);
    // Copy live data into the conflict dir first (so the DB row always points
    // at populated data). Roll back the dir on any failure.
    try {
      await fsp.cp(source.dataDir, conflictDataDir, { recursive: true });
    } catch (err) {
      await fsp.rm(conflictDataDir, { recursive: true, force: true }).catch(() => {});
      throw syncError(
        SyncErrorCode.Internal,
        `failed to preserve local state as conflict copy: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      this.deps.profileManager.insertConflictProfile({
        source,
        conflictId,
        conflictName,
        dataDir: conflictDataDir,
        baseRevision,
        remoteRevision,
      });
    } catch (err) {
      // DB insert failed → roll back the copied dir so we don't orphan it.
      await fsp.rm(conflictDataDir, { recursive: true, force: true }).catch(() => {});
      throw normalizeError(err);
    }
    return conflictId;
  }

  // ── Kopia + manifest helpers ─────────────────────────────────────────────

  private async makeKopiaFor(
    _profileId: string,
    purpose: "backing up" | "restoring",
  ): Promise<KopiaAdapter> {
    const c = this.cfg();
    const secrets = await this.loadKopiaSecrets(purpose);
    const configFile = c.kopiaConfigPath.trim() || this.deps.kopiaConfigDefault;
    if (this.deps.makeKopia) return this.deps.makeKopia(secrets, configFile);
    const bin = resolveKopiaBinary({
      overridePath: c.kopiaBinPath,
      resourcesPath: this.deps.resourcesPath,
    });
    const guard = new ProfileQuiescenceGuard({
      driver: this.deps.driver,
      resolveDataDir: (id) => this.deps.profileManager.get(id)?.dataDir ?? null,
    });
    return createKopiaAdapter({ bin, configFile, secrets, guard });
  }

  private async loadKopiaSecrets(purpose: "backing up" | "restoring"): Promise<KopiaSecrets> {
    const c = this.cfg();
    const [password, accessKey, secretKey] = await Promise.all([
      this.deps.vault.get(c.kopiaPasswordRef),
      this.deps.vault.get(c.s3AccessKeyIdRef),
      this.deps.vault.get(c.s3SecretAccessKeyRef),
    ]);
    if (!password) {
      throw syncError(
        SyncErrorCode.InvalidInput,
        `Set an encryption password before ${purpose}. It is not required for the S3 connection test.`,
      );
    }
    return {
      kopiaPassword: password,
      awsAccessKeyId: accessKey ?? undefined,
      awsSecretAccessKey: secretKey ?? undefined,
    };
  }

  private repoTarget() {
    const c = this.cfg();
    // The AWS SDK accepts an origin URL, while Kopia's --endpoint accepts only
    // host[:port]. Derive both from the same validated effective URL, stripping
    // any legacy bucket path and mapping explicit HTTP to Kopia's TLS flag.
    const effectiveEndpoint = this.effectiveEndpoint(c.s3Endpoint);
    const endpointUrl = effectiveEndpoint ? new URL(effectiveEndpoint) : null;
    return {
      kind: "s3" as const,
      bucket: c.s3Bucket,
      endpoint: endpointUrl?.host,
      disableTls: endpointUrl?.protocol === "http:",
      region: c.s3Region || undefined,
      prefix: c.s3Prefix || DEFAULT_KOPIA_PREFIX,
    };
  }

  /**
   * Turn a manifest's extension list back into a profile's extension list.
   *
   * Only allow-listed, structurally valid entries are accepted — a manifest is
   * remote input, so a malformed entry is dropped rather than trusted into the
   * database. Shared-scope entries whose files are not present on this device are
   * returned in `missing` and marked `enabled: false`, because an entry Chromium
   * cannot load would otherwise fail at launch with no explanation.
   */
  private reconcileRestoredExtensions(raw: unknown): {
    extensions: ExtensionConfig[];
    missing: string[];
  } {
    if (!Array.isArray(raw)) return { extensions: [], missing: [] };
    const storeRoot = this.extensionStoreRoot();
    const extensions: ExtensionConfig[] = [];
    const missing: string[] = [];

    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || e.id.length === 0) continue;
      if (typeof e.name !== "string") continue;
      if (typeof e.version !== "string") continue;
      if (e.scope !== "shared" && e.scope !== "profile") continue;
      if (typeof e.dir !== "string") continue;
      if (e.source !== "web-store" && e.source !== "file" && e.source !== "folder") continue;
      // A relative dir is the contract; anything absolute or escaping is refused.
      if (e.dir.length > 0 && (isAbsolute(e.dir) || e.dir.split(/[\\/]/).includes(".."))) {
        continue;
      }

      const present =
        e.scope === "profile"
          ? true // its files came back inside the restored data directory
          : existsSync(storeEntryDir(storeRoot, e.id, e.version));
      if (!present) missing.push(e.name.length > 0 ? e.name : e.id);

      extensions.push({
        id: e.id,
        name: e.name,
        version: e.version,
        enabled: present && e.enabled === true,
        scope: e.scope,
        dir: e.dir,
        source: e.source,
      });
    }
    return { extensions, missing };
  }

  /**
   * Shared extension store root. It is a sibling of `profilesRoot` (both live
   * under `<userData>/data`), so it is derived rather than added as a new
   * dependency every caller would have to thread through.
   */
  private extensionStoreRoot(): string {
    return join(dirname(this.deps.profilesRoot), "extension-store");
  }

  /** Write the sanitized manifest into `<dataDir>/.multizen-sync/profile-manifest.json`. */
  private async writeManifest(profile: Profile): Promise<void> {
    const dir = join(profile.dataDir, ".multizen-sync");
    await fsp.mkdir(dir, { recursive: true });
    // Shared extension code lives outside the snapshotted profile directory.
    // Include a portable copy so another device can load the same selection;
    // Chromium's per-profile extension state is already inside profile.dataDir.
    const extensions: ExtensionConfig[] = [];
    for (const ext of profile.extensions ?? []) {
      if (ext.scope !== "shared") {
        extensions.push(ext);
        continue;
      }
      if (
        !/^[a-p]{32}$/.test(ext.id) ||
        !/^[0-9A-Za-z._-]*$/.test(ext.version) ||
        ext.version === "." ||
        ext.version === ".."
      ) {
        throw syncError(SyncErrorCode.InvalidInput, "invalid shared extension identity");
      }
      const source = storeEntryDir(this.extensionStoreRoot(), ext.id, ext.version);
      if (!existsSync(join(source, "manifest.json"))) {
        throw syncError(SyncErrorCode.LocalStateCorrupt, `extension files missing for ${ext.name}`);
      }
      const relativeDir = join(".multizen-sync", "extensions", ext.id, ext.version || "0");
      const target = join(profile.dataDir, relativeDir);
      if (!existsSync(join(target, "manifest.json"))) {
        await fsp.mkdir(dirname(target), { recursive: true });
        await fsp.cp(source, target, { recursive: true });
      }
      extensions.push({ ...ext, scope: "profile", dir: relativeDir });
    }
    const manifest = assertManifestSafe(
      toManifest({
        id: profile.id,
        name: profile.name,
        notes: profile.notes,
        tags: profile.tags,
        proxy: profile.proxy,
        fingerprint: profile.fingerprint,
        icon: profile.icon,
        startUrl: profile.startUrl,
        searchProvider: profile.searchProvider,
        engine: profile.engine ?? this.deps.getSettings().browserEngine,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        proxyCountry: profile.proxyCountry,
        // Extensions carry no secrets and no absolute paths, so they belong in
        // the portable description. Omitting them silently emptied a restored
        // profile's extension list.
        extensions,
        // dataDir intentionally omitted (absolute path is machine-local).
      }),
    );
    await fsp.writeFile(join(dir, "profile-manifest.json"), JSON.stringify(manifest, null, 2));
  }

  private async readManifestFrom(rootDir: string): Promise<Record<string, unknown>> {
    const p = join(rootDir, ".multizen-sync", "profile-manifest.json");
    if (!existsSync(p)) {
      throw syncError(SyncErrorCode.LocalStateCorrupt, "restored snapshot has no manifest");
    }
    const raw = await fsp.readFile(p, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw syncError(SyncErrorCode.LocalStateCorrupt, "restored manifest is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw syncError(SyncErrorCode.LocalStateCorrupt, "restored manifest is not an object");
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * Structurally validate a restored manifest and re-run {@link assertManifestSafe}
   * before it can seed a real profile. Rejects malformed or mismatched
   * manifests deterministically so a tampered/foreign snapshot can never be
   * installed. Requirements:
   *   - manifestVersion equals the supported {@link MANIFEST_VERSION},
   *   - id EXACTLY equals the requested profileId,
   *   - name is a required non-empty string,
   *   - tags is an array of strings,
   *   - createdAt/updatedAt (when present) are valid ISO timestamps,
   *   - fingerprint is a non-null object,
   *   - no forbidden fields (password/username/dataDir) anywhere.
   */
  private validateRestoredManifest(
    manifest: Record<string, unknown>,
    expectedProfileId: string,
  ): void {
    const fail = (why: string): never => {
      throw syncError(SyncErrorCode.LocalStateCorrupt, `invalid restored manifest: ${why}`, {
        profileId: expectedProfileId,
      });
    };

    if (manifest.manifestVersion !== MANIFEST_VERSION) {
      fail(`unsupported manifestVersion ${String(manifest.manifestVersion)}`);
    }
    if (typeof manifest.id !== "string" || manifest.id !== expectedProfileId) {
      fail(`id does not match requested profile (${String(manifest.id)})`);
    }
    if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) {
      fail("name must be a non-empty string");
    }
    if (!Array.isArray(manifest.tags) || !manifest.tags.every((t) => typeof t === "string")) {
      fail("tags must be an array of strings");
    }
    if (
      manifest.fingerprint === null ||
      typeof manifest.fingerprint !== "object" ||
      Array.isArray(manifest.fingerprint)
    ) {
      fail("fingerprint must be an object");
    }
    for (const key of ["createdAt", "updatedAt"] as const) {
      const v = manifest[key];
      if (v !== undefined) {
        if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
          fail(`${key} must be a valid ISO timestamp`);
        }
      }
    }
    if (
      manifest.engine !== undefined &&
      manifest.engine !== "cloakbrowser" &&
      manifest.engine !== "camoufox"
    ) {
      fail("unsupported browser engine");
    }
    for (const key of ["notes", "icon", "startUrl", "searchProvider", "proxyCountry"] as const) {
      if (manifest[key] !== undefined && typeof manifest[key] !== "string") {
        fail(`${key} must be a string when present`);
      }
    }
    // Defense-in-depth: reject any forbidden/secret-bearing field (mirrors the
    // write-time guarantee and blocks a tampered manifest carrying credentials).
    assertManifestSafe(manifest as unknown as Parameters<typeof assertManifestSafe>[0]);
  }

  // ── Whole-library bootstrap ────────────────────────────────────────────────

  /**
   * Cloud Sync readiness. Whole-library bootstrap only runs when EVERY input is
   * satisfied: the global master switch is on, a bucket is configured, both S3
   * credentials are present, an encryption password is present (required before
   * any snapshot/restore), and the last capability probe reported conditional
   * writes are supported. Readiness is checked without contacting the network
   * (it uses the cached probe result); a caller wanting a fresh probe runs
   * {@link testStorageCoordination} first (that is what a "Sync all" retry does).
   */
  private async isCloudSyncReady(): Promise<boolean> {
    const c = this.cfg();
    if (!c.enabled) return false;
    if (!c.s3Bucket.trim()) return false;
    const [pw, ak, sk] = await Promise.all([
      this.deps.vault.has(c.kopiaPasswordRef),
      this.deps.vault.has(c.s3AccessKeyIdRef),
      this.deps.vault.has(c.s3SecretAccessKeyRef),
    ]);
    if (!pw || !ak || !sk) return false;
    if (this.lastStoreHealth !== true || !(this.lastCapability?.ok ?? false)) return false;
    return true;
  }

  /**
   * A stable fingerprint of the readiness-relevant inputs. Used so a readiness
   * change (bucket set, secret saved, successful probe) re-triggers a bootstrap
   * while a no-op config write (e.g. renaming the device) does not. Never
   * carries a secret value — only presence booleans + the last probe result.
   */
  private async readinessFingerprint(): Promise<string> {
    const c = this.cfg();
    const [pw, ak, sk] = await Promise.all([
      this.deps.vault.has(c.kopiaPasswordRef),
      this.deps.vault.has(c.s3AccessKeyIdRef),
      this.deps.vault.has(c.s3SecretAccessKeyRef),
    ]);
    return JSON.stringify({
      enabled: c.enabled,
      bucket: c.s3Bucket.trim(),
      endpoint: this.safeEffectiveEndpoint(c.s3Endpoint),
      region: c.s3Region,
      controlPrefix: c.controlPrefix,
      s3Prefix: c.s3Prefix,
      pw,
      ak,
      sk,
      capabilityOk: this.lastCapability?.ok ?? false,
    });
  }

  /**
   * Startup/readiness entrypoint. Once the global switch, bucket, S3 key pair,
   * and encryption password exist, automatically run one forced S3 capability
   * probe (single-flight) and then bootstrap the whole library. This is what
   * makes a fresh device restore all profiles after settings are entered,
   * without requiring a separate Test S3 connection click.
   */
  async autoBootstrap(opts: { force?: boolean } = {}): Promise<BootstrapSummary> {
    if (this.disposed) return this.bootstrapStatus();
    const c = this.cfg();
    if (!c.enabled || !c.s3Bucket.trim()) return this.bootstrapStatus();
    const [pw, ak, sk] = await Promise.all([
      this.deps.vault.has(c.kopiaPasswordRef),
      this.deps.vault.has(c.s3AccessKeyIdRef),
      this.deps.vault.has(c.s3SecretAccessKeyRef),
    ]);
    if (!pw || !ak || !sk) return this.bootstrapStatus();

    if (this.lastStoreHealth !== true || !(this.lastCapability?.ok ?? false)) {
      if (!this.bootstrapProbePromise) {
        const task = this.testStorageCoordination({ scheduleBootstrap: false }).finally(() => {
          if (this.bootstrapProbePromise === task) this.bootstrapProbePromise = null;
        });
        this.bootstrapProbePromise = task;
      }
      const tested = await this.bootstrapProbePromise;
      if (!tested.conditionalWritesSupported) return this.bootstrapStatus();
    }
    return this.maybeBootstrap(opts);
  }

  /**
   * Trigger a whole-library bootstrap IF Cloud Sync is ready and the readiness
   * inputs changed since the last successful trigger (or it never ran). This is
   * the single entry the app calls at startup AND whenever config/secret/test
   * state changes. Single-flight: a run already in progress is joined, never
   * duplicated. Fully non-throwing — a failure is captured in the summary. When
   * `force` is true (explicit "Sync all" retry) the readiness-fingerprint gate
   * is bypassed so the operator can always re-run.
   */
  async maybeBootstrap(opts: { force?: boolean } = {}): Promise<BootstrapSummary> {
    if (this.disposed) return this.bootstrapSummary;
    // Gate FIRST (may await readiness/fingerprint). A gated no-op returns the
    // cached summary WITHOUT occupying the single-flight slot, so it can never
    // preempt a concurrent forced run.
    if (!(await this.isCloudSyncReady())) {
      // Not ready → do nothing (and do not mark the fingerprint, so becoming
      // ready later triggers a run). Leave the cached summary as-is.
      return this.bootstrapSummary;
    }
    const fp = await this.readinessFingerprint();
    if (!opts.force && this.lastReadyFingerprint === fp) {
      // Readiness inputs unchanged since the last trigger → avoid a redundant
      // re-run loop. An explicit retry (force) bypasses this.
      return this.bootstrapSummary;
    }

    // Passed the gates → run under single-flight. A run already in progress is
    // JOINED (never duplicated); the fingerprint is recorded after a terminal
    // run so a transient failure does not permanently suppress future triggers.
    if (this.bootstrapPromise) return this.bootstrapPromise;
    const run = this.bootstrapLibrary()
      .then((summary) => {
        this.lastReadyFingerprint = fp;
        return summary;
      })
      .finally(() => {
        this.bootstrapPromise = null;
      });
    this.bootstrapPromise = run;
    return run;
  }

  /** Current (or last) whole-library bootstrap summary for status/UI. Never throws. */
  bootstrapStatus(): BootstrapSummary {
    return { ...this.bootstrapSummary, results: [...this.bootstrapSummary.results] };
  }

  /**
   * Explicit "Sync all" retry from the UI. Runs a fresh capability probe first
   * (so a fixed misconfiguration flips readiness), then forces a bootstrap
   * bypassing the readiness-fingerprint gate. Non-throwing — returns the
   * summary; a probe/readiness failure leaves the summary describing why.
   */
  async syncAll(): Promise<BootstrapSummary> {
    this.requireGlobalEnabled();
    // Refresh the capability cache so a just-fixed endpoint/credential flips
    // readiness. testStorageCoordination never throws for a probe failure.
    await this.testStorageCoordination().catch(() => undefined);
    return this.maybeBootstrap({ force: true });
  }

  /**
   * The whole-library bootstrap body (single-flight; only called through
   * {@link maybeBootstrap}). Steps:
   *   1. List committed, non-tombstoned remote profiles.
   *   2. For every remote profile MISSING locally: restore it (temporary lease,
   *      released after) — never overwriting same-id local data. Per-profile
   *      failures are recorded and the run continues (idempotent retry).
   *   3. Backfill sync-state so every LOCAL profile is syncEnabled (existing
   *      user-disabled profiles are preserved by backfill's idempotency).
   *   4. For every local profile that is dirty (incl. never-published new ones):
   *      upload it through a temporary acquire→backup→release IF it is not
   *      running; running profiles defer their upload to close.
   *   5. Existing local+remote profiles reconcile safely: never overwrite a
   *      dirty local, never blindly publish over a newer remote (the
   *      backup/launch conflict policy already enforces this).
   *
   * Never throws: a fatal listing error is captured in the summary as
   * `phase: "error"`. Never carries a secret (all messages redacted).
   */
  private async bootstrapLibrary(): Promise<BootstrapSummary> {
    const secrets = await this.secretValuesForRedaction().catch(() => [] as (string | null)[]);
    const results: BootstrapProfileResult[] = [];
    const summary: BootstrapSummary = {
      phase: "running",
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      remoteDiscovered: 0,
      restored: 0,
      uploaded: 0,
      deferred: 0,
      reconciled: 0,
      failed: 0,
      remoteTruncated: false,
      results,
      error: null,
    };
    this.bootstrapSummary = summary;
    this.emit({ profileId: "", phase: "restoring", message: "Syncing your profile library…" });

    // ── 1. Discover remote profiles. A listing failure is fatal for discovery
    // but we still proceed to the local upload phase so a fresh device with
    // local-only profiles still publishes them.
    let remoteProfiles = new Map<
      string,
      { currentRevision: number; latestSnapshotId: string | null }
    >();
    try {
      const coordinator = await this.coordinator();
      const listed = await coordinator.listProfiles();
      summary.remoteDiscovered = listed.profiles.length;
      summary.remoteTruncated = listed.truncated;
      remoteProfiles = new Map(
        listed.profiles.map((p) => [
          p.profileId,
          { currentRevision: p.currentRevision, latestSnapshotId: p.latestSnapshotId },
        ]),
      );
      // Restore every remote profile missing locally.
      for (const remote of listed.profiles) {
        if (this.disposed || this.quitting || this.suppressAutoBackup || !this.cfg().enabled) break;
        if (this.deps.profileManager.get(remote.profileId)) {
          // Existing local profiles are handled in the reconciliation phase,
          // where dirty/local/remote revisions determine upload vs restore.
          continue;
        }
        try {
          await this.withProfile(remote.profileId, () =>
            this.restoreIntoNewProfile(remote.profileId, { releaseLeaseAfter: true }),
          );
          summary.restored += 1;
          results.push({ profileId: remote.profileId, action: "restored", ok: true });
        } catch (err) {
          summary.failed += 1;
          results.push({
            profileId: remote.profileId,
            action: "failed",
            ok: false,
            message: redact(describeStorageError(err), secrets),
          });
        }
      }
    } catch (err) {
      summary.error = redact(describeStorageError(err), secrets);
      summary.phase = "error";
      summary.running = false;
      summary.finishedAt = new Date().toISOString();
      this.emit({ profileId: "", phase: "error", message: summary.error });
      return summary;
    }

    // ── 3. Backfill: ensure every LOCAL profile is sync-enabled (idempotent;
    // preserves a user's explicit per-profile disable) and initial-dirty when
    // never published.
    try {
      this.deps.profileManager.backfillSyncEnabled();
    } catch {
      /* best-effort: backfill failure never aborts the bootstrap */
    }

    // ── 4. Upload local dirty profiles that have no remote yet (or reconcile
    // existing). Running profiles defer to close.
    const localIds = this.allProfileIds();
    for (const id of localIds) {
      if (this.disposed || this.quitting || this.suppressAutoBackup || !this.cfg().enabled) break;
      await this.withProfile(id, async () => {
        const state = this.deps.profileManager.getSyncState(id);
        if (!state?.syncEnabled) return; // user explicitly disabled → skip
        const remote = remoteProfiles.get(id);
        if (results.some((r) => r.profileId === id && r.action === "restored")) return;
        if (this.deps.driver.isRunning(id)) {
          summary.deferred += 1;
          results.push({
            profileId: id,
            action: "deferred-running",
            ok: true,
            message: "Synchronization deferred until the browser closes",
          });
          return;
        }
        try {
          if (state.dirty) {
            await this.withTemporaryLease(id, () => this.backupAndPublishInternal(id));
            summary.uploaded += 1;
            results.push({ profileId: id, action: "uploaded", ok: true });
          } else if (remote && remote.currentRevision > state.localRevision) {
            await this.withTemporaryLease(id, () =>
              this.restoreInternal(id, { keepLocalAsConflict: false }),
            );
            summary.restored += 1;
            results.push({ profileId: id, action: "restored", ok: true });
          } else if (remote) {
            summary.reconciled += 1;
            results.push({ profileId: id, action: "reconciled", ok: true });
          } else {
            results.push({ profileId: id, action: "skipped", ok: true });
          }
        } catch (err) {
          summary.failed += 1;
          results.push({
            profileId: id,
            action: "failed",
            ok: false,
            message: redact(describeStorageError(err), secrets),
          });
        }
      });
    }

    summary.phase = "done";
    summary.running = false;
    summary.finishedAt = new Date().toISOString();
    this.emit({
      profileId: "",
      phase: "done",
      message: `Library sync complete — restored ${summary.restored}, uploaded ${summary.uploaded}${
        summary.deferred ? `, ${summary.deferred} deferred` : ""
      }${summary.failed ? `, ${summary.failed} failed` : ""}`,
    });
    return summary;
  }

  private async withTemporaryLease(id: string, work: () => Promise<unknown>): Promise<void> {
    const previous = this.leases.get(id);
    await this.ensureLeaseForLaunch(id);
    const owned = this.requireOwnedLease(id);
    try {
      await work();
    } finally {
      if (owned !== previous && this.leases.get(id) === owned) {
        await this.releaseAndDropLease(id).catch(() => {});
      }
    }
  }

  /** Ids of every local profile (best-effort; empty if PM lacks a lister). */
  private allProfileIds(): string[] {
    const pm = this.deps.profileManager as unknown as {
      list?: () => Array<{ id: string }>;
    };
    const all = typeof pm.list === "function" ? pm.list() : [];
    return all.map((p) => p.id);
  }

  // ── Destructive per-profile remote-disable (delete) ────────────────────────

  /**
   * Per-profile "uncheck" is a DESTRUCTIVE remote-disable, not a local flag
   * flip: it logically deletes the profile's cloud backup and only then marks
   * the LOCAL profile sync-disabled (keeping all local data). Fail-closed and
   * idempotent so a partial failure never leaves local sync off without the
   * remote actually deleted.
   *
   * Sequence (serialized per profile so two deletes never interleave):
   *   1. Preconditions: global on, profile exists, sync currently enabled,
   *      browser CLOSED.
   *   2. Acquire + validate ownership of the coordination lease (never steals
   *      an active peer lease).
   *   3. Write the durable TOMBSTONE first (authoritative logical deletion;
   *      fences all peers of the current generation). Best-effort strict cleanup
   *      of that profile's revision-history control objects.
   *   4. Delete ONLY that profile's Kopia snapshot manifests through the adapter
   *      (list-once-then-delete-exact-ids; idempotent no-op when none).
   *   5. ONLY after the logical deletion sufficiently succeeds, set local
   *      `syncEnabled = false`. The local profile + data dir are untouched.
   *   6. Release the lease.
   *
   * NOTE on erasure semantics: this performs IMMEDIATE logical deletion (the
   * tombstone + snapshot manifest removal make the profile unrecoverable through
   * normal sync and invisible to `listProfiles`). Physical, deduplicated chunk
   * reclamation is EVENTUAL (Kopia maintenance GC) — this never claims immediate
   * byte erasure.
   */
  async disableProfileSyncAndDeleteRemote(profileId: string): Promise<DisableProfileSyncResult> {
    // Serialize per-profile: a second concurrent delete joins the first.
    const inFlight = this.disableInFlight.get(profileId);
    if (inFlight) return inFlight;
    const task = this.withProfile(profileId, () =>
      this.disableProfileSyncAndDeleteRemoteInternal(profileId),
    ).finally(() => {
      if (this.disableInFlight.get(profileId) === task) {
        this.disableInFlight.delete(profileId);
      }
    });
    this.disableInFlight.set(profileId, task);
    return task;
  }

  private async disableProfileSyncAndDeleteRemoteInternal(
    profileId: string,
  ): Promise<DisableProfileSyncResult> {
    this.requireGlobalEnabled();
    const profile = this.deps.profileManager.get(profileId);
    if (!profile) {
      throw syncError(SyncErrorCode.InvalidInput, "profile not found", { profileId });
    }
    const state = this.deps.profileManager.getSyncState(profileId);
    if (!state?.syncEnabled) {
      // Idempotent: already disabled → nothing to delete remotely.
      return {
        profileId,
        disabled: true,
        deletedSnapshotIds: [],
        message: "Sync already disabled for this profile",
      };
    }
    if (this.deps.driver.isRunning(profileId)) {
      throw syncError(
        SyncErrorCode.BrowserStillRunning,
        "Close the browser before disabling and deleting this profile's cloud backup",
        { profileId },
      );
    }

    const secrets = await this.secretValuesForRedaction();
    const op = this.deps.profileManager.recordSyncOperation({
      profileId,
      kind: "handoff",
      status: "running",
      message: "Disabling sync + deleting remote backup",
    });

    // Track lease so we always release it, even on failure.
    let acquiredHere = false;
    try {
      const coordinator = await this.coordinator();
      const remote = await coordinator.getState(profileId);
      const alreadyTombstoned = remote.kind === "state" && remote.state.deleted === true;

      if (!alreadyTombstoned) {
        // Acquire + own the lease (fails closed against an active peer lease).
        this.emit({ profileId, phase: "acquiring", message: "Acquiring lease…" });
        const held = this.leases.get(profileId);
        if (!held || held.expiresAtMs <= Date.now()) {
          const acquired = await coordinator.acquire(profileId, this.newOperationId());
          this.installLease(profileId, {
            leaseId: acquired.lease.leaseId,
            fencingToken: acquired.lease.fencingToken,
            expiresAtMs: acquired.lease.leaseExpiresAt,
            renewalMs: acquired.lease.recommendedRenewalMs,
          });
          acquiredHere = true;
        }
        const owned = this.requireOwnedLease(profileId);

        // Durable tombstone FIRST (authoritative logical deletion). Strict
        // history cleanup is best-effort (a warning, never fatal).
        this.emit({ profileId, phase: "releasing", message: "Writing deletion marker…" });
        await coordinator.tombstoneProfile(profileId, {
          leaseId: owned.leaseId,
          fencingToken: owned.fencingToken,
          operationId: this.newOperationId(),
          reason: "user-disabled-sync",
          cleanupHistory: true,
        });
      } else {
        // A prior attempt wrote the tombstone but failed while deleting backup
        // snapshots. Tombstoned profiles deliberately cannot be acquired, so
        // resume after the ownership step and finish the idempotent deletion.
        this.emit({
          profileId,
          phase: "releasing",
          message: "Resuming cloud backup deletion…",
        });
      }

      // Delete ONLY this profile's Kopia snapshot manifests.
      this.emit({ profileId, phase: "releasing", message: "Deleting cloud backup…" });
      const kopia = await this.makeKopiaFor(profileId, "backing up");
      await kopia.connect(this.repoTarget());
      const del = await kopia.deleteProfileSnapshots(profileId);

      // ── 5. Logical deletion succeeded → NOW disable local sync. Local profile
      // + data dir are intentionally left intact.
      this.deps.profileManager.updateSyncState(profileId, {
        syncEnabled: false,
        dirty: false,
        latestSnapshotId: null,
      });

      this.deps.profileManager.updateSyncOperation(op.id, {
        status: "succeeded",
        message: `Deleted ${del.deleted} snapshot(s); local sync disabled`,
      });
      this.emit({ profileId, phase: "done", message: "Cloud backup deleted; local profile kept" });
      return {
        profileId,
        disabled: true,
        deletedSnapshotIds: [...del.deletedIds],
        message: `Deleted ${del.deleted} snapshot(s). Local profile and data were kept.`,
      };
    } catch (err) {
      // Fail closed: do NOT disable local sync on failure. Keep the profile
      // syncEnabled so a retry re-runs the whole flow idempotently.
      this.deps.profileManager.updateSyncOperation(op.id, {
        status: "failed",
        message: redactError(err, secrets),
      });
      this.emit({ profileId, phase: "error", message: redactError(err, secrets) });
      throw normalizeError(err);
    } finally {
      // Always release the lease we hold for this profile (whether we acquired
      // it here or reused an existing one) so ownership never leaks after a
      // delete attempt.
      void acquiredHere;
      await this.releaseAndDropLease(profileId).catch(() => {});
    }
  }

  /**
   * Re-enable sync for a profile whose remote backup was deleted. Explicitly
   * REVIVES a fresh generation on the coordinator (fencing any stale peers from
   * the prior generation), marks the local profile dirty, and flips
   * `syncEnabled` back on so the next bootstrap/launch uploads it as a brand-new
   * baseline (a fresh revision line). Requires global on + browser closed.
   */
  async reEnableProfileSync(profileId: string): Promise<ProfileSyncStatusView> {
    return this.withProfile(profileId, () => this.reEnableInternal(profileId));
  }

  private async reEnableInternal(profileId: string): Promise<ProfileSyncStatusView> {
    this.requireGlobalEnabled();
    const profile = this.deps.profileManager.get(profileId);
    if (!profile) throw syncError(SyncErrorCode.InvalidInput, "profile not found", { profileId });
    if (this.deps.driver.isRunning(profileId)) {
      throw syncError(
        SyncErrorCode.BrowserStillRunning,
        "Close the browser before re-enabling sync",
        { profileId },
      );
    }
    const coordinator = await this.coordinator();
    // Revive resets to a fresh generation + revision line so a prior tombstone
    // does not fail-close acquire/publish. Idempotent; a no-op on a live profile.
    await coordinator.reviveProfile(profileId, this.newOperationId());
    // Mark dirty + enabled so it uploads as a fresh baseline (never published).
    this.deps.profileManager.upsertSyncState({
      profileId,
      syncEnabled: true,
      dirty: true,
      localRevision: 0,
      baseRevision: 0,
      remoteRevision: 0,
      latestSnapshotId: null,
      lastSyncedAt: null,
    });
    this.emit({ profileId, phase: "done", message: "Sync re-enabled — preparing a fresh backup" });
    void this.autoBootstrap().catch(() => undefined);
    return this.status(profileId);
  }

  // ── Misc ─────────────────────────────────────────────────────────────────

  private async requireEnabled(profileId: string): Promise<Profile> {
    this.requireGlobalEnabled();
    const profile = this.deps.profileManager.get(profileId);
    if (!profile) throw syncError(SyncErrorCode.InvalidInput, "profile not found", { profileId });
    const s = this.deps.profileManager.getSyncState(profileId);
    if (!s?.syncEnabled) {
      throw syncError(SyncErrorCode.SyncDisabled, "sync is not enabled for this profile", {
        profileId,
      });
    }
    return profile;
  }

  /**
   * Authoritative global gate. Every operation that contacts storage or changes
   * cloud-sync state (test coordination, acquire, backup/publish, restore,
   * connect-existing, enabling a profile) MUST call this first. When the master
   * switch is off it throws {@link SyncErrorCode.SyncDisabled} so no cloud I/O
   * or coordination can happen. Configuration edits, secret saves/deletes,
   * diagnostics/export, and disabling a profile deliberately do NOT call this.
   */
  private requireGlobalEnabled(): void {
    if (!this.cfg().enabled) {
      throw syncError(
        SyncErrorCode.SyncDisabled,
        "Cloud Sync is disabled — enable it in Settings before running cloud operations",
      );
    }
  }

  private newOperationId(): string {
    return `op_${randomUUID().replace(/-/g, "")}`;
  }

  /**
   * Safely wind down all coordination this controller holds. Used when the
   * global master switch transitions on→off so we never leave a stale owner
   * holding a lease after Cloud Sync is disabled.
   *
   * For every held lease: close the profile's browser if it is running (so no
   * writable session outlives coordination), then best-effort release the lease
   * through the CURRENT coordinator, and finally clear the renewal timer and
   * drop the lease. All errors are caught + redacted — winding down must never
   * throw, and must never leak a secret. Runs while the config is still
   * `enabled` so the coordinator can be built for the release attempt (the
   * disabled state is committed by the caller AFTER this returns).
   */
  private async stopCoordination(): Promise<void> {
    // Suppress close-triggered auto backups for the whole wind-down: the browser
    // closes below fire `running-changed` → onBrowserClosed, but we are already
    // releasing these leases, so any auto backup would just fail on a released
    // lease. Restore the flag afterwards so a normal later close still backs up.
    this.pauses++;
    try {
      // A close-triggered backup may already be using a held lease. Let it
      // finish before releasing ownership; suppression prevents new ones.
      const pending = [...this.profileJobs.values(), ...this.autoBackups.values()];
      if (pending.length > 0) await Promise.allSettled(pending);
      const ids = [...this.leases.keys()];
      for (const profileId of ids) {
        const held = this.leases.get(profileId);
        if (!held) continue;
        // Close any running browser first so no writable session outlives the
        // lease we are about to release.
        if (this.deps.driver.isRunning(profileId)) {
          await this.deps.driver.close(profileId);
        }
        // Best-effort remote release through the current coordinator.
        try {
          const coordinator = await this.coordinator();
          await coordinator.release(
            profileId,
            held.leaseId,
            held.fencingToken,
            this.newOperationId(),
          );
        } catch (err) {
          const secrets = await this.secretValuesForRedaction();
          this.emit({
            profileId,
            phase: "error",
            message: redact(
              `Could not release lease while disabling Cloud Sync: ${redactError(err, secrets)}`,
              secrets,
            ),
          });
        } finally {
          // Always clear the renewal timer + drop the lease, even if release
          // failed, so no timer keeps firing after Cloud Sync is disabled.
          this.dropLease(profileId);
        }
      }
    } finally {
      this.pauses--;
    }
  }

  /** Drain already-admitted launches before closeAll enumerates running browsers. */
  async prepareToQuit(): Promise<void> {
    this.quitting = true;
    await Promise.allSettled([...this.profileJobs.values()]);
  }

  /** Stop timers + drop leases (does not release them remotely). */
  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = null;
    // App shutdown flow: `before-quit` runs `browserDriver.closeAll()` BEFORE
    // `controller.shutdown()`, so close events have already started auto
    // backups. Await every currently in-flight auto backup (their promises
    // never reject) so a close-triggered publish completes before we clear the
    // leases it depends on and exit. Snapshot the values first — the map is
    // mutated as tasks settle.
    const pending = [...this.profileJobs.values(), ...this.autoBackups.values()];
    if (pending.length > 0) await Promise.allSettled(pending);
    for (const held of this.leases.values()) {
      clearInterval(held.renewTimer);
    }
    this.leases.clear();
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Human-readable detail for structured sync/provider errors; never `[object Object]`. */
export function describeStorageError(err: unknown): string {
  if (isSyncError(err)) return err.message;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return typeof err === "string" && err.trim() ? err : "Unknown storage error";
}

/** Keep diagnostic endpoint context while stripping userinfo, query, and fragment. */
export function safeStorageEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  if (!value) return "(provider default)";
  try {
    const parsed = new URL(value);
    return parsed.origin;
  } catch {
    return "(invalid endpoint)";
  }
}

/**
 * Reject any profile id that is not a single, safe path segment before it is
 * ever joined into a filesystem path. Blocks path traversal and absolute-path
 * escapes:
 *   - empty / whitespace-only,
 *   - "." and "..",
 *   - path separators ("/" or "\") and NUL,
 *   - anything outside a conservative allow-list ([A-Za-z0-9._-]).
 * Throws a deterministic {@link SyncErrorCode.InvalidInput} on rejection.
 */
export function assertSafePathSegment(segment: string): void {
  const bad = (why: string): never => {
    throw syncError(SyncErrorCode.InvalidInput, `unsafe profile id: ${why}`, { segment });
  };
  if (typeof segment !== "string" || segment.trim().length === 0) bad("empty");
  if (segment === "." || segment === "..") bad("reserved dot segment");
  if (/[\\/]/.test(segment)) bad("contains a path separator");
  // eslint-disable-next-line no-control-regex
  if (/\u0000/.test(segment)) bad("contains a NUL byte");
  if (!/^[A-Za-z0-9._-]+$/.test(segment)) bad("contains disallowed characters");
  if (segment.length > 255) bad("too long");
}

/**
 * Coerce a correlation identifier into the adapter's tag allow-list
 * ([A-Za-z0-9._-], 1..200 chars). Any disallowed character is replaced with
 * `_`; an empty result falls back to "unknown". This mirrors the adapter's
 * `validateTags` contract so a snapshot never fails on an odd id, while still
 * guaranteeing no control chars / secrets can ride along on argv.
 */
export function sanitizeTagValue(value: string): string {
  const cleaned = (value ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** Strictly recognize Kopia's empty-storage connect failure across error layers. */
function isUninitializedKopiaRepositoryError(err: unknown): boolean {
  const result = (err as { result?: { stderr?: unknown; stdout?: unknown } } | null)?.result;
  const text = [
    err instanceof Error ? err.message : String(err ?? ""),
    typeof result?.stderr === "string" ? result.stderr : "",
    typeof result?.stdout === "string" ? result.stdout : "",
  ]
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ");
  return text.includes("repository not initialized in the provided storage");
}

/**
 * Robustly extract a snapshot id from Kopia's `snapshot create --json` output.
 * Kopia has emitted different shapes across versions; probe common fields and
 * fall back to a scan for an id-like value.
 */
export function extractSnapshotId(json: unknown): string | null {
  if (json == null) return null;
  const candidates = Array.isArray(json) ? json : [json];
  for (const entry of candidates) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    // Common: { id: "..." } or { rootEntry: { obj: "..." } } or { manifestId }
    if (typeof obj.id === "string" && obj.id.length > 0) return obj.id;
    if (typeof obj.snapshotID === "string" && obj.snapshotID.length > 0) return obj.snapshotID;
    if (typeof obj.manifestId === "string" && obj.manifestId.length > 0) return obj.manifestId;
    const root = obj.rootEntry as Record<string, unknown> | undefined;
    if (root && typeof root.obj === "string" && root.obj.length > 0) return root.obj;
    if (typeof obj.rootID === "string" && obj.rootID.length > 0) return obj.rootID;
  }
  return null;
}

function manifestProxyToConfig(proxy: unknown): Profile["proxy"] {
  if (typeof proxy !== "object" || proxy === null) return undefined;
  const p = proxy as Record<string, unknown>;
  if (typeof p.host !== "string" || typeof p.port !== "number") return undefined;
  const type = p.type === "socks5" ? "socks5" : "http";
  // Credentials are intentionally absent from a manifest — the user re-enters.
  return { type, host: p.host, port: p.port };
}

function normalizeError(err: unknown): SyncError {
  if (isSyncError(err)) return err;
  return syncError(SyncErrorCode.Internal, err instanceof Error ? err.message : String(err));
}
