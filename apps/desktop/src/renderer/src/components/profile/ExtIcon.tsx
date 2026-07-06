import { Blocks } from "lucide-react";
import type { JSX } from "react";
import { CATALOG_ICONS } from "../../data/extensionCatalogIcons";

/**
 * One extension icon, rendered consistently everywhere extensions appear
 * (catalog picker, installed list, attach list). Resolves the bundled Web Store
 * icon by extension id — so any catalog extension shows its real icon however it
 * was installed (catalog, URL, or ID) — and falls back to the generic glyph for
 * extensions that aren't in the curated catalog. No runtime network.
 */
export function ExtIcon({ id, size = 14 }: { id: string; size?: number }): JSX.Element {
  const src = CATALOG_ICONS[id];
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
