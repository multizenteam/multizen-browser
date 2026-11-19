/**
 * Installs a project's gateway endpoints into the agent configuration files of
 * each local directory the operator associated with it.
 *
 * This is the layer that turns "this project has these enabled endpoints" plus
 * "this directory uses Cursor and Codex" into verified writes, using the
 * hardened {@link ConfigFileTransactor} and the per-agent adapters. It owns no
 * durable state of its own: directory associations, agent selections, and
 * ownership records all live in {@link WorkspaceBindingStore}.
 *
 * Failure isolation is deliberate. One agent's malformed file, permission
 * problem, or unowned-name collision records an error for THAT
 * directory+agent pair and leaves every other pair installed and current. The
 * operator sees exactly which target failed, why, and what to do, and can retry
 * that one target.
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";

import {
  adapterFor,
  type DesiredEndpoint,
} from "./agentAdapters.ts";
import {
  canonicalizeWorkspace,
  ConfigFileError,
  ConfigFileTransactor,
  resolveTargetPath,
} from "./ConfigFileTransactor.ts";
import type { AgentState, Binding, WorkspaceBindingStore } from "./WorkspaceBindingStore.ts";
import type {
  AgentInstallStateView,
  AgentKind,
  ReconcileResultView,
  WorkspaceBindingView,
} from "./types.ts";

/** Stable fingerprint of a desired endpoint set, for out-of-date detection. */
export function hashDesired(desired: readonly DesiredEndpoint[]): string {
  const canonical = [...desired]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((e) => `${e.key}\u0000${e.url}\u0000${e.authEnvName ?? ""}`)
    .join("\u0001");
  // A short, stable digest is enough; this is a change detector, not a secret.
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${canonical.length.toString(36)}-${h.toString(16)}`;
}

/** One directory+agent pair that failed to install. */
export interface InstallFailure {
  readonly directory: string;
  readonly agent: AgentKind;
  readonly message: string;
  readonly hint?: string;
}

export interface AgentConfigManagerDeps {
  readonly workspaces: WorkspaceBindingStore;
  readonly transactor: ConfigFileTransactor;
  /**
   * The endpoints that should exist for a project right now. Returns an empty
   * array for a disabled, quarantined, or unknown project, which uninstalls.
   */
  readonly desiredFor: (projectId: string) => readonly DesiredEndpoint[];
  readonly now?: () => number;
}

export class AgentConfigManager {
  private readonly now: () => number;

  constructor(private readonly deps: AgentConfigManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ── directory association ───────────────────────────────────────────────

  /**
   * Associate a directory with a project and set the agents it should install.
   *
   * The path is canonicalized first, so the same directory reached by two
   * spellings (or through a symlink) can never produce two bindings. Agents
   * removed from the selection have their owned entries UNINSTALLED before the
   * selection is forgotten, so nothing is orphaned in a file we stop tracking.
   */
  async setDirectoryAgents(
    projectId: string,
    directory: string,
    agents: readonly AgentKind[],
  ): Promise<WorkspaceBindingView> {
    const canonical = await canonicalizeWorkspace(directory);
    const { removed } = await this.deps.workspaces.setAgents(projectId, canonical, agents);

    // Clean up de-selected agents first. A failure here is reported but does not
    // block the new selection from installing; the operator is told which file
    // still holds Sekvona entries.
    const cleanupFailures: InstallFailure[] = [];
    for (const row of removed) {
      const failure = await this.uninstallOne(projectId, canonical, row);
      if (failure) cleanupFailures.push(failure);
    }

    const view = await this.installDirectory(projectId, canonical);
    if (cleanupFailures.length > 0) {
      // Surface the cleanup problem on the agents that are still selected is
      // wrong; instead re-add a row-less error entry is not representable. Throw
      // only when nothing installed, otherwise the view already tells the story.
      if (view.agents.length === 0) {
        const first = cleanupFailures[0] as InstallFailure;
        throw new ConfigFileError(
          `could not remove Sekvona entries from ${first.agent}: ${first.message}`,
          "io",
          first.hint,
        );
      }
    }
    return view;
  }

  /**
   * Resolve an incoming directory string to the key a binding is stored under.
   *
   * Bindings are keyed by canonical path, but a caller may pass a non-canonical
   * spelling (or a path whose directory has since been removed). Try the literal
   * value first, then its canonical form. Returns null when no binding matches.
   */
  private async storedDirectory(
    projectId: string,
    directory: string,
  ): Promise<string | null> {
    if (this.deps.workspaces.get(projectId, directory)) return directory;
    try {
      const real = await fs.realpath(directory);
      if (this.deps.workspaces.get(projectId, real)) return real;
    } catch {
      // The directory is gone; only a literal match could have applied.
    }
    return null;
  }

  /**
   * Forget a directory after removing every Sekvona entry it holds.
   *
   * If a file cannot be cleaned the binding is KEPT and the failure is thrown,
   * so the operator can fix the file and retry rather than silently leaving our
   * entries behind in a directory we no longer track.
   */
  async removeDirectory(projectId: string, directory: string): Promise<void> {
    const key = await this.storedDirectory(projectId, directory);
    if (key === null) return;
    const binding = this.deps.workspaces.get(projectId, key);
    if (!binding) return;
    const failures: InstallFailure[] = [];
    for (const row of binding.agents) {
      const failure = await this.uninstallOne(projectId, key, row);
      if (failure) failures.push(failure);
    }
    if (failures.length > 0) {
      const first = failures[0] as InstallFailure;
      throw new ConfigFileError(
        `could not remove Sekvona entries from ${first.agent}: ${first.message}`,
        "io",
        first.hint ??
          "Fix the reported problem and unlink again, or remove the multizen_* entries by hand.",
      );
    }
    await this.deps.workspaces.removeBinding(projectId, key);
  }

  // ── reconciliation ──────────────────────────────────────────────────────

  /** Install the project's current endpoints into every associated directory. */
  async reconcileProject(projectId: string): Promise<ReconcileResultView> {
    const bindings = this.deps.workspaces.listForProject(projectId);
    const views: WorkspaceBindingView[] = [];
    for (const binding of bindings) {
      views.push(await this.installDirectory(projectId, binding.directory));
    }
    return {
      projectId,
      allCurrent: views.every((b) => b.agents.every((a) => a.status === "current")),
      bindings: views,
    };
  }

  /** Retry one directory+agent pair after the operator fixed the cause. */
  async retry(
    projectId: string,
    directory: string,
    agent: AgentKind,
  ): Promise<WorkspaceBindingView> {
    const key = await this.storedDirectory(projectId, directory);
    if (key === null) {
      throw new ConfigFileError(`${directory} is not associated with this project`, "not-found");
    }
    const binding = this.deps.workspaces.get(projectId, key);
    const row = binding?.agents.find((a) => a.agent === agent);
    if (row) {
      await this.installOne(projectId, key, row, this.deps.desiredFor(projectId));
    }
    return this.viewFor(projectId, key);
  }

  /**
   * Remove every Sekvona entry this project owns, across all its directories.
   * Returns the failures rather than throwing, so a caller (project deletion)
   * can decide whether to proceed.
   */
  async uninstallProject(projectId: string): Promise<InstallFailure[]> {
    const failures: InstallFailure[] = [];
    for (const binding of this.deps.workspaces.listForProject(projectId)) {
      for (const row of binding.agents) {
        const failure = await this.uninstallOne(projectId, binding.directory, row);
        if (failure) failures.push(failure);
      }
    }
    return failures;
  }

  /** Forget every binding of a project (after a successful uninstall). */
  async forgetProject(projectId: string): Promise<void> {
    await this.deps.workspaces.removeProject(projectId);
  }

  // ── views ───────────────────────────────────────────────────────────────

  /** Current bindings + install state for a project. */
  async bindings(projectId: string): Promise<WorkspaceBindingView[]> {
    const out: WorkspaceBindingView[] = [];
    for (const binding of this.deps.workspaces.listForProject(projectId)) {
      out.push(await this.viewFor(projectId, binding.directory));
    }
    return out;
  }

  private async viewFor(projectId: string, directory: string): Promise<WorkspaceBindingView> {
    const binding = this.deps.workspaces.get(projectId, directory);
    if (!binding) return { projectId, directory, agents: [] };
    const desiredHash = hashDesired(this.deps.desiredFor(projectId));
    return {
      projectId,
      directory,
      agents: binding.agents.map((row) => this.agentView(directory, row, desiredHash)),
    };
  }

  /**
   * Project one stored agent row into a view. `status` is derived rather than
   * trusted: a row recorded as "current" whose desired set has since changed is
   * reported "out-of-date", so the UI never claims a stale file is up to date.
   */
  private agentView(
    directory: string,
    row: AgentState,
    desiredHash: string,
  ): AgentInstallStateView {
    const adapter = adapterFor(row.agent);
    const configPath = path.join(directory, ...adapter.relativePath);
    const status =
      row.status === "error"
        ? "error"
        : row.desiredHash === desiredHash
          ? "current"
          : "out-of-date";
    return {
      agent: row.agent,
      status,
      configPath,
      lastInstalledAt: row.lastInstalledAt,
      ...(row.error !== undefined ? { error: row.error } : {}),
      ...(row.hint !== undefined ? { hint: row.hint } : {}),
    };
  }

  // ── one directory / one agent ───────────────────────────────────────────

  private async installDirectory(
    projectId: string,
    directory: string,
  ): Promise<WorkspaceBindingView> {
    const binding = this.deps.workspaces.get(projectId, directory);
    if (!binding) return { projectId, directory, agents: [] };
    const desired = this.deps.desiredFor(projectId);
    for (const row of binding.agents) {
      await this.installOne(projectId, directory, row, desired);
    }
    return this.viewFor(projectId, directory);
  }

  /** Write (or clear) one agent's file, recording the outcome either way. */
  private async installOne(
    projectId: string,
    directory: string,
    row: AgentState,
    desired: readonly DesiredEndpoint[],
  ): Promise<void> {
    const adapter = adapterFor(row.agent);
    try {
      const workspace = await canonicalizeWorkspace(directory);
      const target = await resolveTargetPath(workspace, adapter.relativePath);
      const result = await this.deps.transactor.apply(target, (current) =>
        adapter.render({
          projectId,
          current,
          desired,
          ownedKeys: row.ownedKeys,
        }),
      );
      await this.deps.workspaces.updateAgentState(projectId, directory, row.agent, {
        // Ownership now reflects exactly what we just wrote.
        ownedKeys: desired.map((d) => d.key),
        desiredHash: hashDesired(desired),
        fileHash: result.fileHash,
        lastInstalledAt: this.now(),
        status: "current",
        error: undefined,
        // A successful write can still need an operator step in the agent.
        hint: desired.length > 0 ? adapter.postInstallHint : undefined,
      });
    } catch (err) {
      const { message, hint } = describe(err);
      await this.deps.workspaces.updateAgentState(projectId, directory, row.agent, {
        status: "error",
        error: message,
        ...(hint !== undefined ? { hint } : { hint: undefined }),
      });
    }
  }

  /**
   * Clear this project's entries from one agent file. Returns a failure record
   * instead of throwing so callers can aggregate across many targets.
   */
  private async uninstallOne(
    projectId: string,
    directory: string,
    row: AgentState,
  ): Promise<InstallFailure | null> {
    // Nothing was ever written for this agent: nothing to clean up.
    if (row.ownedKeys.length === 0) return null;
    const adapter = adapterFor(row.agent);
    try {
      const workspace = await canonicalizeWorkspace(directory);
      const target = await resolveTargetPath(workspace, adapter.relativePath);
      await this.deps.transactor.apply(target, (current) =>
        adapter.render({ projectId, current, desired: [], ownedKeys: row.ownedKeys }),
      );
      await this.deps.workspaces.updateAgentState(projectId, directory, row.agent, {
        ownedKeys: [],
        desiredHash: null,
        fileHash: null,
        status: "out-of-date",
        error: undefined,
        hint: undefined,
      });
      return null;
    } catch (err) {
      // A directory that no longer exists cannot hold our entries, so treat it
      // as cleaned rather than blocking the operator forever.
      if (err instanceof ConfigFileError && err.code === "not-found") {
        await this.deps.workspaces.updateAgentState(projectId, directory, row.agent, {
          ownedKeys: [],
          desiredHash: null,
          fileHash: null,
          status: "out-of-date",
          error: undefined,
          hint: undefined,
        });
        return null;
      }
      const { message, hint } = describe(err);
      await this.deps.workspaces.updateAgentState(projectId, directory, row.agent, {
        status: "error",
        error: message,
        ...(hint !== undefined ? { hint } : { hint: undefined }),
      });
      return {
        directory,
        agent: row.agent,
        message,
        ...(hint !== undefined ? { hint } : {}),
      };
    }
  }
}

/** Bounded, secret-free message + hint for any thrown failure. */
function describe(err: unknown): { message: string; hint?: string } {
  if (err instanceof ConfigFileError) {
    return {
      message: err.message.slice(0, 300),
      ...(err.hint !== undefined ? { hint: err.hint } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { message: message.slice(0, 300) };
}

export type { Binding };
