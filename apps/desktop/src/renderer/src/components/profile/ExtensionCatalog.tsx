import { useMemo, useState, type JSX } from "react";
import { Check, Loader2, Plus, Search } from "lucide-react";
import {
  CATALOG_CATEGORIES,
  CATALOG_EXTENSIONS,
  type CatalogExtension,
} from "../../data/extensionCatalog";
import { ExtIcon } from "./ExtIcon";

/**
 * In-app "Discover" picker over the curated MV3 catalog. Searchable, grouped by
 * category, one-click install. The parent supplies the install action (live
 * install for a saved profile, or staging for the create sheet) so this stays
 * mode-agnostic.
 */
export function ExtensionCatalog({
  installedIds,
  busyId,
  onInstall,
}: {
  /** Ids already present on the profile / staged — shown as "Added". */
  installedIds: Set<string>;
  /** Id currently installing (spinner), or null. */
  busyId: string | null;
  onInstall: (ext: CatalogExtension) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (e: CatalogExtension): boolean =>
      !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
    return CATALOG_CATEGORIES.map((cat) => ({
      cat,
      items: CATALOG_EXTENSIONS.filter((e) => e.category === cat.id && match(e)),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  if (CATALOG_EXTENSIONS.length === 0) {
    return (
      <div className="text-[11px] text-slate-600 leading-relaxed px-1 py-2">
        The extension catalog is empty in this build. Add extensions by Chrome Web Store URL or
        ID above.
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 px-2.5 h-9 rounded-lg bg-white/[0.03]"
        style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
      >
        <Search size={13} className="text-slate-500 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the catalog…"
          className="flex-1 bg-transparent text-[12px] text-slate-200 placeholder:text-slate-600 outline-none"
        />
      </div>

      {groups.length === 0 ? (
        <div className="text-[11px] text-slate-600 px-1 py-2">No matches.</div>
      ) : (
        <div className="space-y-3 max-h-[280px] overflow-y-auto pr-1">
          {groups.map(({ cat, items }) => (
            <div key={cat.id} className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">
                {cat.label}
              </div>
              {items.map((ext) => {
                const added = installedIds.has(ext.id);
                const busy = busyId === ext.id;
                return (
                  <div
                    key={ext.id}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg"
                    style={{
                      background: "rgba(255,255,255,0.03)",
                      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                    }}
                  >
                    <ExtIcon id={ext.id} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] text-slate-200 truncate">{ext.name}</div>
                      <div className="text-[11px] text-slate-500 truncate">{ext.description}</div>
                    </div>
                    <button
                      type="button"
                      disabled={added || busy}
                      onClick={() => onInstall(ext)}
                      className="btn-secondary px-2.5 py-[5px] text-[11px] rounded-lg whitespace-nowrap inline-flex items-center gap-1 disabled:opacity-60"
                    >
                      {added ? (
                        <>
                          <Check size={11} /> Added
                        </>
                      ) : busy ? (
                        <>
                          <Loader2 size={11} className="animate-spin" /> Adding
                        </>
                      ) : (
                        <>
                          <Plus size={11} /> Add
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
