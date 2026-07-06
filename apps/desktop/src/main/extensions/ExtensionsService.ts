import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileManager } from "@multizen/profile-manager";
import type { ExtensionConfig, Profile } from "@multizen/types";
import { unpackToStore } from "./crxPipeline.ts";
import { gcEntry } from "./extensionStore.ts";
import { downloadCrxById, parseExtensionId } from "./webstoreDownload.ts";

/**
 * Compare two dotted numeric version strings (e.g. "1.50.0" vs "1.9.0").
 * Returns >0 if a is newer, <0 if older, 0 if equal. Non-numeric / missing
 * segments (incl. the "" legacy version) sort as 0, so a real version always
 * wins over a legacy blank. Numeric-per-segment, so "1.50" > "1.9" correctly.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

interface ExtensionsServiceDeps {
  profileManager: ProfileManager;
  /** Root of the shared extension store, e.g. `<userData>/data/extension-store`. */
  extensionStoreRoot: string;
  /** Live engine version (e.g. CloakBrowser "145.0.7632.109.2") for the CRX endpoint. */
  engineVersion: () => string;
}

/**
 * Extension management. Installs land ONCE in a shared, content/identity-
 * addressed store (`extensionStoreRoot/<id>/<version>/`) and profiles hold
 * lightweight references — so the same extension across N profiles costs ~1×
 * disk, not N×. Extension *state* (logins/chrome.storage) stays per-profile via
 * Chromium's per-user-data-dir, so isolation is unchanged.
 *
 * Legacy per-profile installs (from before this feature) keep working and are
 * migrated opportunistically when re-installed.
 */
export class ExtensionsService {
  private readonly pm: ProfileManager;
  private readonly storeRoot: string;
  private readonly engineVersion: () => string;

  constructor(deps: ExtensionsServiceDeps) {
    this.pm = deps.profileManager;
    this.storeRoot = deps.extensionStoreRoot;
    this.engineVersion = deps.engineVersion;
  }

  list(profileId: string): ExtensionConfig[] {
    return this.pm.get(profileId)?.extensions ?? [];
  }

  /**
   * Distinct shared-store entries currently referenced by any profile, so a
   * new/other profile can "attach" one without a fresh download — the files
   * already live in the app-global store. Deduped by id (newest version wins);
   * only "shared"-scope refs are attachable (a legacy per-profile copy lives
   * under someone else's dataDir and can't be shared). Extension *state* stays
   * per-profile, so the attached copy starts logged-out/fresh.
   */
  storeEntries(): ExtensionConfig[] {
    const byId = new Map<string, ExtensionConfig>();
    for (const { ext } of this.pm.allExtensionRefs()) {
      if (ext.scope !== "shared") continue;
      const prev = byId.get(ext.id);
      if (!prev || compareVersions(ext.version, prev.version) > 0) {
        // Normalize to an enabled, attachable ref (drop the source profile's
        // enabled/toggle state — a fresh attach defaults to enabled).
        byId.set(ext.id, { ...ext, enabled: true });
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Unpack a local .crx / .zip / folder into the shared store and return its
   * ref WITHOUT attaching it to any profile. Used by the create sheet (no
   * profile id yet) to stage extensions before the profile exists.
   */
  async prepareFromFile(sourcePath: string): Promise<ExtensionConfig> {
    const isDir = (await stat(sourcePath)).isDirectory();
    return unpackToStore({
      source: sourcePath,
      storeRoot: this.storeRoot,
      origin: isDir ? "folder" : "file",
    });
  }

  /**
   * Download + unpack a Chrome Web Store extension into the shared store and
   * return its ref WITHOUT attaching it to any profile (staging path).
   */
  async prepareFromWebStore(urlOrId: string): Promise<ExtensionConfig> {
    const id = parseExtensionId(urlOrId);
    const crxPath = await downloadCrxById(id, this.engineVersion());
    try {
      return await unpackToStore({
        source: crxPath,
        storeRoot: this.storeRoot,
        origin: "web-store",
      });
    } finally {
      await rm(crxPath, { force: true }).catch(() => {});
    }
  }

  /** Install from a local .crx / .zip / unpacked folder into a profile. */
  async installFromFile(profileId: string, sourcePath: string): Promise<ExtensionConfig> {
    const profile = this.requireProfile(profileId);
    const cfg = await this.prepareFromFile(sourcePath);
    await this.persist(profile, cfg);
    return cfg;
  }

  /** Install by Chrome Web Store URL or bare ID into a profile. */
  async installFromWebStore(profileId: string, urlOrId: string): Promise<ExtensionConfig> {
    const profile = this.requireProfile(profileId);
    const cfg = await this.prepareFromWebStore(urlOrId);
    await this.persist(profile, cfg);
    return cfg;
  }

  async remove(profileId: string, extId: string): Promise<void> {
    const profile = this.requireProfile(profileId);
    const cfg = (profile.extensions ?? []).find((e) => e.id === extId);
    const next = (profile.extensions ?? []).filter((e) => e.id !== extId);
    this.pm.update(profileId, { extensions: next });
    if (cfg) await this.reclaim(profile, cfg);
  }

  setEnabled(profileId: string, extId: string, enabled: boolean): void {
    const profile = this.requireProfile(profileId);
    const next = (profile.extensions ?? []).map((e) =>
      e.id === extId ? { ...e, enabled } : e,
    );
    this.pm.update(profileId, { extensions: next });
  }

  // ─── internals ──────────────────────────────────────────────────────

  private requireProfile(profileId: string): Profile {
    const p = this.pm.get(profileId);
    if (!p) throw new Error(`Profile ${profileId} not found`);
    return p;
  }

  // (compareVersions lives at module scope, below.)

  /**
   * Append (or replace by id) the new extension on the profile, then reclaim the
   * prior install if it's no longer used. Re-installing a legacy per-profile
   * item this way migrates it to the shared store and drops the old copy.
   */
  private async persist(profile: Profile, cfg: ExtensionConfig): Promise<void> {
    // Re-read immediately before the read-modify-write: install does a long
    // await (CRX download / unpack) on a profile snapshot, during which another
    // op (a second install, the companion, a toggle) may have rewritten the
    // extensions column. better-sqlite3 is synchronous, so get→update with no
    // await between is atomic and won't clobber that concurrent write.
    const fresh = this.pm.get(profile.id) ?? profile;
    const prior = (fresh.extensions ?? []).find((e) => e.id === cfg.id);
    const next = (fresh.extensions ?? []).filter((e) => e.id !== cfg.id);
    next.push(cfg);
    this.pm.update(fresh.id, { extensions: next });
    // Reclaim the prior copy if it pointed somewhere different (changed version,
    // or a legacy per-profile dir being superseded by a shared entry).
    if (prior && (prior.scope !== cfg.scope || prior.version !== cfg.version || prior.dir !== cfg.dir)) {
      await this.reclaim(fresh, prior);
    }
  }

  /**
   * Free the storage a (now-unreferenced) extension reference used: a legacy
   * per-profile dir is always safe to delete; a shared entry is GC'd only if no
   * other profile still references that id+version.
   */
  private async reclaim(profile: Profile, cfg: ExtensionConfig): Promise<void> {
    if (cfg.scope === "shared") {
      const allRefs = this.pm.allExtensionRefs().map((r) => r.ext);
      await gcEntry(this.storeRoot, cfg.id, cfg.version, allRefs);
    } else if (cfg.dir) {
      await rm(join(profile.dataDir, cfg.dir), { recursive: true, force: true }).catch(() => {});
    }
  }
}
