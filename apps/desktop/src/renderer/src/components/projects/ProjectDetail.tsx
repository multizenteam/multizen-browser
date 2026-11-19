import { shortenProjectName } from "../../../../main/mcp-gateway/projectNames";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { History, Trash2 } from "lucide-react";

import type {
  BindableProfileView,
  GatewayOpResult,
  ProjectEndpointsView,
  ProjectRuntimeView,
  ProjectView,
  SecretRefStatusView,
  WorkspaceBindingView,
} from "../../types";
import { Button } from "../atoms/Button";
import { Pill, confirm } from "../atoms";
import { ServersSection } from "./ServersSection";
import { ProjectHistoryModal } from "./ProjectHistoryModal";
import { ReferencesSection } from "./ReferencesSection";
import { DirectoriesSection } from "./DirectoriesSection";
import { AccessSection } from "./AccessSection";

/**
 * Editor for one gateway project.
 *
 * Fields autosave on commit (blur / toggle / Enter), matching the profile editor
 * so there is no Save button to forget. Every mutation goes through the preload
 * `gateway` API and reports failures inline — the backend returns structured
 * envelopes and never throws across IPC, so an error is a normal render state
 * rather than an exception.
 */

export interface ProjectDetailProps {
  readonly project: ProjectView;
  /** Called after any successful mutation so the list can re-read. */
  readonly onChanged: (projectId: string) => void;
  /** Called after the project has been deleted. */
  readonly onDeleted: () => void;
}

export function ProjectDetail({
  project,
  onChanged,
  onDeleted,
}: ProjectDetailProps): JSX.Element {
  const [label, setLabel] = useState(project.label ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [runtime, setRuntime] = useState<ProjectRuntimeView | null>(null);
  const [refs, setRefs] = useState<readonly SecretRefStatusView[]>([]);
  const [profiles, setProfiles] = useState<readonly BindableProfileView[]>([]);
  const [bindings, setBindings] = useState<readonly WorkspaceBindingView[]>([]);
  const [endpoints, setEndpoints] = useState<ProjectEndpointsView | null>(null);

  // Keep the local field in step when the project is re-read from the backend.
  const lastAppliedLabel = useRef(project.label ?? "");
  useEffect(() => {
    if (project.label !== undefined && project.label !== lastAppliedLabel.current) {
      lastAppliedLabel.current = project.label;
      setLabel(project.label);
    }
  }, [project.label]);

  /**
   * Load the derived state the detail pane shows alongside the config: live
   * runtime phases, reference availability, and which browser profiles are free.
   * Re-runs whenever the project object changes, i.e. after every mutation.
   */
  const loadDerived = useCallback(async () => {
    const [rt, sr, bp, dirs, eps] = await Promise.all([
      window.multizen.gateway.runtime(project.id),
      window.multizen.gateway.secretRefs(project.id),
      window.multizen.gateway.bindableProfiles(project.id),
      window.multizen.gateway.directories(project.id),
      window.multizen.gateway.endpoints(project.id),
    ]);
    if (rt.ok) setRuntime(rt.value);
    if (sr.ok) setRefs(sr.value);
    if (bp.ok) setProfiles(bp.value);
    if (dirs.ok) setBindings(dirs.value);
    if (eps.ok) setEndpoints(eps.value);
  }, [project.id]);

  useEffect(() => {
    void loadDerived();
  }, [loadDerived, project]);

  /** Run a mutation, surfacing a failed envelope as an inline error. */
  const run = useCallback(
    async <T,>(op: () => Promise<GatewayOpResult<T>>): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        const res = await op();
        if (!res.ok) {
          setError(res.error.message);
          return null;
        }
        onChanged(project.id);
        return res.value;
      } finally {
        setBusy(false);
      }
    },
    [onChanged, project.id],
  );

  const commitLabel = useCallback(async () => {
    const next = label.trim();
    if (next === (project.label ?? "")) return;
    lastAppliedLabel.current = next;
    await run(() => window.multizen.gateway.updateProject(project.id, { label: next }));
  }, [label, project.id, project.label, run]);

  const toggleEnabled = useCallback(async () => {
    await run(() =>
      window.multizen.gateway.updateProject(project.id, { enabled: !project.enabled }),
    );
  }, [project.enabled, project.id, run]);

  const bindProfile = useCallback(
    async (profileId: string | null) => {
      await run(() => window.multizen.gateway.bindProfile(project.id, profileId));
    },
    [project.id, run],
  );

  const remove = useCallback(async () => {
    const confirmed = await confirm({
      title: `Delete “${shortenProjectName(project.label ?? project.id)}”?`,
      body: (
        <>
          Sekvona will remove this project’s MCP entries from every folder’s agent
          configuration, then delete the project. Your browser profile and any
          servers you configured by hand are left untouched.
        </>
      ),
      confirmLabel: "Delete project",
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.multizen.gateway.deleteProject(project.id);
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      onDeleted();
    } finally {
      setBusy(false);
    }
  }, [onDeleted, project.id, project.label]);

  const activeServers = (runtime?.servers ?? []).filter(
    (s) => s.phase === "running" || s.phase === "connected",
  ).length;
  const endpointCount =
    project.servers.filter((s) => !s.disabled).length +
    (project.browserProfileId !== undefined ? 1 : 0);

  return (
    <div style={{ padding: "20px 24px" }} data-testid="project-detail">
      <div className="max-w-[820px]">
        {/* ── header ──────────────────────────────────────────────────────── */}
        <div className="flex items-start gap-3 mb-5">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-[16px] font-bold text-slate-100 truncate">
                {shortenProjectName(project.label ?? project.id)}
              </h2>
              {project.enabled ? <Pill kind="running">on</Pill> : <Pill kind="idle">off</Pill>}
            </div>
            <div className="mono text-[11px] text-slate-500">
              {project.id} · {endpointCount} {endpointCount === 1 ? "endpoint" : "endpoints"}
              {project.enabled && ` · ${activeServers} active`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<History size={12} />}
              disabled={busy}
              onClick={() => setHistoryOpen(true)}
            >
              History
            </Button>
            <Button
              size="sm"
              variant="danger"
              leftIcon={<Trash2 size={12} />}
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          </div>
        </div>

        {error !== null && (
          <div
            role="alert"
            className="mb-4 px-3 py-2.5 text-[12px] text-red-300 leading-relaxed"
            style={{
              borderRadius: 10,
              background: "rgba(239,68,68,0.06)",
              boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.25)",
            }}
          >
            {error}
          </div>
        )}

        {/* ── overview ────────────────────────────────────────────────────── */}
        <Section title="Overview">
          <Field label="Name">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(shortenProjectName(e.target.value))}
              onBlur={() => void commitLabel()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitLabel();
              }}
              placeholder={project.id}
              aria-label="Project name"
              className="w-full text-[12.5px] text-slate-200 outline-none"
              style={{
                height: 32,
                padding: "0 10px",
                borderRadius: 8,
                background: "rgba(0,0,0,0.25)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
              }}
            />
          </Field>

          <Field
            label="Enabled"
            hint={
              project.enabled
                ? "Endpoints are served and written into your folders’ agent configuration."
                : "Nothing is served, and Sekvona’s entries are removed from your folders."
            }
          >
            <button
              type="button"
              role="switch"
              aria-checked={project.enabled}
              aria-label="Project enabled"
              disabled={busy}
              onClick={() => void toggleEnabled()}
              className="relative transition-colors"
              style={{
                width: 38,
                height: 22,
                borderRadius: 999,
                background: project.enabled ? "rgba(16,185,129,0.35)" : "rgba(255,255,255,0.08)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.10)",
                opacity: busy ? 0.6 : 1,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 3,
                  left: project.enabled ? 19 : 3,
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  background: project.enabled ? "#34d399" : "#94a3b8",
                  transition: "left 140ms ease",
                }}
              />
            </button>
          </Field>

          <Field
            label="Browser profile"
            hint="A profile belongs to at most one project. Binding one adds a profile-scoped browser endpoint."
          >
            <select
              value={project.browserProfileId ?? ""}
              disabled={busy}
              aria-label="Browser profile"
              onChange={(e) => void bindProfile(e.target.value === "" ? null : e.target.value)}
              className="w-full text-[12.5px] text-slate-200 outline-none"
              style={{
                height: 32,
                padding: "0 8px",
                borderRadius: 8,
                background: "rgba(0,0,0,0.25)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
              }}
            >
              <option value="">No browser profile</option>
              {profiles.map((p) => (
                <option key={p.profileId} value={p.profileId} disabled={!p.available}>
                  {p.name}
                  {p.available ? "" : ` — in use by ${p.boundToProjectId ?? "another project"}`}
                </option>
              ))}
              {/* A bound profile the list no longer reports must still render, or
                  the select would silently show "No browser profile". */}
              {project.browserProfileId !== undefined &&
                !profiles.some((p) => p.profileId === project.browserProfileId) && (
                  <option value={project.browserProfileId}>{project.browserProfileId}</option>
                )}
            </select>
          </Field>
        </Section>

        <ServersSection
          project={project}
          runtime={runtime}
          managedRefNames={refs.filter((r) => r.managed).map((r) => r.name)}
          onChanged={() => {
            onChanged(project.id);
            void loadDerived();
          }}
          onError={setError}
        />

        <ReferencesSection
          projectId={project.id}
          refs={refs}
          onChanged={() => {
            onChanged(project.id);
            void loadDerived();
          }}
          onError={setError}
        />

        <DirectoriesSection
          projectId={project.id}
          bindings={bindings}
          onChanged={() => {
            onChanged(project.id);
            void loadDerived();
          }}
          onError={setError}
        />

        <AccessSection
          project={project}
          endpoints={endpoints}
          onChanged={() => {
            onChanged(project.id);
            void loadDerived();
          }}
          onError={setError}
        />
      </div>

      {historyOpen && (
        <ProjectHistoryModal
          projectId={project.id}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => {
            // A rollback republishes the config, so the pane and its derived
            // views (runtime, references, endpoints) are all stale.
            onChanged(project.id);
            void loadDerived();
          }}
        />
      )}
    </div>
  );
}

/** A titled block in the detail pane. */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-2.5">
        <h3 className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">
          {title}
        </h3>
        <div className="flex-1" />
        {action}
      </div>
      <div
        style={{
          borderRadius: 14,
          background: "rgba(255,255,255,0.02)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
          padding: 14,
        }}
      >
        {children}
      </div>
    </section>
  );
}

/** A labelled row inside a {@link Section}. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start gap-4 py-2">
      <div style={{ width: 120, flexShrink: 0 }}>
        <div className="text-[12px] font-medium text-slate-300 mt-1.5">{label}</div>
      </div>
      <div className="flex-1 min-w-0">
        {children}
        {hint !== undefined && (
          <div className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">{hint}</div>
        )}
      </div>
    </div>
  );
}
