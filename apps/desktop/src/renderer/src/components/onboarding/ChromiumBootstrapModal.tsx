import { useEffect, useState, type JSX } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { Button } from "../atoms/Button";
import { Cube } from "../atoms/Cube";
import type { ChromiumStatus } from "../../types";

/**
 * Blocks the UI until the patched Chromium binary is present. Shown:
 *   - on first run (download)
 *   - on cache invalidation (re-download)
 *   - on download error (retry)
 *
 * In dev (status === "dev-system") the modal is hidden — we use system Chrome.
 * When status is "ready", modal is hidden — Chromium is good to spawn.
 */
export function ChromiumBootstrapModal(): JSX.Element | null {
  const [status, setStatus] = useState<ChromiumStatus | null>(null);

  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.chromium.status().then(setStatus);
    return window.multizen.chromium.onStatus(setStatus);
  }, []);

  if (!status) return null;
  if (status.kind === "ready" || status.kind === "dev-system") return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ background: "rgba(5,6,10,0.7)", backdropFilter: "blur(12px)" }}
    >
      <div
        className="rounded-2xl p-6 w-full max-w-md mx-6"
        style={{
          background: "rgba(15,16,22,0.95)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.10), 0 30px 80px rgba(0,0,0,0.6)",
        }}
      >
        <div className="flex items-center gap-3 mb-4">
          <Cube size={36} glow={false} />
          <div>
            <div className="text-[15px] font-bold text-slate-100">{titleFor(status)}</div>
            <div className="text-[12px] text-slate-400 mt-0.5">{subtitleFor(status)}</div>
          </div>
        </div>

        <Body status={status} />
      </div>
    </div>
  );
}

function titleFor(status: ChromiumStatus): string {
  switch (status.kind) {
    case "missing":
      return "Setting up Sekvona";
    case "fetching-manifest":
      return "Looking up the browser runtime";
    case "downloading":
      return "Downloading browser runtime";
    case "verifying":
      return "Verifying download";
    case "extracting":
      return "Installing browser runtime";
    case "error":
      return "Setup failed";
    default:
      return "Sekvona";
  }
}

function subtitleFor(status: ChromiumStatus): string {
  switch (status.kind) {
    case "missing":
      return "First-run download. About 150-550 MB.";
    case "fetching-manifest":
      return "Resolving the latest compatible build";
    case "downloading":
      return `Runtime ${status.version}`;
    case "verifying":
      return "Checking integrity (SHA-256 + macOS code signature)";
    case "extracting":
      return `Unpacking runtime ${status.version}…`;
    case "error":
      return "We could not download the Chromium binary.";
    default:
      return "";
  }
}

function Body({ status }: { status: ChromiumStatus }): JSX.Element {
  if (status.kind === "missing") {
    return (
      <div className="flex items-center gap-2 text-[12px] text-slate-400">
        <Loader2 size={14} className="animate-spin text-purple-400" />
        Preparing download…
      </div>
    );
  }

  if (status.kind === "fetching-manifest") {
    return (
      <div className="flex items-center gap-2 text-[12px] text-slate-400">
        <Loader2 size={14} className="animate-spin text-purple-400" />
        Resolving latest stable version…
      </div>
    );
  }

  if (status.kind === "extracting") {
    return (
      <div className="flex items-center gap-2 text-[12px] text-slate-400">
        <Loader2 size={14} className="animate-spin text-purple-400" />
        Unpacking and verifying signature…
      </div>
    );
  }

  if (status.kind === "downloading") {
    const pct =
      status.bytesTotal > 0
        ? Math.min(100, Math.round((status.bytesReceived / status.bytesTotal) * 100))
        : 0;
    return (
      <>
        <div
          className="relative h-2 rounded-full overflow-hidden mb-3"
          style={{ background: "rgba(255,255,255,0.06)" }}
        >
          <div
            className="absolute inset-y-0 left-0 transition-[width] duration-200"
            style={{
              width: `${pct}%`,
              background: "linear-gradient(90deg, #6366f1, #a855f7, #ec4899)",
            }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] mono text-slate-500">
          <span>
            {formatMB(status.bytesReceived)} / {formatMB(status.bytesTotal)}
          </span>
          <span>{pct}%</span>
        </div>
      </>
    );
  }

  if (status.kind === "verifying") {
    return (
      <div className="flex items-center gap-2 text-[12px] text-slate-400">
        <Loader2 size={14} className="animate-spin text-purple-400" />
        Verifying SHA-256 checksum…
      </div>
    );
  }

  if (status.kind === "error") {
    return (
      <>
        <div
          className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg mb-4 min-w-0"
          style={{
            background: "rgba(239,68,68,0.06)",
            boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.25)",
          }}
        >
          <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
          <div
            className="mono text-[11px] text-red-300 min-w-0 flex-1 max-h-32 overflow-auto"
            style={{
              // overflow-wrap:anywhere breaks long file paths / URLs that
              // have no whitespace; word-break alone (Tailwind break-words)
              // only splits on spaces.
              overflowWrap: "anywhere",
              wordBreak: "break-word",
            }}
          >
            {status.message}
          </div>
        </div>
        <Button
          variant="primary"
          fullWidth
          leftIcon={<Download size={14} strokeWidth={1.5} />}
          onClick={() => void window.multizen.chromium.retry()}
        >
          Retry download
        </Button>
      </>
    );
  }

  return <></>;
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
