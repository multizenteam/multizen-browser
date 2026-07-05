import type { JSX } from "react";

/**
 * Browser start-page control, shared by the create and edit sheets.
 * Self-contained (own label/input) so both sheets can drop it into their own
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

export function BrowserSection({
  startUrl,
  onStartUrl,
}: {
  startUrl: string;
  onStartUrl: (v: string) => void;
}): JSX.Element {
  return (
    <div className="space-y-2.5">
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
        Opens on a profile's first launch (later launches restore your tabs). Leave the default
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
