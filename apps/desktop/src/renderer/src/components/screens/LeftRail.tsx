import type { JSX } from "react";
import { Boxes, Command, Plug, Settings } from "lucide-react";
import { cn } from "../../lib/cn";

export type Section = "profiles" | "mcp" | "settings";

interface Item {
  id: Section;
  icon: typeof Boxes;
  label: string;
  kbd: string;
}

const ITEMS: Item[] = [
  { id: "profiles", icon: Boxes, label: "Profiles", kbd: "1" },
  { id: "mcp", icon: Plug, label: "MCP", kbd: "2" },
  { id: "settings", icon: Settings, label: "Settings", kbd: "," },
];

interface Props {
  active: Section;
  onChange: (s: Section) => void;
  onCmdK: () => void;
}

export function LeftRail({ active, onChange, onCmdK }: Props): JSX.Element {
  return (
    <div
      className="flex flex-col items-center pt-3.5 gap-1.5 flex-shrink-0"
      style={{
        width: 56,
        background: "rgba(255,255,255,0.01)",
        borderRight: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      {ITEMS.map((it) => {
        const Icon = it.icon;
        const isActive = active === it.id;
        return (
          <button
            key={it.id}
            type="button"
            title={`${it.label} · ⌘${it.kbd}`}
            onClick={() => onChange(it.id)}
            className={cn(
              "w-9 h-9 rounded-[10px] flex items-center justify-center transition-colors",
              isActive ? "text-purple-300" : "text-slate-500 hover:text-slate-200 hover:bg-white/5",
            )}
            style={{
              background: isActive ? "rgba(168,85,247,0.12)" : undefined,
              boxShadow: isActive ? "inset 0 0 0 1px rgba(168,85,247,0.25)" : undefined,
            }}
          >
            <Icon size={16} strokeWidth={1.5} />
          </button>
        );
      })}
      <div className="flex-1" />
      <button
        type="button"
        title="Command palette · ⌘K"
        onClick={onCmdK}
        className="mb-3.5 w-9 h-9 rounded-[10px] flex items-center justify-center text-slate-600 hover:text-slate-300 hover:bg-white/5 transition-colors"
      >
        <Command size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}
