#!/usr/bin/env node
// Bumps the version in the root package.json and apps/desktop/package.json
// (electron-builder reads the version from the desktop package) and keeps
// them in lockstep.
//
// Usage:
//   node scripts/bump-version.mjs <patch|minor|major>
//   node scripts/bump-version.mjs <explicit-version e.g. 0.3.0>
//   node scripts/bump-version.mjs --check        # print current version, no write
//
// Prints the resulting version to stdout (last line) so the caller can
// derive the v<version> tag.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// Every manifest that must carry the same version.
const TARGETS = ["package.json", "apps/desktop/package.json"];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function readManifest(rel) {
  const path = join(repoRoot, rel);
  const raw = readFileSync(path, "utf8");
  const json = JSON.parse(raw);
  // Preserve trailing newline style of the original file.
  const trailingNewline = raw.endsWith("\n");
  return { path, json, trailingNewline };
}

function bump(version, kind) {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`Current version "${version}" is not plain semver (x.y.z).`);
  let [major, minor, patch] = m.slice(1).map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump kind "${kind}".`);
}

function resolveNext(current, arg) {
  if (["patch", "minor", "major"].includes(arg)) return bump(current, arg);
  if (SEMVER.test(arg)) return arg;
  throw new Error(`Argument must be patch|minor|major or x.y.z, got "${arg}".`);
}

function main() {
  const arg = process.argv[2];
  const manifests = TARGETS.map(readManifest);

  // The root package.json is the source of truth for the current version.
  const current = manifests[0].json.version;

  // Sanity: all manifests should already agree before we touch them.
  const mismatched = manifests.filter((m) => m.json.version !== current);
  if (mismatched.length > 0) {
    const detail = manifests.map((m) => `  ${m.path} -> ${m.json.version}`).join("\n");
    throw new Error(`Version mismatch across manifests before bump:\n${detail}`);
  }

  if (!arg || arg === "--check") {
    console.log(current);
    return;
  }

  const next = resolveNext(current, arg);
  if (next === current) throw new Error(`Next version equals current (${current}); nothing to bump.`);

  for (const m of manifests) {
    m.json.version = next;
    const out = JSON.stringify(m.json, null, 2) + (m.trailingNewline ? "\n" : "");
    writeFileSync(m.path, out, "utf8");
  }

  console.error(`Bumped ${current} -> ${next} in:`);
  for (const m of manifests) console.error(`  ${m.path}`);
  // Machine-readable last line.
  console.log(next);
}

try {
  main();
} catch (err) {
  console.error(`bump-version: ${err.message}`);
  process.exit(1);
}
