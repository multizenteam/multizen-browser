import type { BrowserDriver } from "./server.js";
import type { LaunchedProfile, ProfileId } from "@multizen/types";

/**
 * In-memory browser driver for development. Returns plausible mock data
 * so MCP clients can be tested end-to-end before the real Chromium driver
 * is hooked up.
 */
export class MockBrowserDriver implements BrowserDriver {
  private readonly running = new Map<ProfileId, { url: string; pid: number; port: number }>();
  private port = 9222;

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    const existing = this.running.get(profileId);
    if (existing) {
      return {
        id: profileId,
        cdpEndpoint: `ws://localhost:${existing.port}/devtools/browser/mock-${profileId}`,
        pid: existing.pid,
        startedAt: new Date().toISOString(),
      };
    }
    this.port += 1;
    const pid = Math.floor(Math.random() * 100000) + 1000;
    this.running.set(profileId, { url: "about:blank", pid, port: this.port });
    return {
      id: profileId,
      cdpEndpoint: `ws://localhost:${this.port}/devtools/browser/mock-${profileId}`,
      pid,
      startedAt: new Date().toISOString(),
    };
  }

  async close(profileId: ProfileId): Promise<void> {
    this.running.delete(profileId);
  }

  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }

  async navigate(profileId: ProfileId, url: string): Promise<{ url: string }> {
    const r = this.running.get(profileId);
    if (!r) throw new Error("not running");
    r.url = url;
    return { url };
  }

  async click(_profileId: ProfileId, _selector: string): Promise<{ ok: true }> {
    return { ok: true };
  }

  async type(
    _profileId: ProfileId,
    _selector: string,
    _text: string,
  ): Promise<{ ok: true }> {
    return { ok: true };
  }

  async extract(_profileId: ProfileId): Promise<{ result: unknown }> {
    return {
      result: {
        note: "mock extraction — real implementation returns the page accessibility tree",
        url: "about:blank",
        title: "",
      },
    };
  }

  async screenshot(_profileId: ProfileId): Promise<{ pngBase64: string }> {
    return {
      pngBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    };
  }

  async cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown> {
    const r = this.running.get(profileId);
    if (!r) throw new Error("not running");
    // Echo the request back so MCP clients can exercise the CDP tool surfaces
    // end-to-end against the mock without a real browser.
    return {
      mock: true,
      method,
      params: params ?? {},
      sessionId: sessionId ?? null,
      safe: opts?.safe ?? true,
    };
  }
}
