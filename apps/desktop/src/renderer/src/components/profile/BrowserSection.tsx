import type { JSX } from "react";
import type { BrowserEngine } from "../../types";

/**
 * Browser engine + start-page controls, shared by the create and edit sheets.
 * Self-contained (own labels/inputs) so both sheets can drop it into their own
 * "Browser" group.
 *
 * NOTE: a per-profile default-search-engine control lived here too, but ungoogled
 * CloakBrowser ignores both pref-seeding and extension `search_provider` overrides
 * (verified on the real binary — see specs/profile-startpage-search). It needs a
 * Chromium source patch, so search is deferred to the patched-Chromium build and
 * intentionally not surfaced here yet.
 */

/** Prefilled into the Start page input for new profiles (a real, editable
 *  value — the user can select/clear it, not just a placeholder). */
export const DEFAULT_START_URL = "https://duckduckgo.com/";

/** Engines a user can assign to a profile. CFT is intentionally not offered. */
export const ENGINE_ROSTER: ReadonlyArray<{
  value: BrowserEngine;
  label: string;
  description: string;
}> = [
  {
    value: "cloakbrowser",
    label: "CloakBrowser",
    description: "Source-patched Chromium. Full anti-detect + agent tools.",
  },
  {
    value: "camoufox",
    label: "Camoufox",
    description: "Firefox-based anti-detect. A non-Chrome TLS/JS fingerprint.",
  },
];

export function BrowserSection({
  startUrl,
  onStartUrl,
  engine,
  onEngine,
  engineDisabled = false,
  engineDisabledReason,
}: {
  startUrl: string;
  onStartUrl: (v: string) => void;
  engine: BrowserEngine;
  onEngine: (v: BrowserEngine) => void;
  /** When true the engine cannot be changed (e.g. the profile is running). */
  engineDisabled?: boolean;
  /** Shown under the picker to explain why it's locked. */
  engineDisabledReason?: string;
}): JSX.Element {
  return (
    <div className="space-y-2.5">
      <SectionField label="Engine">
        <div className="grid gap-2 sm:grid-cols-2">
          {ENGINE_ROSTER.map((opt) => {
            const selected = engine === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={engineDisabled}
                onClick={() => onEngine(opt.value)}
                className="text-left p-2.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                style={{
                  boxShadow: selected
                    ? "inset 0 0 0 1px rgba(168,85,247,0.45)"
                    : "inset 0 0 0 1px rgba(255,255,255,0.08)",
                  background: selected ? "rgba(168,85,247,0.08)" : "rgba(255,255,255,0.025)",
                }}
              >
                <div className="text-[12px] font-medium text-slate-200">{opt.label}</div>
                <div className="text-[10px] text-slate-500 leading-snug mt-0.5">
                  {opt.description}
                </div>
              </button>
            );
          })}
        </div>
        {engineDisabled && engineDisabledReason ? (
          <p className="text-[10px] text-slate-600 leading-relaxed">{engineDisabledReason}</p>
        ) : null}
        {engine === "camoufox" ? (
          <p className="text-[10px] text-amber-400/80 leading-relaxed">
            Camoufox is Firefox-based, so Chrome extensions aren't supported — the
            Extensions section is hidden for this engine.
          </p>
        ) : null}
      </SectionField>

      <SectionField label="Start page">
        <input
          type="text"
          value={startUrl}
          onChange={(e) => onStartUrl(e.target.value)}
          placeholder={DEFAULT_START_URL}
          className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 outline-none placeholder:text-slate-600"
          style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
        />
      </SectionField>

      <p className="text-[10px] text-slate-600 leading-relaxed">
        Opens on a profile's first launch
        {engine === "camoufox" ? "" : " (later launches restore your tabs)"}. Leave the default
        or set your own — any http(s) URL, or <code className="text-slate-500">about:blank</code>.
      </p>
    </div>
  );
}

function SectionField({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      {children}
    </div>
  );
}
