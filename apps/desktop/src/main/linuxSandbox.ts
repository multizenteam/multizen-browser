import { app } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LinuxSandboxState } from "@multizen/settings-store";
import type { SandboxStatus, SandboxUiState } from "@multizen/types";

export type { SandboxStatus, SandboxUiState };

/**
 * Linux AppArmor sandbox manager.
 *
 * On kernels that restrict unprivileged user namespaces (Ubuntu 24.04+ by
 * default) the Chromium engine cannot start its sandbox and dies with "No
 * usable sandbox!". The proper fix (keeping the sandbox ON, no "unsupported
 * flag" banner) is a per-binary AppArmor profile that re-permits `userns` for
 * only the engine binary, installed once via a single pkexec elevation. When
 * that can't be done (declined, no polkit, too-old AppArmor, no window), we
 * fall back to launching with `--no-sandbox` so the profile always launches.
 *
 * This module owns detection, live verification, the elevated install, and the
 * per-launch decision. Everything OS-specific is Linux-gated; on macOS/Windows
 * `resolveForLaunch` returns `{ noSandbox: false }` before touching anything.
 *
 * Prompting and settings persistence are injected (see LinuxSandboxDeps) so the
 * module stays free of electron `dialog` / the settings store and its pure
 * helpers stay unit-testable.
 */

export const PROFILE_NAME = "multizen-cloakbrowser";
export const PROFILE_FILE = `/etc/apparmor.d/${PROFILE_NAME}`;

/** Why the secure setup could not be completed (surfaced to the user). */
export type SetupFailureReason =
  | "cancelled" // user dismissed the polkit prompt (pkexec 126)
  | "unauthorized" // auth failed / not permitted / no polkit agent (pkexec 127)
  | "no-pkexec" // pkexec not installed
  | "unsupported" // AppArmor unavailable or too old to accept the rule
  | "engine-path-unmanaged" // engine binary not under the managed cache dir
  | "no-script" // the packaged installer script is missing
  | "failed"; // write/load error reported by the script

export interface SandboxDecision {
  /** True → add `--no-sandbox` to the engine's argv for this launch. */
  noSandbox: boolean;
}

// SandboxStatus / SandboxUiState are the cross-process DTO, defined in
// @multizen/types and re-exported above. State meanings: "n/a" = not Linux or
// not the AppArmor mechanism; "not-restricted" = Linux, userns not restricted;
// "active" = profile verified loaded for the current binary; "needs-setup" =
// restricted + not yet set up + not declined; "declined"/"unsupported" as named.

/** Plain-language explanation of a setup failure (shared by the main dialog and
 *  the Settings row, so both read identically). */
export function describeSandboxReason(reason: SetupFailureReason): string {
  switch (reason) {
    case "cancelled":
      return "The authorization prompt was dismissed.";
    case "unauthorized":
      return "The system authorization was not granted.";
    case "no-pkexec":
      return "pkexec (polkit) is not installed, so the one-time authorization can't be requested.";
    case "unsupported":
      return "This system's AppArmor is unavailable or too old to accept the sandbox rule.";
    case "engine-path-unmanaged":
      return "The browser engine is not in its managed location, so the sandbox rule can't target it.";
    case "no-script":
      return "The sandbox installer was not found in this build.";
    case "failed":
      return "The sandbox setup did not complete.";
  }
}

/** Shown in the two-option setup prompt. */
export interface SetupPromptInfo {
  profileName: string;
}

/** Shown in the one-option informational dialog (unsupported / failure). */
export interface SandboxNotice {
  reason: SetupFailureReason;
  manualCommand: string;
}

export interface LinuxSandboxDeps {
  /** Read the persisted state (from the settings store). */
  getState: () => LinuxSandboxState;
  /** Persist the state (into the settings store). */
  setState: (state: LinuxSandboxState) => Promise<void>;
  /**
   * Present the two-option setup choice. Resolves "setup" or "no-sandbox".
   * Only called when a window is available.
   */
  promptSetup: (info: SetupPromptInfo) => Promise<"setup" | "no-sandbox">;
  /** Surface a one-off informational notice (reason + manual alternative). */
  showNotice: (notice: SandboxNotice) => Promise<void>;
  /** Whether a window is available to show a dialog right now. */
  hasWindow: () => boolean;
}

// ── Pure helpers (Linux detection + profile math) ──────────────────────────

/** Read a `/proc/sys/...` knob; null when the kernel doesn't expose it. */
export function readSysctl(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

export type RestrictionMechanism = "apparmor" | "clone" | "none";

/**
 * Which lever (if any) restricts unprivileged user namespaces. The clone lever
 * is checked FIRST: when it is off, an AppArmor profile cannot help (and if both
 * are set, the profile would still be blocked), so we fall back rather than
 * wastefully installing one.
 */
export function detectMechanism(): RestrictionMechanism {
  if (process.platform !== "linux") return "none";
  if (readSysctl("/proc/sys/kernel/unprivileged_userns_clone") === "0") return "clone";
  if (readSysctl("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1") {
    return "apparmor";
  }
  return "none";
}

/** Whether the AppArmor LSM is active on this host. */
export function isApparmorEnabled(): boolean {
  return readSysctl("/sys/module/apparmor/parameters/enabled") === "Y";
}

/** Whether `cmd` is resolvable on PATH (no execution). */
export function hasExecutable(cmd: string): boolean {
  const dirs = (process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin").split(delimiter);
  return dirs.some((d) => d && existsSync(join(d, cmd)));
}

/** The engine binary cache root: `<userData>/chromium/cloakbrowser`. */
export function cacheDirForEngine(): string {
  return join(app.getPath("userData"), "chromium", "cloakbrowser");
}

/** The AppArmor attach path: a version-glob over the engine cache. */
export function attachPathForCache(cacheDir: string): string {
  return join(cacheDir, "**", "chrome");
}

/** Canonical profile text. Must match the installer script's template exactly. */
export function buildProfileText(attachPath: string): string {
  return [
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    `profile ${PROFILE_NAME} ${attachPath} flags=(unconfined) {`,
    "  userns,",
    "}",
  ].join("\n");
}

/** The manual `sudo` alternative shown when automatic setup can't run. */
export function buildManualCommand(attachPath: string): string {
  const body = buildProfileText(attachPath).replace(/'/g, `'\\''`);
  return `printf '%s\\n' '${body}' | sudo tee ${PROFILE_FILE} >/dev/null && sudo apparmor_parser -r ${PROFILE_FILE}`;
}

/** Map a pkexec/script exit to a failure reason. */
export function mapSetupExit(code: number | null): SetupFailureReason {
  switch (code) {
    case 126:
      return "cancelled";
    case 127:
      return "unauthorized";
    case 11:
      return "unsupported";
    default:
      return "failed";
  }
}

// ── Live verification ──────────────────────────────────────────────────────

/**
 * Whether the secure setup is ACTUALLY active for `binaryPath` right now,
 * verified against live OS state (never a persisted flag). The profile file
 * must exist and attach to the current engine's cache tree; when the kernel's
 * loaded-profile list is readable we also require the profile to be loaded.
 * The crash-detection backstop in the driver covers any residual "file present
 * but not loaded" case, so this stays a non-root best-effort check.
 */
export function verifyActive(binaryPath: string, cacheDir: string): boolean {
  if (!existsSync(PROFILE_FILE)) return false;
  // The binary must live under the cache tree the profile grants userns to.
  if (!binaryPath.startsWith(cacheDir + "/")) return false;
  let fileText: string;
  try {
    fileText = readFileSync(PROFILE_FILE, "utf8");
  } catch {
    return false;
  }
  if (!fileText.includes(`profile ${PROFILE_NAME} ${attachPathForCache(cacheDir)} `)) {
    return false;
  }
  // If the loaded-profile list is readable, require the profile to be loaded.
  const loaded = readSysctl("/sys/kernel/security/apparmor/profiles");
  if (loaded !== null && !loaded.split("\n").some((l) => l.startsWith(PROFILE_NAME))) {
    return false;
  }
  return true;
}

// ── Elevated install (pkexec) ──────────────────────────────────────────────

/**
 * Packaged/dev path to the static installer script. pkexec runs this path as
 * root, so its directory must not be attacker-writable. This holds for our
 * shipped AppImage (read-only squashfs mount) and would hold for a root-owned
 * .deb/.rpm install; an extracted-then-run AppImage or dev tree is NOT a
 * trusted location for the elevated path. We ship AppImage only today.
 */
function resolveScriptPath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "linux-sandbox", "install-apparmor-profile.sh")]
    : [
        // import.meta.url -> out/main/index.js at runtime -> up to apps/desktop,
        // then resources/linux. (The packaged dir is named linux-sandbox, the
        // dev dir resources/linux: asymmetric on purpose, see builder config.)
        join(
          fileURLToPath(new URL(".", import.meta.url)),
          "../../resources/linux/install-apparmor-profile.sh",
        ),
      ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Whether `apparmor_parser -Q -K` accepts the rule (no root, no kernel load). */
async function parserAcceptsRule(profileText: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    try {
      const p = spawn("apparmor_parser", ["-Q", "-K"], { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", () => finish(false));
      p.on("close", (code) => finish(code === 0));
      p.stdin.on("error", () => finish(false));
      p.stdin.end(profileText);
      timer = setTimeout(() => {
        p.kill();
        finish(false);
      }, 5000);
    } catch {
      finish(false);
    }
  });
}

interface SetupResult {
  ok: boolean;
  reason?: SetupFailureReason;
}

/**
 * The non-root usability gate: can this box run the secure setup at all? Runs
 * BEFORE any prompt so an unsupported box never triggers a password dialog.
 */
async function runUsabilityGate(profileText: string): Promise<SetupResult> {
  if (!isApparmorEnabled()) return { ok: false, reason: "unsupported" };
  if (!hasExecutable("apparmor_parser")) return { ok: false, reason: "unsupported" };
  if (!hasExecutable("pkexec")) return { ok: false, reason: "no-pkexec" };
  if (!(await parserAcceptsRule(profileText))) return { ok: false, reason: "unsupported" };
  return { ok: true };
}

/**
 * Install the AppArmor profile via a single pkexec call to the static script,
 * passing the profile text on stdin. The usability gate is assumed to have
 * passed already (launch flow) or is re-run by the caller (Settings entry).
 */
export async function runInstall(attachPath: string): Promise<SetupResult> {
  const scriptPath = resolveScriptPath();
  if (!scriptPath) return { ok: false, reason: "no-script" };
  const profileText = buildProfileText(attachPath);
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: SetupResult): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    try {
      const p = spawn("pkexec", [scriptPath], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      p.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      p.on("error", (e: NodeJS.ErrnoException) => {
        // pkexec missing surfaces here as ENOENT.
        finish({ ok: false, reason: e.code === "ENOENT" ? "no-pkexec" : "failed" });
      });
      p.on("close", (code) => {
        if (code === 0) return finish({ ok: true });
        if (stderr.trim()) console.warn(`[multizen] apparmor install: ${stderr.trim()}`);
        finish({ ok: false, reason: mapSetupExit(code) });
      });
      p.stdin.on("error", () => finish({ ok: false, reason: "failed" }));
      p.stdin.end(profileText);
    } catch {
      finish({ ok: false, reason: "failed" });
    }
  });
}

// ── Manager ────────────────────────────────────────────────────────────────

export class LinuxSandboxManager {
  private readonly deps: LinuxSandboxDeps;
  /** Collapses concurrent first-launch setups onto one prompt/elevation. */
  private inFlight: Promise<SandboxDecision> | null = null;
  /**
   * Engine binaries whose sandbox was expected active but failed to start this
   * session (the crash backstop fired). We stop trusting verifyActive for them
   * so we don't optimistically crash-and-relaunch on every launch; a successful
   * (re-)setup clears the entry.
   */
  private readonly brokenThisSession = new Set<string>();

  constructor(deps: LinuxSandboxDeps) {
    this.deps = deps;
  }

  /** The crash backstop calls this (via the driver) when a sandboxed launch
   *  failed despite verifyActive; forces a re-offer on the next launch. */
  markBinaryInactive(binaryPath: string): void {
    this.brokenThisSession.add(binaryPath);
  }

  /**
   * Decide whether this launch must pass `--no-sandbox`. Pure fast-paths first,
   * then detection, live verification, persisted state, and finally the
   * one-time setup flow (single-flight, window-gated).
   */
  async resolveForLaunch(ctx: { engine: string; binaryPath: string }): Promise<SandboxDecision> {
    // Fast paths: no async, no prompt.
    if (process.platform !== "linux") return { noSandbox: false };
    if (process.argv.includes("--no-sandbox")) return { noSandbox: true };
    // This fix targets the Chromium engine only; Camoufox is out of scope.
    if (ctx.engine !== "cloakbrowser") return { noSandbox: false };

    const mechanism = detectMechanism();
    if (mechanism === "none") return { noSandbox: false };
    // The clone lever can't be fixed with an AppArmor profile.
    if (mechanism === "clone") return { noSandbox: true };

    const cacheDir = cacheDirForEngine();

    // Already active in the live OS -> launch sandboxed, no prompt. Skip this
    // optimistic path if the sandbox already failed for this binary this session
    // (verifyActive can false-positive when the loaded-profile list isn't
    // readable), so we re-offer instead of crash-looping.
    if (!this.brokenThisSession.has(ctx.binaryPath) && verifyActive(ctx.binaryPath, cacheDir)) {
      return { noSandbox: false };
    }

    // Persisted terminal states → no prompt.
    const state = this.deps.getState();
    if (state === "declined" || state === "unsupported") return { noSandbox: true };

    // No window → can't show consent; launch unsandboxed, persist nothing, so a
    // later windowed launch still offers setup (R16/AC18).
    if (!this.deps.hasWindow()) return { noSandbox: true };

    // Single-flight: one gate + prompt + install at a time; concurrent launches
    // await the same result (R10/AC12).
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runSetupFlow(ctx.binaryPath, cacheDir).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** The gate → prompt → install flow. Caller guarantees a window exists. */
  private async runSetupFlow(binaryPath: string, cacheDir: string): Promise<SandboxDecision> {
    const attachPath = attachPathForCache(cacheDir);
    // The engine binary must be under the managed cache dir for the glob to
    // cover it; otherwise there is nothing safe to grant.
    if (!binaryPath.startsWith(cacheDir + "/")) {
      await this.surfaceUnsupported("engine-path-unmanaged", attachPath);
      return { noSandbox: true };
    }

    const profileText = buildProfileText(attachPath);
    const gate = await runUsabilityGate(profileText);
    if (!gate.ok) {
      await this.surfaceUnsupported(gate.reason ?? "unsupported", attachPath);
      return { noSandbox: true };
    }

    const choice = await this.deps.promptSetup({ profileName: PROFILE_NAME });
    if (choice === "no-sandbox") {
      await this.deps.setState("declined");
      return { noSandbox: true };
    }

    const result = await runInstall(attachPath);
    if (result.ok) {
      // Completion supersedes any prior decline (R7/AC8a) and clears a prior
      // this-session "broken" mark for this binary.
      this.brokenThisSession.delete(binaryPath);
      await this.deps.setState("unset");
      if (verifyActive(binaryPath, cacheDir)) return { noSandbox: false };
      // Loaded but not yet observable as active; the crash backstop still
      // guarantees a launch; keep the sandbox on.
      return { noSandbox: false };
    }

    // Install failed. Cancel/auth-fail: re-offer next launch (don't persist).
    // Environmental impossibility: persist "unsupported" so we don't re-nag.
    const reason = result.reason ?? "failed";
    await this.deps.showNotice({ reason, manualCommand: buildManualCommand(attachPath) });
    if (reason === "unsupported" || reason === "no-pkexec" || reason === "no-script") {
      await this.deps.setState("unsupported");
    }
    return { noSandbox: true };
  }

  /** Surface an unsupported/failed reason once and persist "unsupported". */
  private async surfaceUnsupported(reason: SetupFailureReason, attachPath: string): Promise<void> {
    await this.deps.showNotice({ reason, manualCommand: buildManualCommand(attachPath) });
    await this.deps.setState("unsupported");
  }

  /**
   * Run the secure setup from Settings (R7). Re-asserts the usability gate (this
   * path does not go through resolveForLaunch). Returns the resulting status.
   */
  async setupFromSettings(binaryPath: string): Promise<SandboxStatus> {
    const cacheDir = cacheDirForEngine();
    const attachPath = attachPathForCache(cacheDir);
    if (!binaryPath.startsWith(cacheDir + "/")) {
      await this.deps.setState("unsupported");
      return this.failureStatus("engine-path-unmanaged", attachPath);
    }
    const profileText = buildProfileText(attachPath);
    const gate = await runUsabilityGate(profileText);
    if (!gate.ok) {
      await this.deps.setState("unsupported");
      return this.failureStatus(gate.reason ?? "unsupported", attachPath);
    }
    const result = await runInstall(attachPath);
    if (result.ok) {
      this.brokenThisSession.delete(binaryPath);
      await this.deps.setState("unset");
      return { state: "active" };
    }
    const reason = result.reason ?? "failed";
    // Only terminal, environment-level reasons are persisted as "unsupported"
    // (no re-nag). Cancel / auth-fail / a transient "failed" stay retryable, so
    // this matches runSetupFlow's persistence (see N6).
    const retryable =
      reason === "cancelled" || reason === "unauthorized" || reason === "failed";
    if (!retryable) await this.deps.setState("unsupported");
    return {
      ...this.failureStatus(reason, attachPath),
      state: retryable ? "needs-setup" : "unsupported",
    };
  }

  private failureStatus(reason: SetupFailureReason, attachPath: string): SandboxStatus {
    return {
      state: "unsupported",
      reasonText: describeSandboxReason(reason),
      manualCommand: buildManualCommand(attachPath),
    };
  }

  /**
   * Live status for the Settings row. Computes against the OS + the current
   * engine binary, not a raw persisted read, so it can report active vs
   * needs-setup and hide the row on non-affected systems.
   */
  getStatus(binaryPath: string | null): SandboxStatus {
    if (detectMechanism() !== "apparmor") {
      return { state: process.platform === "linux" ? "not-restricted" : "n/a" };
    }
    const cacheDir = cacheDirForEngine();
    if (binaryPath && verifyActive(binaryPath, cacheDir)) return { state: "active" };
    const state = this.deps.getState();
    const attachPath = attachPathForCache(cacheDir);
    if (state === "declined") return { state: "declined" };
    if (state === "unsupported") {
      return {
        state: "unsupported",
        reasonText: "The secure sandbox can't be set up automatically on this system.",
        manualCommand: buildManualCommand(attachPath),
      };
    }
    return { state: "needs-setup" };
  }
}
