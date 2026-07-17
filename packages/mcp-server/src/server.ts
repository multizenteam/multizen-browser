import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ProfileManager } from "@multizen/profile-manager";
import {
  generateFingerprint,
  reconcileFingerprint,
  FingerprintReconcileError,
  deviceCatalog,
  localeCatalog,
} from "@multizen/profile-manager";
import type {
  LaunchedProfile,
  ProfileId,
  CreateProfileInput,
  UpdateProfileInput,
  FingerprintConfig,
  ProxyConfig,
} from "@multizen/types";
import { ActivityLog } from "./ActivityLog.js";

/**
 * BrowserDriver is the surface that the MCP server delegates real
 * browser work to. The desktop app implements it on top of patched
 * Chromium + CDP. The standalone dev mode implements a mock so the
 * MCP server can be exercised without a browser.
 */
export interface BrowserDriver {
  launch(profileId: ProfileId): Promise<LaunchedProfile>;
  close(profileId: ProfileId): Promise<void>;
  isRunning(profileId: ProfileId): boolean;
  navigate(profileId: ProfileId, url: string): Promise<{ url: string }>;
  click(profileId: ProfileId, selector: string): Promise<{ ok: true }>;
  type(profileId: ProfileId, selector: string, text: string): Promise<{ ok: true }>;
  extract(profileId: ProfileId): Promise<{ result: unknown }>;
  screenshot(profileId: ProfileId): Promise<{ pngBase64: string }>;
  /**
   * Send a raw CDP command. `opts.safe` (default true) auto-disables any
   * domain the call had to enable so the stealth baseline is preserved; the
   * convenience CDP tools compose on top of this single primitive.
   */
  cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown>;
}

export interface MultizenMcpServerOptions {
  profileManager: ProfileManager;
  browserDriver: BrowserDriver;
  /** Optional activity log; if not provided, a fresh one is created */
  activityLog?: ActivityLog;
}

export interface MultizenMcpServer {
  server: Server;
  activityLog: ActivityLog;
}

const ProfileIdSchema = z.object({ profile_id: z.string().min(1) });
const NavigateSchema = ProfileIdSchema.extend({ url: z.string().url() });
const ClickSchema = ProfileIdSchema.extend({ selector: z.string().min(1) });
const TypeSchema = ProfileIdSchema.extend({
  selector: z.string().min(1),
  text: z.string(),
});
const ExtractSchema = ProfileIdSchema;

// ── CDP convenience tool schemas ────────────────────────────────────────────
const EvaluateJsSchema = ProfileIdSchema.extend({
  expression: z.string().min(1),
  sessionId: z.string().optional(),
});
const WaitForSelectorSchema = ProfileIdSchema.extend({
  selector: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
});
const ListTabsSchema = ProfileIdSchema.extend({ sessionId: z.string().optional() });
const TabIdSchema = ProfileIdSchema.extend({
  target_id: z.string().min(1),
  sessionId: z.string().optional(),
});
const WaitForLoadSchema = ProfileIdSchema.extend({
  timeout_ms: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
});

/** Real device families a fingerprint can impersonate. MUST stay in lockstep
 *  with the `DeviceFamily` union in @multizen/types (and the DEVICES catalog);
 *  call `list_fingerprint_options` for the human-readable catalog. */
const DEVICE_FAMILIES = [
  "macbook-pro-14-m3",
  "macbook-pro-14-m3-pro",
  "macbook-pro-16-m3-pro",
  "macbook-air-13-m3",
  "macbook-air-15-m3",
  "imac-24-m3",
  "mac-mini-m2",
  "windows-laptop-intel",
  "windows-laptop-intel-uhd",
  "windows-laptop-amd",
  "windows-laptop-nvidia",
  "windows-laptop-nvidia-4050",
  "windows-desktop-nvidia",
  "windows-desktop-nvidia-4080",
  "windows-desktop-amd",
  "windows-desktop-intel",
  "linux-desktop-intel",
  "linux-desktop-amd",
  "linux-desktop-nvidia",
] as const;

const ProxySchema = z.object({
  type: z.enum(["http", "socks5"]),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
});

/**
 * User-facing fingerprint knobs. We deliberately do NOT accept the raw
 * `FingerprintConfig` (userAgent, clientHints, webgl, …): those surfaces must
 * stay mutually coherent or detection vendors flag the mismatch. Instead the
 * caller picks high-level dimensions and `reconcileFingerprint` derives a
 * coherent config — throwing FingerprintReconcileError (→ INVALID_INPUT) on an
 * incoherent combination rather than silently substituting a default.
 */
const FingerprintInputSchema = z
  .object({
    device: z.enum(DEVICE_FAMILIES).optional(),
    localeId: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    screen: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional(),
    hardwareConcurrency: z.number().int().positive().optional(),
    deviceMemory: z.number().positive().optional(),
  })
  .strict();

const CreateProfileSchema = z.object({
  name: z.string().min(1),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  proxy: ProxySchema.optional(),
  fingerprint: FingerprintInputSchema.optional(),
  // Optional entropy seed; rotates CloakBrowser canvas/audio/WebGL noise.
  seed: z.string().min(1).optional(),
});

const UpdateProfileSchema = ProfileIdSchema.extend({
  name: z.string().min(1).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  // `null` clears the proxy; omitted leaves it untouched.
  proxy: ProxySchema.nullable().optional(),
  fingerprint: FingerprintInputSchema.optional(),
});

/**
 * Server-level guidance surfaced to any connecting agent via the MCP
 * `initialize` result. Complements the per-tool descriptions with the workflow
 * and the non-obvious constraints (profiles are real windows, headful only,
 * a human may step in) that an agent can't infer from tool signatures alone.
 */
const MULTIZEN_MCP_INSTRUCTIONS = [
  "MultiZen drives real, persistent Chromium profiles — each has its own cookies, login state, fingerprint, and proxy, kept on disk between sessions.",
  "",
  "Workflow:",
  "1. Call list_profiles to see available profiles and which are already running.",
  "2. Call launch_profile before any page action — navigate/click/type/extract/screenshot fail on a profile that is not running. launch_profile is idempotent.",
  "3. Use extract to read the page (URL, title, trimmed accessibility tree) and derive precise CSS selectors from it BEFORE calling click or type.",
  "4. Leave the profile running for follow-up actions; close_profile only when done. State persists either way.",
  "",
  "Constraints:",
  "- Profiles always open as visible desktop windows. There is no headless mode; do not expect one.",
  "- A human operator shares the same window. If you hit a CAPTCHA, 2FA, or login wall, pause and let the user solve it, then continue — the session carries over.",
  "- Do not create or launch profiles in bulk to farm accounts; this is a human-in-the-loop tool for authorized workflows.",
].join("\n");

export function createMultizenMcpServer(opts: MultizenMcpServerOptions): MultizenMcpServer {
  const { profileManager, browserDriver } = opts;
  const activityLog = opts.activityLog ?? new ActivityLog();

  const server = new Server(
    { name: "multizen", version: "0.2.0-pre" },
    {
      capabilities: {
        tools: {},
      },
      // Returned in the `initialize` result so a connecting agent learns the
      // overall workflow up front, not just per-tool descriptions.
      instructions: MULTIZEN_MCP_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const event = activityLog.startCall(name, args);
    const startedAt = Date.now();

    try {
      const result = await dispatch(name, args, { profileManager, browserDriver });
      activityLog.finish(event, "ok", summarize(result), startedAt);
      return ok(result);
    } catch (e) {
      const message = e instanceof z.ZodError ? e.message : e instanceof Error ? e.message : String(e);
      const code =
        e instanceof z.ZodError || e instanceof FingerprintReconcileError
          ? "INVALID_INPUT"
          : "INTERNAL_ERROR";
      activityLog.finish(event, "error", message, startedAt);
      return err(code, message);
    }
  });

  return { server, activityLog };
}

interface DispatchDeps {
  profileManager: ProfileManager;
  browserDriver: BrowserDriver;
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<unknown> {
  const { profileManager, browserDriver } = deps;
  switch (name) {
    case "list_profiles": {
      const profiles = profileManager.list().map((p) => ({
        ...p,
        // Never echo proxy credentials to the agent — redact the summary's proxy.
        proxy: redactedProxy(p.proxy),
        isRunning: browserDriver.isRunning(p.id),
      }));
      return { profiles };
    }
    case "create_profile": {
      const input = CreateProfileSchema.parse(args);
      const createInput: CreateProfileInput = {
        name: input.name,
        notes: input.notes,
        tags: input.tags,
        proxy: input.proxy,
      };
      const seed = input.seed;
      // Build a fingerprint when the caller passes knobs OR a seed. Seed from a
      // fresh coherent fingerprint, apply the high-level knobs (throws on an
      // incoherent combination → INVALID_INPUT), then persist the seed.
      if (input.fingerprint || seed) {
        const reconciled = reconcileFingerprint(generateFingerprint(seed), input.fingerprint ?? {});
        createInput.fingerprint = seed ? { ...reconciled, seed } : reconciled;
      }
      const created = profileManager.create(createInput);
      return {
        id: created.id,
        name: created.name,
        proxy: redactedProxy(created.proxy),
        fingerprint: fingerprintSummary(created.fingerprint),
      };
    }
    case "update_profile": {
      const input = UpdateProfileSchema.parse(args);
      const existing = profileManager.get(input.profile_id);
      if (!existing) throw new Error(`Profile ${input.profile_id} not found`);

      const patch: UpdateProfileInput = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.tags !== undefined) patch.tags = input.tags;
      // `proxy: null` clears it, `proxy: {…}` sets it, omitted leaves as-is.
      if (input.proxy !== undefined) patch.proxy = input.proxy;
      if (input.fingerprint !== undefined) {
        patch.fingerprint = reconcileFingerprint(existing.fingerprint, input.fingerprint);
      }

      const updated = profileManager.update(input.profile_id, patch);
      return {
        id: updated.id,
        name: updated.name,
        tags: updated.tags,
        proxy: redactedProxy(updated.proxy),
        fingerprint: fingerprintSummary(updated.fingerprint),
        // Surface the caveat: a live browser keeps the old proxy/fingerprint.
        appliesOnNextLaunch: browserDriver.isRunning(input.profile_id),
      };
    }
    case "delete_profile": {
      const { profile_id } = ProfileIdSchema.parse(args);
      assertProfileExists(profileManager, profile_id);
      // Close first so Chromium releases the data dir before we remove it
      // (on Windows a live handle would otherwise block the rmSync).
      if (browserDriver.isRunning(profile_id)) {
        await browserDriver.close(profile_id);
      }
      profileManager.delete(profile_id);
      return { deleted: profile_id };
    }
    case "list_fingerprint_options": {
      return { devices: deviceCatalog(), locales: localeCatalog() };
    }
    case "launch_profile": {
      const { profile_id } = ProfileIdSchema.parse(args);
      assertProfileExists(profileManager, profile_id);
      // ChromiumBrowserDriver.launch() handles markOpened internally so
      // every entry-point (UI, MCP, palette) gets the same timestamp.
      const launched = await browserDriver.launch(profile_id);
      return launched;
    }
    case "close_profile": {
      const { profile_id } = ProfileIdSchema.parse(args);
      await browserDriver.close(profile_id);
      return { closed: profile_id };
    }
    case "navigate": {
      const { profile_id, url } = NavigateSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.navigate(profile_id, url);
    }
    case "click": {
      const { profile_id, selector } = ClickSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.click(profile_id, selector);
    }
    case "type": {
      const { profile_id, selector, text } = TypeSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.type(profile_id, selector, text);
    }
    case "extract": {
      const { profile_id } = ExtractSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.extract(profile_id);
    }
    case "screenshot": {
      const { profile_id } = ProfileIdSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.screenshot(profile_id);
    }
    case "evaluate_js": {
      const { profile_id, expression, sessionId } = EvaluateJsSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      // Runtime.evaluate works without Runtime.enable — no domain is enabled.
      return await browserDriver.cdpSend(
        profile_id,
        "Runtime.evaluate",
        { expression, returnByValue: true },
        sessionId,
        { safe: true },
      );
    }
    case "wait_for_selector": {
      const { profile_id, selector, timeout_ms, sessionId } = WaitForSelectorSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      const expression = `!!document.querySelector(${JSON.stringify(selector)})`;
      const found = await pollUntil(
        async () => {
          const res = (await browserDriver.cdpSend(
            profile_id,
            "Runtime.evaluate",
            { expression, returnByValue: true },
            sessionId,
            { safe: true },
          )) as { result?: { value?: unknown } };
          return res?.result?.value === true;
        },
        timeout_ms ?? 30000,
      );
      return { found, selector };
    }
    case "list_tabs": {
      const { profile_id, sessionId } = ListTabsSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.cdpSend(profile_id, "Target.getTargets", {}, sessionId, {
        safe: true,
      });
    }
    case "activate_tab": {
      const { profile_id, target_id, sessionId } = TabIdSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.cdpSend(
        profile_id,
        "Target.activateTarget",
        { targetId: target_id },
        sessionId,
        { safe: true },
      );
    }
    case "close_tab": {
      const { profile_id, target_id, sessionId } = TabIdSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      return await browserDriver.cdpSend(
        profile_id,
        "Target.closeTarget",
        { targetId: target_id },
        sessionId,
        { safe: true },
      );
    }
    case "wait_for_navigation":
    case "wait_for_load": {
      const { profile_id, timeout_ms, sessionId } = WaitForLoadSchema.parse(args);
      assertProfileRunning(browserDriver, profile_id);
      // `Page` is enabled at connect, but waiting on the loadEventFired event
      // requires an event subscription the single cdpSend primitive can't
      // express. Polling document.readyState gives the same readiness signal
      // purely through Runtime.evaluate (no domain enable).
      const loaded = await pollUntil(
        async () => {
          const res = (await browserDriver.cdpSend(
            profile_id,
            "Runtime.evaluate",
            { expression: "document.readyState", returnByValue: true },
            sessionId,
            { safe: true },
          )) as { result?: { value?: unknown } };
          return res?.result?.value === "complete";
        },
        timeout_ms ?? 30000,
      );
      return { loaded };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const PROXY_JSON_SCHEMA = {
  type: "object",
  description: "Per-profile proxy. DNS is resolved remotely via a local SOCKS5 bridge.",
  required: ["type", "host", "port"],
  properties: {
    type: { type: "string", enum: ["http", "socks5"] },
    host: { type: "string" },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    username: { type: "string" },
    password: { type: "string" },
  },
} as const;

const FINGERPRINT_JSON_SCHEMA = {
  type: "object",
  description:
    "High-level fingerprint dimensions. The server derives a coherent UA / Client-Hints / WebGL / locale story from these — raw surfaces cannot be set individually. All fields optional; an incoherent combination is rejected (INVALID_INPUT).",
  properties: {
    device: {
      type: "string",
      enum: [...DEVICE_FAMILIES],
      description: "Device family to impersonate (see list_fingerprint_options).",
    },
    localeId: {
      type: "string",
      description: "Locale group id, e.g. 'en-US', 'de-DE' (see list_fingerprint_options).",
    },
    timezone: {
      type: "string",
      description: "IANA timezone; must belong to the chosen locale.",
    },
    screen: {
      type: "object",
      required: ["width", "height"],
      properties: {
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
      },
    },
    hardwareConcurrency: { type: "integer", minimum: 1 },
    deviceMemory: { type: "number", minimum: 1 },
  },
} as const;

const TOOL_DEFINITIONS = [
  {
    name: "list_profiles",
    description:
      "List all browser profiles available on this machine. Returns id, name, tags, last opened, and running state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_profile",
    description:
      "Create a new browser profile. Only `name` is required; a coherent default fingerprint is generated. Optionally pass a `proxy`, high-level `fingerprint` knobs, and/or a `seed` (rotates canvas/audio/WebGL noise). Call list_fingerprint_options for valid device families and locale ids.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Human-readable name" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        proxy: PROXY_JSON_SCHEMA,
        fingerprint: FINGERPRINT_JSON_SCHEMA,
        seed: { type: "string", description: "Optional entropy seed for the native fingerprint noise." },
      },
    },
  },
  {
    name: "launch_profile",
    description:
      "Launch a profile in patched Chromium. Returns CDP endpoint. Idempotent: returns existing endpoint if already running.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" } },
    },
  },
  {
    name: "close_profile",
    description: "Close a running profile. Cookies and state remain on disk.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" } },
    },
  },
  {
    name: "navigate",
    description: "Navigate the profile's browser to a URL. Waits for page load.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "url"],
      properties: {
        profile_id: { type: "string" },
        url: { type: "string", format: "uri" },
      },
    },
  },
  {
    name: "click",
    description:
      "Click an element by CSS selector. The selector must be precise — call extract first to inspect the page accessibility tree, then derive a selector from it.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "selector"],
      properties: {
        profile_id: { type: "string" },
        selector: {
          type: "string",
          description: "CSS selector, e.g. 'button[type=submit]' or 'input[name=email]'",
        },
      },
    },
  },
  {
    name: "type",
    description: "Type text into an input element by CSS selector.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "selector", "text"],
      properties: {
        profile_id: { type: "string" },
        selector: { type: "string", description: "CSS selector for the input element" },
        text: { type: "string" },
      },
    },
  },
  {
    name: "extract",
    description:
      "Snapshot the current page: returns the URL, title, and a trimmed accessibility tree. The calling LLM is responsible for parsing this into whatever structured data it needs. MultiZen does not call any external API.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: {
        profile_id: { type: "string" },
      },
    },
  },
  {
    name: "screenshot",
    description: "Capture a PNG screenshot of the current viewport. Returns base64.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" } },
    },
  },
  {
    name: "update_profile",
    description:
      "Update an existing profile's name, notes, tags, proxy, and/or fingerprint. Every field is optional — only the ones you pass change. Set `proxy` to null to remove it. Fingerprint changes are reconciled for coherence. If the profile is running, changes apply on the next launch (response includes appliesOnNextLaunch). Proxy credentials are never echoed back.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: {
        profile_id: { type: "string" },
        name: { type: "string" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        proxy: {
          description: "Proxy object to set, or null to clear. Omit to leave unchanged.",
          anyOf: [PROXY_JSON_SCHEMA, { type: "null" }],
        },
        fingerprint: FINGERPRINT_JSON_SCHEMA,
      },
    },
  },
  {
    name: "delete_profile",
    description:
      "Permanently delete a profile and its on-disk data (cookies, Chromium state, installed extensions). Closes the browser first if it's running. This cannot be undone.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" } },
    },
  },
  {
    name: "list_fingerprint_options",
    description:
      "List the valid fingerprint building blocks: device families (with their real screen sizes) and locale groups (locale, country, plausible timezones). Use these values for the `device`, `localeId`, `timezone`, and `screen` fields of create_profile / update_profile.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evaluate_js",
    description:
      "Evaluate a JavaScript expression in the page and return the result by value. Runs via Runtime.evaluate without enabling the Runtime domain (stealth-safe).",
    inputSchema: {
      type: "object",
      required: ["profile_id", "expression"],
      properties: {
        profile_id: { type: "string" },
        expression: { type: "string", description: "JavaScript expression to evaluate" },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "wait_for_selector",
    description:
      "Poll the page until an element matching the CSS selector exists, or the timeout elapses. Returns { found, selector }. Uses Runtime.evaluate polling (no domain enable).",
    inputSchema: {
      type: "object",
      required: ["profile_id", "selector"],
      properties: {
        profile_id: { type: "string" },
        selector: { type: "string", description: "CSS selector to wait for" },
        timeout_ms: { type: "integer", minimum: 1, description: "Wait budget in ms (default 30000)" },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "list_tabs",
    description: "List open targets (tabs/pages) via Target.getTargets.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: { profile_id: { type: "string" }, sessionId: { type: "string" } },
    },
  },
  {
    name: "activate_tab",
    description: "Bring a tab to the foreground via Target.activateTarget.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "target_id"],
      properties: {
        profile_id: { type: "string" },
        target_id: { type: "string", description: "Target id from list_tabs" },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "close_tab",
    description: "Close a tab via Target.closeTarget.",
    inputSchema: {
      type: "object",
      required: ["profile_id", "target_id"],
      properties: {
        profile_id: { type: "string" },
        target_id: { type: "string", description: "Target id from list_tabs" },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "wait_for_navigation",
    description:
      "Wait until the page finishes loading (document.readyState === 'complete'), or the timeout elapses. Returns { loaded }. Polls via Runtime.evaluate (no domain enable).",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: {
        profile_id: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1, description: "Wait budget in ms (default 30000)" },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "wait_for_load",
    description:
      "Alias of wait_for_navigation: wait until document.readyState === 'complete' or the timeout elapses. Returns { loaded }.",
    inputSchema: {
      type: "object",
      required: ["profile_id"],
      properties: {
        profile_id: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1, description: "Wait budget in ms (default 30000)" },
        sessionId: { type: "string" },
      },
    },
  },
];

/** Coherent, non-secret view of a fingerprint for tool responses. */
function fingerprintSummary(fp: FingerprintConfig): {
  device: string;
  locale: string;
  timezone: string;
  screen: { width: number; height: number };
  userAgent: string;
} {
  return {
    device: fp.device,
    locale: fp.locale,
    timezone: fp.timezone,
    screen: fp.screen,
    userAgent: fp.userAgent,
  };
}

/**
 * Proxy view safe to return to an MCP caller: NEVER echo username/password.
 * Redacting the response also defeats the `update_profile {name}`-only
 * password read-back (a caller must never learn a stored proxy's secret it
 * didn't itself just set).
 */
function redactedProxy(
  proxy: ProxyConfig | null | undefined,
): { type: string; host: string; port: number; hasAuth: boolean } | null {
  if (!proxy) return null;
  return {
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    hasAuth: Boolean(proxy.username || proxy.password),
  };
}

function summarize(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 200);
  if (result && typeof result === "object") {
    const keys = Object.keys(result).slice(0, 5).join(", ");
    return `keys: ${keys}`;
  }
  return String(result);
}

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(code: string, message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
  };
}

function assertProfileExists(pm: ProfileManager, id: string): void {
  const p = pm.get(id);
  if (!p) throw new Error(`Profile ${id} not found`);
}

function assertProfileRunning(driver: BrowserDriver, id: string): void {
  if (!driver.isRunning(id)) {
    throw new Error(`Profile ${id} is not running. Call launch_profile first.`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Transient CDP failures raised while a target is mid-navigation: the V8
 * execution context is torn down and recreated, so an in-flight Runtime.evaluate
 * can reject even though the page is perfectly fine a moment later. These are
 * safe to swallow and retry; any other error is a genuine failure (e.g. an
 * invalid selector expression) and must surface immediately.
 */
const TRANSIENT_NAVIGATION_ERROR =
  /execution context was destroyed|Cannot find context|Inspected target (navigated|closed)|No execution context/i;

function isTransientNavigationError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return TRANSIENT_NAVIGATION_ERROR.test(message);
}

/**
 * Poll `check` on a fixed 150ms backoff until it returns true or the budget is
 * exhausted. Returns the final boolean rather than throwing so wait_* tools
 * can report a clean `{ found/loaded: false }` on a normal timeout.
 *
 * Scoped retry: transient navigation errors (execution context destroyed while
 * the page reloads) are swallowed and retried until the budget runs out — never
 * masking real errors, which propagate immediately. If only transient errors
 * are seen right up to the deadline, a clear timeout error is thrown so the
 * caller is not told the page settled when it never did.
 */
async function pollUntil(check: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let lastTransient: Error | undefined;
  for (;;) {
    try {
      if (await check()) return true;
      lastTransient = undefined; // a clean check ran: not stuck on a transient error
    } catch (e) {
      if (!isTransientNavigationError(e)) throw e;
      lastTransient = e instanceof Error ? e : new Error(String(e));
    }
    if (Date.now() >= deadline) {
      if (lastTransient) {
        throw new Error(
          `Timed out after ${budgetMs}ms waiting for the page to settle; ` +
            `last transient navigation error: ${lastTransient.message}`,
        );
      }
      return false;
    }
    await sleep(150);
  }
}
