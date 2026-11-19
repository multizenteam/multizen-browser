/**
 * "Set up this device from backup" — one ordered, resumable pass that turns a
 * blank install plus a bucket into a working one.
 *
 * Every piece of this already existed and could be driven by hand: configure
 * Cloud Sync, probe the store, adopt the trust registry, pull settings, pull
 * projects, relink folders, restore credentials, restore browser profiles. The
 * problem was that "already existed" meant an operator had to know all eight
 * steps, their order, and which failures were fatal. This module encodes that
 * knowledge once.
 *
 * WHY THIS ORDER. It is not arbitrary and the stages are not interchangeable:
 *
 *   1. `storage`     — nothing else can run without bucket coordinates,
 *                      credentials, and a store that actually supports
 *                      conditional writes.
 *   2. `trust`       — every later stage verifies signatures against the trust
 *                      registry, so it has to be adopted before anything is read.
 *   3. `settings`    — cheap, and shared preferences can influence what follows.
 *   4. `projects`    — bindings and credentials are both keyed by project id, so
 *                      the projects have to exist locally first.
 *   5. `bindings`    — relinks folders to agents, which rewrites agent config
 *                      files from the projects restored in step 4.
 *   6. `credentials` — optional; writing a secret makes the servers that were
 *                      held back for a missing `${NAME}` start.
 *   7. `profiles`    — heaviest by far (it downloads snapshots) and nothing
 *                      depends on it, so it goes last where a slow or partial
 *                      run has already left a usable install behind.
 *
 * WHAT IS FATAL AND WHAT IS NOT. `storage` and `trust` are fatal: without them
 * every later stage would fail for the same reason, and reporting that reason
 * seven times is worse than reporting it once. Everything after is recorded and
 * stepped over, because a device that recovered its projects but not its browser
 * profiles is far more useful than one that recovered nothing.
 *
 * APPROVAL IS NOT REQUIRED TO RESTORE, and this is the subtlety worth stating
 * plainly. A fresh device adopts the existing trust registry and can therefore
 * VERIFY records signed by devices already in it — so reading works immediately.
 * What it cannot do is PUBLISH: its own signature is unknown until an admin
 * approves it elsewhere. So setup announces the device and reports
 * `awaitingApproval` rather than blocking on a human, and the caller can tell the
 * operator that this machine is read-only until approved.
 *
 * IDEMPOTENT. Re-running is the expected way to finish an interrupted setup or to
 * retry after approval. Every stage is either a converging write (config patches,
 * secret saves) or a restore that writes the same values again.
 */

import type {
  BootstrapSummary,
  SecretKind,
  StorageTestResult,
  SyncConfigView,
} from "../sync/types.ts";
import type { SetupFromBackupInput } from "./types.ts";
import type { BindingsSync } from "./BindingsSync.ts";
import type { CredentialSync } from "./CredentialSync.ts";
import type { GatewayService } from "./GatewayService.ts";
import type { SettingsSync } from "./SettingsSync.ts";

/**
 * The slice of Cloud Sync this flow drives.
 *
 * A structural port rather than the concrete `SyncController` so this module —
 * and its tests — do not pull in Kopia, the AWS SDK, or the profile manager. The
 * real controller satisfies it as-is.
 */
export interface CloudSyncPort {
  updateConfig(patch: Partial<SyncConfigView>): Promise<SyncConfigView>;
  saveSecret(kind: SecretKind, value: string): Promise<void>;
  testStorageCoordination(opts?: { scheduleBootstrap?: boolean }): Promise<StorageTestResult>;
  syncAll(): Promise<BootstrapSummary>;
}

export const SETUP_STAGES = [
  "storage",
  "trust",
  "settings",
  "projects",
  "bindings",
  "credentials",
  "profiles",
] as const;

export type SetupStageId = (typeof SETUP_STAGES)[number];

export type SetupStageStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface SetupStageState {
  readonly id: SetupStageId;
  readonly status: SetupStageStatus;
  /** One short operator-facing line describing the outcome. Never a secret. */
  readonly detail: string | null;
}

/**
 * Input for one setup run. The shape lives in `types.ts` because the preload
 * bridge and the renderer need it too, and a secret-carrying shape must have
 * exactly one definition.
 */
export type DeviceSetupInput = SetupFromBackupInput;

export interface DeviceSetupResult {
  /** True when no stage failed. Skipped stages do not count as failures. */
  readonly ok: boolean;
  readonly stages: readonly SetupStageState[];
  /** This device's signing identity, once storage and trust succeeded. */
  readonly deviceId: string | null;
  /**
   * True when this device is a trusted registry entry and may publish. False
   * means restore worked but local changes stay local until an admin approves.
   */
  readonly canPublish: boolean;
  /** True when this device announced itself and is waiting to be approved. */
  readonly awaitingApproval: boolean;
}

export interface DeviceSetupDeps {
  readonly cloud: CloudSyncPort;
  readonly service: GatewayService;
  readonly settings: SettingsSync;
  readonly bindings: BindingsSync;
  readonly credentials: CredentialSync;
  /** Called on every stage transition so a UI can show live progress. */
  readonly onStage?: (state: SetupStageState) => void;
}

/** A stage that failed in a way that makes the rest of the run pointless. */
class FatalStageError extends Error {
  override readonly name = "FatalStageError";
}

export class DeviceSetup {
  constructor(private readonly deps: DeviceSetupDeps) {}

  async run(input: DeviceSetupInput): Promise<DeviceSetupResult> {
    const stages = new Map<SetupStageId, SetupStageState>(
      SETUP_STAGES.map((id) => [id, { id, status: "pending" as const, detail: null }]),
    );
    const set = (id: SetupStageId, status: SetupStageStatus, detail: string | null): void => {
      const state: SetupStageState = { id, status, detail };
      stages.set(id, state);
      // A throwing listener must not abort a setup run that is otherwise fine.
      try {
        this.deps.onStage?.(state);
      } catch {
        /* progress reporting is advisory */
      }
    };

    let deviceId: string | null = null;
    let canPublish = false;
    let awaitingApproval = false;

    /**
     * Run one stage. `fatal` stages abort the whole pass; the rest record their
     * failure and let the run continue, so a partial recovery is still a recovery.
     */
    const stage = async (
      id: SetupStageId,
      fatal: boolean,
      body: () => Promise<{ status: "done" | "skipped"; detail: string }>,
    ): Promise<boolean> => {
      set(id, "running", null);
      try {
        const out = await body();
        set(id, out.status, out.detail);
        return true;
      } catch (err) {
        set(id, "failed", describe(err));
        if (fatal) throw new FatalStageError(describe(err));
        return false;
      }
    };

    try {
      await stage("storage", true, async () => {
        // Secrets first: `updateConfig` and `testStorageCoordination` both need
        // them, and saving a secret is what invalidates the stale capability
        // cache from any previous, differently-configured attempt.
        await this.deps.cloud.saveSecret("s3AccessKeyId", input.secrets.s3AccessKeyId);
        await this.deps.cloud.saveSecret("s3SecretAccessKey", input.secrets.s3SecretAccessKey);
        await this.deps.cloud.saveSecret("kopiaPassword", input.secrets.kopiaPassword);
        await this.deps.cloud.updateConfig({
          enabled: true,
          s3Bucket: input.storage.s3Bucket,
          ...(input.storage.s3Endpoint !== undefined
            ? { s3Endpoint: input.storage.s3Endpoint }
            : {}),
          ...(input.storage.s3Region !== undefined ? { s3Region: input.storage.s3Region } : {}),
          ...(input.storage.s3Prefix !== undefined ? { s3Prefix: input.storage.s3Prefix } : {}),
          ...(input.storage.controlPrefix !== undefined
            ? { controlPrefix: input.storage.controlPrefix }
            : {}),
          ...(input.storage.s3ForcePathStyle !== undefined
            ? { s3ForcePathStyle: input.storage.s3ForcePathStyle }
            : {}),
        });
        // Probe without letting it kick off a background profile bootstrap: the
        // `profiles` stage runs that deliberately, at the end, where its progress
        // is reported instead of racing this pass.
        const probe = await this.deps.cloud.testStorageCoordination({ scheduleBootstrap: false });
        if (!probe.healthy) {
          throw new Error(
            probe.capability.message ??
              "The bucket could not be reached with these credentials.",
          );
        }
        if (!probe.conditionalWritesSupported) {
          throw new Error(
            `This storage does not support the conditional writes Sekvona needs` +
              (probe.capability.failedCheck !== null
                ? ` (failed check: ${probe.capability.failedCheck})`
                : ""),
          );
        }
        return { status: "done", detail: "Storage reachable and safe for coordination." };
      });

      await stage("trust", true, async () => {
        // Compose the gateway's sync bridge from the now-ready Cloud Sync state.
        // Without this the gateway stays local-only until the app restarts.
        const composed = await this.deps.service.composeSyncIfReady();
        if (!composed) {
          throw new Error(
            "Cloud Sync is configured but the gateway could not compose it. Check the encryption password.",
          );
        }
        const bridge = this.deps.service.syncBridge;
        if (!bridge) throw new Error("The gateway sync bridge is unavailable.");

        // Adopts an existing registry, or bootstraps this device as the first
        // trust root on a fresh bucket. Either way it is self-verified.
        const registry = await bridge.ensureTrustRegistry();
        deviceId = bridge.selfDeviceId;
        const self = registry.entries.find((e) => e.deviceId === deviceId);
        canPublish = self?.role === "trusted";
        if (self?.role === "revoked") {
          throw new Error(
            "This device has been revoked for this bucket. An administrator must re-approve it.",
          );
        }
        if (!canPublish) {
          // Announce so an admin elsewhere can find and approve this device.
          // Reading still works from here on, which is what setup needs.
          await bridge.announceSelf(input.deviceName ?? "This device");
          awaitingApproval = true;
          return {
            status: "done",
            detail:
              "Trust registry adopted. This device can restore now, but cannot publish until an administrator approves it.",
          };
        }
        return { status: "done", detail: "Trust registry adopted; this device is trusted." };
      });

      await stage("settings", false, async () => {
        const pulled = await this.deps.settings.pull({ expectFresh: false });
        if (!pulled.applied) {
          return {
            status: pulled.reason === "absent" ? "skipped" : "done",
            detail:
              pulled.reason === "absent"
                ? "No shared settings have been published yet."
                : `Shared settings already match (${pulled.reason ?? "unchanged"}).`,
          };
        }
        return { status: "done", detail: "Shared preferences restored." };
      });

      await stage("projects", false, async () => {
        await this.deps.service.syncNow();
        const status = this.deps.service.syncStatusView();
        if (status.lastError !== null) throw new Error(status.lastError);
        const count = this.deps.service.allConfigs().length;
        const quarantined = status.quarantined;
        return {
          status: count === 0 && quarantined === 0 ? "skipped" : "done",
          detail:
            count === 0 && quarantined === 0
              ? "No MCP projects have been published yet."
              : `${count} project${count === 1 ? "" : "s"} restored` +
                (quarantined > 0 ? `; ${quarantined} refused and quarantined.` : "."),
        };
      });

      await stage("bindings", false, async () => {
        // `expectFresh: false` because re-applying the current revision onto a
        // blank device is exactly the point of a restore.
        const out = await this.deps.bindings.restoreOwn({ expectFresh: false });
        if (out.reason !== undefined) {
          return {
            status: out.reason === "absent" ? "skipped" : "done",
            detail:
              out.reason === "absent"
                ? "This device has no folder layout stored for it yet."
                : `Folder layout not restored (${out.reason}).`,
          };
        }
        const restored = out.restored.length;
        const skipped = out.skipped.length;
        return {
          status: restored === 0 && skipped === 0 ? "skipped" : "done",
          detail:
            restored === 0 && skipped === 0
              ? "This device had no folder layout to relink."
              : `${restored} folder${restored === 1 ? "" : "s"} relinked` +
                (skipped > 0 ? `; ${skipped} skipped (missing folder or project).` : "."),
        };
      });

      await stage("credentials", false, async () => {
        if (input.credentialPassphrase === undefined) {
          return {
            status: "skipped",
            detail: "No credential passphrase given — server secrets were not restored.",
          };
        }
        const out = await this.deps.credentials.restore(input.credentialPassphrase);
        if (out.reason !== undefined) {
          if (out.reason === "absent" || out.reason === "purged") {
            return { status: "skipped", detail: "No credential backup is stored." };
          }
          // A wrong passphrase is a real failure worth surfacing, not a skip: the
          // operator supplied one and it did not work.
          throw new Error(reasonText(out.reason));
        }
        return {
          status: "done",
          detail:
            `${out.restored} credential${out.restored === 1 ? "" : "s"} restored` +
            (out.projects.length > 0 ? ` for ${out.projects.join(", ")}.` : "."),
        };
      });

      await stage("profiles", false, async () => {
        const summary = await this.deps.cloud.syncAll();
        if (summary.error !== null) throw new Error(summary.error);
        const total = summary.restored + summary.uploaded + summary.reconciled;
        return {
          status: summary.remoteDiscovered === 0 && total === 0 ? "skipped" : "done",
          detail:
            summary.remoteDiscovered === 0 && total === 0
              ? "No browser profiles have been backed up yet."
              : `${summary.restored} profile${summary.restored === 1 ? "" : "s"} restored` +
                (summary.failed > 0 ? `; ${summary.failed} failed.` : ".") +
                (summary.remoteTruncated
                  ? " Some profiles were not listed — run the sync again."
                  : ""),
        };
      });
    } catch (err) {
      // A fatal stage has already recorded itself; everything after it stays
      // `pending`, which is a truthful description of what happened.
      if (!(err instanceof FatalStageError)) throw err;
    }

    const list = SETUP_STAGES.map((id) => stages.get(id) as SetupStageState);
    return {
      ok: list.every((s) => s.status === "done" || s.status === "skipped"),
      stages: list,
      deviceId,
      canPublish,
      awaitingApproval,
    };
  }
}

/** A non-secret, human-readable line for a failure. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function reasonText(reason: string): string {
  switch (reason) {
    case "wrong-passphrase":
      return "The credential passphrase does not open the stored backup.";
    case "malformed":
      return "The stored credential backup could not be read and may be damaged.";
    case "rejected":
      return "The stored credential backup could not be trusted.";
    case "not-syncing":
      return "Cloud Sync was not ready when credentials were restored.";
    default:
      return `Credentials could not be restored (${reason}).`;
  }
}
