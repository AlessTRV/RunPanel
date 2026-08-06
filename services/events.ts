import { EventEmitter } from "events";

/**
 * In-process pub/sub for everything a project emits while it is being deployed
 * or while it runs.
 *
 * This is what replaces the polling: the UI opens one SSE connection per
 * project and receives deploy progress, build output and process output as they
 * happen, instead of re-fetching the whole log every three seconds and trying
 * to work out what is new.
 *
 * In-process is the right scope here — RunPanel is a single-process panel, and
 * a deploy is driven by the same process that serves the stream.
 */

export type ProjectEvent =
  | { type: "deploy:status"; deploymentId: string; status: string; message?: string }
  | { type: "deploy:log"; deploymentId: string; line: string }
  | { type: "process:log"; line: string; stream: "stdout" | "stderr" }
  | { type: "process:status"; status: string; running: boolean; pid?: number; uptime?: number }
  | { type: "terminal:output"; text: string }
  | { type: "terminal:closed"; code: number | null };

type Listener = (event: ProjectEvent) => void;

class ProjectEventBus {
  private emitter = new EventEmitter();

  constructor() {
    // A project with several browser tabs open, each with several widgets,
    // legitimately exceeds Node's default warning threshold of 10.
    this.emitter.setMaxListeners(200);
  }

  emit(projectId: string, event: ProjectEvent): void {
    this.emitter.emit(projectId, event);
  }

  subscribe(projectId: string, listener: Listener): () => void {
    this.emitter.on(projectId, listener);
    return () => {
      this.emitter.off(projectId, listener);
    };
  }

  subscriberCount(projectId: string): number {
    return this.emitter.listenerCount(projectId);
  }
}

// Held on globalThis so dev-mode module reloading does not orphan subscribers
// on an emitter nobody publishes to any more.
const globalRef = globalThis as typeof globalThis & { __runpanelEvents?: ProjectEventBus };

export const projectEvents = (globalRef.__runpanelEvents ??= new ProjectEventBus());
