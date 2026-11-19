/**
 * Project-config synchronizer over a conditional object store.
 *
 * This is the control plane for MCP *project configuration* sync — the analogue
 * of `@multizen/s3-coordinator` for browser profiles, but for a DIFFERENT asset
 * living in a DIFFERENT reserved key namespace (`<prefix>/mcp/...`, see keys.ts).
 * It never touches browser-profile keys, and browser-profile deletion never
 * touches its keys.
 *
 * Guarantees:
 *   - Per-project monotonic revision with expected-revision CAS. Publishing
 *     revision N requires the head to currently be at N-1 (or absent for the
 *     first publish). A losing CAS is NEVER last-write-wins: the remote stays
 *     authoritative and the losing local signed config is returned to the caller
 *     as a durable conflict copy (with metadata) to persist locally.
 *   - Encryption-at-rest: every payload is AES-256-GCM sealed under a key
 *     derived from the operator password (crypto.ts). Cleartext config is never
 *     stored.
 *   - Signed envelopes: only valid canonical signed envelopes are published.
 *     On restore/list every record is verified (envelope shape, project id,
 *     revision monotonicity/rollback, config hash, Ed25519 signature against a
 *     signed trust registry, signer trusted/not-revoked) BEFORE it becomes an
 *     apply candidate. Anything failing goes to quarantine and never auto-starts.
 *   - Fresh-device semantics: a device with only the operator password + the
 *     signed trust registry can list and restore ALL projects (enabled AND
 *     disabled) to their exact desired state. Verification is honest — it trusts
 *     the trust registry's self-signature bootstrap, nothing more.
 *   - Robust discovery: paginated listing with a scan cap and strict key
 *     parsing; a single malformed/quarantined project never aborts the others.
 */

import { canonicalBytes, canonicalize, type JsonValue } from "../canonicalJson.js";
import { assertProjectId, isSafeId, type ProjectId } from "../ids.js";
import { parseProjectConfig, projectConfigToJson, type ProjectConfig } from "../projectConfig.js";
import {
  assertTrustedSigner,
  evaluateProject,
  hashConfig,
  signArchiveStamp,
  signProject,
  signTombstone,
  verifyArchiveStamp,
  verifyTombstone,
  verifyTrustRegistry,
  VerificationError,
  type ArchiveStamp,
  type ProjectEnvelope,
  type ProjectTombstone,
  type TrustRegistry,
} from "../trust.js";
import type { SigningKey } from "../vault.js";
import { open, seal, type CryptoEnvelope } from "./crypto.js";
import { isStoreErrorKind, type SyncObjectStore } from "./objectStore.js";
import {
  mcpProjectsPrefix,
  parseProjectRevisionKey,
  parseProjectStateKey,
  parseProjectTombstoneKey,
  projectRevisionKey,
  projectRevisionsPrefix,
  projectStateKey,
  projectTombstoneKey,
} from "./keys.js";
import {
  decodeRecord,
  encodeRecord,
  projectRecordJson,
  PROJECT_RECORD_VERSION,
  RecordError,
  type ProjectRecord,
} from "./projectRecord.js";

/** Default page size and total scan cap for whole-library discovery. */
export const DEFAULT_LIST_PAGE_SIZE = 200;
export const DEFAULT_MAX_SCAN_KEYS = 100_000;

/** Wire version of the stamped revision-archive wrapper. */
export const ARCHIVE_RECORD_VERSION = 1 as const;

/**
 * Archived revisions retained per project by default.
 *
 * History is for answering "what changed, and can I go back to Tuesday" — not
 * for indefinite retention. Twenty revisions of a config that changes a handful
 * of times a week is months of coverage for a few kilobytes, and bounds what an
 * unattended device can accumulate in someone's bucket.
 */
export const DEFAULT_HISTORY_LIMIT = 20;

/** One entry in a project's timeline: a config revision or its deletion. */
export interface HistoryEntry {
  readonly projectId: string;
  readonly revision: number;
  /**
   * ISO time, from a signed stamp. Null when the revision predates stamping or
   * its stamp could not be verified — never a guess.
   */
  readonly archivedAt: string | null;
  readonly signer: string;
  readonly kind: "config" | "tombstone";
}

/** A verified archived revision, ready to be re-published as the newest one. */
export interface ArchivedRevision {
  readonly projectId: string;
  readonly revision: number;
  readonly archivedAt: string | null;
  readonly signer: string;
  readonly config: ProjectConfig;
}

export interface PruneResult {
  readonly deleted: number;
  readonly retained: number;
  /** False when the store cannot delete, so full history is kept by necessity. */
  readonly supported: boolean;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

export interface SyncCoordinatorConfig {
  /** Object store (structural). */
  readonly store: SyncObjectStore;
  /** Base control prefix (repository root under the bucket). */
  readonly controlPrefix: string;
  /** Operator encryption password. Held only in memory; never persisted here. */
  readonly password: string;
  /** Per-repository salt (hex) for key derivation; stable across the repo. */
  readonly saltHex: string;
  /** This device's signing key (private material stays in the vault). */
  readonly signingKey: SigningKey;
  /** Per-page listing size (defaults to {@link DEFAULT_LIST_PAGE_SIZE}). */
  readonly listPageSize?: number;
  /** Hard cap on total keys scanned during discovery. */
  readonly maxScanKeys?: number;
  /**
   * Archived revisions to retain per project (defaults to
   * {@link DEFAULT_HISTORY_LIMIT}). Pruning happens after a successful publish.
   */
  readonly historyLimit?: number;
}

/** A published (or would-be-published) project head. */
export interface PublishOutcome {
  readonly kind: "published";
  readonly projectId: string;
  readonly revision: number;
  readonly envelope: ProjectEnvelope;
}

/**
 * A concurrent-update loss: the remote advanced past our expected revision, so
 * we did NOT overwrite it. The losing local signed config is returned as a
 * durable conflict copy for the caller to persist locally (keep-both policy).
 */
export interface ConflictOutcome {
  readonly kind: "conflict";
  readonly projectId: string;
  /** Revision we attempted to publish. */
  readonly attemptedRevision: number;
  /** Revision currently authoritative on the remote. */
  readonly remoteRevision: number;
  /** The losing local envelope (authoritative-losing) for conflict persistence. */
  readonly losingEnvelope: ProjectEnvelope;
  /** The losing local config, to be saved as a conflict copy locally. */
  readonly losingConfig: ProjectConfig;
  /** Conflict metadata for the local durable copy. */
  readonly metadata: ConflictMetadata;
}

export type PublishResult = PublishOutcome | ConflictOutcome;

export interface ConflictMetadata {
  readonly projectId: string;
  readonly attemptedRevision: number;
  readonly remoteRevision: number;
  readonly localSigner: string;
  readonly remoteSigner: string;
  readonly detectedAt: string;
  readonly reason: "cas-lost" | "remote-newer";
}

/** A verified, ready-to-apply project. */
export interface AppliedProject {
  readonly projectId: string;
  readonly revision: number;
  readonly signer: string;
  readonly config: ProjectConfig;
}

/** A rejected/quarantined project; never auto-started. */
export interface QuarantinedProject {
  readonly projectId: string;
  readonly reason: string;
  readonly code:
    | "malformed"
    | "decrypt"
    | "bad-signature"
    | "hash-mismatch"
    | "unknown-signer"
    | "revoked-signer"
    | "rollback"
    | "id-mismatch";
}

/** A verified deletion the caller must act on locally. */
export interface DeletedProject {
  readonly projectId: string;
  readonly revision: number;
  readonly signer: string;
  readonly deletedAt: string;
}

export interface RestoreResult {
  readonly absent: string[];
  readonly readErrors: { projectId: string; kind: "AuthFailed" | "Unreachable" | "ReadFailed" }[];
  readonly applied: AppliedProject[];
  readonly quarantined: QuarantinedProject[];
  /**
   * Projects deleted elsewhere. Separate from `applied` because the caller must
   * do local cleanup (remove agent-config entries, drop stored credentials)
   * rather than just persisting a config.
   */
  readonly deleted: DeletedProject[];
  readonly scanned: number;
}

export class SyncCoordinatorError extends Error {
  override readonly name = "SyncCoordinatorError";
  constructor(
    message: string,
    readonly code: "store" | "config" | "crypto" | "trust",
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();

/** Canonical JSON for a tombstone, including its signature. */
function tombstoneToJson(t: ProjectTombstone): JsonValue {
  return {
    tombstoneVersion: t.tombstoneVersion,
    project: t.project,
    revision: t.revision,
    signer: t.signer,
    deletedAt: t.deletedAt,
    signature: t.signature,
  };
}

const MAX_TOMBSTONE_BYTES = 8 * 1024;

/**
 * Structurally validate a stored tombstone. Returns null for anything malformed
 * so one corrupt object cannot abort a whole restore pass; authenticity is a
 * separate step (see verifyTombstone).
 */
function decodeTombstone(bytes: Uint8Array): ProjectTombstone | null {
  if (bytes.byteLength > MAX_TOMBSTONE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (
      !["tombstoneVersion", "project", "revision", "signer", "deletedAt", "signature"].includes(k)
    ) {
      return null;
    }
  }
  if (p.tombstoneVersion !== 1) return null;
  if (typeof p.project !== "string" || !isSafeId(p.project)) return null;
  if (typeof p.revision !== "number" || !Number.isInteger(p.revision) || p.revision < 1) {
    return null;
  }
  if (typeof p.signer !== "string" || typeof p.deletedAt !== "string") return null;
  if (typeof p.signature !== "string" || !/^[0-9a-f]+$/.test(p.signature)) return null;
  return {
    tombstoneVersion: 1,
    project: p.project as ProjectId,
    revision: p.revision,
    signer: p.signer,
    deletedAt: p.deletedAt,
    signature: p.signature,
  };
}

export class ProjectSyncCoordinator {
  private readonly store: SyncObjectStore;
  private readonly controlPrefix: string;
  private readonly password: string;
  private readonly saltHex: string;
  private readonly signingKey: SigningKey;
  private readonly pageSize: number;
  private readonly maxScanKeys: number;
  private readonly historyLimit: number;

  constructor(config: SyncCoordinatorConfig) {
    this.store = config.store;
    this.controlPrefix = config.controlPrefix;
    this.password = config.password;
    this.saltHex = config.saltHex;
    this.signingKey = config.signingKey;
    this.pageSize = config.listPageSize ?? DEFAULT_LIST_PAGE_SIZE;
    this.maxScanKeys = config.maxScanKeys ?? DEFAULT_MAX_SCAN_KEYS;
    this.historyLimit = config.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  // ── payload sealing ───────────────────────────────────────────────────────

  private sealConfig(config: ProjectConfig): CryptoEnvelope {
    const canonical = canonicalize(projectConfigToJson(config) as JsonValue);
    return seal(this.password, encoder.encode(canonical), {
      saltHex: this.saltHex,
      // Bind the ciphertext to the project id: a password holder cannot move a
      // ciphertext to another project's slot without failing the AAD check.
      context: config.id,
    });
  }

  private openConfig(
    payload: CryptoEnvelope,
    projectId: string,
  ): { config: ProjectConfig; serializedConfig: JsonValue } {
    const plaintext = open(this.password, payload, projectId);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const serializedConfig = JSON.parse(text) as JsonValue;
    return { config: parseProjectConfig(serializedConfig), serializedConfig };
  }

  // ── head read ─────────────────────────────────────────────────────────────

  /**
   * Read the current head record + etag for a project, or null when absent.
   * Malformed/oversized head objects reject as a store error caller can handle.
   */
  private async readHead(
    projectId: ProjectId,
  ): Promise<{ record: ProjectRecord; etag: string } | null> {
    const key = projectStateKey(this.controlPrefix, projectId);
    try {
      const got = await this.store.get(key);
      return { record: decodeRecord(got.bytes), etag: got.etag };
    } catch (err) {
      if (isStoreErrorKind(err, "NotFound")) return null;
      throw err;
    }
  }

  // ── publish ─────────────────────────────────────────────────────────────

  /**
   * Publish `config` at `revision`. `revision` must be strictly greater than the
   * current remote revision (monotonic). The first publish uses revision 1 and a
   * conditional create; subsequent publishes CAS against the current head etag,
   * asserting the head is exactly at `revision - 1`.
   *
   * On a lost race (someone else advanced the head first) we DO NOT overwrite:
   * we return a {@link ConflictOutcome} carrying the losing signed config so the
   * caller persists a durable local conflict copy (keep-both). Bound and unbound
   * projects (with/without `browserProfileId`) publish identically.
   */
  async publish(config: ProjectConfig, revision: number, allowRecreation = true): Promise<PublishResult> {
    const projectId = assertProjectId(config.id);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new SyncCoordinatorError(`revision must be a positive integer`, "config");
    }

    // Sign the (canonical) config at this revision. Only canonical signed
    // envelopes are ever written.
    const envelope = await signProject(this.signingKey, projectId, revision, config);
    const record: ProjectRecord = {
      recordVersion: PROJECT_RECORD_VERSION,
      envelope,
      payload: this.sealConfig(config),
    };
    const body = encodeRecord(record);
    const headKey = projectStateKey(this.controlPrefix, projectId);

    const current = await this.readHead(projectId);
    // A tombstone participates in the SAME revision sequence, so a project that
    // was deleted can only be recreated by a record that outranks the deletion.
    // Without this the head would still sit below the tombstone, `publish` would
    // demand the tombstone's own revision, and the tie would keep going to the
    // tombstone — making resurrection impossible.
    const tombstone = await this.readTombstone(projectId);
    const tombstoneRevision = tombstone?.revision ?? 0;
    if (!allowRecreation && tombstone && tombstone.revision >= (current?.record.envelope.revision ?? 0)) {
      return this.buildConflict(projectId, config, envelope, revision, tombstone);
    }

    if (current === null) {
      const required = tombstoneRevision + 1;
      if (revision !== required) {
        // Expected-revision CAS: the first publish must be revision 1, or one
        // past a deletion when the project previously existed.
        throw new SyncCoordinatorError(
          `first publish must be revision ${required}, got ${revision}`,
          "config",
        );
      }
      try {
        await this.store.putCreate(headKey, body);
      } catch (err) {
        if (isStoreErrorKind(err, "PreconditionFailed", "Conflict")) {
          // Lost the create race: someone created the head first.
          return this.buildConflict(projectId, config, envelope, revision);
        }
        throw err;
      }
      await this.writeHistory(projectId, revision, body);
      return { kind: "published", projectId, revision, envelope };
    }

    const remoteRevision = Math.max(current.record.envelope.revision, tombstoneRevision);
    if (revision <= remoteRevision) {
      // Remote already at/ahead of our revision: do not overwrite. Keep both.
      return this.buildConflict(projectId, config, envelope, revision, current.record.envelope);
    }
    if (revision !== remoteRevision + 1) {
      throw new SyncCoordinatorError(
        `non-contiguous revision: head at ${remoteRevision}, cannot publish ${revision}`,
        "config",
      );
    }

    try {
      await this.store.putCompareAndSwap(headKey, body, current.etag);
    } catch (err) {
      if (isStoreErrorKind(err, "PreconditionFailed", "Conflict", "NotFound")) {
        // Lost the CAS race: re-read to attach the winning remote metadata.
        const fresh = await this.readHead(projectId);
        return this.buildConflict(projectId, config, envelope, revision, fresh?.record.envelope);
      }
      throw err;
    }
    await this.writeHistory(projectId, revision, body);
    // Housekeeping after the head is safely advanced, never before: a prune that
    // failed must not be able to affect whether the publish counted.
    await this.pruneHistory(projectId, this.historyLimit).catch(() => undefined);
    return { kind: "published", projectId, revision, envelope };
  }

  private buildConflict(
    projectId: ProjectId,
    losingConfig: ProjectConfig,
    losingEnvelope: ProjectEnvelope,
    attemptedRevision: number,
    remoteRecord?: Pick<ProjectEnvelope, "revision" | "signer">,
  ): ConflictOutcome {
    const remoteRevision = remoteRecord?.revision ?? attemptedRevision;
    const remoteSigner = remoteRecord?.signer ?? "unknown";
    return {
      kind: "conflict",
      projectId,
      attemptedRevision,
      remoteRevision,
      losingEnvelope,
      losingConfig,
      metadata: {
        projectId,
        attemptedRevision,
        remoteRevision,
        localSigner: this.signingKey.deviceId,
        remoteSigner,
        detectedAt: new Date().toISOString(),
        reason: remoteRevision >= attemptedRevision ? "remote-newer" : "cas-lost",
      },
    };
  }

  /**
   * Write the immutable revision-history record, with a signed timestamp.
   *
   * The archived object is a wrapper rather than a copy of the head bytes, so a
   * revision carries when it was made. Without that, "restore the configuration
   * as of last Tuesday" has nothing to select on — a revision number alone tells
   * you the order of edits, not their dates.
   *
   * Best-effort throughout: the head is the source of truth, so a store that
   * refuses the archive (or has already got this exact revision) must not fail the
   * publish that already succeeded.
   */
  private async writeHistory(
    projectId: ProjectId,
    revision: number,
    body: Uint8Array,
  ): Promise<void> {
    const key = projectRevisionKey(this.controlPrefix, projectId, revision);
    try {
      const archived = await this.buildArchive(projectId, revision, body);
      await this.store.putImmutable(key, archived);
    } catch (err) {
      // A pre-existing immutable record for this exact revision is fine
      // (idempotent republish). Other failures are non-fatal for the head.
      if (isStoreErrorKind(err, "PreconditionFailed", "Conflict")) return;
      // Swallow: history is advisory; head is the source of truth.
    }
  }

  /** Serialize one archived revision: the signed record plus a signed stamp. */
  private async buildArchive(
    projectId: ProjectId,
    revision: number,
    recordBody: Uint8Array,
  ): Promise<Uint8Array> {
    const record = decodeRecord(recordBody);
    const recordJson = projectRecordJson(record);
    const recordHash = await sha256Hex(canonicalBytes(recordJson));
    const stamp = await signArchiveStamp(this.signingKey, projectId, revision, recordHash);
    const archive: JsonValue = {
      archiveVersion: ARCHIVE_RECORD_VERSION,
      stamp: {
        stampVersion: stamp.stampVersion,
        project: stamp.project,
        revision: stamp.revision,
        signer: stamp.signer,
        archivedAt: stamp.archivedAt,
        recordHash: stamp.recordHash,
        signature: stamp.signature,
      },
      record: recordJson,
    };
    return new TextEncoder().encode(canonicalize(archive));
  }

  // ── revision history ─────────────────────────────────────────────────────

  /**
   * One entry in a project's history. `archivedAt` is null for revisions written
   * before archives carried a signed timestamp, and for any whose stamp failed
   * verification — in both cases the revision is still listed, because hiding a
   * genuine signed config because its clock reading is untrustworthy would be
   * worse than showing it without a date.
   */
  async history(projectId: string, registry: TrustRegistry): Promise<HistoryEntry[]> {
    verifyTrustRegistry(registry);
    const id = assertProjectId(projectId);
    const prefix = projectRevisionsPrefix(this.controlPrefix, id);
    const revisions: number[] = [];
    let continuationToken: string | undefined;
    let scanned = 0;
    do {
      const page = await this.store.list(prefix, {
        maxKeys: this.pageSize,
        ...(continuationToken !== undefined ? { continuationToken } : {}),
      });
      for (const key of page.keys) {
        if (scanned >= this.maxScanKeys) {
          continuationToken = undefined;
          break;
        }
        scanned += 1;
        const rev = parseProjectRevisionKey(this.controlPrefix, id, key);
        if (rev !== null) revisions.push(rev);
      }
      continuationToken = page.nextContinuationToken ?? undefined;
    } while (continuationToken !== undefined && scanned < this.maxScanKeys);

    const entries: HistoryEntry[] = [];
    for (const revision of revisions.sort((a, b) => a - b)) {
      const read = await this.readArchive(id, revision, registry);
      if (read === null) continue;
      // History is the menu of revisions an operator may restore, so a record
      // authored by a device this repository does not trust has no business on it.
      // This is a membership check, not a full signature verification: verifying
      // every entry would mean a key derivation per revision (~100 ms each), and
      // `readRevision` does the complete check before anything is actually
      // restored. A stamp that verified has already proved a trusted device
      // vouched for these exact bytes.
      if (read.archivedAt === null) {
        try {
          assertTrustedSigner(registry, read.record.envelope.signer);
        } catch {
          continue;
        }
      }
      entries.push({
        projectId: id,
        revision,
        archivedAt: read.archivedAt,
        signer: read.record.envelope.signer,
        kind: "config",
      });
    }

    // A deletion belongs in the timeline: without it, "what did this look like on
    // Friday" would answer with the last config even when the project was gone.
    const tombstone = await this.readTombstone(id);
    if (tombstone !== null) {
      try {
        const verified = verifyTombstone(tombstone, registry);
        entries.push({
          projectId: id,
          revision: verified.revision,
          archivedAt: verified.deletedAt,
          signer: verified.signer,
          kind: "tombstone",
        });
      } catch {
        // An unverifiable deletion marker is not part of the history.
      }
    }
    return entries.sort((a, b) => a.revision - b.revision);
  }

  /**
   * Read and fully verify one archived revision. Returns null when it is absent
   * or cannot be trusted — the caller is offering the operator a config to
   * restore, so anything short of verified is not on the menu.
   */
  async readRevision(
    projectId: string,
    revision: number,
    registry: TrustRegistry,
  ): Promise<ArchivedRevision | null> {
    verifyTrustRegistry(registry);
    const id = assertProjectId(projectId);
    const read = await this.readArchive(id, revision, registry);
    if (read === null) return null;
    try {
      const { config, serializedConfig } = this.openConfig(read.record.payload, id);
      // The same verification a restore does, MINUS the rollback check: reading an
      // old revision on purpose is the entire point here, so rollback protection
      // would reject exactly the records this method exists to fetch.
      const decision = evaluateProject(read.record.envelope, config, registry, {
        serializedConfig,
      });
      if (!decision.accepted || decision.verified === undefined) return null;
      const verified = decision.verified;
      // The envelope must describe the slot it was found in, so an archive object
      // cannot pass off one revision (or one project) as another.
      if (verified.project !== id || verified.revision !== revision) return null;
      return {
        projectId: id,
        revision: verified.revision,
        archivedAt: read.archivedAt,
        signer: verified.signer,
        config,
      };
    } catch {
      return null;
    }
  }

  /**
   * Delete archived revisions older than the newest `keep`.
   *
   * Only the archive is touched — never a head, a tombstone, or a trust record.
   * A store without `deleteStrict` keeps everything and says so, because silently
   * doing nothing would look identical to a retention policy that worked.
   */
  async pruneHistory(projectId: string, keep: number): Promise<PruneResult> {
    const id = assertProjectId(projectId);
    if (!Number.isInteger(keep) || keep < 1) {
      throw new SyncCoordinatorError("keep must be a positive integer", "config");
    }
    const del = this.store.deleteStrict?.bind(this.store);
    const prefix = projectRevisionsPrefix(this.controlPrefix, id);
    const revisions: number[] = [];
    let continuationToken: string | undefined;
    let scanned = 0;
    do {
      const page = await this.store.list(prefix, {
        maxKeys: this.pageSize,
        ...(continuationToken !== undefined ? { continuationToken } : {}),
      });
      for (const key of page.keys) {
        if (scanned >= this.maxScanKeys) {
          continuationToken = undefined;
          break;
        }
        scanned += 1;
        const rev = parseProjectRevisionKey(this.controlPrefix, id, key);
        if (rev !== null) revisions.push(rev);
      }
      continuationToken = page.nextContinuationToken ?? undefined;
    } while (continuationToken !== undefined && scanned < this.maxScanKeys);

    revisions.sort((a, b) => b - a);
    const doomed = revisions.slice(keep);
    if (del === undefined) {
      return { deleted: 0, retained: revisions.length, supported: false };
    }
    let deleted = 0;
    for (const revision of doomed) {
      try {
        await del(projectRevisionKey(this.controlPrefix, id, revision));
        deleted += 1;
      } catch {
        // Pruning is housekeeping; a failure must never surface as a sync error.
      }
    }
    return { deleted, retained: revisions.length - deleted, supported: true };
  }

  /**
   * Read one archive object and verify its stamp. Accepts a bare record for
   * revisions written before archives were stamped, reporting `archivedAt: null`
   * rather than inventing a time.
   */
  private async readArchive(
    projectId: ProjectId,
    revision: number,
    registry: TrustRegistry,
  ): Promise<{ record: ProjectRecord; archivedAt: string | null } | null> {
    const key = projectRevisionKey(this.controlPrefix, projectId, revision);
    let bytes: Uint8Array;
    try {
      bytes = (await this.store.get(key)).bytes;
    } catch (err) {
      if (isStoreErrorKind(err, "NotFound")) return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (p.archiveVersion !== ARCHIVE_RECORD_VERSION) {
      // Legacy: the object IS the record, with no timestamp to offer.
      try {
        return { record: decodeRecord(bytes), archivedAt: null };
      } catch {
        return null;
      }
    }
    let record: ProjectRecord;
    try {
      record = decodeRecord(new TextEncoder().encode(canonicalize(p.record as JsonValue)));
    } catch {
      return null;
    }
    let archivedAt: string | null = null;
    try {
      const recordHash = await sha256Hex(canonicalBytes(projectRecordJson(record)));
      archivedAt = verifyArchiveStamp(p.stamp as ArchiveStamp, registry, {
        project: projectId,
        revision,
        recordHash,
      }).archivedAt;
    } catch {
      // An untrustworthy timestamp is dropped, not fatal: the signed config is
      // still a real config, and listing it without a date is more useful than
      // pretending the revision does not exist.
      archivedAt = null;
    }
    return { record, archivedAt };
  }

  // ── tombstones ───────────────────────────────────────────────────────────

  /**
   * Publish a signed deletion marker for a project at `revision`.
   *
   * The revision shares the project's sequence, so a deletion and a concurrent
   * edit are ordered against each other rather than racing on wall-clock time.
   * The head object is deliberately left in place: readers compare revisions and
   * the newer record wins, which means a slow reader can never see an empty
   * subtree and conclude the project simply never existed.
   */
  async publishTombstone(projectId: string, revision: number): Promise<ProjectTombstone> {
    const id = assertProjectId(projectId);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new SyncCoordinatorError(`revision must be a positive integer`, "config");
    }
    const tombstone = await signTombstone(this.signingKey, id, revision);
    const body = encoder.encode(canonicalize(tombstoneToJson(tombstone)));
    const key = projectTombstoneKey(this.controlPrefix, id);
    try {
      await this.store.putCreate(key, body);
    } catch (err) {
      if (!isStoreErrorKind(err, "PreconditionFailed", "Conflict")) throw err;
      // A tombstone already exists. Replace it only when ours is newer, so a
      // re-delete after a resurrect-and-delete cycle still orders correctly.
      const existing = await this.store.get(key);
      const current = decodeTombstone(existing.bytes);
      if (current !== null && current.revision >= revision) return current;
      await this.store.putCompareAndSwap(key, body, existing.etag);
    }
    return tombstone;
  }

  /** Read and decode a project's tombstone, or null when absent/unreadable. */
  private async readTombstone(projectId: string): Promise<ProjectTombstone | null> {
    const key = projectTombstoneKey(this.controlPrefix, projectId);
    try {
      const got = await this.store.get(key);
      const record = decodeTombstone(got.bytes);
      if (!record || record.project !== projectId)
        throw new VerificationError("Invalid project tombstone", "malformed");
      return record;
    } catch (err) {
      if (isStoreErrorKind(err, "NotFound")) return null;
      throw err;
    }
  }

  // ── verification ─────────────────────────────────────────────────────────

  /**
   * Verify a single stored record against a pre-verified trust registry into an
   * apply candidate, or a quarantine decision. Never throws for verification
   * failures — returns a discriminated result so one bad project cannot abort a
   * batch.
   */
  private verifyRecord(
    projectId: string,
    record: ProjectRecord,
    registry: TrustRegistry,
    lastAppliedRevision?: number,
  ): AppliedProject | QuarantinedProject {
    // Decrypt first: a record we cannot authenticate is quarantined without
    // ever trusting its bytes.
    let opened: { config: ProjectConfig; serializedConfig: JsonValue };
    try {
      opened = this.openConfig(record.payload, projectId);
    } catch (err) {
      return {
        projectId,
        reason: `decrypt/parse failed: ${(err as Error).message}`,
        code: "decrypt",
      };
    }
    if (opened.config.id !== projectId) {
      return { projectId, reason: "config id does not match key", code: "id-mismatch" };
    }
    const decision = evaluateProject(record.envelope, opened.config, registry, {
      ...(lastAppliedRevision !== undefined ? { lastAppliedRevision } : {}),
      serializedConfig: opened.serializedConfig,
    });
    if (decision.accepted && decision.verified) {
      return {
        projectId,
        revision: decision.verified.revision,
        signer: decision.verified.signer,
        config: decision.verified.config,
      };
    }
    const code = (decision.error?.code ?? "malformed") as QuarantinedProject["code"];
    return {
      projectId,
      reason: decision.error?.message ?? "verification failed",
      code,
    };
  }

  // ── restore one ────────────────────────────────────────────────────────

  /**
   * Restore a single project by id. Returns an apply candidate or a quarantine
   * record; null when the project head is absent. `lastAppliedRevision` enables
   * rollback protection against replay of a stale (previously-applied) record.
   */
  async restoreProject(
    id: ProjectId,
    registry: TrustRegistry,
    lastAppliedRevision?: number,
  ): Promise<AppliedProject | QuarantinedProject | null> {
    verifyTrustRegistry(registry);
    const head = await this.readHeadResilient(id);
    if (head === null) return null;
    if (head.kind === "malformed") {
      return { projectId: id, reason: head.reason, code: "malformed" };
    }
    return this.verifyRecord(id, head.record, registry, lastAppliedRevision);
  }

  /**
   * Read a head, converting decode failures into a structured malformed marker
   * rather than throwing, so a corrupt head quarantines instead of aborting.
   */
  private async readHeadResilient(
    projectId: ProjectId,
  ): Promise<{ kind: "ok"; record: ProjectRecord } | { kind: "malformed"; reason: string } | null> {
    const key = projectStateKey(this.controlPrefix, projectId);
    let bytes: Uint8Array;
    try {
      const got = await this.store.get(key);
      bytes = got.bytes;
    } catch (err) {
      if (isStoreErrorKind(err, "NotFound")) return null;
      throw err;
    }
    try {
      return { kind: "ok", record: decodeRecord(bytes) };
    } catch (err) {
      if (err instanceof RecordError) {
        return { kind: "malformed", reason: err.message };
      }
      throw err;
    }
  }

  // ── restore all (fresh-device / whole-library) ─────────────────────────

  /**
   * Discover and restore ALL projects (enabled and disabled) to their exact
   * desired state. This is the fresh-device path: given only the password and a
   * signed trust registry, it lists every project head, verifies each, and
   * returns apply candidates plus quarantined records. Disabled projects are
   * returned as-is (their `enabled=false` desired state is preserved) — a
   * disabled project remains disabled after restore.
   *
   * Discovery is paginated with a hard scan cap and strict key parsing. A
   * malformed key, a decode failure, or a verification failure for one project
   * NEVER aborts the whole pass — that project is quarantined and the scan
   * continues.
   *
   * `knownRevisions` (optional) maps projectId → last-applied revision for
   * rollback protection; absent entries are treated as never-applied (0).
   */
  async restoreAll(
    registry: TrustRegistry,
    knownRevisions?: ReadonlyMap<string, number>,
    localIds: Iterable<string> = [],
  ): Promise<RestoreResult> {
    verifyTrustRegistry(registry);
    const prefix = mcpProjectsPrefix(this.controlPrefix);
    let scanned = 0;
    let continuationToken: string | undefined;

    // Discovery has to notice BOTH kinds of record for a project, because a
    // deletion lives beside the head rather than replacing it. Collect ids first,
    // then decide per project, so a project is judged once even when both objects
    // show up on the same page.
    const local = new Set(localIds);
    const ids = new Set(local);
    do {
      const page = await this.store.list(prefix, {
        maxKeys: this.pageSize,
        ...(continuationToken !== undefined ? { continuationToken } : {}),
      });
      for (const key of page.keys) {
        if (scanned >= this.maxScanKeys) {
          continuationToken = undefined;
          break;
        }
        // STRICT key parse: only exact head or tombstone keys are considered.
        // Everything else (revision history, foreign keys) is ignored.
        const id =
          parseProjectStateKey(this.controlPrefix, key) ??
          parseProjectTombstoneKey(this.controlPrefix, key);
        if (id === null) continue;
        scanned += 1;
        if (!isSafeId(id)) continue;
        ids.add(id);
      }
      continuationToken = page.nextContinuationToken ?? undefined;
    } while (continuationToken !== undefined && scanned < this.maxScanKeys);

    return this.readProjects(registry, ids, knownRevisions, scanned, local);
  }

  async readProjects(
    registry: TrustRegistry,
    ids: Iterable<string>,
    knownRevisions?: ReadonlyMap<string, number>,
    scanned = 0,
    includeCurrentDeletion: ReadonlySet<string> = new Set(),
  ): Promise<RestoreResult> {
    verifyTrustRegistry(registry);
    const applied: AppliedProject[] = [];
    const quarantined: QuarantinedProject[] = [];
    const deleted: DeletedProject[] = [];
    const absent: string[] = [];
    const readErrors: RestoreResult["readErrors"] = [];
    for (const id of ids) {
      const projectId = id as ProjectId;
      const last = knownRevisions?.get(projectId);
      try {
        const tombstone = await this.readTombstone(projectId);
        const head = await this.readHeadResilient(projectId);
        const headRevision = head?.kind === "ok" ? head.record.envelope.revision : 0;

        // Newest record wins. A deletion at or above the head revision means the
        // project is gone; a later re-publish resurrects it.
        if (tombstone !== null && tombstone.revision >= headRevision) {
          try {
            // A local draft may intentionally recreate a previously deleted project.
            // Return that exact deletion to the caller while still rejecting older records.
            const floor =
              last !== undefined && includeCurrentDeletion.has(id) ? Math.max(0, last - 1) : last;
            const verified = verifyTombstone(tombstone, registry, {
              ...(floor !== undefined ? { lastAppliedRevision: floor } : {}),
            });
            deleted.push({
              projectId: verified.project,
              revision: verified.revision,
              signer: verified.signer,
              deletedAt: verified.deletedAt,
            });
          } catch (err) {
            if (err instanceof VerificationError) {
              // An unauthenticated or replayed deletion is refused outright —
              // otherwise bucket write access alone would destroy projects.
              // `rollback` just means we already processed it; not a problem.
              if (err.code !== "rollback" || includeCurrentDeletion.has(id)) {
                quarantined.push({
                  projectId,
                  reason: `deletion refused: ${err.message}`,
                  code: err.code as QuarantinedProject["code"],
                });
              }
            } else throw err;
          }
          continue;
        }

        if (head === null) {
          absent.push(id);
          continue;
        }
        if (head.kind === "malformed") {
          quarantined.push({ projectId, reason: head.reason, code: "malformed" });
          continue;
        }
        const result = this.verifyRecord(projectId, head.record, registry, last);
        if ("config" in result) applied.push(result);
        else quarantined.push(result);
      } catch (err) {
        if (err instanceof VerificationError || isStoreErrorKind(err, "Malformed")) {
          quarantined.push({
            projectId,
            reason: "Invalid stored project record",
            code: "malformed",
          });
        } else {
          const kind = isStoreErrorKind(err, "AuthFailed")
            ? "AuthFailed"
            : isStoreErrorKind(err, "Unreachable")
              ? "Unreachable"
              : "ReadFailed";
          readErrors.push({ projectId, kind });
        }
      }
    }

    return { applied, quarantined, deleted, scanned, absent, readErrors };
  }
}

export { VerificationError, type ProjectEnvelope, type TrustRegistry };

/**
 * Pick the revision a project was at on a given date.
 *
 * Pure so it can be reasoned about and tested without a store. Three rules, each
 * of which matters:
 *
 *   - Entries with no trustworthy timestamp are ignored. Guessing where an
 *     undated revision belongs in a timeline would make the answer arbitrary.
 *   - A deletion counts as an event. If the newest thing at or before the chosen
 *     moment is a tombstone, the project did not exist then, and the honest
 *     answer is "nothing to restore" rather than the config from before it was
 *     deleted.
 *   - Ties on the same timestamp are broken by revision, since revisions are the
 *     authoritative ordering and clocks on different devices are not.
 */
export function selectRevisionAt(
  entries: readonly HistoryEntry[],
  atMs: number,
): HistoryEntry | null {
  const dated = entries
    .filter((e) => e.archivedAt !== null)
    .map((e) => ({ entry: e, at: Date.parse(e.archivedAt as string) }))
    .filter((e) => Number.isFinite(e.at) && e.at <= atMs)
    .sort((a, b) => (a.at !== b.at ? a.at - b.at : a.entry.revision - b.entry.revision));
  const newest = dated.at(-1);
  if (newest === undefined) return null;
  if (newest.entry.kind === "tombstone") return null;
  return newest.entry;
}
