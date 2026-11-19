import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncErrorCode, isSyncError, syncError } from "@multizen/sync-core";
import {
  SyncController,
  extractSnapshotId,
  assertSafePathSegment,
  describeStorageError,
  safeStorageEndpoint,
} from "../SyncController.ts";
import { FakeCredentialVault } from "../CredentialVault.ts";

// ── extractSnapshotId (pure) ─────────────────────────────────────────────

test("extractSnapshotId probes common Kopia shapes", () => {
  assert.equal(extractSnapshotId({ id: "abc" }), "abc");
  assert.equal(extractSnapshotId([{ id: "arr1" }]), "arr1");
  assert.equal(extractSnapshotId({ rootEntry: { obj: "k123" } }), "k123");
  assert.equal(extractSnapshotId({ manifestId: "m1" }), "m1");
  assert.equal(extractSnapshotId({ nothing: true }), null);
  assert.equal(extractSnapshotId(null), null);
});

// ── Fakes ────────────────────────────────────────────────────────────────

type SyncStateRow = {
  profileId: string;
  syncEnabled: boolean;
  localRevision: number;
  baseRevision: number;
  remoteRevision: number;
  dirty: boolean;
  latestSnapshotId: string | null;
  lastSyncedAt: string | null;
  updatedAt: string;
};

class FakeProfileManager {
  profiles = new Map<string, { id: string; name: string; dataDir: string; tags?: string[]; engine?: string }>();
  states = new Map<string, SyncStateRow>();
  ops: Array<{ id: string; profileId: string; kind: string; status: string; message?: string | null }> = [];
  /** Toggle to force insertImported to throw (fault injection). */
  failInsertImported = false;
  /** Toggle to force upsertSyncState to throw once after insert (fault injection). */
  failNextUpsert = false;

  get(id: string) {
    return this.profiles.get(id) ?? null;
  }
  list() {
    return [...this.profiles.values()].map((p) => ({ id: p.id }));
  }
  backfillSyncEnabled(): string[] {
    const backfilled: string[] = [];
    for (const id of this.profiles.keys()) {
      if (this.states.has(id)) continue;
      this.upsertSyncState({ profileId: id, syncEnabled: true, dirty: true });
      backfilled.push(id);
    }
    return backfilled;
  }
  getSyncState(id: string) {
    return this.states.get(id) ?? null;
  }
  upsertSyncState(input: { profileId: string } & Partial<SyncStateRow>) {
    if (this.failNextUpsert) {
      this.failNextUpsert = false;
      throw new Error("injected upsertSyncState failure");
    }
    const prev = this.states.get(input.profileId);
    const row: SyncStateRow = {
      profileId: input.profileId,
      syncEnabled: input.syncEnabled ?? prev?.syncEnabled ?? false,
      localRevision: input.localRevision ?? prev?.localRevision ?? 0,
      baseRevision: input.baseRevision ?? prev?.baseRevision ?? 0,
      remoteRevision: input.remoteRevision ?? prev?.remoteRevision ?? 0,
      dirty: input.dirty ?? prev?.dirty ?? false,
      latestSnapshotId:
        input.latestSnapshotId !== undefined ? input.latestSnapshotId : (prev?.latestSnapshotId ?? null),
      lastSyncedAt: input.lastSyncedAt !== undefined ? input.lastSyncedAt : (prev?.lastSyncedAt ?? null),
      updatedAt: new Date().toISOString(),
    };
    this.states.set(input.profileId, row);
    return row;
  }
  updateSyncState(id: string, patch: Partial<SyncStateRow>) {
    return this.upsertSyncState({ profileId: id, ...patch });
  }
  markSyncDirty(id: string, dirty = true) {
    return this.updateSyncState(id, { dirty });
  }
  // Mirrors ProfileManager.insertImported: inserting the row is what enables a
  // subsequent sync-operation journal write (FK to profiles(id)).
  insertImported(profile: { id: string; name: string; dataDir: string; tags?: string[]; engine?: string }) {
    if (this.failInsertImported) throw new Error("injected insertImported failure");
    if (this.profiles.has(profile.id)) throw new Error(`Profile ${profile.id} already exists`);
    this.profiles.set(profile.id, { id: profile.id, name: profile.name, dataDir: profile.dataDir, tags: profile.tags, engine: profile.engine });
    return profile;
  }
  insertConflictProfile(input: {
    source: { id: string; name: string; dataDir: string };
    conflictId: string;
    conflictName: string;
    dataDir: string;
    baseRevision: number;
    remoteRevision: number;
  }) {
    if (this.profiles.has(input.conflictId)) {
      throw new Error(`Profile ${input.conflictId} already exists`);
    }
    this.profiles.set(input.conflictId, {
      id: input.conflictId,
      name: input.conflictName,
      dataDir: input.dataDir,
    });
    this.upsertSyncState({
      profileId: input.conflictId,
      syncEnabled: false,
      localRevision: input.remoteRevision,
      baseRevision: input.baseRevision,
      remoteRevision: input.remoteRevision,
      dirty: false,
    });
    return this.profiles.get(input.conflictId)!;
  }
  delete(id: string) {
    this.profiles.delete(id);
    this.states.delete(id);
    // Cascade delete journal entries (mirrors ON DELETE CASCADE).
    this.ops = this.ops.filter((o) => o.profileId !== id);
  }
  recordSyncOperation(input: { profileId: string; kind: string; status: string; message?: string | null }) {
    // Enforce the real FK: a journal row cannot exist without its profile row.
    if (!this.profiles.has(input.profileId)) {
      throw new Error(
        `FOREIGN KEY constraint failed: sync_operations.profile_id -> profiles(${input.profileId})`,
      );
    }
    const op = {
      id: `op${this.ops.length}`,
      profileId: input.profileId,
      kind: input.kind,
      status: input.status,
      message: input.message ?? null,
    };
    this.ops.push(op);
    return op;
  }
  updateSyncOperation(opId: string, patch: { status?: string; message?: string | null }) {
    const op = this.ops.find((o) => o.id === opId);
    if (op && patch.status) op.status = patch.status;
    if (op && patch.message !== undefined) op.message = patch.message;
  }
}

class FakeDriver {
  private runningSet = new Set<string>();
  closed: string[] = [];
  setRunning(id: string, running: boolean) {
    if (running) this.runningSet.add(id);
    else this.runningSet.delete(id);
  }
  isRunning(id: string) {
    return this.runningSet.has(id);
  }
  async countProcessesUsingDataDir() {
    return 0;
  }
  async close(id: string) {
    this.closed.push(id);
    this.runningSet.delete(id);
  }
}

function makeSettings() {
  return {
    sync: {
      enabled: true,
      s3Endpoint: "endpoint",
      s3Region: "auto",
      s3Bucket: "bucket",
      s3Prefix: "",
      controlPrefix: "multizen-control",
      s3ForcePathStyle: false,
      leaseTtlMs: 60_000,
      renewalMs: 15_000,
      clockSkewSafetyMs: 10_000,
      deviceId: "device_test",
      deviceDisplayName: "Test Mac",
      kopiaPasswordRef: "kopiaPassword",
      s3AccessKeyIdRef: "s3AccessKeyId",
      s3SecretAccessKeyRef: "s3SecretAccessKey",
      kopiaConfigPath: "",
      kopiaBinPath: "",
    },
  };
}

class FakeSettingsStore {
  constructor(private settings: ReturnType<typeof makeSettings>) {}
  async update(patch: { sync?: Record<string, unknown> }) {
    if (patch.sync) Object.assign(this.settings.sync, patch.sync);
    return this.settings;
  }
}

class FakeCoordinator {
  state = { currentRevision: 0, latestSnapshotId: null as string | null };
  tombstonedProfiles = new Set<string>();
  publishCalls = 0;
  lastPublishArgs: { expectedRevision: number } | null = null;
  releaseCalls = 0;
  acquireCalls = 0;
  renewCalls = 0;
  events: string[] = [];
  capabilityProbeCalls = 0;
  /** When set, acquire rejects with this error (fault injection). */
  acquireError: Error | null = null;
  /** When false, the bucket health check fails. */
  healthy = true;
  /** When false, capabilityProbe reports the store can't do conditional writes. */
  capabilityOk = true;
  async health() {
    return this.healthy;
  }
  async capabilityProbe(_force?: boolean) {
    this.capabilityProbeCalls += 1;
    return this.capabilityOk
      ? { ok: true as const }
      : { ok: false as const, failedCheck: "stale-cas-precondition" as const, message: "no If-Match" };
  }
  /** Mirror S3Coordinator: writable ops refuse until capability passes. */
  private async ensureWritable() {
    const probe = await this.capabilityProbe();
    if (!probe.ok) {
      throw syncError(
        SyncErrorCode.StorageUnreachable,
        `store failed capability probe (${probe.failedCheck ?? "unknown"})`,
      );
    }
  }
  async getState(profileId?: string) {
    // Prefer a seeded remote-library entry for this profile id (bootstrap
    // restore path). Fall back to the single shared `state` used by the
    // manual/backup tests.
    if (profileId && this.tombstonedProfiles.has(profileId)) {
      return {
        kind: "state" as const,
        state: {
          profileId,
          generation: 1,
          currentRevision: this.state.currentRevision,
          latestSnapshotId: null,
          ownerDeviceId: null,
          leaseExpiresAt: null,
          fencingToken: 2,
          deleted: true,
        },
      };
    }
    if (profileId) {
      const remote = this.remoteProfiles.find((p) => p.profileId === profileId);
      if (remote) {
        return {
          kind: "state" as const,
          state: {
            profileId,
            currentRevision: remote.currentRevision,
            latestSnapshotId: remote.latestSnapshotId,
            ownerDeviceId: null,
            leaseExpiresAt: Date.now() + 60000,
            fencingToken: 1,
          },
        };
      }
    }
    if (this.state.currentRevision === 0 && !this.state.latestSnapshotId) {
      return { kind: "not-found" as const };
    }
    return {
      kind: "state" as const,
      state: {
        profileId: "p",
        currentRevision: this.state.currentRevision,
        latestSnapshotId: this.state.latestSnapshotId,
        ownerDeviceId: "device_test",
        leaseExpiresAt: Date.now() + 60000,
        fencingToken: 1,
      },
    };
  }
  async acquire(profileId = "p") {
    await this.ensureWritable();
    if (this.tombstonedProfiles.has(profileId)) {
      throw syncError(SyncErrorCode.ProfileDeleted, "profile is tombstoned");
    }
    this.acquireCalls += 1;
    if (this.acquireError) throw this.acquireError;
    return {
      state: { profileId: "p", currentRevision: this.state.currentRevision, latestSnapshotId: this.state.latestSnapshotId, ownerDeviceId: "device_test", leaseExpiresAt: Date.now() + 60000, fencingToken: 1 },
      lease: { leaseId: "lease0123456789ab", fencingToken: 1, leaseExpiresAt: Date.now() + 60000, leaseTtlMs: 60000, recommendedRenewalMs: 30000 },
    };
  }
  async renew() {
    await this.ensureWritable();
    this.renewCalls += 1;
    return {
      state: { profileId: "p", currentRevision: this.state.currentRevision, latestSnapshotId: this.state.latestSnapshotId, ownerDeviceId: "device_test", leaseExpiresAt: Date.now() + 60000, fencingToken: 1 },
      lease: { leaseId: "lease0123456789ab", fencingToken: 1, leaseExpiresAt: Date.now() + 60000, leaseTtlMs: 60000, recommendedRenewalMs: 30000 },
    };
  }
  async publish(_profileId: string, args: { expectedRevision: number }) {
    await this.ensureWritable();
    this.publishCalls += 1;
    this.events.push("publish");
    this.lastPublishArgs = { expectedRevision: args.expectedRevision };
    const revision = this.state.currentRevision + 1;
    this.state.currentRevision = revision;
    return { state: { profileId: "p", currentRevision: revision, latestSnapshotId: "snapX", ownerDeviceId: "device_test", leaseExpiresAt: Date.now() + 60000, fencingToken: 1 }, revision };
  }
  async release() {
    await this.ensureWritable();
    this.releaseCalls += 1;
    this.events.push("release");
    return { state: {}, released: true };
  }

  /**
   * Remote library used by listProfiles(). A test seeds committed remote
   * profiles here; bootstrap discovery reads them. Tombstoned ids are removed.
   */
  remoteProfiles: Array<{ profileId: string; currentRevision: number; latestSnapshotId: string | null }> = [];
  listProfilesCalls = 0;
  tombstoneCalls: string[] = [];
  reviveCalls: string[] = [];
  listTruncated = false;
  async listProfiles() {
    this.listProfilesCalls += 1;
    return {
      profiles: this.remoteProfiles.map((p) => ({
        profileId: p.profileId,
        generation: 0,
        currentRevision: p.currentRevision,
        latestSnapshotId: p.latestSnapshotId,
        ownerDeviceId: null,
        leaseExpiresAt: null,
        fencingToken: 0,
      })),
      skipped: [],
      scanned: this.remoteProfiles.length,
      truncated: this.listTruncated,
    };
  }
  async tombstoneProfile(profileId: string) {
    await this.ensureWritable();
    this.tombstoneCalls.push(profileId);
    this.tombstonedProfiles.add(profileId);
    this.events.push("tombstone");
    // Remove from the remote library so a subsequent listProfiles hides it.
    this.remoteProfiles = this.remoteProfiles.filter((p) => p.profileId !== profileId);
    return { state: {}, tombstoned: true };
  }
  async reviveProfile(profileId: string) {
    await this.ensureWritable();
    this.reviveCalls.push(profileId);
    this.tombstonedProfiles.delete(profileId);
    this.events.push("revive");
    return { state: {}, revived: true };
  }
}

class FakeKopia {
  connected = false;
  restoreCalls = 0;
  ensureRepositoryCalls = 0;
  createRepositoryCalls = 0;
  connectCalls = 0;
  snapshotCalls = 0;
  /** Result ensureRepository reports (first backup → created:true, later → false). */
  ensureCreated = false;
  /** When set, ensureRepository rejects (fault injection). */
  ensureRepositoryError: Error | null = null;
  /** When set, restore rejects (fault injection). */
  restoreError: Error | null = null;
  /** When set, snapshot rejects (fault injection for backup failures). */
  snapshotError: Error | null = null;
  /**
   * Optional deterministic gate. When set, snapshot() awaits it before
   * returning — lets a test hold a backup "in flight" without sleeps so
   * dedup/join/await races are exercised deterministically. Resolve via
   * `releaseGate()`.
   */
  private gate: Promise<void> | null = null;
  private gateResolve: (() => void) | null = null;
  /** Manifest object written into the restore staging dir; null = write none. */
  manifest: Record<string, unknown> | null = null;
  /**
   * When true, restore() writes a structurally-valid manifest whose id matches
   * the profile being restored. Lets one FakeKopia serve a multi-profile
   * bootstrap where each restored id needs its own matching manifest.
   */
  dynamicManifest = false;
  /** Optional payload files written alongside the manifest to prove byte-identity. */
  payload: Record<string, string> = {};
  constructor(init?: { manifest?: Record<string, unknown> | null; payload?: Record<string, string> }) {
    if (init && "manifest" in init) this.manifest = init.manifest ?? null;
    if (init?.payload) this.payload = init.payload;
  }
  /** Arm a gate so the next snapshot() blocks until releaseGate() is called. */
  armGate() {
    this.gate = new Promise<void>((resolve) => {
      this.gateResolve = resolve;
    });
  }
  /** Release an armed gate so a blocked snapshot() can complete. */
  releaseGate() {
    this.gateResolve?.();
  }
  async connect() {
    this.connectCalls += 1;
    this.connected = true;
  }
  async ensureRepository() {
    this.ensureRepositoryCalls += 1;
    if (this.ensureRepositoryError) throw this.ensureRepositoryError;
    this.connected = true;
    return { created: this.ensureCreated };
  }
  async createRepository() {
    this.createRepositoryCalls += 1;
    this.connected = true;
  }
  async snapshot() {
    this.snapshotCalls += 1;
    if (this.snapshotError) throw this.snapshotError;
    if (this.gate) await this.gate;
    return { id: "snapX" };
  }
  async restore(_profileId: string, _snapshotId: string, targetDir: string) {
    this.restoreCalls += 1;
    if (this.restoreError) throw this.restoreError;
    // Write payload files (default: a marker) so tests can assert the live dir
    // is byte-identical to the original after a rollback.
    const files = Object.keys(this.payload).length > 0 ? this.payload : { "restored.txt": "restored" };
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(targetDir, rel), content);
    }
    const manifest = this.dynamicManifest
      ? {
          manifestVersion: 1,
          id: _profileId,
          name: `Restored ${_profileId}`,
          tags: [],
          fingerprint: { ua: "x" },
        }
      : this.manifest;
    if (manifest !== null) {
      const dir = join(targetDir, ".multizen-sync");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "profile-manifest.json"), JSON.stringify(manifest));
    }
  }
  deleteProfileSnapshotsCalls: string[] = [];
  /** When set, deleteProfileSnapshots rejects (fault injection). */
  deleteError: Error | null = null;
  /** Snapshot ids the fake reports deleting for a profile. */
  deletedSnapshotIds: string[] = ["snap-del-1"];
  async deleteProfileSnapshots(profileId: string) {
    this.deleteProfileSnapshotsCalls.push(profileId);
    if (this.deleteError) throw this.deleteError;
    return {
      profileId,
      deletedIds: [...this.deletedSnapshotIds],
      deleted: this.deletedSnapshotIds.length,
    };
  }
}

/** Build a structurally-valid manifest for a given profile id. */
function validManifest(id: string, name = "Restored"): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id,
    name,
    tags: ["a", "b"],
    fingerprint: { ua: "x" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
  };
}

function makeController(overrides: {
  pm: FakeProfileManager;
  driver: FakeDriver;
  client?: FakeCoordinator;
  kopia?: FakeKopia;
  vault?: FakeCredentialVault;
  root?: string;
  settings?: ReturnType<typeof makeSettings>;
  logger?: Pick<Console, "error">;
}): { ctl: SyncController; root: string } {
  const settings = overrides.settings ?? makeSettings();
  const vault = overrides.vault ?? new FakeCredentialVault();
  const root = overrides.root ?? mkdtempSync(join(tmpdir(), "mz-ctl-"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    settingsStore: new FakeSettingsStore(settings),
    getSettings: () => settings,
    onSettingsUpdated: (next: ReturnType<typeof makeSettings>) => {
      Object.assign(settings, next);
    },
    profileManager: overrides.pm,
    vault,
    driver: overrides.driver,
    profilesRoot: root,
    kopiaConfigDefault: join(root, "kopia.config"),
    ...(overrides.client ? { coordinator: overrides.client } : {}),
    makeKopia: () => overrides.kopia ?? new FakeKopia(),
    sameVolume: () => true,
    logger: overrides.logger ?? { error: () => undefined },
  };
  return { ctl: new SyncController(deps), root };
}

/** A vault preloaded with a Kopia password so makeKopiaFor won't reject. */
async function vaultWithPassword(): Promise<FakeCredentialVault> {
  const v = new FakeCredentialVault();
  await v.set("kopiaPassword", "pw-secret-1234");
  return v;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("beforeLaunch is a no-op for unsynced profiles", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  // no sync state row → unsynced
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client });
  await ctl.beforeLaunch("p"); // must not throw, must not create state
  assert.equal(pm.getSyncState("p"), null);
});

test("markDirty only affects sync-enabled profiles", () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: false });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeCoordinator() });
  ctl.markDirty("p");
  assert.equal(pm.getSyncState("p")!.dirty, false);

  pm.upsertSyncState({ profileId: "p", syncEnabled: true });
  ctl.markDirty("p");
  assert.equal(pm.getSyncState("p")!.dirty, true);
});

test("beforeLaunch auto-acquires a lease for a synced profile (normal lifecycle, no manual acquire)", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, vault: await vaultWithPassword() });
  // No manual acquire() — beforeLaunch must acquire the lease itself.
  await ctl.beforeLaunch("p");
  assert.equal(client.acquireCalls, 1, "beforeLaunch auto-acquired the lease");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.ok((ctl as any).leases.has("p"), "lease is held for the writable launch");
  // A writable launch marks the profile dirty.
  assert.equal(pm.getSyncState("p")!.dirty, true);
  await ctl.shutdown();
});

test("beforeLaunch on synced clean profile WITH a lease marks dirty (writable launch)", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeCoordinator(); // NOT_FOUND → remote revision 0
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, vault: await vaultWithPassword() });
  await ctl.acquire("p"); // own an unexpired lease first
  await ctl.beforeLaunch("p");
  const s = pm.getSyncState("p")!;
  assert.equal(s.dirty, true);
  assert.equal(s.remoteRevision, 0, "NOT_FOUND treated as revision 0");
  await ctl.shutdown();
});

test("beforeLaunch drops an expired lease and auto re-acquires (normal lifecycle)", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  assert.equal(client.acquireCalls, 1);
  // Force the in-memory lease to be expired.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const held = (ctl as any).leases.get("p");
  held.expiresAtMs = Date.now() - 1;
  // beforeLaunch drops the stale lease and re-acquires a fresh one (no refuse).
  await ctl.beforeLaunch("p");
  assert.equal(client.acquireCalls, 2, "stale lease re-acquired");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fresh = (ctl as any).leases.get("p");
  assert.ok(fresh && fresh.expiresAtMs > Date.now(), "a fresh unexpired lease is held");
  assert.equal(pm.getSyncState("p")!.dirty, true, "writable launch marks dirty");
  await ctl.shutdown();
});

test("release refuses while Chromium is running", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true });
  const driver = new FakeDriver();
  driver.setRunning("p", true);
  const { ctl } = makeController({ pm, driver, client: new FakeCoordinator() });
  await assert.rejects(
    () => ctl.release("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.BrowserStillRunning,
  );
});

test("backup refuses while Chromium is running", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const driver = new FakeDriver();
  driver.setRunning("p", true);
  const { ctl } = makeController({ pm, driver, client: new FakeCoordinator() });
  await assert.rejects(
    () => ctl.backupAndPublish("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.BrowserStillRunning,
  );
});

test("backup without a lease is refused", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeCoordinator() });
  await assert.rejects(
    () => ctl.backupAndPublish("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.LeaseHeldByOther,
  );
});


test("backup requires encryption password even though the S3 connection test does not", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  const { ctl } = makeController({
    pm,
    driver: new FakeDriver(),
    client,
    kopia,
    vault: new FakeCredentialVault(),
  });

  await ctl.acquire("p");
  await assert.rejects(
    () => ctl.backupAndPublish("p"),
    (err: unknown) =>
      isSyncError(err) &&
      err.code === SyncErrorCode.InvalidInput &&
      err.message ===
        "Set an encryption password before backing up. It is not required for the S3 connection test.",
  );
  assert.equal(kopia.ensureRepositoryCalls, 0, "repository work never starts without encryption");
  assert.equal(client.publishCalls, 0, "no revision is published");
  assert.equal(pm.getSyncState("p")!.dirty, true, "unsynced local state remains dirty");
  await ctl.shutdown();
});
test("acquire → backup clears dirty ONLY after publish accepted", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia(), vault: await vaultWithPassword() });

  await ctl.acquire("p");
  // still dirty right after acquire
  assert.equal(pm.getSyncState("p")!.dirty, true);

  const status = await ctl.backupAndPublish("p");
  assert.equal(client.publishCalls, 1);
  assert.equal(status.dirty, false, "dirty cleared after accepted publish");
  assert.equal(status.localRevision, 1);
  assert.equal(status.latestSnapshotId, "snapX");
  await ctl.shutdown();
});

test("backupAndPublish REFUSES when remote advanced past base (conflict preservation)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  // Local diverged: base=1, dirty local edits, but remote already advanced to 2.
  pm.upsertSyncState({
    profileId: "p",
    syncEnabled: true,
    dirty: true,
    localRevision: 1,
    baseRevision: 1,
    remoteRevision: 1,
  });
  const client = new FakeCoordinator();
  client.state = { currentRevision: 2, latestSnapshotId: "snapRemote" }; // remote > base
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia(), vault: await vaultWithPassword() });

  await ctl.acquire("p");
  await assert.rejects(
    () => ctl.backupAndPublish("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.ConflictDetected,
  );
  // The invariant: no publish issued, and dirty is preserved for the user to resolve.
  assert.equal(client.publishCalls, 0, "must NOT fast-forward over a newer peer revision");
  assert.equal(pm.getSyncState("p")!.dirty, true, "dirty preserved until conflict resolved");
  await ctl.shutdown();
});

test("backupAndPublish uses baseRevision as the CAS anchor (not fetched remote)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  // base=3, remote also at 3 (in sync), dirty local edits to push as rev 4.
  pm.upsertSyncState({
    profileId: "p",
    syncEnabled: true,
    dirty: true,
    localRevision: 3,
    baseRevision: 3,
    remoteRevision: 3,
  });
  const client = new FakeCoordinator();
  client.state = { currentRevision: 3, latestSnapshotId: "snap3" };
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia(), vault: await vaultWithPassword() });

  await ctl.acquire("p");
  await ctl.backupAndPublish("p");
  assert.equal(client.publishCalls, 1);
  assert.equal(
    client.lastPublishArgs!.expectedRevision,
    3,
    "expectedRevision must be the device baseRevision (CAS anchor)",
  );
  await ctl.shutdown();
});

test("enable toggles per-profile sync flag", () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeCoordinator() });
  const s = ctl.enable("p", true);
  assert.equal(s.syncEnabled, true);
  const s2 = ctl.enable("p", false);
  assert.equal(s2.syncEnabled, false);
});

// ── restoreLatest: lease + dirty guards (req 2) ─────────────────────────────

test("restoreLatest without a lease is refused (LeaseHeldByOther)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeCoordinator();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia({ manifest: validManifest("p") }), vault: await vaultWithPassword() });
  await assert.rejects(
    () => ctl.restoreLatest("p", { keepLocalAsConflict: false }),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.LeaseHeldByOther,
  );
});

test("restoreLatest REFUSES to overwrite dirty local with keepLocalAsConflict=false", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  writeFileSync(join(dataDir, "orig.txt"), "ORIGINAL");
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true, baseRevision: 1, localRevision: 1 });
  const client = new FakeCoordinator();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const kopia = new FakeKopia({ manifest: validManifest("p") });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  await assert.rejects(
    () => ctl.restoreLatest("p", { keepLocalAsConflict: false }),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.ConflictDetected,
  );
  // Nothing was restored; original data untouched, still dirty.
  assert.equal(kopia.restoreCalls, 0);
  assert.equal(readFileSync(join(dataDir, "orig.txt"), "utf8"), "ORIGINAL");
  assert.equal(pm.getSyncState("p")!.dirty, true);
  await ctl.shutdown();
});

test("restoreLatest happy path swaps in remote and clears dirty", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const dataDir = join(parent, "p");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "orig.txt"), "ORIGINAL");
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false, baseRevision: 1, localRevision: 1 });
  const client = new FakeCoordinator();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const kopia = new FakeKopia({ manifest: validManifest("p"), payload: { "new.txt": "NEW" } });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  const status = await ctl.restoreLatest("p", { keepLocalAsConflict: false });
  assert.equal(status.localRevision, 5);
  assert.equal(status.dirty, false);
  assert.equal(readFileSync(join(dataDir, "new.txt"), "utf8"), "NEW");
  assert.equal(existsSync(join(dataDir, "orig.txt")), false, "old live content replaced");
  await ctl.shutdown();
});

// ── restoreLatest atomic rollback (req 5) ───────────────────────────────────

test("restoreLatest: restore failure leaves original data + DB unchanged", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const dataDir = join(parent, "p");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "orig.txt"), "ORIGINAL");
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false, baseRevision: 1, localRevision: 1, remoteRevision: 5 });
  const client = new FakeCoordinator();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const kopia = new FakeKopia({ manifest: validManifest("p") });
  kopia.restoreError = new Error("kopia restore blew up");
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  await assert.rejects(() => ctl.restoreLatest("p", { keepLocalAsConflict: false }));
  // Original live dir intact; DB row unchanged.
  assert.equal(readFileSync(join(dataDir, "orig.txt"), "utf8"), "ORIGINAL");
  const s = pm.getSyncState("p")!;
  assert.equal(s.localRevision, 1, "revision not advanced on failed restore");
  assert.equal(s.baseRevision, 1);
  // No leftover staging/backup dirs in parent.
  assert.deepEqual(readdirSync(parent).filter((n: string) => n.startsWith(".")), []);
  await ctl.shutdown();
});

test("restoreLatest: DB-update failure AFTER swap restores original from backup", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const dataDir = join(parent, "p");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "orig.txt"), "ORIGINAL");
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false, baseRevision: 1, localRevision: 1, remoteRevision: 5 });
  const client = new FakeCoordinator();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const kopia = new FakeKopia({ manifest: validManifest("p"), payload: { "new.txt": "NEW" } });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  // Fail the post-swap DB update.
  pm.failNextUpsert = true;
  await assert.rejects(() => ctl.restoreLatest("p", { keepLocalAsConflict: false }));
  // Original live dir must be restored byte-identically from the backup.
  assert.equal(readFileSync(join(dataDir, "orig.txt"), "utf8"), "ORIGINAL");
  assert.equal(existsSync(join(dataDir, "new.txt")), false, "restored content rolled back");
  const s = pm.getSyncState("p")!;
  assert.equal(s.localRevision, 1, "revision reverted after rollback");
  assert.equal(s.baseRevision, 1);
  // No leftover staging/backup dirs.
  assert.deepEqual(readdirSync(parent).filter((n: string) => n.startsWith(".")), []);
  await ctl.shutdown();
});

test("restoreLatest: conflict rollback deletes conflict profile when restore fails", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const dataDir = join(parent, "p");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "orig.txt"), "ORIGINAL");
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true, baseRevision: 1, localRevision: 1, remoteRevision: 5 });
  const client = new FakeCoordinator();
  client.state = { currentRevision: 5, latestSnapshotId: "snap5" };
  const kopia = new FakeKopia({ manifest: validManifest("p") });
  kopia.restoreError = new Error("kopia restore blew up");
  const { ctl, root } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
  await ctl.acquire("p");
  const before = pm.profiles.size;
  await assert.rejects(() => ctl.restoreLatest("p", { keepLocalAsConflict: true }));
  // Conflict profile created then rolled back → profile set unchanged.
  assert.equal(pm.profiles.size, before, "conflict profile row deleted on rollback");
  assert.equal(pm.getSyncState("p")!.dirty, true, "original still dirty (nothing restored)");
  assert.equal(readFileSync(join(dataDir, "orig.txt"), "utf8"), "ORIGINAL");
  assert.ok(root);
  await ctl.shutdown();
});

// ── connectExisting: path safety, lease-first, FK, rollback (req 3/4/6) ──────

test("connectExisting rejects unsafe profile ids (path traversal)", async () => {
  for (const bad of ["", ".", "..", "a/b", "a\\b", "../evil", "with space"]) {
    const pm = new FakeProfileManager();
    const client = new FakeCoordinator();
    client.state = { currentRevision: 3, latestSnapshotId: "snap3" };
    const { ctl } = makeController({ pm, driver: new FakeDriver(), client, vault: await vaultWithPassword() });
    await assert.rejects(
      () => ctl.connectExisting(bad),
      (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.InvalidInput,
      `expected reject for ${JSON.stringify(bad)}`,
    );
    // Never acquired a lease for an invalid id.
    assert.equal(client.acquireCalls, 0);
    await ctl.shutdown();
  }
});

test("assertSafePathSegment accepts normal ids and rejects unsafe ones", () => {
  assertSafePathSegment("profile_123");
  assertSafePathSegment("A-b.C");
  for (const bad of ["", "..", ".", "a/b", "a\\b", "x\u0000y", "spa ce"]) {
    assert.throws(() => assertSafePathSegment(bad), (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.InvalidInput);
  }
});

test("connectExisting: acquires lease BEFORE restore and succeeds (no FK violation)", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const client = new FakeCoordinator();
  client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
  const kopia = new FakeKopia({ manifest: validManifest("prof1", "Imported"), payload: { "data.txt": "D" } });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
  const res = await ctl.connectExisting("prof1");
  assert.equal(res.profileId, "prof1");
  // Lease acquired before restore.
  assert.equal(client.acquireCalls, 1);
  assert.ok(client.acquireCalls === 1);
  // Profile + sync state inserted; a SUCCESS op journalled after the row exists.
  assert.ok(pm.get("prof1"));
  assert.equal(pm.getSyncState("prof1")!.localRevision, 7);
  assert.equal(pm.ops.length, 1);
  assert.equal(pm.ops[0]!.status, "succeeded");
  assert.equal(pm.ops[0]!.profileId, "prof1");
  // Temporary lease released after a successful connect (bulk-restore-safe: the
  // normal path re-acquires on launch). connectExisting no longer retains it.
  assert.equal(client.releaseCalls, 1, "temporary lease released after connect");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((ctl as any).leases.has("prof1"), false, "lease not retained after connect");
  assert.equal(readFileSync(join(parent, "prof1", "data.txt"), "utf8"), "D");
  await ctl.shutdown();
});

test("connectExisting rollback: DB insert failure removes installed dir + releases lease (repro of prior FK failure)", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const client = new FakeCoordinator();
  client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
  const kopia = new FakeKopia({ manifest: validManifest("prof1") });
  pm.failInsertImported = true; // final rename ok, DB insert fails
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
  await assert.rejects(() => ctl.connectExisting("prof1"));
  // The newly-installed data dir must be removed.
  assert.equal(existsSync(join(parent, "prof1")), false, "installed dir removed on rollback");
  // No profile row, no orphaned journal entry (FK would have failed if journalled early).
  assert.equal(pm.get("prof1"), null);
  assert.equal(pm.ops.length, 0, "no journal entry written before the profile row existed");
  // Lease released + dropped.
  assert.equal(client.releaseCalls, 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((ctl as any).leases.has("prof1"), false, "acquired lease released and dropped");
  await ctl.shutdown();
});

test("connectExisting rejects a manifest whose id mismatches the requested id", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const client = new FakeCoordinator();
  client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
  // Manifest claims a different id → structural validation must reject.
  const kopia = new FakeKopia({ manifest: validManifest("someone-else") });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
  await assert.rejects(
    () => ctl.connectExisting("prof1"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.LocalStateCorrupt,
  );
  assert.equal(existsSync(join(parent, "prof1")), false);
  assert.equal(pm.get("prof1"), null);
  assert.equal(client.releaseCalls, 1, "lease released after manifest rejection");
  await ctl.shutdown();
});

test("connectExisting refuses when the final data dir already exists (never rm)", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const existing = join(parent, "prof1");
  mkdirSync(existing);
  writeFileSync(join(existing, "keep.txt"), "KEEP");
  const client = new FakeCoordinator();
  client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia({ manifest: validManifest("prof1") }), vault: await vaultWithPassword(), root: parent });
  await assert.rejects(
    () => ctl.connectExisting("prof1"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.LocalStateCorrupt,
  );
  // Pre-existing dir untouched; no lease acquired.
  assert.equal(readFileSync(join(existing, "keep.txt"), "utf8"), "KEEP");
  assert.equal(client.acquireCalls, 0);
  await ctl.shutdown();
});

test("connectExisting rejects a manifest carrying a forbidden secret field", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const client = new FakeCoordinator();
  client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
  const tampered = validManifest("prof1") as Record<string, unknown>;
  (tampered.proxy as unknown) = { type: "http", host: "h", port: 1, password: "leak" };
  const kopia = new FakeKopia({ manifest: tampered });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
  await assert.rejects(() => ctl.connectExisting("prof1"));
  assert.equal(existsSync(join(parent, "prof1")), false);
  assert.equal(pm.get("prof1"), null);
  await ctl.shutdown();
});

// ── Storage coordinator: capability, config rebuild, test coordination ──────

test("acquire is BLOCKED when the store fails the conditional-write capability probe", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeCoordinator();
  client.capabilityOk = false; // store ignores If-Match/If-None-Match
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, vault: await vaultWithPassword() });
  await assert.rejects(
    () => ctl.acquire("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.StorageUnreachable,
  );
  // No lease installed when the capability gate fails.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((ctl as any).leases.has("p"), false);
  await ctl.shutdown();
});

test("backupAndPublish is BLOCKED when capability probe fails (no publish issued)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia(), vault: await vaultWithPassword() });
  await ctl.acquire("p"); // capability ok here
  // Now the store loses conditional-write support before publish.
  client.capabilityOk = false;
  await assert.rejects(
    () => ctl.backupAndPublish("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.StorageUnreachable,
  );
  assert.equal(client.publishCalls, 0, "capability failure must block the publish");
  assert.equal(pm.getSyncState("p")!.dirty, true, "dirty preserved when publish blocked");
  await ctl.shutdown();
});

test("testStorageCoordination runs health + forced capability and reports support", async () => {
  const pm = new FakeProfileManager();
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, vault: await vaultWithPassword() });
  const before = client.capabilityProbeCalls;
  const res = await ctl.testStorageCoordination();
  assert.equal(res.healthy, true);
  assert.equal(res.capability.ok, true);
  assert.equal(res.conditionalWritesSupported, true);
  assert.ok(client.capabilityProbeCalls > before, "forced capability probe ran");
  await ctl.shutdown();
});


test("testStorageCoordination succeeds without reading an encryption password", async () => {
  const vault = new FakeCredentialVault();
  await vault.set("s3AccessKeyId", "AKIA-connection-test");
  await vault.set("s3SecretAccessKey", "s3-connection-secret");
  const reads: string[] = [];
  const originalGet = vault.get.bind(vault);
  vault.get = async (name: string) => {
    reads.push(name);
    return originalGet(name);
  };

  const client = new FakeCoordinator();
  const { ctl } = makeController({
    pm: new FakeProfileManager(),
    driver: new FakeDriver(),
    client,
    vault,
  });
  const result = await ctl.testStorageCoordination();

  assert.equal(result.conditionalWritesSupported, true);
  assert.equal(await vault.has("kopiaPassword"), false);
  assert.equal(reads.includes("kopiaPassword"), false, "connection test never reads backup secret");
  await ctl.shutdown();
});

test("failed S3 tests keep structured detail and log only sanitized connection context", async () => {
  const accessKey = "AKIA-CANARY-NOT-IN-LOG";
  const secretKey = "SECRET-CANARY-NOT-IN-LOG";
  const vault = new FakeCredentialVault();
  await vault.set("s3AccessKeyId", accessKey);
  await vault.set("s3SecretAccessKey", secretKey);
  const settings = makeSettings();
  settings.sync.s3Endpoint =
    "https://endpoint-user:endpoint-password@s3.example.test/path?token=query-secret#fragment";
  settings.sync.s3Bucket = "";
  const logCalls: unknown[][] = [];
  const logger = { error: (...args: unknown[]) => logCalls.push(args) };
  const { ctl } = makeController({
    pm: new FakeProfileManager(),
    driver: new FakeDriver(),
    vault,
    settings,
    logger,
  });

  const result = await ctl.testStorageCoordination();
  assert.equal(result.conditionalWritesSupported, false);
  assert.equal(result.capability.failedCheck, "unconfigured");
  assert.equal(
    result.capability.message,
    "Storage bucket is not configured — set it before coordinating",
  );
  assert.equal(result.capability.message?.includes("[object Object]"), false);

  const logged = JSON.stringify(logCalls);
  assert.match(logged, /S3 connection test failed/);
  assert.match(logged, /https:\/\/s3\.example\.test/);
  assert.doesNotMatch(logged, /endpoint-user|endpoint-password|query-secret|path|fragment/);
  assert.doesNotMatch(logged, new RegExp(accessKey));
  assert.doesNotMatch(logged, new RegExp(secretKey));
  await ctl.shutdown();
});

test("storage diagnostic formatters preserve messages and strip unsafe endpoint parts", () => {
  assert.equal(
    describeStorageError(syncError(SyncErrorCode.InvalidInput, "bucket is required")),
    "bucket is required",
  );
  assert.equal(describeStorageError({ unexpected: true }), "Unknown storage error");
  assert.equal(
    safeStorageEndpoint("https://user:pass@s3.example.test/path?q=secret#fragment"),
    "https://s3.example.test",
  );
});
test("testStorageCoordination reports unsupported conditional writes", async () => {
  const pm = new FakeProfileManager();
  const client = new FakeCoordinator();
  client.capabilityOk = false;
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, vault: await vaultWithPassword() });
  const res = await ctl.testStorageCoordination();
  assert.equal(res.conditionalWritesSupported, false);
  assert.equal(res.capability.ok, false);
  assert.ok(res.capability.failedCheck);
  await ctl.shutdown();
});

test("a config change (bucket) rebuilds the storage coordinator via the factory", async () => {
  // Use the real factory (not the injected coordinator) so we can observe a
  // rebuild. buildCoordinator returns a distinct fake per effective config.
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });

  const built: Array<{ bucket: string; controlPrefix: string }> = [];
  const settings = makeSettings();
  const vault = await vaultWithPassword();
  await vault.set("s3AccessKeyId", "AKIA-test");
  await vault.set("s3SecretAccessKey", "secret-test");
  const root = mkdtempSync(join(tmpdir(), "mz-ctl-"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    settingsStore: new FakeSettingsStore(settings),
    getSettings: () => settings,
    onSettingsUpdated: (next: ReturnType<typeof makeSettings>) => {
      Object.assign(settings, next);
    },
    profileManager: pm,
    vault,
    driver: new FakeDriver(),
    profilesRoot: root,
    kopiaConfigDefault: join(root, "kopia.config"),
    coordinatorFactoryDeps: {
      buildCoordinator: (config: { bucket: string; controlPrefix: string }) => {
        built.push({ bucket: config.bucket, controlPrefix: config.controlPrefix });
        return new FakeCoordinator();
      },
    },
    makeKopia: () => new FakeKopia(),
    sameVolume: () => true,
  };
  const ctl = new SyncController(deps);

  await ctl.acquire("p");
  assert.equal(built.length, 1, "coordinator built once for the initial config");
  assert.equal(built[0]!.controlPrefix, "multizen-control");

  // Change the bucket → factory reset + rebuild on next use.
  await ctl.updateConfig({ s3Bucket: "another-bucket" });
  await ctl.acquire("p");
  assert.equal(built.length, 2, "coordinator rebuilt after a bucket change");
  assert.equal(built[1]!.bucket, "another-bucket");

  // No further change → cached, no rebuild.
  await ctl.acquire("p");
  assert.equal(built.length, 2, "no rebuild when config is unchanged");
  await ctl.shutdown();
});

test("connectExisting acquires via the coordinator interface (no Access fields present)", async () => {
  const pm = new FakeProfileManager();
  const parent = mkdtempSync(join(tmpdir(), "mz-parent-"));
  const client = new FakeCoordinator();
  client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
  const kopia = new FakeKopia({ manifest: validManifest("prof1", "Imported"), payload: { "d.txt": "D" } });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
  await ctl.connectExisting("prof1");
  assert.equal(client.acquireCalls, 1, "acquired via coordinator before restore");
  // The coordinator surface carries no Worker/Access shape at all.
  assert.equal((client as unknown as Record<string, unknown>).accessClientId, undefined);
  assert.equal((client as unknown as Record<string, unknown>).workerUrl, undefined);
  await ctl.shutdown();
});

// ── Global enable/disable authority (Section A) ─────────────────────────────

test("updateConfig adopts the replacing settings object so enabled true→false does not stay checked", async () => {
  let cachedSettings = makeSettings();
  let persistedSettings = makeSettings();
  cachedSettings.sync.enabled = true;
  persistedSettings.sync.enabled = true;

  // Unlike the original FakeSettingsStore, the real SettingsStore returns a
  // brand-new object. This reproduces the main-process stale-reference bug.
  const replacingStore = {
    async update(patch: { sync?: Record<string, unknown> }) {
      persistedSettings = {
        ...persistedSettings,
        sync: { ...persistedSettings.sync, ...(patch.sync ?? {}) },
      };
      return persistedSettings;
    },
  };

  const root = mkdtempSync(join(tmpdir(), "mz-settings-cache-"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    settingsStore: replacingStore,
    getSettings: () => cachedSettings,
    onSettingsUpdated: (next: ReturnType<typeof makeSettings>) => {
      cachedSettings = next;
    },
    profileManager: new FakeProfileManager(),
    vault: new FakeCredentialVault(),
    driver: new FakeDriver(),
    profilesRoot: root,
    kopiaConfigDefault: join(root, "kopia.config"),
    coordinator: new FakeCoordinator(),
    makeKopia: () => new FakeKopia(),
    sameVolume: () => true,
  };
  const ctl = new SyncController(deps);

  const disabled = await ctl.updateConfig({ enabled: false });
  assert.equal(disabled.enabled, false, "returned view reflects the unchecked value");
  assert.equal(ctl.configView().enabled, false, "controller no longer reads stale true");
  assert.equal(cachedSettings.sync.enabled, false, "main-owned cache adopted replacement");
  assert.equal(persistedSettings.sync.enabled, false, "replacement store persisted false");

  await ctl.updateConfig({ enabled: true });
  await ctl.updateConfig({ enabled: false });
  const reloaded = JSON.parse(JSON.stringify(persistedSettings)) as ReturnType<
    typeof makeSettings
  >;
  assert.equal(reloaded.sync.enabled, false, "true→false survives an equivalent reload");
  await ctl.shutdown();
});

test("status exposes globalEnabled reflecting the master switch", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeCoordinator() });
  assert.equal(ctl.status("p").globalEnabled, true);
  await ctl.updateConfig({ enabled: false });
  assert.equal(ctl.status("p").globalEnabled, false);
  await ctl.shutdown();
});

test("cloud operations refuse with SyncDisabled when global sync is off", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia(), vault: await vaultWithPassword() });
  await ctl.updateConfig({ enabled: false });
  const isDisabled = (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.SyncDisabled;

  await assert.rejects(() => ctl.testStorageCoordination(), isDisabled);
  await assert.rejects(() => ctl.acquire("p"), isDisabled);
  await assert.rejects(() => ctl.backupAndPublish("p"), isDisabled);
  await assert.rejects(() => ctl.restoreLatest("p", { keepLocalAsConflict: false }), isDisabled);
  await assert.rejects(() => ctl.connectExisting("other"), isDisabled);
  // No storage contact happened.
  assert.equal(client.acquireCalls, 0);
  assert.equal(client.publishCalls, 0);
  await ctl.shutdown();
});

test("configuration edits and secret saves remain available while global off", async () => {
  const pm = new FakeProfileManager();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeCoordinator() });
  await ctl.updateConfig({ enabled: false });
  // Config edit still works.
  const cfg = await ctl.updateConfig({ s3Bucket: "still-editable" });
  assert.equal(cfg.s3Bucket, "still-editable");
  // Secret save/delete still work (no throw).
  await ctl.saveSecret("kopiaPassword", "pw");
  await ctl.deleteSecret("kopiaPassword");
  await ctl.shutdown();
});

test("beforeLaunch while global off allows local launch and marks a synced profile dirty (no lease required)", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client });
  await ctl.updateConfig({ enabled: false });
  // Must NOT throw (no lease requirement while global off) and must mark dirty.
  await ctl.beforeLaunch("p");
  assert.equal(pm.getSyncState("p")!.dirty, true, "dirty so re-enabling can't overwrite local");
  assert.equal(client.acquireCalls, 0, "no lease acquired while global off");
  await ctl.shutdown();
});

test("enabling a profile is blocked while global off, disabling stays allowed", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeCoordinator() });
  await ctl.updateConfig({ enabled: false });
  // Enabling is refused.
  assert.throws(
    () => ctl.enable("p", true),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.SyncDisabled,
  );
  // Disabling an already-enabled profile is allowed.
  const s = ctl.enable("p", false);
  assert.equal(s.syncEnabled, false);
  await ctl.shutdown();
});

test("disabling global sync clears renewal timers/leases, closes owned browser, and attempts release", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true });
  const client = new FakeCoordinator();
  const driver = new FakeDriver();
  const { ctl } = makeController({ pm, driver, client, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.ok((ctl as any).leases.has("p"), "lease held before disable");
  driver.setRunning("p", true);

  await ctl.updateConfig({ enabled: false });

  // Running owned browser was closed.
  assert.ok(driver.closed.includes("p"), "owned browser closed on disable");
  // Best-effort remote release attempted.
  assert.ok(client.releaseCalls >= 1, "lease release attempted through coordinator");
  // Lease + renewal timer cleared.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((ctl as any).leases.has("p"), false, "lease dropped after disable");
  await ctl.shutdown();
});

// ── Backup auto-creates encrypted storage (Section B) ───────────────────────

test("first Backup & Publish auto-creates encrypted storage via ensureRepository (not connect)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  kopia.ensureCreated = true; // repo did not exist → created on first backup
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  await ctl.backupAndPublish("p");
  assert.equal(kopia.ensureRepositoryCalls, 1, "backup ensures the repository exists");
  assert.equal(kopia.connectCalls, 0, "backup no longer calls connect directly");
  assert.equal(client.publishCalls, 1);
  await ctl.shutdown();
});

test("a later Backup & Publish connects to existing storage (ensureRepository returns created:false)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  kopia.ensureCreated = false; // repo already exists → connect only
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });
  await ctl.acquire("p");
  await ctl.backupAndPublish("p");
  assert.equal(kopia.ensureRepositoryCalls, 1);
  assert.equal(client.publishCalls, 1);
  await ctl.shutdown();
});

test("Backup & Publish creates storage when the exact uninitialized error escapes the adapter", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  kopia.ensureRepositoryError = Object.assign(
    new Error(
      "repository connect failed with exit code 1: error connecting to repository: repository not initialized in the provided storage",
    ),
    {
      result: {
        code: 1,
        stderr:
          "error connecting to repository: repository not initialized in the provided storage\n",
        stdout: "",
      },
    },
  );
  const { ctl } = makeController({
    pm,
    driver: new FakeDriver(),
    client,
    kopia,
    vault: await vaultWithPassword(),
  });

  await ctl.acquire("p");
  await ctl.backupAndPublish("p");

  assert.equal(kopia.ensureRepositoryCalls, 1);
  assert.equal(kopia.createRepositoryCalls, 1);
  assert.equal(kopia.snapshotCalls, 1);
  assert.equal(client.publishCalls, 1);
  await ctl.shutdown();
});

// ── Automatic backup after browser close (Section B) ────────────────────────

test("onBrowserClosed backs up automatically for a dirty profile holding a lease", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });

  await ctl.acquire("p"); // installs an unexpired in-memory lease
  await ctl.onBrowserClosed("p");

  assert.equal(kopia.snapshotCalls, 1, "auto backup created exactly one snapshot");
  assert.equal(client.publishCalls, 1, "auto backup published one revision");
  assert.equal(pm.getSyncState("p")!.dirty, false, "dirty cleared after accepted publish");
  assert.equal(pm.getSyncState("p")!.localRevision, 1, "revision advanced");
  // Normal lifecycle: after a successful close-backup the lease is auto-released
  // so the profile is free for another device (no manual "Release" needed).
  assert.equal(client.releaseCalls, 1, "auto backup releases the lease after a successful publish");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((ctl as any).leases.has("p"), false, "lease dropped locally after release");
  await ctl.shutdown();
});

test("backup includes shared extension files and selection in the profile snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "mz-shared-ext-"));
  const dataDir = join(root, "profiles", "p");
  const extId = "a".repeat(32);
  const storeDir = join(root, "extension-store", extId, "1.0");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, "manifest.json"), '{"name":"Example"}');
  const pm = new FakeProfileManager();
  pm.profiles.set("p", {
    id: "p",
    name: "P",
    dataDir,
    extensions: [{ id: extId, name: "Example", version: "1.0", enabled: true, scope: "shared", dir: "", source: "web-store" }],
  } as never);
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeCoordinator(), kopia: new FakeKopia(), vault: await vaultWithPassword(), root: join(root, "profiles") });
  try {
    await ctl.acquire("p");
    await ctl.backupAndPublish("p");
    const manifest = JSON.parse(readFileSync(join(dataDir, ".multizen-sync", "profile-manifest.json"), "utf8"));
    assert.equal(manifest.extensions[0].scope, "profile");
    assert.equal(manifest.extensions[0].enabled, true);
    assert.equal(readFileSync(join(dataDir, manifest.extensions[0].dir, "manifest.json"), "utf8"), '{"name":"Example"}');
  } finally {
    await ctl.shutdown();
  }
});

test("automatic reconciliation publishes a changed closed profile while the app stays open", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-auto-sync-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  const vault = await vaultWithPassword();
  await vault.set("s3AccessKeyId", "access");
  await vault.set("s3SecretAccessKey", "secret");
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault });
  try {
    await ctl.autoBootstrap();
    pm.markSyncDirty("p");
    ctl.startAutoSync(10);
    const deadline = Date.now() + 1000;
    while (client.publishCalls === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The 10ms timer fires many times across this window, yet forced ticks are
    // single-flight-bounded, so exactly one publish results — not one per tick.
    assert.equal(client.publishCalls, 1);
    assert.equal(pm.getSyncState("p")?.dirty, false);
  } finally {
    await ctl.shutdown();
  }
});


test("beforeLaunch waits for auto backup and reloads the published revision", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({
    profileId: "p",
    syncEnabled: true,
    dirty: true,
    localRevision: 0,
    baseRevision: 0,
    remoteRevision: 0,
  });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  kopia.armGate();
  const { ctl } = makeController({
    pm,
    driver: new FakeDriver(),
    client,
    kopia,
    vault: await vaultWithPassword(),
  });

  await ctl.acquire("p");
  const automatic = ctl.onBrowserClosed("p");
  const relaunch = ctl.beforeLaunch("p");
  kopia.releaseGate();
  await automatic;
  await relaunch;

  const state = pm.getSyncState("p")!;
  assert.equal(state.localRevision, 1);
  assert.equal(state.baseRevision, 1);
  assert.equal(state.remoteRevision, 1);
  assert.equal(state.dirty, true, "successful relaunch marks the fresh revision dirty again");
  assert.equal(kopia.snapshotCalls, 1);
  assert.equal(client.publishCalls, 1);
  await ctl.shutdown();
});
test("onBrowserClosed is a no-op for a clean profile (no Kopia/storage contact)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });

  await ctl.acquire("p");
  await ctl.onBrowserClosed("p");

  assert.equal(kopia.snapshotCalls, 0, "clean close never snapshots");
  assert.equal(client.publishCalls, 0, "clean close never publishes");
  await ctl.shutdown();
});

test("onBrowserClosed skips when this device holds no lease", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });

  // No acquire → no in-memory lease.
  await ctl.onBrowserClosed("p");

  assert.equal(kopia.snapshotCalls, 0, "no-lease close never snapshots");
  assert.equal(client.publishCalls, 0, "no-lease close never publishes");
  assert.equal(pm.getSyncState("p")!.dirty, true, "dirty preserved");
  await ctl.shutdown();
});

test("onBrowserClosed skips when global Cloud Sync is off", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });

  await ctl.acquire("p"); // lease installed while enabled
  // Turn global sync off WITHOUT winding down the lease here: we want to prove
  // the close handler itself skips when the master switch is off. Patch the
  // config directly to avoid stopCoordination dropping the lease.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctl as any).cfg().enabled = false;

  await ctl.onBrowserClosed("p");

  assert.equal(kopia.snapshotCalls, 0, "global-off close never snapshots");
  assert.equal(client.publishCalls, 0, "global-off close never publishes");
  await ctl.shutdown();
});

test("onBrowserClosed failure keeps dirty, issues no publish, and is redacted", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  const vault = await vaultWithPassword();
  const SECRET = "pw-secret-1234";
  // The snapshot throws AND embeds the encryption password in its message so we
  // can prove the main-process log is redacted.
  kopia.snapshotError = new Error(`boom leaking ${SECRET} in the failure text`);
  const logged: Array<{ msg: string; ctx: unknown }> = [];
  const logger = {
    error: (msg: string, ctx?: unknown) => {
      logged.push({ msg, ctx });
    },
  };
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault, logger });

  await ctl.acquire("p");
  // Must NOT throw out of the (never-rejecting) auto backup promise.
  await ctl.onBrowserClosed("p");

  assert.equal(client.publishCalls, 0, "no publish when the snapshot fails");
  assert.equal(pm.getSyncState("p")!.dirty, true, "dirty preserved on failure");
  const serialized = JSON.stringify(logged);
  assert.ok(serialized.includes("[REDACTED]"), "failure summary is redacted");
  assert.ok(!serialized.includes(SECRET), "secret never appears in the log");
  await ctl.shutdown();
});

test("duplicate onBrowserClosed calls produce exactly one snapshot + publish", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  kopia.armGate(); // hold the first backup in flight (deterministic, no sleeps)
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });

  await ctl.acquire("p");
  const first = ctl.onBrowserClosed("p");
  const second = ctl.onBrowserClosed("p"); // dedup: joins the in-flight backup
  kopia.releaseGate();
  await Promise.all([first, second]);

  assert.equal(kopia.snapshotCalls, 1, "deduped to a single snapshot");
  assert.equal(client.publishCalls, 1, "deduped to a single publish");
  assert.equal(pm.getSyncState("p")!.dirty, false);
  await ctl.shutdown();
});

test("manual backup joins an in-flight auto backup instead of double-publishing", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  kopia.armGate();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });

  await ctl.acquire("p");
  const auto = ctl.onBrowserClosed("p");
  const manual = ctl.backupAndPublish("p"); // must JOIN, not race
  kopia.releaseGate();
  await Promise.all([auto, manual]);

  assert.equal(kopia.snapshotCalls, 1, "manual joined the auto backup (one snapshot)");
  assert.equal(client.publishCalls, 1, "manual joined the auto backup (one publish)");
  await ctl.shutdown();
});


test("global disable waits for in-flight auto backup before releasing the lease", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  kopia.armGate();
  const { ctl } = makeController({
    pm,
    driver: new FakeDriver(),
    client,
    kopia,
    vault: await vaultWithPassword(),
  });

  await ctl.acquire("p");
  const automatic = ctl.onBrowserClosed("p");
  const disabling = ctl.updateConfig({ enabled: false });
  kopia.releaseGate();
  await Promise.all([automatic, disabling]);

  assert.deepEqual(client.events, ["publish", "release"]);
  assert.equal(pm.getSyncState("p")!.dirty, false);
  assert.equal(ctl.configView().enabled, false);
  await ctl.shutdown();
});
test("shutdown awaits an in-flight auto backup before clearing leases", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  kopia.armGate();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword() });

  await ctl.acquire("p");
  const auto = ctl.onBrowserClosed("p"); // starts, blocks on the gate
  const shutdownPromise = ctl.shutdown(); // must await the in-flight backup
  kopia.releaseGate();
  await Promise.all([auto, shutdownPromise]);

  assert.equal(client.publishCalls, 1, "auto backup completed before shutdown finished");
  assert.equal(pm.getSyncState("p")!.dirty, false, "publish landed before leases cleared");
});

// ── Endpoint normalization (Section A) ──────────────────────────────────────

test("updateConfig normalizes a copied R2 URL with /bucket?query to its origin", async () => {
  const pm = new FakeProfileManager();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeCoordinator() });
  const view = await ctl.updateConfig({
    s3Endpoint: "https://account.r2.cloudflarestorage.com/bucket?x=y",
  });
  assert.equal(view.s3Endpoint, "https://account.r2.cloudflarestorage.com");
  assert.equal(
    ctl.configView().s3Endpoint,
    "https://account.r2.cloudflarestorage.com",
    "persisted config carries the normalized origin",
  );
  await ctl.shutdown();
});

test("updateConfig leaves an empty endpoint empty and rejects a malformed one", async () => {
  const pm = new FakeProfileManager();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client: new FakeCoordinator() });
  const cleared = await ctl.updateConfig({ s3Endpoint: "" });
  assert.equal(cleared.s3Endpoint, "", "empty stays empty (AWS default resolution)");
  await assert.rejects(
    () => ctl.updateConfig({ s3Endpoint: "ftp://not-http" }),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.InvalidInput,
  );
  await ctl.shutdown();
});

test("legacy path-bearing endpoint yields an origin for S3 and a host for Kopia", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });

  // Simulate a legacy setting persisted WITH a path/query (never re-entered).
  const settings = makeSettings();
  settings.sync.s3Endpoint = "https://account.r2.cloudflarestorage.com/bucket?x=y";

  const built: Array<{ endpoint: string }> = [];
  const vault = await vaultWithPassword();
  await vault.set("s3AccessKeyId", "AKIA-test");
  await vault.set("s3SecretAccessKey", "secret-test");
  const kopia = new FakeKopia();
  const root = mkdtempSync(join(tmpdir(), "mz-ctl-"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    settingsStore: new FakeSettingsStore(settings),
    getSettings: () => settings,
    onSettingsUpdated: (next: ReturnType<typeof makeSettings>) => {
      Object.assign(settings, next);
    },
    profileManager: pm,
    vault,
    driver: new FakeDriver(),
    profilesRoot: root,
    kopiaConfigDefault: join(root, "kopia.config"),
    coordinatorFactoryDeps: {
      buildCoordinator: (config: { endpoint: string }) => {
        built.push({ endpoint: config.endpoint });
        return new FakeCoordinator();
      },
    },
    makeKopia: () => kopia,
    sameVolume: () => true,
  };
  const ctl = new SyncController(deps);

  // Coordinator config/factory sees the ORIGIN even though the stored value has a path.
  await ctl.acquire("p");
  assert.equal(built.length, 1);
  assert.equal(built[0]!.endpoint, "https://account.r2.cloudflarestorage.com");

  // Kopia expects host[:port], not a URL. Passing https:// here produces its
  // "Endpoint url cannot have fully qualified paths" error.
  let repoTarget: { endpoint?: string; disableTls?: boolean } | undefined;
  const origEnsure = kopia.ensureRepository.bind(kopia);
  kopia.ensureRepository = async (target?: { endpoint?: string; disableTls?: boolean }) => {
    repoTarget = target;
    return origEnsure();
  };
  await ctl.backupAndPublish("p");
  assert.equal(repoTarget?.endpoint, "account.r2.cloudflarestorage.com");
  assert.equal(repoTarget?.disableTls, false);
  await ctl.shutdown();
});

test("exportDiagnostics reports the normalized effective endpoint for a legacy path setting", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true });
  const settings = makeSettings();
  settings.sync.s3Endpoint = "https://account.r2.cloudflarestorage.com/bucket?token=abc";
  const { ctl } = makeController({
    pm,
    driver: new FakeDriver(),
    client: new FakeCoordinator(),
    settings,
  });
  const bundle = await ctl.exportDiagnostics("p");
  assert.equal(
    bundle.storage.endpoint,
    "https://account.r2.cloudflarestorage.com",
    "diagnostics carry the origin only — no path, no query/token",
  );
  assert.ok(!JSON.stringify(bundle).includes("token=abc"), "query/token never leaks");
  await ctl.shutdown();
});

// ── Whole-library bootstrap + destructive delete/revive ─────────────────────

/**
 * A vault preloaded with the encryption password AND both S3 credentials, so
 * Cloud Sync readiness can be satisfied (all secrets present).
 */
async function readyVault(): Promise<FakeCredentialVault> {
  const v = await vaultWithPassword();
  await v.set("s3AccessKeyId", "AKIA-test");
  await v.set("s3SecretAccessKey", "secret-test");
  return v;
}

test("bootstrap: fresh device discovers + restores every remote profile", async () => {
  const pm = new FakeProfileManager();
  const client = new FakeCoordinator();
  client.remoteProfiles = [
    { profileId: "remoteA", currentRevision: 3, latestSnapshotId: "snapA" },
    { profileId: "remoteB", currentRevision: 1, latestSnapshotId: "snapB" },
  ];
  const kopia = new FakeKopia();
  kopia.dynamicManifest = true;
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await readyVault() });

  // Flip capability so readiness is satisfied, then run a forced bootstrap.
  const summary = await ctl.syncAll();
  assert.equal(summary.phase, "done");
  assert.equal(summary.remoteDiscovered, 2);
  assert.equal(summary.restored, 2, "both missing remote profiles restored");
  // Both profiles now exist locally, enabled + clean.
  for (const id of ["remoteA", "remoteB"]) {
    assert.ok(pm.get(id), `${id} installed locally`);
    assert.equal(pm.getSyncState(id)?.syncEnabled, true);
    assert.equal(pm.getSyncState(id)?.dirty, false);
  }
  // Temporary lease was released after each restore (not held).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((ctl as any).leases.size, 0, "no leases retained after bulk restore");
  assert.ok(client.releaseCalls >= 2, "temporary leases released");
  await ctl.shutdown();
});

test("bootstrap: never overwrites dirty same-id local data (reports conflict)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  writeFileSync(join(dataDir, "local.txt"), "LOCAL");
  pm.profiles.set("dup", { id: "dup", name: "Dup", dataDir });
  pm.upsertSyncState({ profileId: "dup", syncEnabled: true, dirty: true, baseRevision: 1, remoteRevision: 1, localRevision: 1 });
  const client = new FakeCoordinator();
  client.remoteProfiles = [{ profileId: "dup", currentRevision: 2, latestSnapshotId: "snapDup" }];
  const kopia = new FakeKopia();
  kopia.dynamicManifest = true;
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await readyVault() });

  const summary = await ctl.syncAll();
  assert.equal(summary.restored, 0, "dirty existing profile is NOT restored over");
  assert.equal(summary.failed, 1, "remote advancement is reported as a conflict failure");
  assert.equal(kopia.restoreCalls, 0, "no restore ran for dirty local state");
  // Local data untouched.
  assert.equal(readFileSync(join(dataDir, "local.txt"), "utf8"), "LOCAL");
  await ctl.shutdown();
});


test("bootstrap: restores a clean existing profile that is behind remote", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  writeFileSync(join(dataDir, "old.txt"), "OLD");
  pm.profiles.set("dup", { id: "dup", name: "Dup", dataDir });
  pm.upsertSyncState({
    profileId: "dup",
    syncEnabled: true,
    dirty: false,
    localRevision: 1,
    baseRevision: 1,
    remoteRevision: 1,
  });
  const client = new FakeCoordinator();
  client.remoteProfiles = [{ profileId: "dup", currentRevision: 2, latestSnapshotId: "snapDup" }];
  const kopia = new FakeKopia();
  kopia.dynamicManifest = true;
  const { ctl } = makeController({
    pm,
    driver: new FakeDriver(),
    client,
    kopia,
    vault: await readyVault(),
  });

  const summary = await ctl.syncAll();
  assert.equal(summary.restored, 1);
  assert.equal(summary.failed, 0);
  assert.equal(kopia.restoreCalls, 1);
  assert.equal(existsSync(join(dataDir, "old.txt")), false, "stale clean data was replaced");
  assert.equal(pm.getSyncState("dup")?.localRevision, 2);
  assert.equal(pm.getSyncState("dup")?.dirty, false);
  await ctl.shutdown();
});
test("bootstrap: partial per-profile failure does not abort the run (idempotent retry)", async () => {
  const pm = new FakeProfileManager();
  const client = new FakeCoordinator();
  client.remoteProfiles = [
    { profileId: "good", currentRevision: 1, latestSnapshotId: "snapGood" },
    { profileId: "bad", currentRevision: 1, latestSnapshotId: "snapBad" },
  ];
  const kopia = new FakeKopia();
  kopia.dynamicManifest = true;
  // Fail the restore for exactly one profile the first time.
  const origRestore = kopia.restore.bind(kopia);
  let failedOnce = false;
  kopia.restore = async (profileId: string, snap: string, dir: string) => {
    if (profileId === "bad" && !failedOnce) {
      failedOnce = true;
      throw new Error("transient restore failure");
    }
    return origRestore(profileId, snap, dir);
  };
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await readyVault() });

  const first = await ctl.syncAll();
  assert.equal(first.restored, 1, "good profile restored despite bad's failure");
  assert.equal(first.failed, 1);
  assert.ok(pm.get("good"));
  assert.ok(!pm.get("bad"), "failed profile rolled back (not half-installed)");

  // Retry is idempotent: "good" is now local (reconciled), "bad" now succeeds.
  const second = await ctl.syncAll();
  assert.ok(pm.get("bad"), "retry restores the previously-failed profile");
  assert.equal(second.restored, 1, "only the still-missing profile is restored on retry");
  await ctl.shutdown();
});

test("bootstrap: uploads a local-only dirty profile, defers a running one", async () => {
  const pm = new FakeProfileManager();
  const dataDirA = mkdtempSync(join(tmpdir(), "mz-a-"));
  const dataDirB = mkdtempSync(join(tmpdir(), "mz-b-"));
  pm.profiles.set("localA", { id: "localA", name: "A", dataDir: dataDirA });
  pm.profiles.set("localB", { id: "localB", name: "B", dataDir: dataDirB });
  pm.upsertSyncState({ profileId: "localA", syncEnabled: true, dirty: true });
  pm.upsertSyncState({ profileId: "localB", syncEnabled: true, dirty: true });
  const driver = new FakeDriver();
  driver.setRunning("localB", true); // running → must defer
  const client = new FakeCoordinator(); // no remote profiles
  const kopia = new FakeKopia();
  const { ctl } = makeController({ pm, driver, client, kopia, vault: await readyVault() });

  const summary = await ctl.syncAll();
  assert.equal(summary.uploaded, 1, "the non-running dirty profile is uploaded");
  assert.equal(summary.deferred, 1, "the running profile defers its upload to close");
  assert.equal(pm.getSyncState("localA")?.dirty, false, "uploaded profile cleared dirty");
  assert.equal(pm.getSyncState("localB")?.dirty, true, "running profile stays dirty (deferred)");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((ctl as any).leases.size, 0, "upload used a temporary lease, released after");
  await ctl.shutdown();
});

test("bootstrap: backfills existing profiles as sync-enabled", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("noRow", { id: "noRow", name: "NoRow", dataDir });
  // No sync-state row → bootstrap should backfill it enabled.
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await readyVault() });

  await ctl.syncAll();
  assert.equal(pm.getSyncState("noRow")?.syncEnabled, true, "existing profile backfilled enabled");
  await ctl.shutdown();
});

test("bootstrap: single-flight — concurrent triggers join one run", async () => {
  const pm = new FakeProfileManager();
  const client = new FakeCoordinator();
  client.remoteProfiles = [{ profileId: "remoteA", currentRevision: 1, latestSnapshotId: "snapA" }];
  const kopia = new FakeKopia();
  kopia.dynamicManifest = true;
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await readyVault() });
  // Make capability pass so readiness is satisfied (syncAll probes; here we
  // probe once then fire two concurrent maybeBootstrap calls).
  await ctl.testStorageCoordination();
  const listBefore = client.listProfilesCalls;
  const [a, b] = await Promise.all([ctl.maybeBootstrap({ force: true }), ctl.maybeBootstrap({ force: true })]);
  assert.strictEqual(a, b, "concurrent triggers return the SAME single-flight run");
  assert.equal(client.listProfilesCalls - listBefore, 1, "listProfiles ran exactly once");
  await ctl.shutdown();
});


test("autoBootstrap probes S3 once and syncs the library when settings are complete", async () => {
  const pm = new FakeProfileManager();
  const client = new FakeCoordinator();
  const { ctl } = makeController({
    pm,
    driver: new FakeDriver(),
    client,
    kopia: new FakeKopia(),
    vault: await readyVault(),
  });

  const beforeProbe = client.capabilityProbeCalls;
  const [first, second] = await Promise.all([ctl.autoBootstrap(), ctl.autoBootstrap()]);
  assert.equal(first.phase, "done");
  assert.equal(second.phase, "done");
  assert.equal(client.capabilityProbeCalls - beforeProbe, 1, "automatic S3 probe is single-flight");
  assert.equal(client.listProfilesCalls, 1, "whole-library discovery starts automatically");
  await ctl.shutdown();
});
test("bootstrap: no-op when Cloud Sync is not ready", async () => {
  const pm = new FakeProfileManager();
  const client = new FakeCoordinator();
  client.remoteProfiles = [{ profileId: "remoteA", currentRevision: 1, latestSnapshotId: "snapA" }];
  // Vault has NO secrets → not ready.
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia(), vault: new FakeCredentialVault() });
  const summary = await ctl.maybeBootstrap();
  assert.equal(summary.phase, "idle", "bootstrap does not run when not ready");
  assert.equal(client.listProfilesCalls, 0, "no remote listing when not ready");
  await ctl.shutdown();
});

test("beforeLaunch auto-acquires a lease (no manual acquire needed)", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false });
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, vault: await readyVault() });
  await ctl.beforeLaunch("p"); // no prior acquire()
  assert.equal(client.acquireCalls, 1, "beforeLaunch auto-acquired the lease");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.ok((ctl as any).leases.has("p"), "lease is held for the open browser");
  assert.equal(pm.getSyncState("p")?.dirty, true, "writable launch marks dirty");
  await ctl.shutdown();
});

test("close backup publishes then auto-releases the lease on success", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const driver = new FakeDriver();
  const { ctl } = makeController({ pm, driver, client, kopia: new FakeKopia(), vault: await readyVault() });
  await ctl.acquire("p");
  // Simulate close → auto backup.
  await ctl.onBrowserClosed("p");
  assert.equal(client.publishCalls, 1, "publish happened on close");
  assert.equal(pm.getSyncState("p")?.dirty, false, "dirty cleared after publish");
  assert.ok(client.releaseCalls >= 1, "lease auto-released after successful publish");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((ctl as any).leases.has("p"), false, "lease dropped locally");
  await ctl.shutdown();
});

test("close backup failure retains the lease AND dirty for retry", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  kopia.snapshotError = new Error("snapshot boom");
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await readyVault() });
  await ctl.acquire("p");
  await ctl.onBrowserClosed("p"); // never rejects
  assert.equal(pm.getSyncState("p")?.dirty, true, "dirty preserved on failure");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.ok((ctl as any).leases.has("p"), "lease retained for retry on failure");
  assert.equal(client.releaseCalls, 0, "no release on failed backup");
  await ctl.shutdown();
});

test("disableProfileSyncAndDeleteRemote: tombstone → snapshot delete → local disable, keeps local", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  writeFileSync(join(dataDir, "keep.txt"), "KEEP");
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: false, latestSnapshotId: "snapX" });
  const client = new FakeCoordinator();
  client.state = { currentRevision: 2, latestSnapshotId: "snapX" };
  const kopia = new FakeKopia();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await readyVault() });

  const res = await ctl.disableProfileSyncAndDeleteRemote("p");
  assert.equal(res.disabled, true);
  assert.deepEqual(client.tombstoneCalls, ["p"], "tombstone written first");
  assert.deepEqual(kopia.deleteProfileSnapshotsCalls, ["p"], "profile snapshots deleted");
  assert.ok(res.deletedSnapshotIds.length >= 1);
  assert.equal(pm.getSyncState("p")?.syncEnabled, false, "local sync disabled AFTER logical delete");
  // Local profile + data kept.
  assert.ok(pm.get("p"), "local profile row kept");
  assert.equal(readFileSync(join(dataDir, "keep.txt"), "utf8"), "KEEP", "local data kept");
  // Ordering: tombstone before delete before disable (events array proves the
  // tombstone preceded the snapshot delete on the coordinator side).
  assert.ok(client.events.indexOf("tombstone") < client.events.length, "tombstone recorded");
  await ctl.shutdown();
});

test("disableProfileSyncAndDeleteRemote: fails closed on snapshot-delete failure (no local disable)", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true });
  const client = new FakeCoordinator();
  client.state = { currentRevision: 1, latestSnapshotId: "snapX" };
  const kopia = new FakeKopia();
  kopia.deleteError = new Error("delete boom");
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await readyVault() });

  await assert.rejects(() => ctl.disableProfileSyncAndDeleteRemote("p"));
  assert.equal(pm.getSyncState("p")?.syncEnabled, true, "local sync STAYS enabled on failure (fail closed)");
  assert.ok(pm.get("p"), "local profile kept");
  assert.deepEqual(client.tombstoneCalls, ["p"], "durable tombstone was written before failure");
  // Lease released/dropped even on failure.
  assert.ok(client.releaseCalls >= 1, "lease release attempted after failed delete");

  // Retry must recognize the existing tombstone and resume snapshot deletion;
  // production coordinators refuse acquire on a tombstoned profile.
  kopia.deleteError = null;
  const retried = await ctl.disableProfileSyncAndDeleteRemote("p");
  assert.equal(retried.disabled, true);
  assert.equal(pm.getSyncState("p")?.syncEnabled, false);
  assert.deepEqual(client.tombstoneCalls, ["p"], "retry does not rewrite/reacquire tombstone");
  assert.deepEqual(kopia.deleteProfileSnapshotsCalls, ["p", "p"]);
  await ctl.shutdown();
});

test("disableProfileSyncAndDeleteRemote: idempotent when already disabled", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: false });
  const client = new FakeCoordinator();
  const kopia = new FakeKopia();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await readyVault() });
  const res = await ctl.disableProfileSyncAndDeleteRemote("p");
  assert.equal(res.disabled, true);
  assert.deepEqual(client.tombstoneCalls, [], "no tombstone when already disabled");
  assert.deepEqual(kopia.deleteProfileSnapshotsCalls, [], "no delete when already disabled");
  await ctl.shutdown();
});

test("disableProfileSyncAndDeleteRemote: refuses while the browser is running", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true });
  const driver = new FakeDriver();
  driver.setRunning("p", true);
  const { ctl } = makeController({ pm, driver, client: new FakeCoordinator(), kopia: new FakeKopia(), vault: await readyVault() });
  await assert.rejects(
    () => ctl.disableProfileSyncAndDeleteRemote("p"),
    (e: unknown) => isSyncError(e) && e.code === SyncErrorCode.BrowserStillRunning,
  );
  await ctl.shutdown();
});

test("reEnableProfileSync: revives a fresh generation, marks dirty for fresh upload", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-p-"));
  pm.profiles.set("p", { id: "p", name: "P", dataDir });
  pm.upsertSyncState({ profileId: "p", syncEnabled: false, localRevision: 5, baseRevision: 5, remoteRevision: 5 });
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia: new FakeKopia(), vault: await readyVault() });
  const status = await ctl.reEnableProfileSync("p");
  assert.deepEqual(client.reviveCalls, ["p"], "revive called for a fresh generation");
  assert.equal(status.syncEnabled, true);
  assert.equal(status.dirty, true, "marked dirty → uploads as a fresh baseline");
  assert.equal(pm.getSyncState("p")?.localRevision, 0, "revision line reset");
  await ctl.shutdown();
});

for (const engine of [undefined, "cloakbrowser", "camoufox"]) {
  test(`connectExisting preserves snapshot engine (${engine ?? "legacy"})`, async () => {
    const pm = new FakeProfileManager();
    const parent = mkdtempSync(join(tmpdir(), "mz-engine-"));
    const client = new FakeCoordinator();
    client.state = { currentRevision: 7, latestSnapshotId: "snap7" };
    const kopia = new FakeKopia({ manifest: { ...validManifest("prof1", "Imported"), engine } });
    const { ctl } = makeController({ pm, driver: new FakeDriver(), client, kopia, vault: await vaultWithPassword(), root: parent });
    try {
      await ctl.connectExisting("prof1");
      assert.equal(pm.get("prof1")?.engine, engine ?? "cloakbrowser");
    } finally {
      await ctl.shutdown();
      rmSync(parent, { recursive: true, force: true });
    }
  });
}

test("library upload waits until the driver launch finishes and defers the running profile", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const vault = await vaultWithPassword();
  await vault.set("s3AccessKeyId", "access");
  await vault.set("s3SecretAccessKey", "secret");
  const driver = new FakeDriver();
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver, client, vault });
  let started!: () => void;
  let finish!: () => void;
  const entering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const launch = ctl.launch("p", async () => {
    started();
    await gate;
    driver.setRunning("p", true);
  });
  await entering;
  const sync = ctl.autoBootstrap({ force: true });
  finish();
  await launch;
  const summary = await sync;
  assert.equal(summary.deferred, 1);
  assert.equal(client.releaseCalls, 0);
  assert.equal(client.publishCalls, 0);
  await ctl.shutdown();
});

test("a stale renewal failure cannot close the next session", async () => {
  const pm = new FakeProfileManager();
  pm.profiles.set("p", { id: "p", name: "P", dataDir: "/tmp/p" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true });
  const driver = new FakeDriver();
  const client = new FakeCoordinator();
  const { ctl } = makeController({ pm, driver, client });
  await ctl.acquire("p");
  let fail!: (err: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  client.renew = () =>
    new Promise((_resolve, reject) => {
      fail = reject;
      entered();
    });
  const renewal = (ctl as unknown as { renewLease(id: string): Promise<void> }).renewLease("p");
  await started;
  await ctl.release("p");
  await ctl.launch("p", async () => {
    driver.setRunning("p", true);
  });
  fail(new Error("old request"));
  await renewal;
  assert.equal(driver.isRunning("p"), true);
  assert.equal(driver.closed.length, 0);
  await ctl.shutdown();
});

test("launch waits for the background upload to publish and release its own lease", async () => {
  const pm = new FakeProfileManager();
  const dataDir = mkdtempSync(join(tmpdir(), "mz-background-launch-"));
  pm.profiles.set("p", { id: "p", dataDir, name: "P" });
  pm.upsertSyncState({ profileId: "p", syncEnabled: true, dirty: true });
  const vault = await vaultWithPassword();
  await vault.set("s3AccessKeyId", "access");
  await vault.set("s3SecretAccessKey", "secret");
  const client = new FakeCoordinator();
  const driver = new FakeDriver();
  const kopia = new FakeKopia();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const snapshot = kopia.snapshot.bind(kopia);
  kopia.armGate();
  kopia.snapshot = async () => {
    entered();
    return snapshot();
  };
  const { ctl } = makeController({ pm, driver, client, vault, kopia });
  try {
    const upload = ctl.autoBootstrap();
    await started;
    const launch = ctl.launch("p", async () => {
      assert.equal(client.releaseCalls, 1);
      driver.setRunning("p", true);
    });
    kopia.releaseGate();
    await upload;
    await launch;
    assert.equal(client.acquireCalls, 2);
    assert.equal(client.releaseCalls, 1);
    assert.equal(pm.getSyncState("p")?.dirty, true);
  } finally {
    await ctl.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
