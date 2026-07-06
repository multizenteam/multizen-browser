import { app } from "electron";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppSettings } from "@multizen/settings-store";

/**
 * Opt-in anonymous usage heartbeat. See docs/TELEMETRY.md for the full design
 * and privacy rationale. The short version:
 *
 *   - OFF by default. Nothing is ever sent unless the user turns it on in
 *     Settings (an anti-detect browser must not phone home silently).
 *   - The MULTIZEN_NO_TELEMETRY env var force-disables it regardless of the
 *     setting (CI / enterprise / paranoid kill switch, à la Homebrew).
 *   - At most ONE ping per local calendar day. The only persisted state is the
 *     last-ping date, which is NEVER sent.
 *   - Payload is exactly { v, os, n }: app version, OS family, and a random
 *     128-bit nonce regenerated every ping. No persistent id, no IP (the client
 *     doesn't send one; the server derives a coarse country from the transient
 *     connection IP then discards it). The nonce lets the server count distinct
 *     machines per day via a daily-salted HyperLogLog without ever storing a
 *     stable identifier.
 *   - Fail-silent: short timeout, no retries; a ping failure never affects the
 *     browser.
 *
 * NOTE: the ingest endpoint is not deployed yet. Because the feature is
 * opt-in/default-off, the code is dormant until both (a) the user enables it and
 * (b) the server exists. Override the endpoint for testing with
 * MULTIZEN_TELEMETRY_ENDPOINT.
 */

const DEFAULT_ENDPOINT = "https://ping.getmultizen.com/ping";
const POST_LAUNCH_DELAY_MS = 12_000; // let first-run + window settle first
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

interface UsageReportingOptions {
  /** Live accessor for current settings (re-read each time, never cached). */
  getSettings: () => AppSettings;
  /** Where to persist the last-ping date (never sent). */
  statePath: string;
}

interface UsageState {
  /** Local YYYY-MM-DD of the last successful ping. */
  lastPingDate?: string;
}

export class UsageReporting {
  private readonly getSettings: () => AppSettings;
  private readonly statePath: string;
  private readonly endpoint: string;
  private readonly enabledByEnv: boolean;
  private timer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;

  constructor(opts: UsageReportingOptions) {
    this.getSettings = opts.getSettings;
    this.statePath = opts.statePath;
    this.endpoint = process.env.MULTIZEN_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT;
    // Homebrew-style hard kill switch: any truthy value disables telemetry.
    this.enabledByEnv = !process.env.MULTIZEN_NO_TELEMETRY;
  }

  /** Begin the daily heartbeat loop. Safe to call once at startup. */
  start(): void {
    if (this.startTimer || this.timer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.maybePing();
      this.timer = setInterval(() => void this.maybePing(), DAILY_INTERVAL_MS);
      this.timer.unref?.();
    }, POST_LAUNCH_DELAY_MS);
    this.startTimer.unref?.();
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.timer) clearInterval(this.timer);
    this.startTimer = null;
    this.timer = null;
  }

  private async maybePing(): Promise<void> {
    if (!this.enabledByEnv) return;
    if (!this.getSettings().usageReporting) return;
    const today = localDateKey();
    const state = this.readState();
    if (state.lastPingDate === today) return; // already pinged today

    const ok = await this.send();
    // Only record the date on success, so a failed ping retries next launch
    // rather than silently skipping the day.
    if (ok) this.writeState({ lastPingDate: today });
  }

  private async send(): Promise<boolean> {
    const body = JSON.stringify({
      v: app.getVersion(),
      os: osFamily(),
      n: randomBytes(16).toString("hex"),
    });
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Drain/ignore the body; we only care that it was accepted.
      return res.ok;
    } catch {
      return false; // fail silent — never let telemetry affect the app
    }
  }

  private readState(): UsageState {
    try {
      return JSON.parse(readFileSync(this.statePath, "utf8")) as UsageState;
    } catch {
      return {};
    }
  }

  private writeState(state: UsageState): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(state), "utf8");
    } catch {
      // Best-effort; if we can't persist we may re-ping next launch, which is
      // harmless (the server dedupes by nonce within the day).
    }
  }
}

/** OS family only — never the full build string (that narrows the fingerprint). */
function osFamily(): "macos" | "windows" | "linux" | "other" {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

/** Local calendar day as YYYY-MM-DD (used only to rate-limit; never sent). */
function localDateKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
