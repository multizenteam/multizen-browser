import { useCallback, useState, type JSX } from "react";
import { FolderOpen, FolderPlus, RefreshCw, Unlink } from "lucide-react";

import type {
  AgentInstallStateView,
  GatewayOpResult,
  WorkspaceBindingView,
} from "../../types";
import { Button } from "../atoms/Button";
import { Pill, confirm, type PillKind } from "../atoms";
import { AGENT_CHOICES, AgentPicker } from "./AgentPicker";
import { Section } from "./ProjectDetail";

/**
 * The local folders this project is installed into, and the agents configured in
 * each one.
 *
 * Every row states plainly which file Sekvona manages, whether that file is
 * currently up to date, and — when something went wrong — what to fix. Nothing
 * is written silently: a folder only receives entries for the agents selected
 * here, and unlinking removes Sekvona's entries before the folder is forgotten.
 */

export interface DirectoriesSectionProps {
  readonly projectId: string;
  readonly bindings: readonly WorkspaceBindingView[];
  readonly onChanged: () => void;
  readonly onError: (message: string | null) => void;
}

function statusPill(status: AgentInstallStateView["status"]): {
  kind: PillKind;
  text: string;
} {
  switch (status) {
    case "current":
      return { kind: "running", text: "up to date" };
    case "out-of-date":
      return { kind: "pending", text: "needs writing" };
    case "error":
      return { kind: "error", text: "failed" };
  }
}

export function DirectoriesSection({
  projectId,
  bindings,
  onChanged,
  onError,
}: DirectoriesSectionProps): JSX.Element {
  const [busy, setBusy] = useState(false);

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

  const addFolder = useCallback(async () => {
    const picked = await window.multizen.gateway.pickDirectory();
    if (picked === null) return;
    if (bindings.some((b) => b.directory === picked)) {
      onError("That folder is already linked to this project.");
      return;
    }
    // A freshly added folder installs nothing until an agent is chosen, so this
    // registers the folder with an empty selection and lets the operator pick.
    await run(() =>
      window.multizen.gateway.setDirectoryAgents(projectId, picked, []),
    );
  }, [bindings, onError, projectId, run]);

  const unlink = useCallback(
    async (directory: string) => {
      const confirmed = await confirm({
        title: "Unlink this folder?",
        body: `Sekvona will remove its entries from the agent configuration in ${directory}. Everything else in those files is left alone.`,
        confirmLabel: "Unlink folder",
        destructive: true,
      });
      if (!confirmed) return;
      await run(() => window.multizen.gateway.removeDirectory(projectId, directory));
    },
    [projectId, run],
  );

  return (
    <Section
      title={`Folders (${bindings.length})`}
      action={
        <div className="flex items-center gap-1.5">
          {bindings.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<RefreshCw size={12} />}
              disabled={busy}
              onClick={() =>
                void run(() => window.multizen.gateway.reconcileDirectories(projectId))
              }
            >
              Rewrite all
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<FolderPlus size={12} />}
            disabled={busy}
            onClick={() => void addFolder()}
          >
            Add folder
          </Button>
        </div>
      }
    >
      {bindings.length === 0 ? (
        <div className="text-[12px] text-slate-500 leading-relaxed">
          No folders linked. Add one and Sekvona will write this project’s endpoints into
          the agent configuration there, keeping everything else in those files intact.
        </div>
      ) : (
        <div className="space-y-2" data-testid="directory-list">
          {bindings.map((binding) => (
            <div
              key={binding.directory}
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(255,255,255,0.02)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="mono text-[11.5px] text-slate-300 truncate flex-1"
                  title={binding.directory}
                >
                  {binding.directory}
                </span>
                <button
                  type="button"
                  aria-label={`Reveal ${binding.directory}`}
                  title="Show in Finder"
                  disabled={busy}
                  onClick={() => void window.multizen.gateway.revealPath(binding.directory)}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.06] transition-colors disabled:opacity-40"
                >
                  <FolderOpen size={12} />
                </button>
                <button
                  type="button"
                  aria-label={`Unlink ${binding.directory}`}
                  title="Unlink this folder"
                  disabled={busy}
                  onClick={() => void unlink(binding.directory)}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-slate-500 hover:text-red-300 hover:bg-white/[0.06] transition-colors disabled:opacity-40"
                >
                  <Unlink size={12} />
                </button>
              </div>

              <AgentPicker
                selected={binding.agents.map((a) => a.agent)}
                namePrefix={binding.directory}
                disabled={busy}
                onChange={(agents) =>
                  void run(() =>
                    window.multizen.gateway.setDirectoryAgents(
                      projectId,
                      binding.directory,
                      agents,
                    ),
                  )
                }
              />

              {binding.agents.length === 0 ? (
                <div className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                  No agents selected, so nothing is written here yet.
                </div>
              ) : (
                <div className="space-y-1.5 mt-2.5">
                  {binding.agents.map((agent) => {
                    const pill = statusPill(agent.status);
                    const label =
                      AGENT_CHOICES.find((c) => c.kind === agent.agent)?.label ?? agent.agent;
                    return (
                      <div key={agent.agent} data-testid={`agent-row-${agent.agent}`}>
                        <div className="flex items-center gap-2">
                          <span className="text-[11.5px] text-slate-300" style={{ width: 92 }}>
                            {label}
                          </span>
                          <Pill kind={pill.kind}>{pill.text}</Pill>
                          <code className="mono text-[10.5px] text-slate-500 truncate flex-1">
                            {agent.configPath}
                          </code>
                          {agent.status !== "current" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                void run(() =>
                                  window.multizen.gateway.retryDirectoryAgent(
                                    projectId,
                                    binding.directory,
                                    agent.agent,
                                  ),
                                )
                              }
                            >
                              {agent.status === "error" ? "Retry" : "Write now"}
                            </Button>
                          )}
                        </div>
                        {agent.error !== undefined && (
                          <div className="text-[10.5px] text-red-300/90 mt-1 ml-[100px] leading-relaxed">
                            {agent.error}
                          </div>
                        )}
                        {agent.hint !== undefined && (
                          <div className="text-[10.5px] text-slate-500 mt-1 ml-[100px] leading-relaxed">
                            {agent.hint}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
