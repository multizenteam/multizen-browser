import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Optional Xvfb display for the browser engines.
 *
 * A profile's Chromium window has to stay on a real display: when it is
 * parked off-screen the compositor stops producing frames and the CDP
 * screencast drops to ~4 fps (measured). Xvfb gives the engine a visible
 * window on a separate X server, so the compositor keeps painting while
 * nothing appears on the user's Wayland session. Electron stays on Wayland;
 * only the engine child gets DISPLAY=:99.
 */
const DEFAULT_DISPLAY = ":99";
const SCREEN = "2560x1600x24";
const READY_TIMEOUT_MS = 5000;

let child: ChildProcess | null = null;
let display: string | null = null;

/** The active virtual display, or null when the feature is unavailable. */
export function virtualDisplay(): string | null {
  return display;
}

/** Start (or adopt an already running) Xvfb. Safe to call once at startup. */
export async function ensureVirtualDisplay(): Promise<string | null> {
  if (process.platform !== "linux") return null;
  const requested = process.env.MULTIZEN_XVFB_DISPLAY?.trim() || DEFAULT_DISPLAY;
  if (!/^:\d+$/.test(requested)) {
    process.stderr.write(`[multizen] invalid MULTIZEN_XVFB_DISPLAY: ${requested}\n`);
    return null;
  }

  const socket = `/tmp/.X11-unix/X${requested.slice(1)}`;
  if (existsSync(socket)) {
    display = requested;
    return display;
  }

  try {
    child = spawn("Xvfb", [requested, "-screen", "0", SCREEN, "-nolisten", "tcp"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (e) {
    process.stderr.write(`[multizen] Xvfb unavailable: ${String(e)}\n`);
    return null;
  }

  for (let i = 0; i < READY_TIMEOUT_MS / 100; i++) {
    if (existsSync(socket)) {
      display = requested;
      return display;
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(100);
  }
  process.stderr.write(`[multizen] Xvfb did not become ready on ${requested}\n`);
  child = null;
  return null;
}

/** Disable the virtual display and stop only the Xvfb we started ourselves. */
export function stopVirtualDisplay(): void {
  if (child) {
    const pid = child.pid;
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // Already gone — nothing to do.
      }
    }
    child = null;
  }
  // A display adopted from the outside is not killed, but it must stop being
  // used by new engines as soon as the setting is turned off.
  display = null;
}
