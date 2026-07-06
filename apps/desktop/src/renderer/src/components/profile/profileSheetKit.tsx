import { Blocks, Fingerprint, Globe, IdCard, Network, type LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

/**
 * Shared building blocks for the create + edit profile sheets so both wear the
 * same Discord-settings look: a left section rail and identical form controls.
 * Keeping them here means create/edit never drift apart visually.
 */

export type SectionId = "general" | "browser" | "proxy" | "extensions" | "fingerprint";

export const SECTIONS: Array<{ id: SectionId; label: string; icon: LucideIcon }> = [
  { id: "general", label: "General", icon: IdCard },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "proxy", label: "Proxy", icon: Network },
  { id: "extensions", label: "Extensions", icon: Blocks },
  { id: "fingerprint", label: "Fingerprint", icon: Fingerprint },
];

/** Height of the sheet body; the content pane scrolls inside it, the rail doesn't. */
export const SHEET_HEIGHT = "min(600px, calc(100vh - 168px))";

export function SectionRail({
  section,
  onSelect,
  badges,
  footer,
}: {
  section: SectionId;
  onSelect: (id: SectionId) => void;
  /** Marks sections needing attention (e.g. a required field is empty) with a dot. */
  badges?: Partial<Record<SectionId, boolean>>;
  /** Optional bottom slot, pinned under the list (e.g. the autosave status pill). */
  footer?: ReactNode;
}): JSX.Element {
  return (
    <nav
      className="flex flex-col shrink-0 py-3 px-2 gap-0.5 overflow-y-auto min-h-0"
      style={{ width: 168, borderRight: "1px solid rgba(255,255,255,0.05)" }}
    >
      {SECTIONS.map(({ id, label, icon: Icon }) => {
        const active = section === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[12.5px] text-left transition-colors"
            style={{
              background: active ? "rgba(168,85,247,0.14)" : "transparent",
              color: active ? "#e9d5ff" : "#94a3b8",
              boxShadow: active ? "inset 0 0 0 1px rgba(168,85,247,0.22)" : undefined,
            }}
          >
            <Icon size={15} strokeWidth={1.75} className="shrink-0" />
            <span className="font-medium flex-1">{label}</span>
            {badges?.[id] && (
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: "#f59e0b" }}
                aria-hidden
              />
            )}
          </button>
        );
      })}

      {footer && <div className="mt-auto px-1.5 pt-2">{footer}</div>}
    </nav>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      {children}
    </div>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  mono,
  type,
  autoFocusHint,
  onPaste,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: "text" | "password";
  /** Tags this input for the Modal's open-focus so it wins over the rail buttons. */
  autoFocusHint?: boolean;
  /** Return true to signal the paste was consumed (default browser paste is suppressed). */
  onPaste?: (text: string) => boolean;
}): JSX.Element {
  return (
    <input
      data-autofocus={autoFocusHint ? "" : undefined}
      type={type ?? "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPaste={
        onPaste
          ? (e) => {
              if (onPaste(e.clipboardData.getData("text"))) e.preventDefault();
            }
          : undefined
      }
      placeholder={placeholder}
      className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none focus:bg-white/[0.05] transition-colors"
      style={{
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontWeight: mono ? 500 : 400,
      }}
    />
  );
}

export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}): JSX.Element {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full px-2.5 py-2 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 placeholder:text-slate-600 outline-none focus:bg-white/[0.05] transition-colors resize-none"
      style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)", fontFamily: "var(--font-sans)" }}
    />
  );
}
