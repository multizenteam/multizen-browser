import { shortenProjectName } from "../../../../main/mcp-gateway/projectNames";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { FolderTree, Plus, RefreshCw, Search } from "lucide-react";

import type { ProjectView } from "../../types";
import { Button } from "../atoms/Button";
import { Pill } from "../atoms";
import { cn } from "../../lib/cn";
import { ProjectDetail } from "./ProjectDetail";
import { NewProjectWizard } from "./NewProjectWizard";
import { SyncStatusRow } from "./SyncStatusRow";

/**
 * The Projects screen: a searchable project list on the left, the selected
 * project's editor on the right.
 *
 * A gateway "project" bundles upstream MCP servers, an optional exclusive
 * browser-profile binding, and the local directories whose agent configuration
 * Sekvona keeps in sync. This screen is the only place that composition is
 * edited; browser-profile settings stay in the Profiles screen.
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; projects: ProjectView[] };

export interface ProjectsScreenProps {
  /**
   * Called when this screen created a browser profile, so the app's profile list
   * (owned by App, not refetched on renderer-local writes) stops being stale.
   */
  readonly onProfilesChanged?: () => void;
}

export function ProjectsScreen({
  onProfilesChanged,
}: ProjectsScreenProps = {}): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);

  const load = useCallback(async (): Promise<ProjectView[] | null> => {
    const res = await window.multizen.gateway.listProjects();
    if (!res.ok) {
      setState({ kind: "error", message: res.error.message });
      return null;
    }
    const projects = [...res.value].sort((a, b) =>
      (a.label ?? a.id).localeCompare(b.label ?? b.id),
    );
    setState({ kind: "ready", projects });
    return projects;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Re-read the list after a mutation, keeping the selection if it still exists. */
  const refresh = useCallback(
    async (preferId?: string) => {
      const projects = await load();
      if (projects === null) return;
      setSelectedId((current) => {
        const wanted = preferId ?? current;
        if (wanted !== null && projects.some((p) => p.id === wanted)) return wanted;
        return null;
      });
    },
    [load],
  );

  const projects = state.kind === "ready" ? state.projects : [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return projects;
    return projects.filter(
      (p) =>
        p.id.toLowerCase().includes(q) || (p.label ?? "").toLowerCase().includes(q),
    );
  }, [projects, query]);

  const selected = projects.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex-1 flex min-h-0" data-testid="projects-screen">
      {/* ── list pane ─────────────────────────────────────────────────────── */}
      <div
        className="flex flex-col flex-shrink-0 min-h-0"
        style={{
          width: 280,
          borderRight: "1px solid rgba(255,255,255,0.05)",
          background: "rgba(255,255,255,0.012)",
        }}
      >
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[13px] font-semibold text-slate-100">Projects</div>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Plus size={13} />}
              onClick={() => setWizardOpen(true)}
            >
              New
            </Button>
          </div>
          <label className="relative block">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
              className="w-full text-[12px] text-slate-200 outline-none"
              style={{
                height: 30,
                paddingLeft: 28,
                paddingRight: 10,
                borderRadius: 8,
                background: "rgba(0,0,0,0.25)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
              }}
            />
          </label>
        </div>

        <div className="flex-1 overflow-auto px-2 pb-3">
          {state.kind === "loading" && (
            <div className="px-2 py-3 text-[12px] text-slate-500" role="status">
              Loading projects…
            </div>
          )}

          {state.kind === "error" && (
            <div
              className="mx-2 p-3 text-[12px] text-red-300"
              role="alert"
              style={{
                borderRadius: 10,
                background: "rgba(239,68,68,0.06)",
                boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.25)",
              }}
            >
              <div className="font-medium mb-1">Couldn’t load projects</div>
              <div className="text-red-200/80 leading-relaxed">{state.message}</div>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                leftIcon={<RefreshCw size={12} />}
                onClick={() => {
                  setState({ kind: "loading" });
                  void load();
                }}
              >
                Try again
              </Button>
            </div>
          )}

          {state.kind === "ready" && projects.length === 0 && (
            <div className="px-3 py-6 text-center">
              <FolderTree size={22} className="mx-auto text-slate-600" strokeWidth={1.5} />
              <div className="text-[12px] font-semibold text-slate-200 mt-2">
                No projects yet
              </div>
              <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                A project groups MCP servers, an optional browser profile, and the
                folders whose agents should see them.
              </div>
              <Button
                size="sm"
                variant="primary"
                className="mt-3"
                leftIcon={<Plus size={13} />}
                onClick={() => setWizardOpen(true)}
              >
                New project
              </Button>
            </div>
          )}

          {state.kind === "ready" && projects.length > 0 && filtered.length === 0 && (
            <div className="px-3 py-4 text-[12px] text-slate-500">
              No project matches “{query.trim()}”.
            </div>
          )}

          {filtered.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              active={p.id === selectedId}
              onSelect={() => setSelectedId(p.id)}
            />
          ))}
        </div>

        <SyncStatusRow onSynced={() => void refresh()} />
      </div>

      {/* ── detail pane ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 min-h-0 overflow-auto">
        {selected === null ? (
          <div className="h-full flex items-center justify-center p-8">
            <div className="text-center max-w-[44ch]">
              <FolderTree size={26} className="mx-auto text-slate-600" strokeWidth={1.5} />
              <div className="text-[13px] font-semibold text-slate-200 mt-3">
                {projects.length === 0 ? "Create your first project" : "Select a project"}
              </div>
              <div className="text-[12px] text-slate-500 mt-1.5 leading-relaxed">
                {projects.length === 0
                  ? "Sekvona will write the project’s MCP endpoints into the agent configuration of every folder you choose."
                  : "Pick a project on the left to edit its servers, folders, and access."}
              </div>
            </div>
          </div>
        ) : (
          <ProjectDetail
            key={selected.id}
            project={selected}
            onChanged={(id) => void refresh(id)}
            onDeleted={() => {
              setSelectedId(null);
              void refresh();
            }}
          />
        )}
      </div>

      <NewProjectWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        {...(onProfilesChanged !== undefined ? { onProfilesChanged } : {})}
        onCreated={(id) => {
          setWizardOpen(false);
          void refresh(id);
        }}
      />
    </div>
  );
}

function ProjectRow({
  project,
  active,
  onSelect,
}: {
  project: ProjectView;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  const serverCount = project.servers.length;
  const enabledCount = project.servers.filter((s) => !s.disabled).length;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "w-full text-left transition-colors mb-0.5",
        active ? "text-slate-100" : "text-slate-300 hover:bg-white/[0.03]",
      )}
      style={{
        padding: "8px 10px",
        borderRadius: 9,
        background: active ? "rgba(180,226,255,0.10)" : undefined,
        boxShadow: active ? "inset 0 0 0 1px rgba(180,226,255,0.22)" : undefined,
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium truncate flex-1">
          {shortenProjectName(project.label ?? project.id)}
        </span>
        {project.enabled ? (
          <Pill kind="running">on</Pill>
        ) : (
          <Pill kind="idle">off</Pill>
        )}
      </div>
      <div className="mono text-[10px] text-slate-500 mt-1 flex items-center gap-1.5 flex-wrap">
        <span>{project.id}</span>
        <span aria-hidden>·</span>
        <span>
          {enabledCount}/{serverCount} {serverCount === 1 ? "server" : "servers"}
        </span>
        {project.browserProfileId !== undefined && (
          <>
            <span aria-hidden>·</span>
            <span title={`Bound to browser profile ${project.browserProfileId}`}>browser</span>
          </>
        )}
        {project.localAuth.enabled && (
          <>
            <span aria-hidden>·</span>
            <span>auth</span>
          </>
        )}
      </div>
    </button>
  );
}
