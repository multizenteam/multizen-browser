import type { JSX } from "react";
import { Search, Settings as SettingsIcon } from "lucide-react";
import { Cube, Pill, Kbd } from "../atoms";

interface Props {
  totalCount: number;
  runningCount: number;
  mcpUrl: string | null;
  onCmdK: () => void;
  onSettings: () => void;
}

export function TopBar({ totalCount, runningCount, mcpUrl, onCmdK, onSettings }: Props): JSX.Element {
  return (
    <div
      className="drag-region flex items-center gap-3.5 relative flex-shrink-0"
      style={{
        height: 44,
        padding: "0 14px",
        background: "rgba(10,11,15,0.7)",
        backdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      {/* macOS spacer for native traffic lights (we use titleBarStyle: hiddenInset) */}
      <div style={{ width: 60 }} className="no-drag" aria-hidden />

      {/* Brand — non-interactive decoration: pointer-events:none so the label
          isn't selectable and pointer events fall through to the drag region. */}
      <div className="flex items-center gap-2 ml-2 pointer-events-none">
        <Cube size={20} />
        <span className="font-bold text-[13px] tracking-tight text-slate-100">MultiZen</span>
      </div>

      {/* Search trigger — center, opens command palette */}
      <button
        type="button"
        onClick={onCmdK}
        className="no-drag flex-1 flex items-center gap-2.5 cursor-pointer"
        style={{
          maxWidth: 540,
          margin: "0 auto",
          padding: "6px 12px",
          borderRadius: 10,
          background: "rgba(255,255,255,0.03)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
        }}
      >
        <Search size={14} className="text-slate-500" />
        <span className="flex-1 text-left text-[13px] text-slate-500">
          Search profiles, tags, urls…
        </span>
        <Kbd>⌘ K</Kbd>
      </button>

      {/* Right cluster */}
      <div className="no-drag flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="mono text-slate-300 text-[12px]">{runningCount}</span>
          <span>running</span>
          <span className="text-slate-600">·</span>
          <span className="mono text-slate-400 text-[12px]">{totalCount}</span>
          <span>total</span>
        </div>
        <Pill kind={mcpUrl ? "running" : "idle"} dot={!!mcpUrl}>
          MCP {mcpUrl ? `· :${new URL(mcpUrl).port}` : "off"}
        </Pill>
        <button
          type="button"
          onClick={onSettings}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:bg-white/5 hover:text-slate-200 transition-colors"
          aria-label="Settings"
        >
          <SettingsIcon size={14} />
        </button>
      </div>
    </div>
  );
}
