import { useCallback, useEffect, useState, type JSX } from "react";
import { CloudDownload, KeyRound } from "lucide-react";

import type { CredentialBackupView, GatewayOpResult, SecretRefStatusView } from "../../types";
import { Button } from "../atoms/Button";
import { Modal, Pill } from "../atoms";
import { approveCredentialBackupSigner } from "../settings/approveCredentialBackupSigner";
import { Section } from "./ProjectDetail";

/**
 * Availability of every `${NAME}` the project's servers reference, and the two
 * ways to satisfy one.
 *
 * A reference can be backed either by an environment variable this device is
 * approved to read, or by a value Sekvona stores in the OS keychain. This
 * screen only ever shows the NAME and whether a value is present — there is no
 * control, and no API, that reads a stored value back. Saving is one-way.
 */

export interface ReferencesSectionProps {
  readonly projectId: string;
  readonly refs: readonly SecretRefStatusView[];
  readonly onChanged: () => void;
  readonly onError: (message: string | null) => void;
}

export function ReferencesSection({
  projectId,
  refs,
  onChanged,
  onError,
}: ReferencesSectionProps): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [provideFor, setProvideFor] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [backup, setBackup] = useState<CredentialBackupView | null>(null);
  const [backupChecked, setBackupChecked] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const hasMissing = refs.some((ref) => !ref.present);
  const blockedDeviceId =
    backup?.remoteIssue?.code === "unknown-signer" ? backup.remoteIssue.deviceId : undefined;

  useEffect(() => {
    let active = true;
    setBackupChecked(false);
    const credentialBackup = window.multizen?.gateway?.credentialBackup;
    if (!hasMissing || !credentialBackup) {
      setBackup(null);
      setBackupChecked(true);
      return () => {
        active = false;
      };
    }
    void credentialBackup()
      .then((res) => {
        if (active) setBackup(res.ok ? res.value : null);
      })
      .catch(() => {
        if (active) setBackup(null);
      })
      .finally(() => {
        if (active) setBackupChecked(true);
      });
    return () => {
      active = false;
    };
  }, [hasMissing, projectId]);

  const run = useCallback(
    async <T,>(op: () => Promise<GatewayOpResult<T>>): Promise<boolean> => {
      setBusy(true);
      onError(null);
      try {
        const res = await op();
        if (!res.ok) {
          onError(res.error.message);
          return false;
        }
        onChanged();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onError],
  );

  const approveBackupDevice = useCallback(
    async (deviceId: string) => {
      setBusy(true);
      onError(null);
      setApprovalError(null);
      try {
        const refreshed = await approveCredentialBackupSigner(deviceId);
        setBackup(refreshed);
        onChanged();
      } catch (err) {
        setApprovalError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onError],
  );

  const closeProvide = useCallback(() => {
    // Never keep a secret in component state after the dialog closes.
    setValue("");
    setProvideFor(null);
  }, []);

  const closeRestore = useCallback(() => {
    // As with a directly-provided value, never retain this secret after close.
    setRestorePassphrase("");
    setRestoreError(null);
    setRestoreOpen(false);
  }, []);

  const saveValue = useCallback(async () => {
    if (provideFor === null || value.length === 0) return;
    const name = provideFor;
    const secret = value;
    // Clear local state before awaiting, so the value does not linger in memory
    // any longer than the call itself needs it.
    setValue("");
    const ok = await run(() => window.multizen.gateway.saveManagedSecret(projectId, name, secret));
    if (ok) setProvideFor(null);
  }, [projectId, provideFor, run, value]);

  const restoreCredentials = useCallback(async () => {
    if (restorePassphrase.length === 0) return;
    const passphrase = restorePassphrase;
    setRestorePassphrase("");
    setBusy(true);
    setRestoreError(null);
    setRestoreMessage(null);
    try {
      const res = await window.multizen.gateway.restoreCredentials(passphrase);
      if (!res.ok) {
        setRestoreError(res.error.message);
        return;
      }
      setRestoreOpen(false);
      setRestoreMessage(
        res.value.restored === 0
          ? "The credential backup was empty."
          : `Restored ${res.value.restored} credential${res.value.restored === 1 ? "" : "s"} from the encrypted backup.`,
      );
      onChanged();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onChanged, restorePassphrase]);

  // Nothing referenced: the section would be an empty box, so omit it entirely.
  if (refs.length === 0) return null;

  return (
    <>
      <Section title={`References (${refs.length})`}>
        <div className="text-[11.5px] text-slate-500 leading-relaxed mb-3">
          Your servers reference these environment variables. Each one can read from this computer’s
          environment, or hold a value Sekvona keeps in your keychain. Values are never shown again
          after you save them, and never written into a project or an agent’s configuration file.
        </div>
        {hasMissing && backupChecked && backup?.remotePresent === true && (
          <div
            className="mb-3 flex items-center gap-3 px-3 py-2.5"
            style={{
              borderRadius: 8,
              background: "rgba(180,226,255,0.06)",
              boxShadow: "inset 0 0 0 1px rgba(180,226,255,0.18)",
            }}
            data-testid="credential-restore-available"
          >
            <div className="flex-1 text-[11px] text-slate-400 leading-relaxed">
              An encrypted MCP credential backup is available in Cloud Sync.
            </div>
            <Button
              size="sm"
              variant="accent"
              leftIcon={<CloudDownload size={12} />}
              disabled={busy}
              onClick={() => {
                setRestoreError(null);
                setRestoreOpen(true);
              }}
            >
              Restore from backup
            </Button>
          </div>
        )}
        {hasMissing && backupChecked && backup?.remotePresent === false && (
          <div
            className="mb-3 px-3 py-2.5 text-[11px] text-amber-300/90 leading-relaxed"
            style={{
              borderRadius: 8,
              background: "rgba(245,158,11,0.05)",
              boxShadow: "inset 0 0 0 1px rgba(245,158,11,0.16)",
            }}
            data-testid="credential-backup-missing"
          >
            No MCP credential backup is stored. On the original Mac, open Cloud Sync settings and
            turn on “Back up MCP credentials,” then return here to restore it.
          </div>
        )}
        {hasMissing &&
          backupChecked &&
          backup?.remoteIssue !== null &&
          backup?.remoteIssue !== undefined && (
            <div
              className="mb-3 px-3 py-2.5 text-[11px] text-amber-300/90 leading-relaxed"
              style={{
                borderRadius: 8,
                background: "rgba(245,158,11,0.05)",
                boxShadow: "inset 0 0 0 1px rgba(245,158,11,0.16)",
              }}
              role="alert"
              data-testid="credential-backup-trust-issue"
            >
              The stored credential backup is blocked: {backup.remoteIssue.message}. On a trusted
              Mac, approve the signing device to continue.
              {blockedDeviceId !== undefined && (
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void approveBackupDevice(blockedDeviceId)}
                  >
                    {busy ? "Approving…" : "Approve backup device"}
                  </Button>
                </div>
              )}
              {approvalError !== null && (
                <div className="mt-2 text-red-300" role="alert">
                  {approvalError}
                </div>
              )}
            </div>
          )}
        {restoreMessage !== null && (
          <div className="mb-3 text-[11px] text-emerald-400/90" role="status">
            {restoreMessage}
          </div>
        )}
        <div className="space-y-2" data-testid="reference-list">
          {refs.map((ref) => (
            <div
              key={ref.name}
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(255,255,255,0.02)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
              }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="mono text-[12px] text-slate-200">{ref.name}</span>
                {ref.present ? (
                  <Pill kind="running">
                    {ref.source === "managed" ? "stored by Sekvona" : "from environment"}
                  </Pill>
                ) : (
                  <Pill kind="error">no value</Pill>
                )}
                <div className="flex-1" />
                {ref.managed ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        window.multizen.gateway.deleteManagedSecret(projectId, ref.name),
                      )
                    }
                  >
                    Remove stored value
                  </Button>
                ) : (
                  <>
                    {ref.approved ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(() => window.multizen.gateway.revokeEnvName(ref.name))
                        }
                      >
                        Stop using environment
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(() => window.multizen.gateway.approveEnvName(ref.name))
                        }
                      >
                        Use environment
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<KeyRound size={12} />}
                      disabled={busy}
                      onClick={() => setProvideFor(ref.name)}
                    >
                      Provide value
                    </Button>
                  </>
                )}
              </div>
              {!ref.present && (
                <div className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
                  {ref.approved
                    ? `Approved to read ${ref.name} from this computer’s environment, but it is not set. Export it before launching Sekvona, or provide a value instead.`
                    : "Approve reading it from this computer’s environment, or let Sekvona store the value in your keychain."}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Modal
        open={provideFor !== null}
        onClose={closeProvide}
        title={provideFor !== null ? `Value for ${provideFor}` : "Provide a value"}
        subtitle="Stored in your operating system’s keychain. Sekvona never displays it again and never writes it into a file."
        width={460}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={closeProvide} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void saveValue()}
              disabled={busy || value.length === 0}
            >
              Save value
            </Button>
          </>
        }
      >
        <div className="px-5 py-4">
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
              Value
            </span>
            <input
              data-autofocus
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label={provideFor !== null ? `Value for ${provideFor}` : "Value"}
              className="w-full mono text-[12.5px] text-slate-200 outline-none"
              style={{
                height: 34,
                padding: "0 11px",
                borderRadius: 9,
                background: "rgba(0,0,0,0.25)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
              }}
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={restoreOpen}
        onClose={closeRestore}
        title="Restore MCP credentials"
        subtitle="Enter the separate passphrase used when credential backup was enabled. The passphrase is not stored or displayed."
        width={460}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={closeRestore} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void restoreCredentials()}
              disabled={busy || restorePassphrase.length === 0}
            >
              {busy ? "Restoring…" : "Restore credentials"}
            </Button>
          </>
        }
      >
        <div className="px-5 py-4">
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
              Credential backup passphrase
            </span>
            <input
              data-autofocus
              type="password"
              autoComplete="off"
              value={restorePassphrase}
              onChange={(e) => setRestorePassphrase(e.target.value)}
              aria-label="Credential backup passphrase"
              className="w-full text-[12.5px] text-slate-200 outline-none"
              style={{
                height: 34,
                padding: "0 11px",
                borderRadius: 8,
                background: "rgba(0,0,0,0.25)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
              }}
            />
          </label>
          {restoreError !== null && (
            <div className="mt-2 text-[11px] text-red-300" role="alert">
              {restoreError}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
