import { Blocks } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import type { ExtensionConfig } from "../../types";
import { CATALOG_ICONS } from "../../data/extensionCatalogIcons";

/**
 * One extension icon, rendered consistently everywhere extensions appear
 * (catalog picker, installed list, attach list). Resolution order:
 *   1. the bundled Web Store icon for curated-catalog extensions (no I/O), then
 *   2. the extension's own manifest icon read from disk (installed non-catalog
 *      extensions), then
 *   3. the generic glyph.
 * Pass `ext` (+ `profileId` for profile-scoped installs) to enable step 2.
 */

// Cache manifest-icon lookups across renders/sites so each extension is fetched
// at most once. Value is the data URI, or null when there's no usable icon.
const manifestIconCache = new Map<string, string | null>();

export function ExtIcon({
  id,
  ext,
  profileId,
  size = 14,
}: {
  id: string;
  ext?: ExtensionConfig;
  profileId?: string | null;
  size?: number;
}): JSX.Element {
  const catalogSrc = CATALOG_ICONS[id];
  const [manifestSrc, setManifestSrc] = useState<string | null>(null);

  useEffect(() => {
    // Catalog icon wins and needs no fetch; without an ext we can't resolve one.
    if (catalogSrc || !ext) return;
    const key = `${ext.id}@${ext.version}`;
    const cached = manifestIconCache.get(key);
    if (cached !== undefined) {
      setManifestSrc(cached);
      return;
    }
    let cancelled = false;
    void window.multizen.extensions.icon(ext, profileId ?? null).then((src) => {
      manifestIconCache.set(key, src);
      if (!cancelled) setManifestSrc(src);
    });
    return () => {
      cancelled = true;
    };
  }, [catalogSrc, ext, profileId]);

  const src = catalogSrc ?? manifestSrc;
  if (!src) return <Blocks size={size} className="text-purple-300 shrink-0" />;
  return (
    <img
      src={src}
      alt=""
      width={size + 2}
      height={size + 2}
      className="rounded-[3px] shrink-0 object-contain"
      style={{ width: size + 2, height: size + 2 }}
    />
  );
}
