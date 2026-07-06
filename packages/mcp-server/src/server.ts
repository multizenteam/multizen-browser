import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ProfileManager } from "@multizen/profile-manager";
import type { LaunchedProfile, ProfileId } from "@multizen/types";
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
const CreateProfileSchema = z.object({
  name: z.string().min(1),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
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
      const code = e instanceof z.ZodError ? "INVALID_INPUT" : "INTERNAL_ERROR";
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
        isRunning: browserDriver.isRunning(p.id),
      }));
      return { profiles };
    }
    case "create_profile": {
      const input = CreateProfileSchema.parse(args);
      const created = profileManager.create(input);
      return { id: created.id, name: created.name };
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const TOOL_DEFINITIONS = [
  {
    name: "list_profiles",
    description:
      "List all browser profiles available on this machine. Returns id, name, tags, last opened, and running state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_profile",
    description: "Create a new browser profile with sensible default fingerprint.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Human-readable name" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
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
];

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
