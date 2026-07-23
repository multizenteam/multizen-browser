import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ExtensionConfig } from "@multizen/types";

/** Don't reclaim a staging dir younger than this — it may be a live install. */
const STALE_STAGING_MS = 5 * 60 * 1000;

/**
 * The shared extension store. Each unique extension is unpacked ONCE into
 * `<storeRoot>/<id>/<version>/` and loaded into any number of profiles via
 * `--load-extension`. Extension *code* is read-only-shared; extension *state*
 * (logins, chrome.storage, IndexedDB) lives in each profile's own user-data-dir,
 * so per-profile isolation is preserved automatically.
 *
 * `storeRoot` is `<userData>/data/extension-store` (sibling of `profiles/`).
 */

/** Absolute directory of a shared store entry, keyed by extension id + version. */
export function storeEntryDir(storeRoot: string, id: string, version: string): string {
  return join(storeRoot, id, version || "0");
}

/** Icons above this are ignored — a real extension icon is a few KB, so this
 *  only guards against pathological manifests. */
const MAX_ICON_BYTES = 512 * 1024;

interface IconManifest {
  icons?: Record<string, string>;
  action?: { default_icon?: string | Record<string, string> };
  browser_action?: { default_icon?: string | Record<string, string> };
}

/** Largest icon path from an `{ "16": "...", "128": "..." }` map, or null. */
function largestFromMap(map: string | Record<string, string> | undefined): string | null {
  if (!map) return null;
  if (typeof map === "string") return map;
  const sizes = Object.keys(map)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  const best = sizes[0];
  return best !== undefined ? (map[String(best)] ?? null) : null;
}

/**
 * Read an unpacked extension's largest declared icon and return it as a data
 * URI, or null if there's no usable icon. Best-effort — any failure (missing
 * manifest, missing file, oversized, path escape) yields null so the caller
 * falls back to the generic glyph. Reads only from within `loadDir`.
 */
export async function readManifestIcon(loadDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(loadDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(raw) as IconManifest;
    const rel =
      largestFromMap(manifest.icons) ??
      largestFromMap(manifest.action?.default_icon) ??
      largestFromMap(manifest.browser_action?.default_icon);
    if (!rel) return null;

    const base = resolve(loadDir);
    const abs = resolve(base, rel.replace(/^\/+/, ""));
    if (abs !== base && !abs.startsWith(base + sep)) return null; // no escaping loadDir

    const buf = await readFile(abs);
    if (buf.length === 0 || buf.length > MAX_ICON_BYTES) return null;
    const lower = rel.toLowerCase();
    const mime = lower.endsWith(".svg")
      ? "image/svg+xml"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
        ? "image/jpeg"
        : lower.endsWith(".webp")
          ? "image/webp"
          : "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Resolve an extension reference to the absolute directory Chromium should load.
 * Handles both new shared entries and legacy per-profile copies, so a profile
 * may mix the two during/after lazy migration.
 */
export function resolveLoadDir(
  ext: ExtensionConfig,
  profileDataDir: string,
  storeRoot: string,
): string {
  if (ext.scope === "shared") return storeEntryDir(storeRoot, ext.id, ext.version);
  return join(profileDataDir, ext.dir);
}

/** Set of "id\0version" keys for every SHARED reference across all profiles. */
function sharedRefKeys(allRefs: ExtensionConfig[]): Set<string> {
  const keys = new Set<string>();
  for (const ext of allRefs) {
    if (ext.scope === "shared") keys.add(`${ext.id}\0${ext.version || "0"}`);
  }
  return keys;
}

/**
 * Garbage-collect one shared store entry: delete `<storeRoot>/<id>/<version>` iff
 * NO profile still references that (id, version). Refcount is derived from the
 * live profiles, so it can't drift. Best-effort — a locked dir won't throw.
 */
export async function gcEntry(
  storeRoot: string,
  id: string,
  version: string,
  allRefs: ExtensionConfig[],
): Promise<void> {
  const key = `${id}\0${version || "0"}`;
  if (sharedRefKeys(allRefs).has(key)) return; // still referenced
  await rm(storeEntryDir(storeRoot, id, version), { recursive: true, force: true }).catch(
    () => {},
  );
}

/**
 * Reclaim store entries no profile references any more (e.g. left by a crash
 * mid-delete) plus stale staging dirs. Called best-effort at app start; never
 * throws into startup.
 */
export async function sweepOrphans(
  storeRoot: string,
  allRefs: ExtensionConfig[],
): Promise<{ removed: number }> {
  let removed = 0;
  if (!existsSync(storeRoot)) return { removed };
  const live = sharedRefKeys(allRefs);
  let idDirs: string[] = [];
  try {
    idDirs = (await readdir(storeRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { removed };
  }
  for (const idDir of idDirs) {
    if (idDir.startsWith(".staging-")) {
      // Only reclaim genuinely stale staging dirs — a recent one may belong to
      // an install racing this sweep.
      try {
        const age = Date.now() - (await stat(join(storeRoot, idDir))).mtimeMs;
        if (age < STALE_STAGING_MS) continue;
      } catch {
        continue;
      }
      await rm(join(storeRoot, idDir), { recursive: true, force: true }).catch(() => {});
      removed++;
      continue;
    }
    let versions: string[] = [];
    try {
      versions = (await readdir(join(storeRoot, idDir), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const ver of versions) {
      if (!live.has(`${idDir}\0${ver}`)) {
        await rm(join(storeRoot, idDir, ver), { recursive: true, force: true }).catch(() => {});
        removed++;
      }
    }
    // Drop an emptied id dir (all versions reclaimed).
    try {
      const rest = await readdir(join(storeRoot, idDir));
      if (rest.length === 0) await rm(join(storeRoot, idDir), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  return { removed };
}
