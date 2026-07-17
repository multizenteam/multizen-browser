/**
 * Entropy / reconcile / seed acceptance tests (P0-1…P0-4, P1-7).
 *
 * Run: `npx tsx packages/profile-manager/scripts/test-fingerprint-entropy.ts`
 * from the repo root.
 */
import {
  generateFingerprint,
  reconcileFingerprint,
  FingerprintReconcileError,
  localeCatalog,
  hostPlatformFamily,
} from "../src/fingerprint.js";
import type { FingerprintConfig } from "@multizen/types";

function coarseHash(fp: FingerprintConfig): string {
  return [
    fp.userAgent,
    fp.platform,
    fp.webgl.vendor,
    fp.webgl.renderer,
    `${fp.screen.width}x${fp.screen.height}`,
  ].join("|");
}

function webglKey(fp: FingerprintConfig): string {
  return `${fp.webgl.vendor}|${fp.webgl.renderer}`;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function diversityForLocale(localeId: string): void {
  const combos = new Set<string>();
  const webgls = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const base = generateFingerprint(`entropy-${localeId}-${i}`);
    const fp = reconcileFingerprint(base, { localeId });
    combos.add(coarseHash(fp));
    webgls.add(webglKey(fp));
  }
  // 50 generates for WebGL diversity
  for (let i = 30; i < 50; i++) {
    const base = generateFingerprint(`entropy-webgl-${localeId}-${i}`);
    const fp = reconcileFingerprint(base, { localeId });
    webgls.add(webglKey(fp));
  }

  console.log(
    `${localeId}: ${combos.size} coarse combos / 30 seeds; ${webgls.size} WebGL pairs / 50 seeds (host=${hostPlatformFamily()})`,
  );

  // Windows host pool stays high; Mac/Linux raised after catalog expansion
  // (plan E: ≥15 coarse / ≥8 WebGL).
  const minCombos = hostPlatformFamily() === "windows" ? 20 : 15;
  const minWebgl = hostPlatformFamily() === "windows" ? 10 : 8;
  assert(
    combos.size >= minCombos,
    `P0-1 FAIL: ${localeId} only ${combos.size} combos (need ≥${minCombos})`,
  );
  assert(
    webgls.size >= minWebgl,
    `P0-2 FAIL: ${localeId} only ${webgls.size} WebGL pairs (need ≥${minWebgl})`,
  );
}

function reconcileHonor(): void {
  const base = generateFingerprint("honor-base");
  const fp = reconcileFingerprint(base, {
    localeId: "en-PK",
    timezone: "Asia/Karachi",
    screen: { width: 1920, height: 1080 },
    hardwareConcurrency: 8,
    deviceMemory: 8,
  });
  assert(fp.locale === "en-PK", `locale=${fp.locale}`);
  assert(fp.timezone === "Asia/Karachi", `tz=${fp.timezone}`);
  assert(fp.screen.width === 1920 && fp.screen.height === 1080, `screen=${JSON.stringify(fp.screen)}`);
  assert(fp.hardwareConcurrency === 8, `hwc=${fp.hardwareConcurrency}`);
  assert(fp.deviceMemory === 8, `mem=${fp.deviceMemory}`);
  assert(!/iPhone|Android|Mobile/i.test(fp.userAgent), "mobile UA on desktop screen");

  const bd = reconcileFingerprint(base, {
    localeId: "bn-BD",
    timezone: "Asia/Dhaka",
  });
  assert(bd.locale === "bn-BD", `bn-BD became ${bd.locale}`);
  assert(bd.timezone === "Asia/Dhaka", `bn-BD tz=${bd.timezone}`);
  assert(bd.locale !== "fr-FR", "regression: bn-BD → fr-FR");

  let rejected = false;
  try {
    reconcileFingerprint(base, { localeId: "xx-YY" });
  } catch (e) {
    rejected =
      e instanceof FingerprintReconcileError &&
      e.field === "localeId" &&
      e.message.includes("xx-YY");
  }
  assert(rejected, "unknown localeId must throw FingerprintReconcileError");

  let badTz = false;
  try {
    reconcileFingerprint(base, {
      localeId: "en-PK",
      timezone: "Europe/Paris",
    });
  } catch (e) {
    badTz = e instanceof FingerprintReconcileError && e.field === "timezone";
  }
  assert(badTz, "timezone outside locale must throw");

  console.log("P0-4 reconcile honor + reject OK");
}

function seedStability(): void {
  // Same seed twice → identical device/UA/WebGL (before reconcile of identical patch)
  const a1 = generateFingerprint("stable-seed-A");
  const a2 = generateFingerprint("stable-seed-A");
  assert(
    a1.device === a2.device &&
      a1.userAgent === a2.userAgent &&
      webglKey(a1) === webglKey(a2),
    "same seed must be deterministic",
  );

  // 10 pairs same locale different seeds → ≥8 differ on UA or WebGL
  let differ = 0;
  for (let i = 0; i < 10; i++) {
    const left = reconcileFingerprint(generateFingerprint(`pair-L-${i}`), {
      localeId: "en-PK",
      timezone: "Asia/Karachi",
    });
    const right = reconcileFingerprint(generateFingerprint(`pair-R-${i}`), {
      localeId: "en-PK",
      timezone: "Asia/Karachi",
    });
    if (left.userAgent !== right.userAgent || webglKey(left) !== webglKey(right)) {
      differ++;
    }
  }
  assert(differ >= 8, `P1-7 FAIL: only ${differ}/10 seed pairs differed on UA/WebGL`);

  // Persist seed on reconcile when present on current
  const withSeed = { ...generateFingerprint("persist-seed"), seed: "persist-seed" };
  const reconciled = reconcileFingerprint(withSeed, { localeId: "en-US" });
  assert(reconciled.seed === "persist-seed", "seed must survive reconcile");

  console.log(`P1-7 seed stability OK (${differ}/10 pairs differed)`);
}

function catalogGaps(): void {
  const ids = new Set(localeCatalog().map((l) => l.id));
  for (const id of ["en-PK", "bn-BD", "km-KH", "es-BO"]) {
    assert(ids.has(id), `catalog missing ${id}`);
  }
  console.log("P0-6 gap locales present in localeCatalog()");
}

/** CloakBrowser-style: generate without host snap → full cross-OS pool diversity. */
function noHostFilterDiversity(): void {
  const platforms = new Set<string>();
  const combos = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const fp = generateFingerprint(`cloak-full-${i}`, { hostFilter: false });
    platforms.add(fp.platform);
    combos.add(coarseHash(fp));
  }
  assert(
    platforms.size >= 2,
    `hostFilter:false must produce ≥2 navigator.platform values (got ${[...platforms].join(",")})`,
  );
  assert(
    combos.size >= 20,
    `hostFilter:false only ${combos.size} coarse combos / 40 seeds (need ≥20)`,
  );
  console.log(
    `hostFilter:false: ${combos.size} coarse / 40 seeds; platforms=${[...platforms].join("|")}`,
  );
}

function run(): void {
  catalogGaps();
  reconcileHonor();
  diversityForLocale("bn-BD");
  diversityForLocale("en-PK");
  seedStability();
  noHostFilterDiversity();
  console.log("\nAll entropy acceptance checks passed.");
}

run();
