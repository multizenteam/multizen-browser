import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
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
 * HARDENING STILL TO DO before release (from the Camoufox security review):
 *   - camoufox-js's fetcher downloads the latest version in its supported range,
 *     NOT an exact pinned tag. Pin an exact CI-built daijro/camoufox release.
 *   - relocate the binary into an app-controlled dir and verify a known SHA-256
 *     fail-closed (today it lands in camoufox-js's default per-user cache dir).
 * Tracked in specs/per-profile-engine/tasks.md (T21 / pre-release hardening).
 */
type Pkgman = typeof import("camoufox-js/dist/pkgman.js");

interface CamoufoxBootstrapEvents {
  status: (status: ChromiumStatus) => void;
}

export class CamoufoxBootstrap extends EventEmitter implements EngineBootstrap {
  private status: ChromiumStatus = { kind: "missing" };
  private binaryPath: string | null = null;

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
