import { spawnSync } from "node:child_process";

/**
 * Hide or show the engine's X11 windows in the system taskbar.
 *
 * The driver launches the engine with `--ozone-platform=x11` on Linux, so the
 * Chrome window IS an X11 client and the EWMH atom reaches it: MEASURED on
 * this machine — setting `_NET_WM_STATE_SKIP_TASKBAR` removes the window
 * from the KDE taskbar, and removing the atom brings it back.
 *
 * The stream (which parks the window off-screen) has no PID, so the driver
 * owns this helper and mirrors the parked state onto the engine's windows.
 *
 * Every call is bounded and NEVER throws: a missing `xprop`, an unreachable
 * DISPLAY or a malformed atom list must degrade to "the taskbar entry stays
 * visible" — a cosmetic problem must never crash a profile.
 *
 * Returns true when at least one window was actually updated. The caller
 * uses it to RETRY: a freshly created Chrome window only registers in
 * `_NET_CLIENT_LIST` ~190ms after it is created (MEASURED), so a call made
 * in the same tick as the window's creation finds nothing to update.
 */
export function setEngineTaskbarHidden(pid: number, hidden: boolean): boolean {
  // Only X11 has EWMH atoms. macOS/Windows manage their own taskbar/dock
  // through the OS, so this is a no-op there.
  if (process.platform !== "linux") return false;
  if (!Number.isFinite(pid) || pid <= 0) return false;
  // No X session at all (headless / systemd service): nothing to do, and
  // spawning xprop would only produce noise.
  if (!process.env.DISPLAY) return false;

  // Total budget for the whole operation. The xprop calls are local and fast,
  // but they run ON the Electron main thread — a hung X server must never
  // block it for more than a couple of seconds, so every child call gets the
  // REMAINING budget as its timeout.
  const deadline = Date.now() + XPROP_BUDGET_MS;

  try {
    const windows = engineWindowIds(pid, deadline);
    let inWantedState = 0;
    for (const windowId of windows) {
      const atoms = readStateAtoms(windowId, deadline);
      if (atoms === null) continue; // unreadable / malformed → leave it alone
      const next = hidden
        ? atoms.includes(SKIP_TASKBAR_ATOM)
          ? atoms
          : [...atoms, SKIP_TASKBAR_ATOM]
        : atoms.filter((atom) => atom !== SKIP_TASKBAR_ATOM);
      // Already in the wanted state → don't rewrite the property (a needless
      // write would also race the window manager).
      if (atoms.length === next.length && atoms.every((atom, i) => atom === next[i])) {
        inWantedState += 1;
        continue;
      }
      writeStateAtoms(windowId, next, deadline);
      inWantedState += 1;
    }
    // True when a window EXISTS and is in the wanted state. A window that
    // does not exist yet is not a success — the caller must retry.
    return inWantedState > 0;
  } catch (e) {
    // Fail silently — the taskbar entry staying is a cosmetic degradation.
    warnOnce(`xprop taskbar update failed: ${String(e)}`);
    return false;
  }
}

/** The EWMH atom that keeps a window out of the taskbar. */
const SKIP_TASKBAR_ATOM = "_NET_WM_STATE_SKIP_TASKBAR";

/**
 * Budget for the whole `setEngineTaskbarHidden` call. The xprop calls are
 * local IPC round-trips (measured: a few ms each); 2.5s is plenty of slack
 * and still bounds the main-thread stall if the X server is wedged.
 */
const XPROP_BUDGET_MS = 2500;

/** At most ONE warning for the process' lifetime — the taskbar is cosmetic. */
let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`[multizen] taskbar: ${message}\n`);
}

/**
 * Run `xprop` with the given args. Returns stdout on success, null on any
 * failure (missing binary, non-zero exit, timeout). stderr is dropped so a
 * dead X server can't spam the app's log.
 */
function xprop(args: string[], deadline: number): string | null {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const res = spawnSync("xprop", args, {
    encoding: "utf8",
    timeout: remaining,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.error) {
    // ENOENT → xprop is not installed; ETIMEDOUT → the X server is wedged.
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") warnOnce("xprop not found — taskbar hiding unavailable");
    return null;
  }
  if (res.status !== 0) return null;
  return res.stdout;
}

/**
 * The engine's X11 window ids: the root's `_NET_CLIENT_LIST`, filtered by
 * `_NET_WM_PID` matching the engine's pid. Chromium's helper processes own
 * no windows of their own, so the browser process owns all of them.
 */
function engineWindowIds(pid: number, deadline: number): string[] {
  const list = xprop(["-root", "_NET_CLIENT_LIST"], deadline);
  if (!list) return [];
  const ids = list.match(/0x[0-9a-fA-F]+/g) ?? [];
  const owned: string[] = [];
  for (const id of ids) {
    const pidProp = xprop(["-id", id, "_NET_WM_PID"], deadline);
    if (!pidProp) continue;
    const match = pidProp.match(/=\s*(\d+)/);
    if (!match || match[1] === undefined) continue;
    const owner = Number.parseInt(match[1], 10);
    if (owner === pid) owned.push(id);
  }
  return owned;
}

/**
 * The window's current `_NET_WM_STATE` atoms. Returns null when the list is
 * malformed (we then leave the window untouched rather than clobbering its
 * state), and an empty array when the window simply has no states.
 */
function readStateAtoms(windowId: string, deadline: number): string[] | null {
  const out = xprop(["-id", windowId, "-f", "_NET_WM_STATE", "32a", "_NET_WM_STATE"], deadline);
  if (out === null) return null;
  const eq = out.indexOf("=");
  if (eq < 0) {
    // "_NET_WM_STATE:  not found." → the window has no states at all.
    return out.includes("not found") ? [] : null;
  }
  const raw = out.slice(eq + 1).trim();
  if (raw === "") return [];
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) return null;
  // Every atom must be a plain name — a malformed list must never be
  // written back (that would corrupt the window's state).
  if (!tokens.every((token) => /^[A-Za-z0-9_]+$/.test(token))) return null;
  return tokens;
}

/**
 * Replace the window's `_NET_WM_STATE` with `atoms`.
 *
 * `xprop -set` REPLACES the whole property, so the caller must pass the
 * preserved atoms too — that is why the atoms are read first and merged.
 * `-remove` is only used when nothing is left to keep (an empty state list
 * is exactly "no atoms"), never to drop the other states.
 */
function writeStateAtoms(windowId: string, atoms: string[], deadline: number): void {
  if (atoms.length === 0) {
    xprop(["-id", windowId, "-remove", "_NET_WM_STATE"], deadline);
    return;
  }
  xprop(
    ["-id", windowId, "-f", "_NET_WM_STATE", "32a", "-set", "_NET_WM_STATE", atoms.join(", ")],
    deadline,
  );
}
