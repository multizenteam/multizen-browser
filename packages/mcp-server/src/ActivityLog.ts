import { EventEmitter } from "node:events";

export interface ActivityEvent {
  id: string;
  timestamp: string;
  /** Tool name as called via MCP, e.g. "navigate" */
  tool: string;
  profileId?: string;
  /** Sanitized args (no secrets) */
  args: Record<string, unknown>;
  /** "ok" if completed, "error" if threw, "pending" if still running */
  status: "pending" | "ok" | "error";
  /** Result summary or error message */
  summary?: string;
  durationMs?: number;
}

interface ActivityLogEvents {
  event: (e: ActivityEvent) => void;
}

/**
 * Emits ActivityEvent for every MCP tool call. The renderer subscribes
 * via IPC, the desktop app shows them in real-time, and they can also
 * be piped to a JSONL file for audit.
 */
export class ActivityLog extends EventEmitter {
  private readonly buffer: ActivityEvent[] = [];
  private readonly maxBuffer = 500;

  override on<K extends keyof ActivityLogEvents>(event: K, listener: ActivityLogEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof ActivityLogEvents>(
    event: K,
    ...args: Parameters<ActivityLogEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  startCall(tool: string, args: Record<string, unknown>): ActivityEvent {
    const event: ActivityEvent = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      tool,
      profileId: typeof args.profile_id === "string" ? args.profile_id : undefined,
      args: sanitize(args),
      status: "pending",
    };
    this.push(event);
    return event;
  }

  finish(event: ActivityEvent, status: "ok" | "error", summary: string, startedAt: number): void {
    event.status = status;
    event.summary = summary.slice(0, 500);
    event.durationMs = Date.now() - startedAt;
    this.emit("event", event);
  }

  recent(limit = 200): ActivityEvent[] {
    return this.buffer.slice(-limit);
  }

  private push(e: ActivityEvent): void {
    this.buffer.push(e);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }
    this.emit("event", e);
  }
}

function sanitize(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "text" && typeof v === "string" && v.length > 80) {
      out[k] = `${v.slice(0, 60)}…[${v.length} chars]`;
    } else if (k === "proxy" && v && typeof v === "object") {
      // Proxy credentials are secrets — never let them reach the activity
      // stream / audit log.
      out[k] = redactProxy(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactProxy(proxy: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...proxy };
  if (typeof out.username === "string" && out.username.length > 0) out.username = "***";
  if (typeof out.password === "string" && out.password.length > 0) out.password = "***";
  return out;
}
