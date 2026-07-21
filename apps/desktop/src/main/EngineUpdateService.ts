import { EventEmitter } from "node:events";
import type { AppSettings } from "@multizen/settings-store";
import type { EngineUpdateStatus } from "@multizen/types";
import type { ChromiumBootstrap } from "./ChromiumBootstrap.ts";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const POST_LAUNCH_DELAY_MS = 10_000; // let first-run + window settle first

interface EngineUpdateEvents {
  status: (status: EngineUpdateStatus) => void;
}

interface EngineUpdateServiceOptions {
  /** The active-engine bootstrap. Its install primitives do the real work. */
  bootstrap: ChromiumBootstrap;
  /** Live accessor for current settings (re-read each time, never cached). */
  getSettings: () => AppSettings;
}

/**
 * Keeps the downloaded Chromium ENGINE (CloakBrowser / Chrome for Testing) up
 * to date, wrapped so the renderer sees a single {@link EngineUpdateStatus}
 * stream (mirrors {@link ChromiumBootstrap} and {@link UpdaterService}).
 *
 * Distinct from the APP self-update ({@link UpdaterService}): this refreshes
 * the browser binary, not MultiZen itself.
 *
 * Behaviour:
 *   - Apply semantics are "next launch". A newer version is downloaded
 *     side-by-side and `current.json` is swapped; the next profile launch
 *     picks it up while already-running browsers keep their old binary.
 *   - Best-effort everywhere. A failed check/download surfaces as an `error`
 *     status and is NEVER thrown into the launch path.
 *   - Never touches a `dev-system` engine (a locally-provided binary).
 *   - Never races the cold-start first install: if nothing is installed yet
 *     the check bails (ensure() owns the first download).
 */
export class EngineUpdateService extends EventEmitter {
  private status: EngineUpdateStatus = { kind: "idle" };
  private inFlight = false;
  private interval: NodeJS.Timeout | null = null;
  private started = false;
  /** Last-seen engineAutoUpdate, so onSettingsChanged only reacts to a real
   *  off→on flip of the toggle — not to every unrelated settings write. */
  private lastAutoUpdate: boolean;
  private readonly bootstrap: ChromiumBootstrap;
  private readonly getSettings: () => AppSettings;

  constructor(opts: EngineUpdateServiceOptions) {
    super();
    this.bootstrap = opts.bootstrap;
    this.getSettings = opts.getSettings;
    this.lastAutoUpdate = opts.getSettings().engineAutoUpdate;
  }

  override on<K extends keyof EngineUpdateEvents>(
    event: K,
    listener: EngineUpdateEvents[K],
  ): this {
    return super.on(event, listener);
  }
  override emit<K extends keyof EngineUpdateEvents>(
    event: K,
    ...args: Parameters<EngineUpdateEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getStatus(): EngineUpdateStatus {
    return this.status;
  }

  /** Schedule background checks. Idempotent; no-op for a dev-system engine. */
  init(): void {
    if (this.started) return; // never double-wire timers
    this.started = true;
    // A dev-provided system binary has no managed download to refresh.
    if (this.bootstrap.isDevSystem()) return;

    setTimeout(() => void this.maybeAutoCheck(), POST_LAUNCH_DELAY_MS);
    this.interval = setInterval(() => void this.maybeAutoCheck(), CHECK_INTERVAL_MS);
  }

  /**
   * Manual "Check for updates" from the UI — checks and stages regardless of
   * the auto-update toggle (but still honours the dev-system + in-flight
   * guards inside check()).
   */
  async updateNow(): Promise<EngineUpdateStatus> {
    await this.check({ download: true });
    return this.status;
  }

  /** Manual check-only (no staging) from the UI. */
  async checkOnly(): Promise<EngineUpdateStatus> {
    await this.check({ download: false });
    return this.status;
  }

  /**
   * React to a settings change. ONLY a false→true flip of the engineAutoUpdate
   * toggle triggers a re-check — not every settings write. Previously any
   * settings:update (e.g. switching the engine dropdown, changing a port) fired
   * a full engine check, which spammed "checking" and was confusing. Other
   * changes are no-ops here; the active engine only changes on app restart.
   */
  onSettingsChanged(): void {
    const now = this.getSettings().engineAutoUpdate;
    const flippedOn = !this.lastAutoUpdate && now;
    this.lastAutoUpdate = now;
    if (flippedOn) void this.maybeAutoCheck();
  }

  // ─── internals ──────────────────────────────────────────────────────

  private set(next: EngineUpdateStatus): void {
    this.status = next;
    const detail = "version" in next ? ` ${next.version}` : "";
    process.stderr.write(`[engine-update] ${next.kind}${detail}\n`);
    this.emit("status", next);
  }

  private async maybeAutoCheck(): Promise<void> {
    if (!this.getSettings().engineAutoUpdate) return;
    await this.check({ download: true });
  }

  /**
   * Resolve the latest published version, compare with what's installed, and
   * (optionally) stage the newer version side-by-side. Every failure is caught
   * and surfaced as an `error` status — this never throws.
   */
  private async check({ download }: { download: boolean }): Promise<void> {
    if (this.inFlight) return;
    // Never update a dev-provided system binary.
    if (this.bootstrap.isDevSystem()) return;

    const current = this.bootstrap.getInstalledVersion();
    if (!current) {
      // Nothing installed yet — the cold-start ensure() owns the first
      // download. Don't race it with a staged install of the same version.
      this.set({ kind: "idle" });
      return;
    }

    this.inFlight = true;
    try {
      this.set({ kind: "checking" });
      const { version, manifest } = await this.bootstrap.resolveLatestVersion();
      if (!isNewerVersion(version, current)) {
        this.set({ kind: "up-to-date", version: current });
        return;
      }
      this.set({ kind: "available", version, current });
      if (download) {
        const staged = await this.bootstrap.stageVersion(manifest, (bytesReceived, bytesTotal) =>
          this.set({ kind: "downloading", version, bytesReceived, bytesTotal }),
        );
        this.set({ kind: "staged", version: staged });
      }
    } catch (e) {
      // Best-effort: a failed check/download must never break a launch.
      this.set({ kind: "error", message: (e as Error).message });
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * Compare two dotted version strings numerically, segment by segment. Missing
 * segments count as 0, so "146.0.7680.177.4" > "146.0.7680.177" > "146.0.7680.99".
 * Non-numeric segments fall back to a string comparison of that segment. Never
 * lexicographic over the whole string (which would rank "146.0.7680.99" above
 * "146.0.7680.177").
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const rawA = pa[i] ?? "0";
    const rawB = pb[i] ?? "0";
    const na = Number(rawA);
    const nb = Number(rawB);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      if (rawA !== rawB) return rawA < rawB ? -1 : 1;
      continue;
    }
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/** True when `candidate` is a strictly newer version than `installed`. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  return compareVersions(candidate, installed) > 0;
}
