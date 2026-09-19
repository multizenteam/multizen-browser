import { useEffect, useState, type JSX, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { BrowserEngine, ChromiumStatus } from "../types";

/**
 * Slim progress bar shown while a browser ENGINE binary downloads on demand.
 * Camoufox fetches its ~300 MB browser the first time a Camoufox profile
 * launches; without this the launch blocks with only a "Launching…" tile and no
 * way to tell a slow download from a hang (AC7). CloakBrowser has its own
 * first-run bootstrap modal + Settings progress, so it's skipped here.
 */
const ENGINE_LABEL: Partial<Record<BrowserEngine, string>> = {
  camoufox: "Camoufox",
  cloakbrowser: "CloakBrowser",
};

export function EngineDownloadBanner(): JSX.Element | null {
  const [state, setState] = useState<{ engine: BrowserEngine; status: ChromiumStatus } | null>(
    null,
  );

  useEffect(() => {
    if (!window.multizen) return;
    return window.multizen.engine.onDownloadStatus(setState);
  }, []);

  // Only surface on-demand engines; CloakBrowser has its own bootstrap UI.
  if (!state || state.engine === "cloakbrowser") return null;
  const label = ENGINE_LABEL[state.engine] ?? state.engine;
  const { status } = state;

  if (status.kind === "downloading") {
    const pct =
      status.bytesTotal > 0 ? Math.round((status.bytesReceived / status.bytesTotal) * 100) : null;
    return (
      <Bar>
        <RefreshCw size={13} className="animate-spin text-purple-300 shrink-0" />
        <span>Downloading {label} engine…</span>
        {pct !== null && <span className="mono text-[11px] text-slate-400">{pct}%</span>}
        <div className="flex-1" />
      </Bar>
    );
  }

  if (status.kind === "fetching-manifest" || status.kind === "extracting") {
    return (
      <Bar>
        <RefreshCw size={13} className="animate-spin text-purple-300 shrink-0" />
        <span>Preparing {label}…</span>
        <div className="flex-1" />
      </Bar>
    );
  }

  // ready / missing / error → quiet (a failed download surfaces at launch).
  return null;
}

function Bar({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      className="flex items-center gap-2 px-4 py-2 text-[12.5px] text-slate-200"
      style={{
        background: "rgba(168,85,247,0.06)",
        boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.14)",
      }}
    >
      {children}
    </div>
  );
}
