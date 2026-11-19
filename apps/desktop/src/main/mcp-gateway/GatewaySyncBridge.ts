/**
 * S3 project-config sync composition for the desktop gateway.
 *
 * When Cloud Sync becomes ready, this bridge is constructed with the SAME
 * object store + control prefix Cloud Sync uses, plus the operator encryption
 * password and the device signing key. It composes the core
 * {@link ProjectSyncCoordinator} and {@link TrustRegistrySync} — both scoped to
 * the reserved `<controlPrefix>/mcp/…` namespace, entirely separate from the
 * browser-profile keys — and runs a single-flight sync:
 *
 *   local load → remote restore/quarantine/conflicts → persist accepted →
 *   verify → hand the accepted set back for runtime reconcile.
 *
 * The gateway works fully offline: when this bridge is absent (Cloud Sync not
 * configured), the service uses local config only. Local edits are published as
 * signed envelopes with expected revisions; a lost CAS becomes a durable local
 * conflict copy (keep-both), never last-write-wins. No browser-profile deletion
 * is ever coupled to config sync.
 *
 * SECURITY: the encryption password lives only in this main-process object and
 * is passed only into the coordinator's in-memory sealing; it is never logged,
 * serialized, or exposed across IPC.
 */

import {
  ProjectSyncCoordinator,
  TrustRegistrySync,
  type ArchivedRevision,
  type ConflictOutcome,
  type HistoryEntry,
  type PendingDevice,
  type ProjectConfig,
  type PublishResult,
  type RestoreResult,
  type SigningKey,
  type SyncObjectStore,
  type TrustRegistry,
} from "@multizen/mcp-gateway";

export interface GatewaySyncBridgeConfig {
  readonly store: SyncObjectStore;
  readonly controlPrefix: string;
  /** Operator encryption password (in-memory only; never leaves this object). */
  readonly password: string;
  /** Per-repository config-sync salt (hex, not secret). */
  readonly saltHex: string;
  /** This device's signing key (private material stays in the vault). */
  readonly signingKey: SigningKey;
}

/** Result of one whole-library config-sync pass. */
export interface GatewaySyncResult extends RestoreResult {
  /** The self-verified trust registry used for this pass. */
  readonly registry: TrustRegistry;
}

export class GatewaySyncBridge {
  private readonly coordinator: ProjectSyncCoordinator;
  private readonly trust: TrustRegistrySync;

  constructor(private readonly config: GatewaySyncBridgeConfig) {
    this.coordinator = new ProjectSyncCoordinator({
      store: config.store,
      controlPrefix: config.controlPrefix,
      password: config.password,
      saltHex: config.saltHex,
      signingKey: config.signingKey,
    });
    this.trust = new TrustRegistrySync(config.store, config.controlPrefix);
  }

  /**
   * Fetch the current trust registry, bootstrapping this device as the sole
   * trust root on a fresh bucket. Self-verified before return.
   */
  async ensureTrustRegistry(): Promise<TrustRegistry> {
    return this.trust.fetchOrBootstrap(this.config.signingKey);
  }

  /** Fetch the current trust registry (null when none exists yet). */
  async fetchTrustRegistry(): Promise<TrustRegistry | null> {
    const res = await this.trust.fetch();
    return res?.registry ?? null;
  }

  /** Approve (trust) a device by publishing a signed registry update. */
  async approveDevice(
    entries: Parameters<TrustRegistrySync["update"]>[1],
  ): Promise<TrustRegistry> {
    return this.trust.update(this.config.signingKey, entries);
  }

  /**
   * Announce this device so an admin elsewhere can approve it.
   *
   * Called when this device is not (yet) an entry in the registry. Without it the
   * approval UI has nothing to show: the registry only lists devices that are
   * already entries, so an unapproved device would be invisible and could never
   * be promoted.
   */
  async announceSelf(name: string): Promise<void> {
    await this.trust.announce(this.config.signingKey, name);
  }

  /** Every self-announced device in the bucket (public keys and names only). */
  async listPendingDevices(): Promise<PendingDevice[]> {
    return this.trust.listPending();
  }

  /** This device's own signer identity, for "is this me?" comparisons. */
  get selfDeviceId(): string {
    return this.config.signingKey.deviceId;
  }

  /**
   * Whole-library restore: discover + verify every remote project head against
   * the (bootstrapped) trust registry. `knownRevisions` provides rollback
   * protection using the last-applied revision per project.
   */
  async restoreAll(
    knownRevisions?: ReadonlyMap<string, number>,
    localIds: Iterable<string> = [],
  ): Promise<GatewaySyncResult> {
    const registry = await this.ensureTrustRegistry();
    const result = await this.coordinator.restoreAll(registry, knownRevisions, localIds);
    return { ...result, registry };
  }

  async inspect(id: string) {
    const registry = await this.ensureTrustRegistry();
    return this.coordinator.readProjects(registry, [id]);
  }

  /**
   * Publish a local config edit at `revision` (strictly monotonic). A lost CAS
   * returns a {@link ConflictOutcome} carrying the losing signed config for a
   * durable keep-both local copy. Never overwrites a newer remote.
   */
  async publish(config: ProjectConfig, revision: number, allowRecreation = true): Promise<PublishResult> {
    return this.coordinator.publish(config, revision, allowRecreation);
  }

  /**
   * Publish a signed deletion marker at `revision`, so other devices remove the
   * project too instead of restoring it back onto this one.
   */
  async publishTombstone(projectId: string, revision: number): Promise<void> {
    await this.coordinator.publishTombstone(projectId, revision);
  }

  /**
   * A project's revision timeline, newest last. Includes the deletion marker when
   * one exists, so "what did this look like on Friday" can answer "it was gone".
   */
  async history(projectId: string): Promise<HistoryEntry[]> {
    const registry = await this.ensureTrustRegistry();
    return this.coordinator.history(projectId, registry);
  }

  /**
   * Read one archived revision, fully verified. Null when it is absent or cannot
   * be trusted — an operator is never offered a config that would not verify.
   */
  async readRevision(projectId: string, revision: number): Promise<ArchivedRevision | null> {
    const registry = await this.ensureTrustRegistry();
    return this.coordinator.readRevision(projectId, revision, registry);
  }

  /** Narrow type guard for a conflict publish outcome. */
  static isConflict(result: PublishResult): result is ConflictOutcome {
    return result.kind === "conflict";
  }
}
