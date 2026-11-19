import type { JSX } from "react";

import type { AgentKind } from "../../types";
import { cn } from "../../lib/cn";

/**
 * Per-directory agent selection.
 *
 * Each directory independently chooses any subset of the supported agents.
 * Sekvona writes the project's enabled endpoints into exactly the selected
 * agents' workspace configuration files, and removes them again when an agent is
 * de-selected.
 */

/** Every supported agent, in display order, with its workspace config path. */
export const AGENT_CHOICES: ReadonlyArray<{
  kind: AgentKind;
  label: string;
  /** Workspace-relative path Sekvona writes for this agent. */
  path: string;
}> = [
  { kind: "claude-code", label: "Claude Code", path: ".mcp.json" },
  { kind: "cursor", label: "Cursor", path: ".cursor/mcp.json" },
  { kind: "codex", label: "Codex", path: ".codex/config.toml" },
  { kind: "kiro-cli", label: "Kiro CLI", path: ".kiro/settings/mcp.json" },
];

export interface AgentPickerProps {
  readonly selected: readonly AgentKind[];
  readonly onChange: (next: AgentKind[]) => void;
  readonly disabled?: boolean;
  /** Prefix for each checkbox's accessible name, to disambiguate directories. */
  readonly namePrefix?: string;
}

export function AgentPicker({
  selected,
  onChange,
  disabled,
  namePrefix,
}: AgentPickerProps): JSX.Element {
  const toggle = (kind: AgentKind): void => {
    onChange(
      selected.includes(kind) ? selected.filter((k) => k !== kind) : [...selected, kind],
    );
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {AGENT_CHOICES.map(({ kind, label, path }) => {
        const on = selected.includes(kind);
        return (
          <label
            key={kind}
            title={path}
            className={cn(
              "flex items-center gap-1.5 cursor-pointer transition-colors select-none",
              disabled && "cursor-not-allowed opacity-50",
              on ? "text-purple-200" : "text-slate-400 hover:text-slate-200",
            )}
            style={{
              height: 28,
              padding: "0 10px",
              borderRadius: 8,
              background: on ? "rgba(180,226,255,0.12)" : "rgba(255,255,255,0.03)",
              boxShadow: on
                ? "inset 0 0 0 1px rgba(180,226,255,0.25)"
                : "inset 0 0 0 1px rgba(255,255,255,0.06)",
            }}
          >
            <input
              type="checkbox"
              checked={on}
              disabled={disabled}
              onChange={() => toggle(kind)}
              aria-label={namePrefix !== undefined ? `${label} — ${namePrefix}` : label}
              style={{ width: 12, height: 12, accentColor: "#a855f7" }}
            />
            <span className="text-[12px]">{label}</span>
          </label>
        );
      })}
    </div>
  );
}
