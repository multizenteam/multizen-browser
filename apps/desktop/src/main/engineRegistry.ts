import { EventEmitter } from "node:events";
import type { BrowserEngine, ChromiumStatus } from "@multizen/types";
import { ChromiumBootstrap } from "./ChromiumBootstrap.ts";

/**
 * Engines that run on the Chromium/CDP stack and are therefore served by
 * {@link ChromiumBootstrap}. Camoufox (Firefox family) ships its own bootstrap
 * in a later phase, so it is intentionally absent here for now.
 */
const CHROMIUM_ENGINES: readonly BrowserEngine[] = ["cloakbrowser"];

export function isChromiumEngine(engine: BrowserEngine): boolean {
  return CHROMIUM_ENGINES.includes(engine);
}

interface EngineRegistryEvents {
  /** A per-engine bootstrap status update, tagged with the engine it came from. */
  status: (engine: BrowserEngine, status: ChromiumStatus) => void;
}

/**
 * Lazily owns one {@link ChromiumBootstrap} per Chromium engine, replacing the
 * former single global bootstrap. A bootstrap is created + event-wired the
 * first time an engine is requested; its status events are re-emitted here
 * tagged with the engine so the main process can fan them out per engine.
 */
export class EngineRegistry extends EventEmitter {
  private readonly bootstraps = new Map<BrowserEngine, ChromiumBootstrap>();

  override on<K extends keyof EngineRegistryEvents>(
    event: K,
    listener: EngineRegistryEvents[K],
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof EngineRegistryEvents>(
    event: K,
    ...args: Parameters<EngineRegistryEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  /**
   * The bootstrap for a Chromium engine, created + event-wired on first use.
   * Throws for a non-Chromium engine (e.g. Camoufox before its bootstrap
   * exists) so a misrouted launch fails loudly instead of silently.
   */
  get(engine: BrowserEngine): ChromiumBootstrap {
    let bootstrap = this.bootstraps.get(engine);
    if (!bootstrap) {
      if (!isChromiumEngine(engine)) {
        throw new Error(`No Chromium bootstrap available for engine "${engine}"`);
      }
      bootstrap = new ChromiumBootstrap({ engine });
      bootstrap.on("status", (status: ChromiumStatus) => this.emit("status", engine, status));
      this.bootstraps.set(engine, bootstrap);
    }
    return bootstrap;
  }

  /** Idempotently download/verify an engine's binary; safe to call in the background. */
  async ensure(engine: BrowserEngine): Promise<ChromiumStatus> {
    return this.get(engine).ensure();
  }

  /** Current status for an engine (creates its bootstrap if untouched). */
  getStatus(engine: BrowserEngine): ChromiumStatus {
    return this.get(engine).getStatus();
  }

  /** Engines that have been instantiated so far (touched via get/ensure/getStatus). */
  instantiatedEngines(): BrowserEngine[] {
    return [...this.bootstraps.keys()];
  }
}
