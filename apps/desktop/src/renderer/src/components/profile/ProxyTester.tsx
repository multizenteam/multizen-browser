import { useState, type JSX } from "react";
import { AlertTriangle, CheckCircle2, Globe2, Loader2 } from "lucide-react";
import { Flag } from "../atoms";
import type { ProxyConfig, ProxyGeoResult } from "../../types";

/**
 * Test-proxy affordance — shared between create and edit forms.
 *
 * Press the button → probes ipapi.co through the proxy and renders a
 * pretty card with country/city/ip/timezone. Errors render inline with
 * the same shape so the layout doesn't jump.
 */

interface Props {
  proxy: ProxyConfig | undefined;
  /** When set, the resolved country code is persisted onto this profile so
   *  the GUI flag chip updates without waiting for the next launch. */
  profileId?: string;
  /** Fired once the probe lands so the host (e.g. ProfileEditSheet) can
   *  refresh its summary list and re-render the flag immediately. */
  onProbed?: () => void;
}

export function ProxyTester({ proxy, profileId, onProbed }: Props): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProxyGeoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!proxy || !proxy.host) return null;

  async function test(): Promise<void> {
    if (!proxy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await window.multizen.proxy.detectGeo(proxy, profileId);
      if (r.ok) {
        setResult(r.geo);
        onProbed?.();
      } else setError(r.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2.5 space-y-2">
      <button
        type="button"
        onClick={() => void test()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 text-[11px] text-purple-300 hover:text-purple-200 transition-colors px-3 py-1.5 rounded-lg disabled:opacity-50"
        style={{
          background: "rgba(168,85,247,0.08)",
          boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.25)",
        }}
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <Globe2 size={11} />}
        {busy ? "Testing…" : "Test proxy"}
      </button>

      {result && <ResultCard result={result} />}
      {error && <ErrorCard message={error} />}
    </div>
  );
}

function ResultCard({ result }: { result: ProxyGeoResult }): JSX.Element {
  return (
    <div
      className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg"
      style={{
        background: "rgba(16,185,129,0.06)",
        boxShadow: "inset 0 0 0 1px rgba(16,185,129,0.25)",
      }}
    >
      <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0 text-emerald-400" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[12px] text-emerald-200 font-medium">
          <Flag cc={result.country} />
          <span className="min-w-0 truncate">
            {result.city ? `${result.city}, ` : ""}
            {result.countryName}
          </span>
          {typeof result.latencyMs === "number" && (
            <span
              className="ml-auto flex-shrink-0 text-[10px] mono"
              style={{ color: latencyColor(result.latencyMs) }}
              title="Round-trip of the test request through the proxy"
            >
              {result.latencyMs} ms
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1.5 text-[10px] mono text-emerald-300/70">
          <div>
            <span className="text-emerald-300/50">IP&nbsp;&nbsp;</span>
            {result.ip}
          </div>
          <div>
            <span className="text-emerald-300/50">TZ&nbsp;&nbsp;</span>
            {result.timezone}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Color the latency: green fast, amber okay, red slow. Thresholds are lenient
 *  because this is a round-trip THROUGH the proxy to a geo API, and residential
 *  proxies routinely sit around a second. */
function latencyColor(ms: number): string {
  if (ms < 1000) return "#34d399"; // emerald-400
  if (ms < 2500) return "#fbbf24"; // amber-400
  return "#f87171"; // red-400
}

function ErrorCard({ message }: { message: string }): JSX.Element {
  return (
    <div
      className="flex items-start gap-2 px-3 py-2 rounded-lg text-[11px] text-red-300"
      style={{
        background: "rgba(239,68,68,0.06)",
        boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.3)",
      }}
    >
      <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
      <span className="break-words">{message}</span>
    </div>
  );
}
