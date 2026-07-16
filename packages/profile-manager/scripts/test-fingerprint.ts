/**
 * Sanity test for fingerprint coherence + locale catalog (P0-5 / P0-6).
 *
 * Generates 200 fingerprints (100 random + 100 deterministic) and asserts
 * core invariants. Run with `tsx scripts/test-fingerprint.ts` from the
 * package root (or repo root with path).
 */
import {
  generateFingerprint,
  reconcileFingerprint,
  FingerprintReconcileError,
  deviceCatalog,
  localeCatalog,
} from "../src/fingerprint.js";
import type { FingerprintConfig } from "@multizen/types";

interface InvariantResult {
  name: string;
  passed: boolean;
  message?: string;
}

/** Gap locales + priority markets that must stay in LOCALES (P0-6). */
const REQUIRED_LOCALES: Array<{ id: string; timezone: string; country: string }> = [
  { id: "en-PK", timezone: "Asia/Karachi", country: "pk" },
  { id: "bn-BD", timezone: "Asia/Dhaka", country: "bd" },
  { id: "km-KH", timezone: "Asia/Phnom_Penh", country: "kh" },
  { id: "es-BO", timezone: "America/La_Paz", country: "bo" },
  { id: "en-US", timezone: "America/New_York", country: "us" },
  { id: "en-GB", timezone: "Europe/London", country: "gb" },
  { id: "en-CA", timezone: "America/Toronto", country: "ca" },
  { id: "de-DE", timezone: "Europe/Berlin", country: "de" },
  { id: "fr-FR", timezone: "Europe/Paris", country: "fr" },
  { id: "en-IN", timezone: "Asia/Kolkata", country: "in" },
  { id: "id-ID", timezone: "Asia/Jakarta", country: "id" },
  { id: "en-PH", timezone: "Asia/Manila", country: "ph" },
  { id: "en-ZA", timezone: "Africa/Johannesburg", country: "za" },
  { id: "nl-NL", timezone: "Europe/Amsterdam", country: "nl" },
  { id: "es-ES", timezone: "Europe/Madrid", country: "es" },
  { id: "sv-SE", timezone: "Europe/Stockholm", country: "se" },
  { id: "th-TH", timezone: "Asia/Bangkok", country: "th" },
  { id: "ms-MY", timezone: "Asia/Kuala_Lumpur", country: "my" },
  { id: "pt-BR", timezone: "America/Sao_Paulo", country: "br" },
  { id: "ar-AE", timezone: "Asia/Dubai", country: "ae" },
  { id: "en-KE", timezone: "Africa/Nairobi", country: "ke" },
  { id: "en-NG", timezone: "Africa/Lagos", country: "ng" },
  { id: "es-MX", timezone: "America/Mexico_City", country: "mx" },
  { id: "it-IT", timezone: "Europe/Rome", country: "it" },
  { id: "pl-PL", timezone: "Europe/Warsaw", country: "pl" },
  { id: "ja-JP", timezone: "Asia/Tokyo", country: "jp" },
  { id: "en-AU", timezone: "Australia/Sydney", country: "au" },
  { id: "ar-EG", timezone: "Africa/Cairo", country: "eg" },
  { id: "tr-TR", timezone: "Europe/Istanbul", country: "tr" },
];

function check(fp: FingerprintConfig): InvariantResult[] {
  const results: InvariantResult[] = [];

  // ─── Platform alignment ───────────────────────────────────────────
  const platformPair: Record<string, string> = {
    MacIntel: "macOS",
    Win32: "Windows",
    "Linux x86_64": "Linux",
  };
  results.push({
    name: "navigator.platform ↔ Sec-CH-UA-Platform",
    passed: platformPair[fp.platform] === fp.clientHints.secChUaPlatform,
    message: `${fp.platform} vs ${fp.clientHints.secChUaPlatform}`,
  });

  const uaSaysMac = fp.userAgent.includes("Macintosh");
  const uaSaysWin = fp.userAgent.includes("Windows NT");
  const uaSaysLinux = fp.userAgent.includes("X11; Linux");
  const expectedUaPlatform =
    fp.clientHints.secChUaPlatform === "macOS"
      ? uaSaysMac
      : fp.clientHints.secChUaPlatform === "Windows"
        ? uaSaysWin
        : fp.clientHints.secChUaPlatform === "Linux"
          ? uaSaysLinux
          : false;
  results.push({
    name: "UA platform token ↔ Sec-CH-UA-Platform",
    passed: expectedUaPlatform,
    message: `UA: "${fp.userAgent.slice(0, 60)}…" / SecCHUAPlatform: ${fp.clientHints.secChUaPlatform}`,
  });

  // No mobile UA tokens on desktop pool
  results.push({
    name: "desktop UA (no iPhone/Android mobile tokens)",
    passed: !/iPhone|Android|Mobile/i.test(fp.userAgent),
    message: fp.userAgent.slice(0, 80),
  });

  // Desktop screen ⇒ desktop UA
  if (fp.screen.width >= 1280) {
    results.push({
      name: "desktop screen ⇒ desktop UA",
      passed: !/iPhone|Android|Mobile/i.test(fp.userAgent),
      message: `screen=${fp.screen.width}x${fp.screen.height}`,
    });
  }

  const expectedArch = fp.platform === "MacIntel" ? "arm" : "x86";
  results.push({
    name: "Sec-CH-UA-Arch matches device family",
    passed: fp.clientHints.secChUaArch === expectedArch,
    message: `arch=${fp.clientHints.secChUaArch}, expected=${expectedArch}`,
  });

  results.push({
    name: "Sec-CH-UA-Bitness is 64",
    passed: fp.clientHints.secChUaBitness === "64",
  });

  results.push({
    name: "Sec-CH-UA-Mobile is ?0 (desktop)",
    passed: fp.clientHints.secChUaMobile === "?0",
  });

  results.push({
    name: "languages[0] matches locale",
    passed: fp.languages[0] === fp.locale,
    message: `languages[0]=${fp.languages[0]}, locale=${fp.locale}`,
  });

  results.push({
    name: "Accept-Language starts with locale",
    passed: fp.acceptLanguage.startsWith(fp.locale),
    message: `acceptLanguage="${fp.acceptLanguage}"`,
  });

  const localeEntry = localeCatalog().find((l) => l.locale === fp.locale);
  results.push({
    name: "timezone is in locale's allowed list",
    passed: !!localeEntry && localeEntry.timezones.includes(fp.timezone),
    message: `timezone=${fp.timezone}, allowed=${localeEntry?.timezones.join(",")}`,
  });

  results.push({
    name: "country matches locale catalog",
    passed: !!localeEntry && localeEntry.country === fp.country,
    message: `country=${fp.country}, expected=${localeEntry?.country}`,
  });

  const deviceEntry = deviceCatalog().find((d) => d.family === fp.device);
  const screenInDevice =
    !!deviceEntry &&
    deviceEntry.screens.some(
      (s) => s.width === fp.screen.width && s.height === fp.screen.height,
    );
  results.push({
    name: "screen size belongs to device family",
    passed: screenInDevice,
    message: `screen=${fp.screen.width}x${fp.screen.height}, device=${fp.device}`,
  });

  results.push({
    name: "availScreen ≤ screen",
    passed:
      !fp.availScreen ||
      (fp.availScreen.width <= fp.screen.width &&
        fp.availScreen.height <= fp.screen.height),
  });

  results.push({
    name: "dpr is 2 on Mac, 1 on Win/Linux",
    passed: fp.platform === "MacIntel" ? fp.dpr === 2 : fp.dpr === 1,
    message: `dpr=${fp.dpr}, platform=${fp.platform}`,
  });

  // ─── WebGL ↔ platform family ──────────────────────────────────────
  if (fp.platform === "MacIntel") {
    results.push({
      name: "Mac → WebGL vendor is Apple",
      passed: fp.webgl.vendor === "Apple Inc.",
      message: `${fp.webgl.vendor} / ${fp.webgl.renderer}`,
    });
    results.push({
      name: "Mac → WebGL not Windows ANGLE NVIDIA/Intel/AMD",
      passed: !/ANGLE \(NVIDIA|ANGLE \(Intel|ANGLE \(AMD/i.test(fp.webgl.renderer),
    });
  } else if (fp.platform === "Win32") {
    results.push({
      name: "Win → WebGL renderer contains ANGLE",
      passed: fp.webgl.renderer.includes("ANGLE"),
      message: fp.webgl.renderer.slice(0, 80),
    });
    results.push({
      name: "Win → WebGL not Apple/Mesa-only",
      passed:
        fp.webgl.vendor !== "Apple Inc." && !fp.webgl.vendor.startsWith("Mesa"),
    });
  } else if (fp.platform === "Linux x86_64") {
    results.push({
      name: "Linux → WebGL vendor is Mesa",
      passed: fp.webgl.vendor === "Mesa",
      message: fp.webgl.vendor,
    });
  }

  results.push({
    name: "hardwareConcurrency > 0",
    passed: fp.hardwareConcurrency > 0,
  });
  results.push({
    name: "deviceMemory > 0",
    passed: fp.deviceMemory > 0,
  });

  const uaChromeMatch = fp.userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  const chFullMatch = fp.clientHints.secChUaFullVersionList.match(
    /"Google Chrome";v="([^"]+)"/,
  );
  results.push({
    name: "UA Chrome version == Sec-CH-UA-Full-Version-List Chrome",
    passed:
      !!uaChromeMatch && !!chFullMatch && uaChromeMatch[1] === chFullMatch[1],
    message: `UA: ${uaChromeMatch?.[1]}, CH: ${chFullMatch?.[1]}`,
  });

  return results;
}

function assertLocaleCatalog(): void {
  const catalog = localeCatalog();
  const byId = new Map(catalog.map((l) => [l.id, l]));
  for (const req of REQUIRED_LOCALES) {
    const entry = byId.get(req.id);
    if (!entry) {
      throw new Error(`P0-6 FAIL: locale catalog missing id=${req.id}`);
    }
    if (entry.country !== req.country) {
      throw new Error(
        `P0-6 FAIL: ${req.id} country=${entry.country}, expected ${req.country}`,
      );
    }
    if (!entry.timezones.includes(req.timezone)) {
      throw new Error(
        `P0-6 FAIL: ${req.id} missing timezone ${req.timezone}; have ${entry.timezones.join(",")}`,
      );
    }
  }
  console.log(`P0-6 locale catalog: ${REQUIRED_LOCALES.length}/${REQUIRED_LOCALES.length} required ids OK`);
}

function assertReconcileCoherence(): void {
  // Caller desktop screen must not produce mobile UA; locale languages for bn-BD.
  const base = generateFingerprint("reconcile-coherence");
  const bd = reconcileFingerprint(base, {
    localeId: "bn-BD",
    timezone: "Asia/Dhaka",
    screen: { width: 2560, height: 1440 },
  });
  if (/iPhone|Android|Mobile/i.test(bd.userAgent)) {
    throw new Error("P0-5 FAIL: desktop screen yielded mobile UA");
  }
  if (!bd.languages.some((l) => l.startsWith("bn"))) {
    throw new Error(`P0-5 FAIL: bn-BD languages missing bn: ${bd.languages.join(",")}`);
  }
  if (bd.timezone !== "Asia/Dhaka") {
    throw new Error(`P0-5 FAIL: bn-BD timezone=${bd.timezone}`);
  }

  let threw = false;
  try {
    reconcileFingerprint(base, { localeId: "xx-YY" });
  } catch (e) {
    threw = e instanceof FingerprintReconcileError && e.field === "localeId";
  }
  if (!threw) {
    throw new Error("P0-4 FAIL: unknown localeId did not throw FingerprintReconcileError");
  }

  const pk = reconcileFingerprint(base, {
    localeId: "en-PK",
    timezone: "Asia/Karachi",
    screen: { width: 1920, height: 1080 },
    hardwareConcurrency: 8,
    deviceMemory: 8,
  });
  if (
    pk.locale !== "en-PK" ||
    pk.timezone !== "Asia/Karachi" ||
    pk.screen.width !== 1920 ||
    pk.screen.height !== 1080 ||
    pk.hardwareConcurrency !== 8 ||
    pk.deviceMemory !== 8
  ) {
    throw new Error(`P0-4 FAIL: honor mismatch ${JSON.stringify({
      locale: pk.locale,
      timezone: pk.timezone,
      screen: pk.screen,
      hwc: pk.hardwareConcurrency,
      mem: pk.deviceMemory,
    })}`);
  }
  console.log("P0-4/P0-5 reconcile path checks OK");
}

function run(): void {
  assertLocaleCatalog();
  assertReconcileCoherence();

  let totalChecks = 0;
  let totalFails = 0;
  const failureSamples: Array<{ fp: FingerprintConfig; failures: InvariantResult[] }> = [];

  for (let i = 0; i < 100; i++) {
    const fp = generateFingerprint();
    const results = check(fp);
    totalChecks += results.length;
    const failures = results.filter((r) => !r.passed);
    totalFails += failures.length;
    if (failures.length > 0 && failureSamples.length < 5) {
      failureSamples.push({ fp, failures });
    }
  }

  for (let i = 0; i < 100; i++) {
    const seed = `seed-${i}`;
    const fp1 = generateFingerprint(seed);
    const fp2 = generateFingerprint(seed);
    totalChecks++;
    if (JSON.stringify(fp1) !== JSON.stringify(fp2)) {
      totalFails++;
      console.error(`Determinism FAIL for seed=${seed}`);
    }
    const results = check(fp1);
    totalChecks += results.length;
    const failures = results.filter((r) => !r.passed);
    totalFails += failures.length;
    if (failures.length > 0 && failureSamples.length < 5) {
      failureSamples.push({ fp: fp1, failures });
    }
  }

  console.log(`\n${totalChecks - totalFails}/${totalChecks} invariants passed`);

  if (failureSamples.length > 0) {
    console.error("\nSample failures:");
    for (const sample of failureSamples) {
      console.error(`\nfp.device=${sample.fp.device}, fp.locale=${sample.fp.locale}`);
      for (const f of sample.failures) {
        console.error(`  ✗ ${f.name}${f.message ? `: ${f.message}` : ""}`);
      }
    }
    process.exit(1);
  }

  console.log("\nExample fingerprint:");
  console.log(JSON.stringify(generateFingerprint("example"), null, 2));
}

run();
