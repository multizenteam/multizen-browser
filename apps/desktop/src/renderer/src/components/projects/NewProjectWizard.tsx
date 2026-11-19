import { shortenProjectName, NEW_PROJECT_ID_LIMIT, PROJECT_NAME_LIMIT } from "../../../../main/mcp-gateway/projectNames";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { AlertTriangle, Check, FolderPlus, Plus, X } from "lucide-react";

import type {
  AgentKind,
  BindableProfileView,
  ProjectSetupInput,
  WorkspaceBindingInput,
} from "../../types";
import { Button } from "../atoms/Button";
import { Modal, Pill } from "../atoms";
import { cn } from "../../lib/cn";
import { AGENT_CHOICES, AgentPicker } from "./AgentPicker";
import {
  emptyServerDraft,
  ServerForm,
  serverDraftToInput,
  validateServerDraft,
  type ServerDraft,
} from "./ServerForm";

/**
 * Guided creation of a gateway project.
 *
 * Four steps — identity, browser profile, first server, folders — collected into
 * ONE `setupProject` call. The backend creates the project DISABLED, installs it
 * into the chosen folders, and only then enables it, so a half-configured project
 * can never serve endpoints or leave partial entries behind. When a folder's
 * agent write fails, the project still exists (disabled) and the failure is shown
 * per target for retry from the detail pane.
 */

export interface NewProjectWizardProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Called with the new project's id once setup completes. */
  readonly onCreated: (projectId: string) => void;
  /** Called after a browser profile was created from inside the wizard. */
  readonly onProfilesChanged?: () => void;
}

/**
 * Derive a safe project id from a display name: lower-case, non-id characters
 * collapsed to `-`, trimmed to the gateway's new-project id grammar.
 */
export function deriveProjectId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, NEW_PROJECT_ID_LIMIT)
    .replace(/[-_]+$/, "");
}

/** The gateway's id grammar: 1–24 chars of [a-z0-9_-]. */
export function isValidProjectId(id: string): boolean {
  return id.length <= NEW_PROJECT_ID_LIMIT && /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(id);
}

type StepId = "identity" | "profile" | "server" | "folders";

const STEPS: ReadonlyArray<{ id: StepId; title: string }> = [
  { id: "identity", title: "Name" },
  { id: "profile", title: "Browser" },
  { id: "server", title: "Server" },
  { id: "folders", title: "Folders" },
];

interface DirectoryDraft {
  readonly directory: string;
  readonly agents: readonly AgentKind[];
}

export function NewProjectWizard({
  open,
  onClose,
  onCreated,
  onProfilesChanged,
}: NewProjectWizardProps): JSX.Element {
  const [step, setStep] = useState<StepId>("identity");
  const [name, setName] = useState("");
  const [idOverride, setIdOverride] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<BindableProfileView[]>([]);
  const [addServer, setAddServer] = useState(false);
  const [serverDraft, setServerDraft] = useState<ServerDraft>(() => emptyServerDraft());
  const [directories, setDirectories] = useState<DirectoryDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Per-target install failures from a completed-but-imperfect setup. */
  const [installIssues, setInstallIssues] = useState<string[]>([]);

  const id = idOverride ?? deriveProjectId(name);

  const idError = useMemo(() => {
    if (id.length === 0) return "Enter a name, or set an id directly.";
    if (!isValidProjectId(id)) {
      return "An id may use only lower-case letters, digits, hyphens, and underscores.";
    }
    return null;
  }, [id]);

  const serverError = useMemo(
    () => (addServer ? validateServerDraft(serverDraft) : null),
    [addServer, serverDraft],
  );

  const reset = useCallback(() => {
    setStep("identity");
    setName("");
    setIdOverride(null);
    setProfileId(null);
    setAddServer(false);
    setServerDraft(emptyServerDraft());
    setDirectories([]);
    setError(null);
    setInstallIssues([]);
    setBusy(false);
  }, []);

  // Load bindable profiles when the wizard opens, so the exclusivity of each
  // profile is visible before the operator picks one.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.multizen.gateway.bindableProfiles().then((res) => {
      if (cancelled || !res.ok) return;
      setProfiles(res.value);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  /**
   * Create a browser profile without leaving the wizard and select it.
   *
   * Only a name is collected — the profile manager generates the fingerprint and
   * every other default, exactly as the onboarding path does. Proxy, tags, and
   * fingerprint tuning stay in Profiles, where there is room to explain them.
   *
   * Resolves to an error message, or `null` on success.
   */
  const createProfile = useCallback(async (profileName: string): Promise<string | null> => {
    const trimmed = profileName.trim();
    if (trimmed.length === 0) return "Give the profile a name.";
    try {
      const created = await window.multizen.profiles.create({ name: trimmed });
      const res = await window.multizen.gateway.bindableProfiles();
      setProfiles((current) => {
        const base = res.ok ? res.value : current;
        // A profile created a moment ago is bound to nothing, so if the refreshed
        // list somehow does not include it yet, show it anyway rather than
        // leaving the operator unable to pick what they just made.
        return base.some((p) => p.profileId === created.id)
          ? base
          : [...base, { profileId: created.id, name: created.name, available: true }];
      });
      setProfileId(created.id);
      onProfilesChanged?.();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Could not create the profile.";
    }
  }, [onProfilesChanged]);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const addDirectory = useCallback(async () => {
    const picked = await window.multizen.gateway.pickDirectory();
    if (picked === null) return;
    setDirectories((current) =>
      current.some((d) => d.directory === picked)
        ? current
        : [...current, { directory: picked, agents: [] }],
    );
  }, []);

  const submit = useCallback(async () => {
    if (idError !== null || serverError !== null) return;
    setBusy(true);
    setError(null);
    setInstallIssues([]);
    try {
      const input: ProjectSetupInput = {
        id,
        ...(name.trim().length > 0 ? { label: name.trim() } : {}),
        ...(profileId !== null ? { browserProfileId: profileId } : {}),
        ...(addServer ? { server: serverDraftToInput(serverDraft) } : {}),
        directories: directories
          // A folder with no agent selected installs nothing; keep it out of the
          // request rather than creating an inert binding.
          .filter((d) => d.agents.length > 0)
          .map<WorkspaceBindingInput>((d) => ({
            directory: d.directory,
            agents: [...d.agents],
          })),
        enableWhenReady: true,
      };
      const res = await window.multizen.gateway.setupProject(input);
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      // Setup succeeded, but a folder may still have failed to install. Report it
      // instead of silently presenting a partially-installed project as clean.
      const issues = res.value.reconcile.bindings.flatMap((b) =>
        b.agents
          .filter((a) => a.status === "error")
          .map(
            (a) =>
              `${AGENT_CHOICES.find((c) => c.kind === a.agent)?.label ?? a.agent} in ${
                b.directory
              }: ${a.error ?? "install failed"}`,
          ),
      );
      if (issues.length > 0) {
        setInstallIssues(issues);
        return;
      }
      const created = res.value.project.id;
      reset();
      onCreated(created);
    } finally {
      setBusy(false);
    }
  }, [
    addServer,
    directories,
    id,
    idError,
    name,
    onCreated,
    profileId,
    reset,
    serverDraft,
    serverError,
  ]);

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const isLast = stepIndex === STEPS.length - 1;
  const blocking =
    step === "identity" ? idError : step === "server" ? serverError : null;

  return (
    <Modal
      open={open}
      onClose={close}
      title="New project"
      subtitle="Group MCP servers, an optional browser profile, and the folders whose agents should see them."
      width={620}
      footer={
        installIssues.length > 0 ? (
          <>
            <Button variant="ghost" size="sm" onClick={close}>
              Close
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                // The project exists; open it so the operator can retry there.
                const created = id;
                reset();
                onCreated(created);
              }}
            >
              Open project
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
              Cancel
            </Button>
            {stepIndex > 0 && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setStep(STEPS[stepIndex - 1]!.id)}
              >
                Back
              </Button>
            )}
            {isLast ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void submit()}
                disabled={busy || idError !== null || serverError !== null}
              >
                {busy ? "Creating…" : "Create project"}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={blocking !== null}
                onClick={() => setStep(STEPS[stepIndex + 1]!.id)}
              >
                Continue
              </Button>
            )}
          </>
        )
      }
    >
      <div className="px-5 py-4">
        {/* step indicator */}
        <ol className="flex items-center gap-1.5 mb-4" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className="flex items-center gap-1.5">
              <span
                aria-current={s.id === step ? "step" : undefined}
                className={cn(
                  "text-[11px] font-medium",
                  s.id === step
                    ? "text-purple-200"
                    : i < stepIndex
                      ? "text-slate-400"
                      : "text-slate-600",
                )}
                style={{
                  height: 24,
                  padding: "0 9px",
                  borderRadius: 7,
                  display: "inline-flex",
                  alignItems: "center",
                  background: s.id === step ? "rgba(180,226,255,0.12)" : undefined,
                  boxShadow:
                    s.id === step ? "inset 0 0 0 1px rgba(180,226,255,0.25)" : undefined,
                }}
              >
                {i < stepIndex && <Check size={11} className="mr-1" />}
                {s.title}
              </span>
              {i < STEPS.length - 1 && <span className="text-slate-700">›</span>}
            </li>
          ))}
        </ol>

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

        {installIssues.length > 0 ? (
          <div
            role="alert"
            className="px-3 py-3 text-[12px] leading-relaxed"
            style={{
              borderRadius: 10,
              background: "rgba(245,158,11,0.06)",
              boxShadow: "inset 0 0 0 1px rgba(245,158,11,0.25)",
            }}
          >
            <div className="flex items-center gap-2 text-amber-200 font-medium mb-1.5">
              <AlertTriangle size={13} />
              Project created, but some folders need attention
            </div>
            <div className="text-slate-400 mb-2">
              It was left switched off so nothing is served from a partial setup. Fix the
              problems below and retry from the project’s Folders section.
            </div>
            <ul className="space-y-1">
              {installIssues.map((issue, i) => (
                <li key={i} className="mono text-[11px] text-amber-200/90">
                  {issue}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            {step === "identity" && (
              <IdentityStep
                name={name}
                id={id}
                idError={idError}
                onName={setName}
                onId={setIdOverride}
              />
            )}

            {step === "profile" && (
              <ProfileStep
                profiles={profiles}
                selected={profileId}
                onSelect={setProfileId}
                onCreate={createProfile}
              />
            )}

            {step === "server" && (
              <div>
                <p className="text-[12px] text-slate-400 leading-relaxed mb-3">
                  Add the project’s first MCP server now, or skip and add servers later. A
                  project with only a browser profile is perfectly valid.
                </p>
                <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={addServer}
                    onChange={(e) => setAddServer(e.target.checked)}
                    aria-label="Add a server now"
                    style={{ width: 13, height: 13, accentColor: "#a855f7" }}
                  />
                  <span className="text-[12px] text-slate-300">Add a server now</span>
                </label>
                {addServer && (
                  <>
                    {/* No project exists yet, so a test can only use the values
                        typed here — which is exactly what should be tested. */}
                    <ServerForm
                      draft={serverDraft}
                      projectId={id}
                      oauthProfileId={profileId}
                      onChange={setServerDraft}
                    />
                    {serverError !== null && (
                      <div className="text-[11px] text-red-300 mt-2" role="alert">
                        {serverError}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {step === "folders" && (
              <FoldersStep
                directories={directories}
                onAdd={() => void addDirectory()}
                onRemove={(dir) =>
                  setDirectories((c) => c.filter((d) => d.directory !== dir))
                }
                onAgents={(dir, agents) =>
                  setDirectories((c) =>
                    c.map((d) => (d.directory === dir ? { ...d, agents } : d)),
                  )
                }
              />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function IdentityStep({
  name,
  id,
  idError,
  onName,
  onId,
}: {
  name: string;
  id: string;
  idError: string | null;
  onName: (v: string) => void;
  onId: (v: string) => void;
}): JSX.Element {
  return (
    <div>
      <label className="block mb-4">
        <span className="block text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
          Name (max {PROJECT_NAME_LIMIT})
        </span>
        <input
          data-autofocus
          type="text"
          value={name}
          onChange={(e) => onName(shortenProjectName(e.target.value))}
          placeholder="Zabit"
          aria-label="Project name"
          className="w-full text-[13px] text-slate-200 outline-none"
          style={{
            height: 34,
            padding: "0 11px",
            borderRadius: 9,
            background: "rgba(0,0,0,0.25)",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
          }}
        />
      </label>

      <label className="block">
        <span className="block text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
          Id
        </span>
        <input
          type="text"
          maxLength={NEW_PROJECT_ID_LIMIT}
          value={id}
          onChange={(e) => onId(e.target.value)}
          aria-label="Project id"
          aria-invalid={idError !== null}
          className="w-full mono text-[12.5px] text-slate-200 outline-none"
          style={{
            height: 34,
            padding: "0 11px",
            borderRadius: 9,
            background: "rgba(0,0,0,0.25)",
            boxShadow: `inset 0 0 0 1px ${
              idError !== null ? "rgba(239,68,68,0.35)" : "rgba(255,255,255,0.06)"
            }`,
          }}
        />
        <span className="block text-[11px] text-slate-500 mt-1.5 leading-relaxed">
          {idError ??
            "Used in endpoint URLs and in the entry names written into agent configuration. It cannot be changed later."}
        </span>
      </label>
    </div>
  );
}

function ProfileStep({
  profiles,
  selected,
  onSelect,
  onCreate,
}: {
  profiles: readonly BindableProfileView[];
  selected: string | null;
  onSelect: (v: string | null) => void;
  onCreate: (name: string) => Promise<string | null>;
}): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const create = useCallback(async () => {
    setBusy(true);
    setCreateError(null);
    try {
      const message = await onCreate(newName);
      if (message !== null) {
        setCreateError(message);
        return;
      }
      // Success selects the new profile upstream; collapse the form so the
      // selection is what the operator sees.
      setCreating(false);
      setNewName("");
    } finally {
      setBusy(false);
    }
  }, [newName, onCreate]);

  return (
    <div>
      <p className="text-[12px] text-slate-400 leading-relaxed mb-3">
        Binding a browser profile adds a profile-scoped browser endpoint to this project.
        A profile belongs to at most one project.
      </p>
      <div className="space-y-1.5" role="radiogroup" aria-label="Browser profile">
        <ProfileOption
          label="No browser profile"
          detail="Add one later if you need browser control."
          checked={selected === null}
          onSelect={() => onSelect(null)}
        />
        {profiles.map((p) => (
          <ProfileOption
            key={p.profileId}
            label={p.name}
            detail={
              p.available
                ? p.profileId
                : `Already bound to “${p.boundToProjectId ?? "another project"}”`
            }
            checked={selected === p.profileId}
            disabled={!p.available}
            onSelect={() => onSelect(p.profileId)}
          />
        ))}
        {profiles.length === 0 && (
          <div className="text-[11px] text-slate-500 px-1">
            No browser profiles exist yet — create one below, or skip this step.
          </div>
        )}
      </div>

      <div className="mt-3">
        {creating ? (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: "rgba(255,255,255,0.02)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
            }}
          >
            <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
              New browser profile
            </div>
            <div className="flex items-center gap-2">
              <input
                autoFocus
                type="text"
                value={newName}
                disabled={busy}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (!busy) void create();
                  }
                }}
                placeholder="zabit.ai"
                aria-label="New profile name"
                className="flex-1 min-w-0 text-[12.5px] text-slate-200 outline-none disabled:opacity-50"
                style={{
                  height: 32,
                  padding: "0 10px",
                  borderRadius: 8,
                  background: "rgba(0,0,0,0.25)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                }}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={busy || newName.trim().length === 0}
                onClick={() => void create()}
              >
                {busy ? "Creating…" : "Create"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                  setCreateError(null);
                }}
              >
                Cancel
              </Button>
            </div>
            {createError !== null && (
              <div className="text-[11px] text-red-300 mt-2" role="alert">
                {createError}
              </div>
            )}
            <div className="text-[10.5px] text-slate-500 mt-2 leading-relaxed">
              A fresh profile is created with a generated fingerprint and no proxy, and is
              bound to this project. Tune it later in Profiles.
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Plus size={13} />}
            onClick={() => {
              setCreateError(null);
              setCreating(true);
            }}
          >
            New profile
          </Button>
        )}
      </div>
    </div>
  );
}

function ProfileOption({
  label,
  detail,
  checked,
  disabled,
  onSelect,
}: {
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <label
      className={cn(
        "flex items-center gap-2.5 select-none",
        disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
      )}
      style={{
        padding: "8px 10px",
        borderRadius: 9,
        background: checked ? "rgba(180,226,255,0.10)" : "rgba(255,255,255,0.02)",
        boxShadow: checked
          ? "inset 0 0 0 1px rgba(180,226,255,0.22)"
          : "inset 0 0 0 1px rgba(255,255,255,0.05)",
      }}
    >
      <input
        type="radio"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        aria-label={label}
        style={{ width: 13, height: 13, accentColor: "#a855f7" }}
      />
      <span className="flex-1 min-w-0">
        <span className="block text-[12.5px] text-slate-200 truncate">{label}</span>
        <span className="block mono text-[10.5px] text-slate-500 truncate">{detail}</span>
      </span>
      {disabled === true && <Pill kind="idle">in use</Pill>}
    </label>
  );
}

function FoldersStep({
  directories,
  onAdd,
  onRemove,
  onAgents,
}: {
  directories: readonly DirectoryDraft[];
  onAdd: () => void;
  onRemove: (directory: string) => void;
  onAgents: (directory: string, agents: AgentKind[]) => void;
}): JSX.Element {
  return (
    <div>
      <p className="text-[12px] text-slate-400 leading-relaxed mb-3">
        Choose the folders whose coding agents should see this project’s servers. Sekvona
        merges its entries into each selected agent’s configuration and leaves everything
        else in those files alone.
      </p>
      <Button
        size="sm"
        variant="secondary"
        leftIcon={<FolderPlus size={13} />}
        onClick={onAdd}
      >
        Add folder
      </Button>

      {directories.length === 0 ? (
        <div className="text-[11px] text-slate-500 mt-3 leading-relaxed">
          No folders yet — that’s fine. You can add them any time from the project’s Folders
          section.
        </div>
      ) : (
        <div className="space-y-2 mt-3">
          {directories.map((d) => (
            <div
              key={d.directory}
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(255,255,255,0.02)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)",
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="mono text-[11px] text-slate-300 truncate flex-1"
                  title={d.directory}
                >
                  {d.directory}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(d.directory)}
                  aria-label={`Remove ${d.directory}`}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-slate-500 hover:text-red-300 hover:bg-white/[0.06] transition-colors"
                >
                  <X size={12} />
                </button>
              </div>
              <AgentPicker
                selected={d.agents}
                namePrefix={d.directory}
                onChange={(agents) => onAgents(d.directory, agents)}
              />
              {d.agents.length === 0 && (
                <div className="text-[10.5px] text-slate-500 mt-1.5">
                  Select at least one agent, or remove this folder.
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
