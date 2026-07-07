import { useMemo, useState, type JSX } from "react";
import { Grid3x3, List, Plus } from "lucide-react";
import type { ProfileSummary, ActivityEvent } from "../../types";
import { Kbd } from "../atoms";
import { ProfileTile, deriveTileState, type TileData, type TileState } from "./ProfileTile";
import { ProfileTable } from "./ProfileTable";
import { usePersistedState } from "../../lib/persisted";
import { cn } from "../../lib/cn";

type ViewMode = "grid" | "list";

interface FilterChip {
  id: "all" | TileState;
  label: string;
  kind?: TileState;
}

const FILTERS: FilterChip[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running", kind: "running" },
  { id: "ai", label: "AI-driven", kind: "ai" },
  { id: "error", label: "Errors", kind: "error" },
  { id: "idle", label: "Idle", kind: "idle" },
];

const DOT_COLOR: Record<TileState, string> = {
  running: "#34d399",
  ai: "#c084fc",
  error: "#f87171",
  idle: "#94a3b8",
};

interface Props {
  profiles: ProfileSummary[];
  recentEvents: ActivityEvent[];
  /** Profiles in the terminating phase (winding down, not yet exited). */
  closingIds?: Set<string>;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onLaunch: (id: string) => void;
  onStop: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
}

export function Constellation({
  profiles,
  recentEvents,
  closingIds,
  onSelect,
  onCreate,
  onLaunch,
  onStop,
  onExport,
  onDelete,
}: Props): JSX.Element {
  const [filter, setFilter] = useState<FilterChip["id"]>("all");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [viewMode, setViewMode] = usePersistedState<ViewMode>("profilesView", "grid");

  const tileData: TileData[] = useMemo(
    () =>
      profiles.map((p) => ({
        ...p,
        ...deriveTileState(p, recentEvents),
      })),
    [profiles, recentEvents],
  );

  const counts = useMemo(() => {
    const c: Record<FilterChip["id"], number> = { all: tileData.length, running: 0, ai: 0, error: 0, idle: 0 };
    for (const t of tileData) c[t.state] += 1;
    return c;
  }, [tileData]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of profiles) for (const t of p.tags) set.add(t);
    return Array.from(set).slice(0, 12);
  }, [profiles]);

  const filtered = useMemo(() => {
    return tileData.filter((t) => {
      if (filter !== "all" && t.state !== filter) return false;
      if (activeTag && !t.tags.includes(activeTag)) return false;
      return true;
    });
  }, [tileData, filter, activeTag]);

  const aiCount = counts.ai;

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Title row */}
      <div className="flex items-center gap-3.5 px-6 pt-4 pb-3">
        <div className="text-lg font-bold tracking-tight text-slate-100">All profiles</div>
        <div className="mono text-[11px] text-slate-600">
          ·  {profiles.length} total · {counts.running + counts.ai} running
          {aiCount > 0 && ` · ${aiCount} driven by Claude`}
        </div>
        <div className="flex-1" />
        <div
          className="flex gap-1 p-[3px] rounded-lg"
          style={{
            background: "rgba(255,255,255,0.03)",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
          }}
        >
          <button
            type="button"
            onClick={() => setViewMode("grid")}
            className={cn(
              "w-7 h-6 rounded-md flex items-center justify-center transition-colors",
              viewMode === "grid"
                ? "text-slate-100"
                : "text-slate-500 hover:text-slate-300",
            )}
            style={{
              background: viewMode === "grid" ? "rgba(255,255,255,0.06)" : undefined,
            }}
            title="Grid view"
          >
            <Grid3x3 size={13} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={() => setViewMode("list")}
            className={cn(
              "w-7 h-6 rounded-md flex items-center justify-center transition-colors",
              viewMode === "list"
                ? "text-slate-100"
                : "text-slate-500 hover:text-slate-300",
            )}
            style={{
              background: viewMode === "list" ? "rgba(255,255,255,0.06)" : undefined,
            }}
            title="List view"
          >
            <List size={13} strokeWidth={1.5} />
          </button>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="btn-brand rounded-[9px] text-[12px] px-3 py-[7px]"
        >
          <Plus size={12} strokeWidth={2} />
          New profile
          <Kbd variant="on-brand">⌘ N</Kbd>
        </button>
      </div>

      {/* Filter row */}
      <div className="flex items-center gap-1.5 px-6 pb-3.5 flex-wrap">
        {FILTERS.map((c) => {
          const isActive = filter === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setFilter(c.id)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-[5px] rounded-lg text-[12px] font-medium transition-colors",
                isActive ? "text-slate-100" : "text-slate-500 hover:text-slate-300",
              )}
              style={{
                background: isActive ? "rgba(255,255,255,0.06)" : undefined,
                boxShadow: isActive ? "inset 0 0 0 1px rgba(255,255,255,0.08)" : undefined,
              }}
            >
              {c.kind && (
                <span
                  className="w-[5px] h-[5px] rounded-full"
                  style={{ background: DOT_COLOR[c.kind] }}
                />
              )}
              {c.label}
              <span className={cn("mono text-[10px]", isActive ? "text-slate-400" : "text-slate-600")}>
                {counts[c.id]}
              </span>
            </button>
          );
        })}

        {allTags.length > 0 && (
          <>
            <div className="w-px h-4 bg-white/[0.06] mx-1.5" />
            {allTags.map((t) => {
              const isActive = activeTag === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setActiveTag(isActive ? null : t)}
                  className={cn(
                    "mz-pill mono cursor-pointer transition-colors",
                    isActive ? "text-purple-300" : "text-slate-500 hover:text-slate-300",
                  )}
                  style={{
                    background: isActive ? "rgba(168,85,247,0.10)" : "rgba(255,255,255,0.03)",
                    boxShadow: isActive
                      ? "inset 0 0 0 1px rgba(168,85,247,0.25)"
                      : "inset 0 0 0 1px rgba(255,255,255,0.05)",
                  }}
                >
                  {t}
                </button>
              );
            })}
          </>
        )}
      </div>

      {/* Body — grid or list. `pt-3` keeps the running/AI glow from
          getting clipped against the top edge of the scroll container
          (box-shadow extends ~32px outside the tile). */}
      <div className="flex-1 overflow-auto px-6 pb-6 pt-3">
        {filtered.length === 0 ? (
          <div className="text-sm text-slate-500 py-12 text-center">
            No profiles match the current filter.
          </div>
        ) : viewMode === "list" ? (
          <ProfileTable
            profiles={filtered}
            closingIds={closingIds}
            onSelect={onSelect}
            onLaunch={onLaunch}
            onStop={onStop}
            onExport={onExport}
            onDelete={onDelete}
          />
        ) : (
          <div
            className="grid gap-3.5"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            }}
          >
            {filtered.map((p) => (
              <ProfileTile
                key={p.id}
                profile={p}
                terminating={closingIds?.has(p.id) ?? false}
                onOpen={() => onSelect(p.id)}
                onLaunch={() => onLaunch(p.id)}
                onStop={() => onStop(p.id)}
                onExport={() => onExport(p.id)}
                onDelete={() => onDelete(p.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
