/**
 * Staged CDP readiness within a single fixed budget, reusing the supplied
 * session (connect() is idempotent). Stages, each polled on a fixed backoff:
 *   1. `/json/version` answers — the DevTools HTTP endpoint is up.
 *   2. `/json/list` reports at least one `type === "page"` target — Chromium
 *      has actually opened a page (chrome-remote-interface attaches to a page
 *      by default, so connecting before one exists throws).
 *   3. `session.connect()` succeeds — websocket attached + Page.enable done.
 *
 * Throws if the budget is exhausted at any stage; the caller is responsible
 * for tearing down the half-launched browser.
 *
 * `fetch` and `sleep` are injectable so the staged ladder / budget behaviour
 * can be exercised without a real Chromium endpoint.
 */
export interface ReadinessResponseLike {
  ok: boolean;
  json: () => Promise<unknown>;
}

export interface ReadinessSession {
  connect(): Promise<void>;
}

export interface ReadinessDeps {
  fetch: (url: string) => Promise<ReadinessResponseLike>;
  sleep: (ms: number) => Promise<void>;
}

const defaultReadinessDeps: ReadinessDeps = {
  fetch: (url) => fetch(url),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function waitForCdpSessionReady(
  port: number,
  session: ReadinessSession,
  budgetMs: number,
  deps: ReadinessDeps = defaultReadinessDeps,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastError: unknown = null;

  // Stage 1: /json/version answers.
  while (Date.now() < deadline) {
    try {
      const res = await deps.fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        lastError = null;
        break;
      }
    } catch (e) {
      lastError = e;
    }
    await deps.sleep(200);
  }
  if (Date.now() >= deadline) {
    throw new Error(
      `CDP /json/version not ready on port ${port} within ${budgetMs}ms: ${String(lastError)}`,
    );
  }

  // Stage 2: a page target exists.
  while (Date.now() < deadline) {
    try {
      const res = await deps.fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = (await res.json()) as Array<{ type?: string }>;
        if (targets.some((t) => t.type === "page")) {
          lastError = null;
          break;
        }
      }
    } catch (e) {
      lastError = e;
    }
    await deps.sleep(200);
  }
  if (Date.now() >= deadline) {
    throw new Error(`No CDP page target on port ${port} within ${budgetMs}ms: ${String(lastError)}`);
  }

  // Stage 3: connect + attach (idempotent; returns immediately once attached).
  while (Date.now() < deadline) {
    try {
      await session.connect();
      return;
    } catch (e) {
      lastError = e;
      await deps.sleep(200);
    }
  }
  throw new Error(
    `CDP connect/attach failed on port ${port} within ${budgetMs}ms: ${String(lastError)}`,
  );
}
