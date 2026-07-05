import CDP from "chrome-remote-interface";
import type { AccessibilityNode, ExtractContext } from "./types.js";

/**
 * Send a CDP command to a specific target/session. Returned by
 * {@link CdpSession.bootstrapTargets} so a setup function does not have
 * to track sessionIds itself.
 */
export interface TargetContext {
  /** True for the root (top-level page) session, false for nested iframes. */
  isRoot: boolean;
  /** Target type as reported by Target.attachedToTarget — "page" | "iframe" | etc. */
  type: "page" | "iframe";
}

export type TargetSender = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

function buildSender(client: CDP.Client, sessionId: string | undefined): TargetSender {
  return ((method: string, params?: Record<string, unknown>) => {
    if (sessionId === undefined) {
      // Root session: third arg omitted entirely.
      return (
        client as unknown as {
          send: (m: string, p?: Record<string, unknown>) => Promise<unknown>;
        }
      ).send(method, params);
    }
    return (
      client as unknown as {
        send: (
          m: string,
          p: Record<string, unknown> | undefined,
          sid: string,
        ) => Promise<unknown>;
      }
    ).send(method, params, sessionId);
  }) as TargetSender;
}

export interface CdpSessionOptions {
  /** Port the Chromium instance is listening on */
  port: number;
  /** Optional host override, defaults to localhost */
  host?: string;
}

/**
 * Thin wrapper around chrome-remote-interface that exposes the
 * primitives our MCP tools call: navigate, click, type, extract,
 * screenshot. Stays connected per profile so cookies / DOM state
 * survive across calls.
 *
 * `click` and `type` require a CSS selector. We do not embed any LLM
 * for natural-language target resolution — the calling MCP client
 * (Claude in Cursor, Claude Desktop, Cline, etc.) does that on its
 * own side, then sends us a concrete selector.
 *
 * `extract` returns the page's URL, title, and trimmed accessibility
 * tree. The calling LLM is expected to parse it. We intentionally do
 * not call any external API.
 */
export class CdpSession {
  private client: CDP.Client | null = null;
  private readonly opts: CdpSessionOptions;
  /** Cleanups (e.g. polling intervals) to run on close(). */
  private readonly teardowns: Array<() => void> = [];

  constructor(opts: CdpSessionOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const host = this.opts.host ?? "localhost";
    this.client = await CDP({ host, port: this.opts.port });
    const { Page } = this.client;
    // Stealth-minimal connect. Anti-detect Chromium forks (CloakBrowser,
    // BotBrowser, Camoufox) DCHECK on most CDP enable commands because
    // they're automation-presence signals. We've reduced to just
    // Page.enable (needed for navigate/lifecycle events). Runtime, DOM,
    // Network, Accessibility are enabled on-demand inside specific
    // methods that need them, then disabled afterwards.
    //
    // The big wins from this: (a) Cloudflare/DataDome can't fingerprint
    // our CDP presence via Runtime.enable, (b) CloakBrowser doesn't
    // SIGTRAP on connect.
    await Page.enable();
  }

  async close(): Promise<void> {
    for (const t of this.teardowns.splice(0)) {
      try {
        t();
      } catch {
        // ignore
      }
    }
    if (!this.client) return;
    await this.client.close();
    this.client = null;
  }

  /**
   * Canonical graceful Chromium shutdown via CDP `Browser.close`. This is
   * the macOS ⌘Q equivalent: it walks Chromium through its full quit
   * sequence so `Default/Sessions/Tabs_*` and `Last Session` are flushed
   * to disk before the process exits — which is what makes the next
   * launch's "Continue where you left off" actually restore tabs.
   *
   * SIGINT/SIGTERM alone are not reliable: SIGTERM kills too fast (lost
   * tabs), SIGINT works on Linux Chrome but on macOS Chromium often
   * exits via a path that skips the session-state writer.
   *
   * The websocket disconnects mid-call, so we don't await — we just fire
   * the command and rely on the caller to wait for `child.on("exit")`.
   */
  async closeBrowser(): Promise<void> {
    if (!this.client) throw new Error("CDP session not connected");
    const send = (
      this.client as unknown as {
        send: (m: string, p?: Record<string, unknown>) => Promise<unknown>;
      }
    ).send;
    await send.call(this.client, "Browser.close").catch(() => {
      // Connection drops as Chromium shuts down — expected.
    });
  }

  /**
   * Apply a setup function to every page target the browser has now and
   * to every page target it opens later. Used to wire Emulation overrides
   * (timezone, locale, Sec-CH-UA via userAgentMetadata) and preload
   * scripts (WebRTC handler) so a fresh tab is never un-cloaked even for
   * a single navigation.
   *
   * `setup` receives a `send` function pre-bound to the right session.
   * It runs on:
   *   1. the root connected target,
   *   2. every existing page target (e.g. session-restored tabs),
   *   3. every future target — auto-attached with waitForDebuggerOnStart
   *      so we win the race against the page's first script.
   */
  async bootstrapTargets(
    setup: (send: TargetSender, ctx: TargetContext) => Promise<void>,
  ): Promise<void> {
    const client = this.require();
    const { Target } = client;

    await setup(buildSender(client, undefined), { isRoot: true, type: "page" });

    // Targets that should receive the setup. "page" covers user tabs;
    // "iframe" covers OOPIFs (cross-origin iframes that live in a
    // separate process — common for ad networks and 3rd-party fingerprint
    // services like browserscan's IP probe). Without iframe coverage,
    // RTCPeerConnection inside a cross-origin iframe goes un-spoofed and
    // leaks the real IP via STUN even when the parent page is patched.
    const SETUP_TARGET_TYPES = new Set(["page", "iframe"]);

    try {
      const targets = await Target.getTargets();
      for (const t of targets.targetInfos) {
        if (!SETUP_TARGET_TYPES.has(t.type)) continue;
        const { sessionId } = await Target.attachToTarget({
          targetId: t.targetId,
          flatten: true,
        });
        await setup(buildSender(client, sessionId), {
          isRoot: false,
          type: t.type as "page" | "iframe",
        }).catch(() => {});
      }
    } catch {
      // Best-effort — root is already covered.
    }

    await Target.setAutoAttach({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    client.on(
      "Target.attachedToTarget",
      (params: { sessionId: string; targetInfo: { type: string } }) => {
        void (async () => {
          try {
            if (SETUP_TARGET_TYPES.has(params.targetInfo.type)) {
              await setup(buildSender(client, params.sessionId), {
                isRoot: false,
                type: params.targetInfo.type as "page" | "iframe",
              }).catch(() => {});
            }
          } finally {
            try {
              await client.send(
                "Runtime.runIfWaitingForDebugger",
                undefined,
                params.sessionId,
              );
            } catch {
              // Already detached.
            }
          }
        })();
      },
    );
  }

  /**
   * Watch for a companion signal on page targets whose URL contains
   * `urlIncludes`. Channel: the content script writes the payload to
   * `<html data-mz-add-ext="…">` and the host polls it via Runtime.evaluate.
   *
   * Why DOM, not a CDP binding/console: CloakBrowser puts content scripts in an
   * ISOLATED world (it ignores manifest `world:MAIN`) and suppresses console
   * CDP events, so neither bindings nor console reach the host. The DOM is
   * shared across worlds and Runtime.evaluate works, so this is the reliable
   * path. Polling is scoped to matching page targets only (never the user's
   * normal browsing) and torn down on close().
   */
  async watchUrlForBinding(opts: {
    urlIncludes: string;
    onPayload: (payload: string) => void;
  }): Promise<void> {
    const client = this.require();
    const { Target } = client;
    const ATTR = "data-mz-add-ext";
    const armed = new Map<string, NodeJS.Timeout>();
    this.teardowns.push(() => {
      for (const iv of armed.values()) clearInterval(iv);
      armed.clear();
    });

    const poll = async (sessionId: string): Promise<void> => {
      try {
        const r = (await client.send(
          "Runtime.evaluate",
          {
            expression: `(function(){var e=document.documentElement,v=e.getAttribute('${ATTR}');if(v)e.removeAttribute('${ATTR}');return v;})()`,
            returnByValue: true,
          },
          sessionId,
        )) as { result?: { value?: unknown } };
        const v = r?.result?.value;
        if (typeof v === "string" && v) {
          opts.onPayload(v);
        }
      } catch {
        // session gone / navigating — ignore
      }
    };

    const arm = (targetId: string, sessionId: string): void => {
      if (armed.has(targetId)) return;
      const interval = setInterval(() => void poll(sessionId), 600);
      armed.set(targetId, interval);
    };
    const disarm = (targetId: string): void => {
      const interval = armed.get(targetId);
      if (interval) {
        clearInterval(interval);
        armed.delete(targetId);
      }
    };

    const evaluate = async (
      targetInfo: { targetId: string; type?: string; url?: string },
      sessionId?: string,
    ): Promise<void> => {
      const isPage = targetInfo.type === undefined || targetInfo.type === "page";
      const matches = isPage && !!targetInfo.url?.includes(opts.urlIncludes);
      if (matches) {
        if (armed.has(targetInfo.targetId)) return;
        let sid = sessionId;
        if (!sid) {
          try {
            sid = (await Target.attachToTarget({ targetId: targetInfo.targetId, flatten: true }))
              .sessionId;
          } catch {
            return;
          }
        }
        arm(targetInfo.targetId, sid);
      } else {
        disarm(targetInfo.targetId);
      }
    };

    await Target.setDiscoverTargets({ discover: true });
    client.on(
      "Target.targetInfoChanged",
      (p: { targetInfo: { targetId: string; url?: string } }) => {
        void evaluate(p.targetInfo);
      },
    );
    client.on(
      "Target.attachedToTarget",
      (p: { sessionId: string; targetInfo: { targetId: string; url?: string } }) => {
        void evaluate(p.targetInfo, p.sessionId);
      },
    );
    client.on("Target.targetDestroyed", (p: { targetId: string }) => {
      disarm(p.targetId);
    });
    try {
      const { targetInfos } = await Target.getTargets();
      for (const t of targetInfos) await evaluate(t);
    } catch {
      // best-effort
    }
  }

  private require(): CDP.Client {
    if (!this.client) throw new Error("CDP session not connected. Call connect() first.");
    return this.client;
  }

  async navigate(url: string, opts: { timeoutMs?: number } = {}): Promise<{ url: string; title: string }> {
    const client = this.require();
    const { Page } = client;
    const timeoutMs = opts.timeoutMs ?? 30000;

    const navigated = Page.loadEventFired();
    await Page.navigate({ url });
    await withTimeout(navigated, timeoutMs, `Navigation to ${url} timed out after ${timeoutMs}ms`);

    const result = await client.Runtime.evaluate({
      expression: "JSON.stringify({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    const value = result.result.value as string;
    return JSON.parse(value) as { url: string; title: string };
  }

  /**
   * Click an element by CSS selector.
   *
   * The selector must be precise — we do NOT resolve natural-language
   * descriptions. If you're driving via MCP from Cursor / Claude
   * Desktop, the LLM should produce a selector from the snapshot
   * returned by `extract`.
   */
  async click(selector: string): Promise<{ ok: true }> {
    const client = this.require();
    const result = await client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false };
        if (el.scrollIntoView) el.scrollIntoView({ block: "center" });
        const rect = el.getBoundingClientRect();
        return { ok: true, x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
      })()`,
      returnByValue: true,
    });
    const v = result.result.value as { ok: boolean; x?: number; y?: number };
    if (!v.ok) throw new Error(`Element not found for selector: ${selector}`);
    await this.dispatchMouseClick(v.x ?? 0, v.y ?? 0);
    return { ok: true };
  }

  private async dispatchMouseClick(x: number, y: number): Promise<void> {
    const client = this.require();
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /**
   * Type text into an element selected by CSS selector.
   */
  async type(selector: string, text: string): Promise<{ ok: true }> {
    const client = this.require();

    const focused = await client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        return true;
      })()`,
      returnByValue: true,
    });
    if (!focused.result.value) {
      throw new Error(`Element not found for selector: ${selector}`);
    }

    for (const ch of text) {
      await client.Input.dispatchKeyEvent({ type: "keyDown", text: ch });
      await client.Input.dispatchKeyEvent({ type: "keyUp" });
    }
    return { ok: true };
  }

  /**
   * Snapshot the page: URL, title, accessibility tree, text fallback.
   * The calling LLM is expected to parse this into whatever structured
   * shape it needs. MultiZen does not call any external API here.
   */
  async extract(): Promise<{ result: ExtractContext }> {
    const snapshot = await this.snapshot();
    return { result: snapshot };
  }

  async screenshot(): Promise<{ pngBase64: string }> {
    const client = this.require();
    const { data } = await client.Page.captureScreenshot({ format: "png" });
    return { pngBase64: data };
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const client = this.require();
    const result = await client.Runtime.evaluate({ expression, returnByValue: true });
    return result.result.value as T;
  }

  async snapshot(): Promise<ExtractContext> {
    const client = this.require();
    const { Accessibility, Runtime } = client;

    const meta = await Runtime.evaluate({
      expression: "JSON.stringify({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    const { url, title } = JSON.parse(meta.result.value as string) as { url: string; title: string };

    // Enable Accessibility only for the duration of this snapshot —
    // keeping it enabled globally is a stealth-build DCHECK trigger.
    let fullTree: { nodes: unknown[] };
    try {
      await Accessibility.enable();
      fullTree = await Accessibility.getFullAXTree();
    } finally {
      await Accessibility.disable().catch(() => {});
    }
    const accessibilityTree = trimAccessibilityTree(fullTree.nodes as unknown as RawAxNode[]);

    let textContent: string | undefined;
    if (accessibilityTree.length === 0) {
      const text = await Runtime.evaluate({
        expression: "document.body && document.body.innerText.slice(0, 8000)",
        returnByValue: true,
      });
      textContent = (text.result.value as string) ?? undefined;
    }

    return { url, title, accessibilityTree, textContent };
  }
}

interface RawAxNode {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  childIds?: string[];
  backendDOMNodeId?: number;
  ignored?: boolean;
}

function trimAccessibilityTree(rawNodes: RawAxNode[]): AccessibilityNode[] {
  const byId = new Map<string, RawAxNode>();
  for (const node of rawNodes) byId.set(node.nodeId, node);

  // Roots = nodes with no parent in the returned set. Include ignored roots:
  // Chrome routinely makes RootWebArea's only child an `ignored` role="none"
  // wrapper (the <body>), with the entire page hanging below it.
  const childIds = new Set<string>();
  for (const node of rawNodes) {
    for (const c of node.childIds ?? []) childIds.add(c);
  }
  const roots = rawNodes.filter((n) => !childIds.has(n.nodeId));

  // Returns a LIST so structural noise is spliced out rather than pruned: an
  // `ignored` node (that <body> wrapper) or a generic/presentational container
  // is dropped, but its meaningful descendants are hoisted to its parent. The
  // previous version returned null for `ignored` nodes, which discarded the
  // whole subtree — so a single ignored ancestor silently dropped ALL page text
  // (e.g. extract returned only RootWebArea for pages whose <body> is ignored).
  function walk(node: RawAxNode, depth: number): AccessibilityNode[] {
    if (depth > 40) return []; // guard against pathological nesting only

    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((n): n is RawAxNode => Boolean(n))
      .flatMap((n) => walk(n, depth + 1));

    if (node.ignored) return children; // splice out ignored wrapper, keep its content

    const role = node.role?.value ?? "generic";
    const name = node.name?.value;
    const value = node.value?.value;
    const description = node.description?.value;

    const isInteresting =
      role !== "generic" &&
      role !== "presentation" &&
      role !== "none" &&
      role !== "InlineTextBox" &&
      (name || value || description || ["link", "button", "textbox", "checkbox", "combobox", "option"].includes(role));

    if (!isInteresting) return children; // drop the generic wrapper, hoist its content

    return [
      {
        nodeId: node.nodeId,
        role,
        name,
        value,
        description,
        backendNodeId: node.backendDOMNodeId,
        children: children.length > 0 ? children : undefined,
      },
    ];
  }

  return roots.flatMap((r) => walk(r, 0));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
