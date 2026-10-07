/**
 * Standalone tsx verification for per-profile engine resolution. No test runner
 * exists on master (project rule: do not add one), so this self-running script
 * exits non-zero on the first failed invariant.
 *
 * Covers:
 *   - resolveEngine precedence (AC2 launch resolution, AC10 default-for-new)
 *   - isBrowserEngine / import not-in-roster fallback (AC8)
 *   - SettingsStore coercion of a stored legacy "cft" (AC11)
 *
 * Run (tsx + @multizen/settings-store are test-only devDeps of this package):
 *   yarn workspace @multizen/profile-manager exec tsx scripts/test-engine-resolution.ts
 * or from the package dir:  npx tsx scripts/test-engine-resolution.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveEngine,
  isBrowserEngine,
  BROWSER_ENGINES,
  type BrowserEngine,
} from "@multizen/types";
import { SettingsStore } from "@multizen/settings-store";

let checks = 0;
let fails = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  checks++;
  try {
    await fn();
  } catch (e) {
    fails++;
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
  }
}

/**
 * The exact import decision from the profiles:import IPC: a recorded engine the
 * build can't run is cleared (so it resolves to the default) and the user is
 * notified. Replicated here to lock the contract.
 */
function coerceImportedEngine(recorded: unknown): {
  engine: BrowserEngine | undefined;
  notice: boolean;
} {
  if (recorded !== undefined && !isBrowserEngine(recorded)) {
    return { engine: undefined, notice: true };
  }
  return { engine: recorded as BrowserEngine | undefined, notice: false };
}

async function run(): Promise<void> {
  // ── AC2 / AC10: resolveEngine precedence ──────────────────────────────────
  await check("both unset → cloakbrowser fallback", () => {
    assert.equal(resolveEngine(undefined, undefined), "cloakbrowser");
    assert.equal(resolveEngine(null, null), "cloakbrowser");
  });
  await check("no profile engine → app default (legacy/null-engine profile)", () => {
    assert.equal(resolveEngine(undefined, "camoufox"), "camoufox");
    assert.equal(resolveEngine(null, "cloakbrowser"), "cloakbrowser");
  });
  await check("profile engine wins over the default", () => {
    assert.equal(resolveEngine("camoufox", "cloakbrowser"), "camoufox");
    assert.equal(resolveEngine("cloakbrowser", "camoufox"), "cloakbrowser");
  });

  // ── AC8: roster guard + import fallback ────────────────────────────────────
  await check("BROWSER_ENGINES is exactly {cloakbrowser, camoufox}, no cft", () => {
    assert.deepEqual([...BROWSER_ENGINES].sort(), ["camoufox", "cloakbrowser"]);
    assert.ok(!(BROWSER_ENGINES as readonly string[]).includes("cft"));
  });
  await check("isBrowserEngine accepts the roster, rejects everything else", () => {
    assert.equal(isBrowserEngine("cloakbrowser"), true);
    assert.equal(isBrowserEngine("camoufox"), true);
    assert.equal(isBrowserEngine("cft"), false);
    assert.equal(isBrowserEngine("chrome"), false);
    assert.equal(isBrowserEngine(""), false);
    assert.equal(isBrowserEngine(undefined), false);
    assert.equal(isBrowserEngine(null), false);
    assert.equal(isBrowserEngine(42), false);
  });
  await check("import of a not-in-roster engine → cleared + notice → default at launch", () => {
    const r = coerceImportedEngine("cft");
    assert.equal(r.engine, undefined);
    assert.equal(r.notice, true);
    // Cleared engine resolves to the app default at launch.
    assert.equal(resolveEngine(r.engine, "cloakbrowser"), "cloakbrowser");
  });
  await check("import of an in-roster engine → preserved, no notice", () => {
    const r = coerceImportedEngine("camoufox");
    assert.equal(r.engine, "camoufox");
    assert.equal(r.notice, false);
  });
  await check("import of an unset engine → unset, no notice", () => {
    const r = coerceImportedEngine(undefined);
    assert.equal(r.engine, undefined);
    assert.equal(r.notice, false);
  });

  // ── AC11: SettingsStore coerces a stored legacy "cft" ──────────────────────
  const dir = mkdtempSync(join(tmpdir(), "mz-engine-test-"));
  try {
    const load = async (stored: unknown): Promise<BrowserEngine> => {
      const p = join(dir, `settings-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(p, JSON.stringify({ browserEngine: stored }), "utf8");
      return (await new SettingsStore(p).load()).browserEngine;
    };
    await check("stored 'cft' coerces to the default (cloakbrowser)", async () => {
      assert.equal(await load("cft"), "cloakbrowser");
    });
    await check("stored garbage coerces to the default", async () => {
      assert.equal(await load("not-a-real-engine"), "cloakbrowser");
    });
    await check("a valid stored engine is preserved", async () => {
      assert.equal(await load("camoufox"), "camoufox");
      assert.equal(await load("cloakbrowser"), "cloakbrowser");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${checks - fails}/${checks} engine-resolution invariants passed`);
  if (fails > 0) process.exit(1);
}

void run();
