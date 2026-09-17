import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { ChromiumStatus } from "@multizen/types";
import type { EngineBootstrap } from "./engineRegistry.ts";

/**
 * Engine bootstrap for Camoufox (the Firefox-family engine): downloads + locates
 * the Camoufox binary and reports readiness, mirroring {@link ChromiumBootstrap}
 * so the registry can treat both uniformly (both satisfy {@link EngineBootstrap}).
 *
 * camoufox-js (and its native deps: impit, better-sqlite3@13) is loaded LAZILY —
 * only inside `ensure()`, when a Camoufox profile is actually launched — so it
 * never touches app startup for the majority of users on the Chromium engine.
 * `ensure()` caches the resolved binary path, so `resolveBinaryPath()` stays
 * synchronous (matching the interface) without re-importing camoufox-js.
 *
 * Hardening applied: the binary is relocated into an app-controlled dir via
 * CAMOUFOX_INSTALL_DIR (set before camoufox-js first loads), not camoufox-js's
 * default per-user cache.
 *
 * HARDENING STILL TO DO before release (from the Camoufox security review):
 *   - camoufox-js's fetcher downloads the latest version in its SUPPORTED RANGE
 *     (constrained to known-good releases), NOT an exact pinned tag. Pinning an
 *     exact CI-built daijro/camoufox tag needs our own downloader.
 *   - verify a KNOWN (pre-shipped, out-of-band) SHA-256 fail-closed; camoufox-js
 *     does no integrity check on the download.
 * Tracked in specs/per-profile-engine/tasks.md (T21 / pre-release hardening).
 */
type Pkgman = typeof import("camoufox-js/dist/pkgman.js");

interface CamoufoxBootstrapEvents {
  status: (status: ChromiumStatus) => void;
}

export class CamoufoxBootstrap extends EventEmitter implements EngineBootstrap {
  private status: ChromiumStatus = { kind: "missing" };
  private binaryPath: string | null = null;
  /** Non-null while an ensure() install is running, to collapse concurrent
   *  callers onto one download (see ensure()). */
  private ensureInFlight: Promise<ChromiumStatus> | null = null;

  override on<K extends keyof CamoufoxBootstrapEvents>(
    event: K,
    listener: CamoufoxBootstrapEvents[K],
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof CamoufoxBootstrapEvents>(
    event: K,
    ...args: Parameters<CamoufoxBootstrapEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getStatus(): ChromiumStatus {
    return this.status;
  }

  /** Known only after a successful ensure() (avoids loading camoufox-js here). */
  getInstalledVersion(): string | null {
    return this.status.kind === "ready" ? this.status.version : null;
  }

  resolveBinaryPath(): string {
    if (!this.binaryPath) {
      throw new Error("Camoufox is not ready — call ensure() before resolveBinaryPath()");
    }
    return this.binaryPath;
  }

  async ensure(): Promise<ChromiumStatus> {
    // Collapse concurrent callers onto one install. Two Camoufox launches in
    // quick succession would otherwise start two CamoufoxFetcher.install()s into
    // the same dir, each of which begins by rmSync-ing it — the second wipes the
    // first's extracted tree mid-flight → corrupt, mixed-provenance install.
    // Memoized only WHILE IN FLIGHT (cleared on settle), so a later ensure()
    // after the dir is cleared still re-runs.
    if (this.ensureInFlight) return this.ensureInFlight;
    this.ensureInFlight = this.doEnsure().finally(() => {
      this.ensureInFlight = null;
    });
    return this.ensureInFlight;
  }

  private async doEnsure(): Promise<ChromiumStatus> {
    // Relocate the binary into an app-controlled dir instead of camoufox-js's
    // default per-user cache. camoufox-js reads CAMOUFOX_INSTALL_DIR when its
    // pkgman module first evaluates — which is the dynamic import just below,
    // so setting it here (before that import) takes effect. Respect an explicit
    // override if the environment already set one.
    if (!process.env.CAMOUFOX_INSTALL_DIR) {
      process.env.CAMOUFOX_INSTALL_DIR = join(app.getPath("userData"), "camoufox");
    }
    const pkgman: Pkgman = await import("camoufox-js/dist/pkgman.js");

    // Already installed? launchPath() throws when nothing is installed yet.
    try {
      const p = pkgman.launchPath();
      if (existsSync(p)) {
        this.binaryPath = p;
        this.setStatus({ kind: "ready", version: installedVersion(pkgman), binaryPath: p });
        return this.status;
      }
    } catch {
      /* not installed yet — fall through to download */
    }

    this.setStatus({ kind: "downloading", bytesReceived: 0, bytesTotal: 0, version: "" });
    try {
      const fetcher = new pkgman.CamoufoxFetcher();
      await fetcher.init();
      await fetcher.install();
      const p = pkgman.launchPath();
      this.binaryPath = p;
      this.setStatus({ kind: "ready", version: installedVersion(pkgman), binaryPath: p });
    } catch (e) {
      this.setStatus({ kind: "error", message: (e as Error).message });
      throw e;
    }
    return this.status;
  }

  private setStatus(next: ChromiumStatus): void {
    this.status = next;
    this.emit("status", next);
  }
}

function installedVersion(pkgman: Pkgman): string {
  try {
    return pkgman.installedVerStr() || "unknown";
  } catch {
    return "unknown";
  }
}
