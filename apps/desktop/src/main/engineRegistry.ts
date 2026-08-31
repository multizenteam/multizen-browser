import { EventEmitter } from "node:events";
import type { BrowserEngine, ChromiumStatus } from "@multizen/types";
import { ChromiumBootstrap } from "./ChromiumBootstrap.ts";
import { CamoufoxBootstrap } from "./CamoufoxBootstrap.ts";

/** Engines that run on the Chromium/CDP stack, served by {@link ChromiumBootstrap}. */
const CHROMIUM_ENGINES: readonly BrowserEngine[] = ["cloakbrowser"];

export function isChromiumEngine(engine: BrowserEngine): boolean {
  return CHROMIUM_ENGINES.includes(engine);
}

/**
 * The engine-neutral surface the registry needs from any engine's bootstrap.
 * Both {@link ChromiumBootstrap} (CloakBrowser) and {@link CamoufoxBootstrap}
 * satisfy it, so the registry can hold either without caring about the browser
 * family. Chromium-only update primitives (resolveLatestVersion/stageVersion/…)
 * live on ChromiumBootstrap; reach them via {@link EngineRegistry.getChromiumBootstrap}.
 */
export interface EngineBootstrap {
  ensure(): Promise<ChromiumStatus>;
  getStatus(): ChromiumStatus;
  resolveBinaryPath(): string;
  getInstalledVersion(): string | null;
  on(event: "status", listener: (status: ChromiumStatus) => void): this;
}

interface EngineRegistryEvents {
  /** A per-engine bootstrap status update, tagged with the engine it came from. */
  status: (engine: BrowserEngine, status: ChromiumStatus) => void;
}

/**
 * Lazily owns one bootstrap per engine, replacing the former single global
 * bootstrap. A bootstrap is created + status-wired the first time its engine is
 * requested; its status events are re-emitted here tagged with the engine so the
 * main process can fan them out per engine. CamoufoxBootstrap lazy-loads
 * camoufox-js only when it downloads/locates its binary, so importing this
 * registry never pulls camoufox-js into app startup.
 */
export class EngineRegistry extends EventEmitter {
  private readonly bootstraps = new Map<BrowserEngine, EngineBootstrap>();

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
   * The bootstrap for an engine, created + status-wired on first use. Chromium
   * engines get a ChromiumBootstrap; camoufox gets a CamoufoxBootstrap.
   */
  get(engine: BrowserEngine): EngineBootstrap {
    let bootstrap = this.bootstraps.get(engine);
    if (!bootstrap) {
      bootstrap = this.create(engine);
      bootstrap.on("status", (status: ChromiumStatus) => this.emit("status", engine, status));
      this.bootstraps.set(engine, bootstrap);
    }
    return bootstrap;
  }

  private create(engine: BrowserEngine): EngineBootstrap {
    if (isChromiumEngine(engine)) return new ChromiumBootstrap({ engine });
    if (engine === "camoufox") return new CamoufoxBootstrap();
    throw new Error(`No bootstrap available for engine "${engine}"`);
  }

  /**
   * The concrete ChromiumBootstrap for a Chromium engine — for consumers that
   * need its Chromium-only update primitives (e.g. EngineUpdateService). Throws
   * for a non-Chromium engine.
   */
  getChromiumBootstrap(engine: BrowserEngine): ChromiumBootstrap {
    if (!isChromiumEngine(engine)) {
      throw new Error(`Engine "${engine}" is not a Chromium engine`);
    }
    return this.get(engine) as ChromiumBootstrap;
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
