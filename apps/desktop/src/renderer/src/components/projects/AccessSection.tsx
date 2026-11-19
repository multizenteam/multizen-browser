import { useCallback, useState, type JSX } from "react";
import { AlertTriangle, KeyRound } from "lucide-react";

import type {
  GatewayOpResult,
  ProjectEndpointsView,
  ProjectView,
} from "../../types";
import { Button } from "../atoms/Button";
import { Modal, Pill, confirm } from "../atoms";
import { CopyRow } from "./CopyRow";
import { Field, Section } from "./ProjectDetail";

/**
 * Who may call this project's endpoints, and where those endpoints are.
 *
 * When a token is required, generated agent configuration references an
 * environment VARIABLE rather than embedding the token — so the agent must be
 * launched with that variable exported. The token itself is shown exactly once,
 * when it is minted; afterwards Sekvona can only report that one exists.
 */

export interface AccessSectionProps {
  readonly project: ProjectView;
  readonly endpoints: ProjectEndpointsView | null;
  readonly onChanged: () => void;
  readonly onError: (message: string | null) => void;
}

/** Strip the `${...}` wrapper from a stored reference for display. */
function envNameOf(tokenRef: string | undefined): string | null {
  if (tokenRef === undefined) return null;
  return /^\$\{(.+)\}$/.exec(tokenRef)?.[1] ?? tokenRef;
}

export function AccessSection({
  project,
  endpoints,
  onChanged,
  onError,
}: AccessSectionProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  /** A freshly minted token, held only until the operator dismisses it. */
  const [revealed, setRevealed] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(op: () => Promise<GatewayOpResult<T>>): Promise<T | null> => {
      setBusy(true);
      onError(null);
      try {
        const res = await op();
        if (!res.ok) {
          onError(res.error.message);
          return null;
        }
        onChanged();
        return res.value;
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onError],
  );

  const toggleAuth = useCallback(async () => {
    await run(() =>
      window.multizen.gateway.setAuthEnabled(project.id, !project.localAuth.enabled),
    );
  }, [project.id, project.localAuth.enabled, run]);

  const generate = useCallback(async () => {
    if (project.localAuth.tokenPresent) {
      const confirmed = await confirm({
        title: "Replace the existing token?",
        body: "The current token stops working immediately. Any agent still using it will be refused until you give it the new one.",
        confirmLabel: "Replace token",
        destructive: true,
      });
      if (!confirmed) return;
    }
    const result = await run(() => window.multizen.gateway.generateToken(project.id));
    if (result !== null) setRevealed(result.token);
  }, [project.id, project.localAuth.tokenPresent, run]);

  const envName = envNameOf(project.localAuth.tokenRef);

  return (
    <>
      <Section title="Access">
        <Field
          label="Require a token"
          hint={
            project.localAuth.enabled
              ? "Callers must send this project's bearer token. Agent configuration references the variable below — never the token itself."
              : "Any local process can call this project's endpoints. Turn this on to require a bearer token."
          }
        >
          <button
            type="button"
            role="switch"
            aria-checked={project.localAuth.enabled}
            aria-label="Require a token"
            disabled={busy}
            onClick={() => void toggleAuth()}
            className="relative transition-colors"
            style={{
              width: 38,
              height: 22,
              borderRadius: 999,
              background: project.localAuth.enabled
                ? "rgba(16,185,129,0.35)"
                : "rgba(255,255,255,0.08)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.10)",
              opacity: busy ? 0.6 : 1,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 3,
                left: project.localAuth.enabled ? 19 : 3,
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: project.localAuth.enabled ? "#34d399" : "#94a3b8",
                transition: "left 140ms ease",
              }}
            />
          </button>
        </Field>

        {project.localAuth.enabled && (
          <>
            <Field
              label="Token"
              hint={
                project.localAuth.tokenPresent
                  ? "A token exists. Sekvona cannot show it again — generate a new one if you have lost it."
                  : "No token yet. Generate one and copy it into the environment variable below."
              }
            >
              <div className="flex items-center gap-2">
                {project.localAuth.tokenPresent ? (
                  <Pill kind="running">stored</Pill>
                ) : (
                  <Pill kind="error">not set</Pill>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<KeyRound size={12} />}
                  disabled={busy}
                  onClick={() => void generate()}
                >
                  {project.localAuth.tokenPresent ? "Generate new token" : "Generate token"}
                </Button>
              </div>
            </Field>

            {envName !== null && (
              <Field
                label="Variable"
                hint="Export this variable — with the token as its value — in the environment where you launch your agent. Sekvona writes only this NAME into agent configuration."
              >
                <CopyRow value={envName} label="Copy variable name" />
              </Field>
            )}
          </>
        )}
      </Section>

      <Section title="Endpoints">
        {endpoints === null ? (
          <div className="text-[12px] text-slate-500">Loading endpoints…</div>
        ) : (
          <>
            {!endpoints.served && (
              <div
                className="flex items-start gap-2 mb-3 px-3 py-2.5 text-[11.5px] leading-relaxed"
                style={{
                  borderRadius: 9,
                  background: "rgba(245,158,11,0.06)",
                  boxShadow: "inset 0 0 0 1px rgba(245,158,11,0.25)",
                }}
              >
                <AlertTriangle size={13} className="text-amber-300 mt-[1px] flex-shrink-0" />
                <span className="text-amber-100/90">
                  These URLs are not being served yet. Turn on the MCP HTTP server in
                  Settings; the addresses below will not change.
                </span>
              </div>
            )}
            {!project.enabled && (
              <div className="text-[11.5px] text-slate-500 mb-3 leading-relaxed">
                This project is switched off, so nothing answers on these addresses yet.
              </div>
            )}
            {endpoints.proxies.length === 0 && endpoints.browser === undefined ? (
              <div className="text-[12px] text-slate-500 leading-relaxed">
                No endpoints yet — add a server, or bind a browser profile.
              </div>
            ) : (
              <div className="space-y-2.5" data-testid="endpoint-list">
                {endpoints.proxies.map((p) => (
                  <CopyRow
                    key={p.serverId}
                    caption={p.serverId}
                    value={p.url}
                    label={`Copy ${p.serverId} endpoint`}
                  />
                ))}
                {endpoints.browser !== undefined && (
                  <CopyRow
                    caption="browser"
                    value={endpoints.browser}
                    label="Copy browser endpoint"
                  />
                )}
              </div>
            )}
            {endpoints.authRequired && (
              <div className="text-[11px] text-slate-500 mt-3 leading-relaxed">
                Calls to these addresses must carry this project’s bearer token.
              </div>
            )}
          </>
        )}
      </Section>

      {/* One-shot token reveal. Dismissing drops it from memory for good. */}
      <Modal
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        title="Copy your token now"
        subtitle="This is the only time Sekvona can show it. Afterwards it can only confirm that a token exists."
        width={520}
        footer={
          <Button variant="primary" size="sm" onClick={() => setRevealed(null)}>
            I’ve saved it
          </Button>
        }
      >
        <div className="px-5 py-4">
          {revealed !== null && (
            <>
              <CopyRow value={revealed} label="Copy token" caption="Token" />
              {envName !== null && (
                <div className="text-[11.5px] text-slate-400 mt-3 leading-relaxed">
                  Export it as{" "}
                  <code className="mono text-slate-200">{envName}</code> wherever you launch
                  your agent, for example{" "}
                  <code className="mono text-slate-200">export {envName}=…</code>
                </div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
