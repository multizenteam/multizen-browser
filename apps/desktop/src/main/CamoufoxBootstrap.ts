import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, net } from "electron";
import extract from "extract-zip";
import type { ChromiumStatus } from "@multizen/types";
import type { EngineBootstrap } from "./engineRegistry.ts";

const execFileP = promisify(execFile);

/**
 * Engine bootstrap for Camoufox (the Firefox-family engine): downloads +
 * verifies + locates the Camoufox binary and reports readiness, mirroring
 * {@link ChromiumBootstrap} so the registry can treat both uniformly.
 *
 * SECURITY — the binary download is integrity-checked, fail-closed. camoufox-js's
 * own fetcher downloads the latest release in its supported RANGE with NO hash
 * check, which would let a compromised upstream / swapped asset / TLS-intercepting
 * proxy deliver arbitrary native code that we then chmod +x and execute. So we do
 * NOT use camoufox-js's fetcher: we download an EXACT pinned tag ourselves over
 * Electron's `net` (Chromium TLS stack), verify it against an embedded per-platform
 * SHA-256 before extraction, and only then let camoufox-js LOCATE the result. Same
 * rigor as ChromiumBootstrap's SHA256SUMS check.
 *
 * The pin is trust-on-first-use: the hashes below are GitHub's server-computed
 * asset digests for {@link CAMOUFOX_PIN.tag}. Upgrading the browser = bump the tag
 * + hashes here (and re-run the security review). The camoufox-js version stays
 * coupled to the browser version, so a browser bump usually rides a camoufox-js bump.
 *
 * camoufox-js (and its native deps) is imported LAZILY — only inside `ensure()` —
 * so it never touches app startup for Chromium-engine users.
 */
type Pkgman = typeof import("camoufox-js/dist/pkgman.js");

/**
 * Pinned Camoufox release + the SHA-256 of each platform asset. daijro/camoufox
 * publishes no checksums file, so these were captured from GitHub's asset
 * `digest` field for the tag. Keys are camoufox-js's platform tokens; the asset
 * is `camoufox-<version>-<release>-<key>.zip`.
 */
const CAMOUFOX_PIN = {
  tag: "v152.0.4-beta.30",
  version: "152.0.4",
  release: "beta.30",
  sha256: {
    "mac.arm64": "3b43e766574f286a6a63296cf58b660b7a3120952086c869b4df4c9a71604bc3",
    "mac.x86_64": "f12f90a3650478e670064a2f071c13b998fdd1125f79dc9f6cad5a9b9395b4bc",
    "win.x86_64": "ea52a02fb1cfb1813ef6a326bea03fb2b650c9774143d953a94a27bfc8f10072",
    "win.i686": "01bd3383af3707f7f44f39f91f060a40e0d5909146ec6fdb439687bf4d4e4fac",
    "lin.x86_64": "5720d45b894ce1770543de024c6f10d514b38be560fa2dc3226b3d8586caf672",
    "lin.arm64": "60447260af8bebdb0ec3f2aa72f687b879e5598367303de2e3fdbc7a5be8c124",
  } as Record<string, string>,
} as const;

/** camoufox-js's platform token for this host (used in the asset name). */
function platformKey(): string {
  const a = process.arch;
  const p = process.platform;
  if (p === "darwin") return a === "arm64" ? "mac.arm64" : "mac.x86_64";
  if (p === "win32") return a === "ia32" ? "win.i686" : "win.x86_64";
  if (p === "linux") return a === "arm64" ? "lin.arm64" : "lin.x86_64";
  throw new Error(`Unsupported platform for Camoufox: ${p}/${a}`);
}

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
    // quick succession would otherwise start two downloads/extractions into the
    // same dir. Memoized only WHILE IN FLIGHT (cleared on settle), so a later
    // ensure() after the dir is cleared still re-runs.
    if (this.ensureInFlight) return this.ensureInFlight;
    this.ensureInFlight = this.doEnsure().finally(() => {
      this.ensureInFlight = null;
    });
    return this.ensureInFlight;
  }

  private async doEnsure(): Promise<ChromiumStatus> {
    const installDir = join(app.getPath("userData"), "camoufox");
    // Always app-controlled. We deliberately OVERRIDE any inherited
    // CAMOUFOX_INSTALL_DIR: honoring it would let anyone able to influence the
    // app's environment (launchd user env, a poisoned shell profile, a wrapper
    // bundle) point camoufox-js at a pre-planted binary we'd then execute.
    process.env.CAMOUFOX_INSTALL_DIR = installDir;

    const pkgman: Pkgman = await import("camoufox-js/dist/pkgman.js");

    // Already installed at the pinned version? Trust the prior verified extract
    // (parity with ChromiumBootstrap, which trusts its cached copy via
    // current.json rather than re-hashing a multi-hundred-MB tree each launch).
    const versionFile = join(installDir, "version.json");
    if (await this.installedMatchesPin(versionFile)) {
      try {
        const p = pkgman.launchPath();
        if (existsSync(p)) {
          this.binaryPath = p;
          this.setStatus({ kind: "ready", version: pinnedVersion(), binaryPath: p });
          return this.status;
        }
      } catch {
        /* marker present but binary missing — fall through to a clean reinstall */
      }
    }

    const key = platformKey();
    const expectedSha = CAMOUFOX_PIN.sha256[key];
    if (!expectedSha) throw new Error(`No pinned Camoufox hash for platform ${key}`);
    const assetName = `camoufox-${CAMOUFOX_PIN.version}-${CAMOUFOX_PIN.release}-${key}.zip`;
    const url = `https://github.com/daijro/camoufox/releases/download/${CAMOUFOX_PIN.tag}/${assetName}`;

    this.setStatus({
      kind: "downloading",
      bytesReceived: 0,
      bytesTotal: 0,
      version: CAMOUFOX_PIN.version,
    });
    try {
      // Start from a clean dir so a stale/older extraction can never be mixed
      // with the new one (also removes a partial from a previous failed run).
      await rm(installDir, { recursive: true, force: true });
      await mkdir(installDir, { recursive: true });

      const zipPath = join(installDir, `${assetName}.partial`);
      await downloadAndVerify(url, zipPath, expectedSha, (received, total) =>
        this.setStatus({
          kind: "downloading",
          bytesReceived: received,
          bytesTotal: total,
          version: CAMOUFOX_PIN.version,
        }),
      );

      this.setStatus({ kind: "extracting", version: CAMOUFOX_PIN.version });
      await extract(zipPath, { dir: installDir });
      await rm(zipPath, { force: true });

      // Executable bits: extract-zip preserves zip modes, but make the launch
      // binary runnable regardless (Windows: no-op).
      if (process.platform !== "win32") {
        await execFileP("chmod", ["-R", "755", installDir]);
      }

      // Write the layout marker camoufox-js looks for, so launchPath() locates
      // our verified install instead of firing its own unverified re-download.
      await writeFile(
        versionFile,
        JSON.stringify({ version: CAMOUFOX_PIN.version, release: CAMOUFOX_PIN.release }),
      );

      const p = pkgman.launchPath();
      this.binaryPath = p;
      this.setStatus({ kind: "ready", version: pinnedVersion(), binaryPath: p });
    } catch (e) {
      this.setStatus({ kind: "error", message: (e as Error).message });
      throw e;
    }
    return this.status;
  }

  private async installedMatchesPin(versionFile: string): Promise<boolean> {
    try {
      const v = JSON.parse(await readFile(versionFile, "utf8")) as {
        version?: string;
        release?: string;
      };
      return v.version === CAMOUFOX_PIN.version && v.release === CAMOUFOX_PIN.release;
    } catch {
      return false;
    }
  }

  private setStatus(next: ChromiumStatus): void {
    this.status = next;
    this.emit("status", next);
  }
}

function pinnedVersion(): string {
  return `${CAMOUFOX_PIN.version}-${CAMOUFOX_PIN.release}`;
}

/**
 * Download `url` to `outPath` over Electron's `net` (Chromium network stack, so
 * it inherits the browser's TLS behaviour and AV allow-listing), hashing as it
 * streams, and verify the SHA-256 against `expectedSha` FAIL-CLOSED. A mismatch
 * means the bytes were altered in transit or tampered upstream — we scrub and
 * throw rather than execute them. Bounded retry for flaky links.
 */
async function downloadAndVerify(
  url: string,
  outPath: string,
  expectedSha: string,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await rm(outPath, { force: true });
      const res = await net.fetch(url);
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} fetching Camoufox archive`);
      }
      const total = Number(res.headers.get("content-length") ?? 0);
      const hash = createHash("sha256");
      const out = createWriteStream(outPath);
      let received = 0;
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          received += value.length;
          if (!out.write(value)) await once(out, "drain");
          onProgress?.(received, total);
        }
      } finally {
        out.end();
        await once(out, "close");
      }

      const sha = hash.digest("hex");
      if (sha !== expectedSha) {
        await rm(outPath, { force: true });
        throw new Error(
          `Camoufox checksum mismatch (got ${sha.slice(0, 12)}…, expected ` +
            `${expectedSha.slice(0, 12)}…) — the download was altered in transit ` +
            `or tampered upstream. Refusing to run it.`,
        );
      }
      return;
    } catch (e) {
      lastError = e as Error;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }

  await rm(outPath, { force: true });
  throw new Error(
    `Could not download a verified Camoufox archive after ${MAX_ATTEMPTS} attempts. ` +
      `Last error: ${lastError?.message ?? "unknown"}.`,
  );
}
