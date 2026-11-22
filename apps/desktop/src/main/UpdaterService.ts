import { BRAND } from "./brand";
import { app } from "electron";
import { EventEmitter } from "node:events";
import electronUpdater from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "electron-updater";
import type { AppSettings } from "@multizen/settings-store";
import type { UpdateStatus } from "@multizen/types";

// electron-updater is CommonJS; in our ESM main we pull `autoUpdater` off the
// default export rather than a named import (which the CJS↔ESM interop doesn't
// reliably provide).
const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
const POST_LAUNCH_DELAY_MS = 8_000; // let first-run + window settle first
const RELEASES = "https://github.com/irensaltali/sekvona/releases";

interface UpdaterEvents {
  status: (status: UpdateStatus) => void;
}

interface UpdaterServiceOptions {
  /** Live accessor for current settings (re-read each time, never cached). */
  getSettings: () => AppSettings;
}

/**
 * App self-update via electron-updater, wrapped so the renderer sees a single
 * {@link UpdateStatus} stream (mirrors {@link ChromiumBootstrap}).
 *
 * Platform behaviour:
 *   - Windows (NSIS) + Linux (AppImage): full flow — background check →
 *     autoDownload → "ready" → quitAndInstall on restart.
 *   - macOS: CHECK-ONLY. Auto-install is impossible without an Apple Developer
 *     ID (Squirrel.Mac rejects the ad-hoc signature), so we never download or
 *     install; on a newer version we emit a terminal "available" with a DMG
 *     deep-link and let the user download manually. Squirrel signature errors
 *     are swallowed so they never surface raw.
 *
 * No-op when `!app.isPackaged` (dev) or when the environment can't update
 * (e.g. Linux not launched as a real .AppImage) — never crashes or error-toasts.
 */
export class UpdaterService extends EventEmitter {
  private status: UpdateStatus = { kind: "idle" };
  private lastCheckedAt = 0;
  private checking = false;
  private lastManual = false;
  private pendingVersion: string | null = null;
  private interval: NodeJS.Timeout | null = null;
  private started = false;
  private readonly getSettings: () => AppSettings;
  private readonly isMac = process.platform === "darwin";

  constructor(opts: UpdaterServiceOptions) {
    super();
    this.getSettings = opts.getSettings;
  }

  override on<K extends keyof UpdaterEvents>(event: K, listener: UpdaterEvents[K]): this {
    return super.on(event, listener);
  }
  override emit<K extends keyof UpdaterEvents>(
    event: K,
    ...args: Parameters<UpdaterEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /** Epoch ms of the last completed check, or 0 if never. */
  getLastCheckedAt(): number {
    return this.lastCheckedAt;
  }

  /** Wire electron-updater and schedule background checks. Safe to call once. */
  init(): void {
    if (this.started) return; // idempotent — never double-wire listeners/timers
    this.started = true;
    if (!app.isPackaged) {
      // Dev: there is no app-update.yml and no installer to swap. Stay idle.
      return;
    }
    autoUpdater.autoDownload = !this.isMac;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.fullChangelog = false;

    this.wireEvents();

    setTimeout(() => void this.maybeAutoCheck(), POST_LAUNCH_DELAY_MS);
    this.interval = setInterval(() => void this.maybeAutoCheck(), CHECK_INTERVAL_MS);
  }

  /** Manual check from the UI — bypasses the time gate but not the in-flight guard. */
  async checkForUpdates(opts: { manual: boolean }): Promise<UpdateStatus> {
    await this.runCheck(opts.manual);
    return this.status;
  }

  /** Apply a staged update (Windows/Linux only). Quits and relaunches. */
  installAndRestart(): void {
    if (this.isMac) return;
    autoUpdater.quitAndInstall();
  }

  /**
   * Build the download URL for a version. macOS → the arch-matched DMG asset;
   * other platforms → the release page (fallback only).
   */
  downloadUrlFor(version: string): string {
    if (this.isMac) {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      return `${RELEASES}/download/v${version}/${BRAND.name}-mac-${arch}.dmg`;
    }
    return `${RELEASES}/tag/v${version}`;
  }

  /** Re-evaluate after settings change (e.g. autoUpdate toggled on). */
  onSettingsChanged(): void {
    if (!app.isPackaged) return;
    if (this.getSettings().autoUpdate) void this.maybeAutoCheck();
  }

  // ─── internals ──────────────────────────────────────────────────────

  private set(next: UpdateStatus): void {
    this.status = next;
    const detail = "version" in next ? ` ${next.version}` : "";
    process.stderr.write(`[updater] ${next.kind}${detail}\n`);
    this.emit("status", next);
  }

  private async maybeAutoCheck(): Promise<void> {
    if (!this.getSettings().autoUpdate) return;
    await this.runCheck(false);
  }

  private async runCheck(manual: boolean): Promise<void> {
    if (!app.isPackaged) {
      // Dev: give manual checks honest feedback, stay quiet otherwise.
      this.set(manual ? { kind: "up-to-date", version: app.getVersion() } : { kind: "idle" });
      return;
    }
    if (this.checking) return;
    // Time gate (DIY — electron-updater has none) to avoid double-download.
    if (!manual && Date.now() - this.lastCheckedAt < CHECK_INTERVAL_MS) return;

    this.checking = true;
    this.lastManual = manual;
    try {
      await autoUpdater.checkForUpdates();
      // Stamp only on success so a transient failure (offline, 5xx) doesn't
      // arm the 4h gate and block the next auto-retry.
      this.lastCheckedAt = Date.now();
    } catch (e) {
      this.handleError(e as Error);
    } finally {
      this.checking = false;
    }
  }

  /** True while we hold a terminal, user-actionable state we must not downgrade. */
  private isStaged(): boolean {
    return this.status.kind === "ready" || this.status.kind === "available";
  }

  private wireEvents(): void {
    autoUpdater.on("checking-for-update", () => {
      // Don't wipe an already-staged update with a transient "checking".
      if (!this.isStaged()) this.set({ kind: "checking" });
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.pendingVersion = info.version;
      if (this.isMac) {
        // Terminal on macOS — we can't install, only point at the DMG.
        this.set({
          kind: "available",
          version: info.version,
          downloadUrl: this.downloadUrlFor(info.version),
        });
      }
      // Windows/Linux: autoDownload is running; wait for progress/downloaded.
    });

    autoUpdater.on("update-not-available", () => {
      // Keep a staged "ready"/"available" — a re-check must not hide a pending
      // restart (e.g. if the published release was yanked after we staged it).
      if (this.isStaged()) return;
      this.set(
        this.lastManual ? { kind: "up-to-date", version: app.getVersion() } : { kind: "idle" },
      );
    });

    autoUpdater.on("download-progress", (p: ProgressInfo) => {
      this.set({
        kind: "downloading",
        version: this.pendingVersion ?? app.getVersion(),
        percent: Math.round(p.percent),
        bytesPerSecond: p.bytesPerSecond,
      });
    });

    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.set({ kind: "ready", version: info.version });
    });

    autoUpdater.on("error", (err: Error) => this.handleError(err));
  }

  private handleError(err: Error): void {
    const msg = err?.message ?? "Update failed";
    // Environment genuinely can't self-update (Linux not launched as a real
    // .AppImage) — treat as "nothing to do", not a user-facing error.
    if (/APPIMAGE/i.test(msg)) {
      this.set({ kind: "idle" });
      return;
    }
    // macOS install path is never invoked (autoDownload=false, no
    // quitAndInstall), but if Squirrel ever rejects the ad-hoc signature don't
    // surface it raw. Real check failures (offline, GitHub 5xx) DO surface so
    // the UI never gets stuck on "checking".
    if (this.isMac && /signature|not signed|code sign/i.test(msg)) {
      this.set({ kind: "idle" });
      return;
    }
    this.set({ kind: "error", message: msg });
  }
}
