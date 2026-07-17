/**
 * Compare generate-time CHROME_VERSION_MAJOR against a CloakBrowser / CFT binary.
 *
 * Resolve order:
 *   1. MULTIZEN_CHROMIUM_BIN
 *   2. MultiZen bootstrap cache current.json (cloakbrowser, then cft)
 *
 * Exit 0 + skip message when no binary is present (CI without CloakBrowser).
 * Fail when |constMajor - binaryMajor| > THRESHOLD (default 0).
 *
 * Run: `npx tsx packages/profile-manager/scripts/check-chrome-version.ts`
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { CHROME_VERSION_FULL, CHROME_VERSION_MAJOR } from "../src/fingerprint.js";

const THRESHOLD = Number(process.env.MULTIZEN_CHROME_MAJOR_THRESHOLD ?? "0");

function parseMajor(s: string): number | null {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return Number(m[1]);
}

function userDataRoots(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(appData, "MultiZen")];
  }
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", "MultiZen")];
  }
  return [join(home, ".config", "MultiZen")];
}

function binaryFromCache(cacheDir: string): string | null {
  const manifestPath = join(cacheDir, "current.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const cur = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version: string;
      binaryRelative: string;
    };
    const candidate = join(cacheDir, cur.version, cur.binaryRelative);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function resolveBinary(): string | null {
  const envBin = process.env.MULTIZEN_CHROMIUM_BIN?.trim();
  if (envBin && existsSync(envBin)) return envBin;

  for (const root of userDataRoots()) {
    for (const engine of ["cloakbrowser", "cft"] as const) {
      const hit = binaryFromCache(join(root, "chromium", engine));
      if (hit) return hit;
    }
  }
  return null;
}

function detectBinaryMajor(binaryPath: string): number | null {
  if (process.platform === "win32") {
    try {
      const escaped = binaryPath.replace(/'/g, "''");
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      return parseMajor(out.trim());
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseMajor(out);
  } catch {
    return null;
  }
}

function main(): void {
  console.log(
    `generate-time constants: CHROME_VERSION_MAJOR=${CHROME_VERSION_MAJOR} FULL=${CHROME_VERSION_FULL}`,
  );

  const binary = resolveBinary();
  if (!binary) {
    console.log(
      "skip: no Chromium binary found (set MULTIZEN_CHROMIUM_BIN or install MultiZen CloakBrowser/CFT cache)",
    );
    process.exit(0);
  }

  console.log(`binary: ${binary}`);
  const binaryMajor = detectBinaryMajor(binary);
  if (binaryMajor == null) {
    console.error("fail: could not parse binary ProductVersion / --version");
    process.exit(1);
  }

  const drift = Math.abs(CHROME_VERSION_MAJOR - binaryMajor);
  console.log(
    `binary major=${binaryMajor}; |const - binary|=${drift}; threshold=${THRESHOLD}`,
  );
  if (drift > THRESHOLD) {
    console.error(
      `fail: CHROME_VERSION_MAJOR (${CHROME_VERSION_MAJOR}) drifts from binary major (${binaryMajor}) by ${drift} (max ${THRESHOLD}). See docs/chrome-version-bump.md`,
    );
    process.exit(1);
  }
  console.log("ok: chrome version constants match binary within threshold");
}

main();
