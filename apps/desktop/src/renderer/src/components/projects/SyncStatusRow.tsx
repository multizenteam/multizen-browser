import { useCallback, useEffect, useState, type JSX } from "react";
import { AlertTriangle, CloudOff, Laptop, RefreshCw, ShieldAlert } from "lucide-react";

import type { GatewaySyncStatusView } from "../../types";
import { Button } from "../atoms/Button";
import { DevicesModal } from "./DevicesModal";
import { SyncIssuesModal } from "./SyncIssuesModal";

/**
 * Project-sync state for the Projects screen.
 *
 * Project configs are published to the same bucket Cloud Sync uses, but that
 * channel was previously invisible: no status, no errors, and no way to recover
 * the common case where Cloud Sync is configured AFTER the gateway started — in
 * which case sync stays composed-as-off until the app restarts. "Retry" re-runs
 * the compose step and then one sync pass, which is the fix for exactly that.
 *
 * The row reports honestly. "Not syncing" is a normal, supported state (the
 * gateway works fully offline), so it is stated plainly rather than as an error.
 */

export interface SyncStatusRowProps {
  /** Re-read the project list after a sync pass applies remote changes. */
  readonly onSynced: () => void;
}

function relativeTime(at: number, now: number): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SyncStatusRow({ onSynced }: SyncStatusRowProps): JSX.Element | null {
  const [status, setStatus] = useState<GatewaySyncStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);

  const read = useCallback(async () => {
    const res = await window.multizen.gateway.syncStatus();
    if (res.ok) setStatus(res.value);
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  const retry = useCallback(async () => {
    setBusy(true);
    try {
      const res = await window.multizen.gateway.syncRetry();
      if (res.ok) {
        setStatus(res.value);
        // A pass may have applied remote projects; the list must catch up.
        onSynced();
      }
    } finally {
      setBusy(false);
    }
  }, [onSynced]);

  if (status === null) return null;

  const problems: string[] = [];
  if (status.quarantined > 0) {
    problems.push(
      `${status.quarantined} refused`,
    );
  }
  if (status.conflicts > 0) {
    problems.push(`${status.conflicts} conflicted`);
  }

  return (
    <div
      data-testid="sync-status"
      className="px-4 py-2.5"
      style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
    >
      <div className="flex items-center gap-2">
        {!status.ready && <CloudOff size={12} className="text-slate-500 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="text-[11.5px] text-slate-300 truncate">
            {status.running ? "Syncing…" : status.ready ? "Cloud sync on" : "Not syncing"}
          </div>
          <div className="text-[10.5px] text-slate-500 truncate">
            {!status.ready
              ? "Projects are stored on this device only."
              : status.lastSyncAt === null
                ? "No sync yet."
                : `Last synced ${relativeTime(status.lastSyncAt, Date.now())}`}
          </div>
        </div>
        {status.ready && (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Laptop size={11} />}
            onClick={() => setDevicesOpen(true)}
          >
            Devices
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          leftIcon={<RefreshCw size={11} />}
          disabled={busy || status.running}
          onClick={() => void retry()}
        >
          {busy ? "Syncing…" : "Retry"}
        </Button>
      </div>

      <DevicesModal
        open={devicesOpen}
        onClose={() => setDevicesOpen(false)}
        onTrustChanged={() => void retry()}
      />

      {Boolean(status.pending || status.unreadable) && (
        <div role="status" className="mt-1 text-[10.5px] text-amber-200/90">
          {[
            (status.pending ?? 0) > 0 && `${status.pending} awaiting upload`,
            (status.unreadable ?? 0) > 0 && `${status.unreadable} could not be read`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      {status.lastError !== null && (
        <div
          role="alert"
          className="flex items-start gap-1.5 mt-1.5 text-[10.5px] text-red-300/90 leading-relaxed"
        >
          <AlertTriangle size={11} className="flex-shrink-0 mt-px" />
          <span className="min-w-0 break-words">{status.lastError}</span>
        </div>
      )}

      {problems.length > 0 && (
        <button
          type="button"
          onClick={() => setIssuesOpen(true)}
          className="flex items-start gap-1.5 mt-1.5 text-[10.5px] text-amber-200/90 leading-relaxed text-left hover:text-amber-100 transition-colors"
        >
          <ShieldAlert size={11} className="flex-shrink-0 mt-px" />
          <span className="min-w-0">{problems.join(" · ")} — review</span>
        </button>
      )}

      <SyncIssuesModal
        open={issuesOpen}
        onClose={() => setIssuesOpen(false)}
        onResolved={() => {
          void read();
          onSynced();
        }}
      />
    </div>
  );
}
