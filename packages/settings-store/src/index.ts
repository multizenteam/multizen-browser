import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserEngine } from "@multizen/types";

export type { BrowserEngine };

export interface AppSettings {
  /** Theme — "dark" only for now, kept for forward compatibility */
  theme: "dark";
  /** Whether to spawn local MCP HTTP server on app start */
  mcpHttpEnabled: boolean;
  /** Port for MCP HTTP server */
  mcpHttpPort: number;
  /** Which Chromium binary to download + run. Switching requires app restart. */
  browserEngine: BrowserEngine;
  /**
   * Automatically check for + (on Windows/Linux) download app updates in the
   * background. On macOS the app can only notify, not auto-install. Manual
   * "Check for updates" works regardless of this flag.
   */
  autoUpdate: boolean;
  /**
   * Automatically check for + stage new versions of the downloaded browser
   * ENGINE (CloakBrowser / Camoufox) in the background. A staged engine
   * applies on the next profile launch; running browsers are never
   * interrupted. Manual "Check for updates" works regardless of this flag.
   */
  engineAutoUpdate: boolean;
  /**
   * Opt-in anonymous usage heartbeat. OFF by default — for an anti-detect
   * audience any call-home must be an explicit choice. When on, the app sends
   * at most one ping/day carrying only app version + OS family + an ephemeral
   * single-use nonce — no persistent id, no IP sent. The MULTIZEN_NO_TELEMETRY
   * env var force-disables it regardless. See docs/TELEMETRY.md.
   */
  usageReporting: boolean;
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  mcpHttpEnabled: true,
  mcpHttpPort: 7777,
  // CloakBrowser is the default engine for newly created profiles.
  browserEngine: "cloakbrowser",
  autoUpdate: true,
  engineAutoUpdate: true,
  // Opt-in. Never phone home unless the user explicitly turns this on.
  usageReporting: false,
};

export class SettingsStore {
  private readonly jsonPath: string;
  private cache: AppSettings | null = null;

  constructor(jsonPath: string) {
    this.jsonPath = jsonPath;
    mkdirSync(dirname(jsonPath), { recursive: true });
  }

  async load(): Promise<AppSettings> {
    if (this.cache) return this.cache;

    let raw: Partial<AppSettings> = {};
    if (existsSync(this.jsonPath)) {
      try {
        const txt = readFileSync(this.jsonPath, "utf8");
        raw = JSON.parse(txt) as Partial<AppSettings>;
      } catch {
        raw = {};
      }
    }

    const merged: AppSettings = { ...DEFAULTS, ...raw };
    if (merged.browserEngine !== "cloakbrowser" && merged.browserEngine !== "camoufox") {
      merged.browserEngine = DEFAULTS.browserEngine;
    }
    if (typeof merged.autoUpdate !== "boolean") {
      merged.autoUpdate = DEFAULTS.autoUpdate;
    }
    if (typeof merged.engineAutoUpdate !== "boolean") {
      merged.engineAutoUpdate = DEFAULTS.engineAutoUpdate;
    }
    if (typeof merged.usageReporting !== "boolean") {
      merged.usageReporting = DEFAULTS.usageReporting;
    }
    this.cache = merged;
    return merged;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.load();
    const next = { ...current, ...patch };
    this.cache = next;
    writeFileSync(this.jsonPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  }
}

export function defaultSettingsPath(userDataDir: string): string {
  return join(userDataDir, "settings.json");
}
