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
  /**
   * A new run is about to start and its output begins from nothing — see
   * `process-drivers/run-log.ts`. Emitted before the process is replaced, so a
   * viewer clears the old run's lines instead of appending the new ones under
   * them, which is what made a log look like it had never changed.
   */
  | { type: "process:reset" }
  | { type: "process:status"; status: string; running: boolean; pid?: number; uptime?: number }
  | { type: "terminal:output"; text: string }
  | { type: "terminal:closed"; code: number | null }
  /** Applying the bind list — see `services/project-mounts.ts`. */
  | { type: "mount:log"; line: string }
  | { type: "mount:phase"; phase: MountPhase; error?: string }
  | { type: "mount:progress"; copiedKb: number; totalKb: number | null };

/**
 * Everything a long operation that is not a project emits: a backup run, a
 * restore, the boot reconciler.
 *
 * A separate channel rather than a synthetic project id. `projectEvents` is
 * keyed by project because every one of its events belongs to one, and the
 * three operations here routinely belong to none — a backup of the panel's own
 * store, a policy that touches ten projects, a standalone service being
 * restored. Forcing them through a `"__system"` key would make the key mean two
 * things, which is how the four disagreeing status maps in `lib/status.ts` came
 * about in the first place.
 */
export type OpsEvent =
  | { type: "backup:log"; line: string }
  | { type: "backup:status"; status: string; message?: string }
  | { type: "backup:artifact"; label: string; status: string; bytes?: number; error?: string }
  | { type: "restore:log"; line: string }
  | { type: "restore:status"; status: string; message?: string }
  | { type: "autostart:log"; line: string };

/**
 * What one service emits: a console session, and the move of its data.
 *
 * A third channel rather than a corner of one of the two above, for the reason
 * the comment on `OpsEvent` already gives. `projectEvents` is keyed by project
 * and a service need not have one — `services.project_id` is nullable, and a
 * standalone database is an ordinary thing here. `opsEvents` is keyed by the id
 * of a run that starts, finishes and is then history; a service outlives every
 * console session opened on it. Keyed by service id, which means exactly one
 * thing.
 */
export type ConsoleMode = "engine" | "shell" | "logs";

export type MountPhase =
  | "checking"
  | "stopping"
  | "seeding"
  | "recreating"
  | "verifying"
  | "rolling-back"
  | "done"
  | "failed";

export type ServiceEvent =
  | { type: "console:output"; mode: ConsoleMode; text: string }
  | { type: "console:closed"; mode: ConsoleMode; code: number | null }
  /** Applying the bind list — see `services/service-mounts.ts`. */
  | { type: "mount:log"; line: string }
  | { type: "mount:phase"; phase: MountPhase; error?: string }
  | { type: "mount:progress"; copiedKb: number; totalKb: number | null };

/**
 * One emitter, keyed by a channel string. Three instances rather than three
 * classes: the wiring is identical and only the event union and the meaning of
 * the key differ.
 */
class ChannelBus<TEvent> {
  private emitter = new EventEmitter();

  constructor() {
    // A project with several browser tabs open, each with several widgets,
    // legitimately exceeds Node's default warning threshold of 10.
    this.emitter.setMaxListeners(200);
  }

  emit(channel: string, event: TEvent): void {
    this.emitter.emit(channel, event);
  }

  subscribe(channel: string, listener: (event: TEvent) => void): () => void {
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }

  subscriberCount(channel: string): number {
    return this.emitter.listenerCount(channel);
  }
}

// Held on globalThis so dev-mode module reloading does not orphan subscribers
// on an emitter nobody publishes to any more.
const globalRef = globalThis as typeof globalThis & {
  __runpanelEvents?: ChannelBus<ProjectEvent>;
  __runpanelOpsEvents?: ChannelBus<OpsEvent>;
  __runpanelServiceEvents?: ChannelBus<ServiceEvent>;
};

export const projectEvents = (globalRef.__runpanelEvents ??= new ChannelBus<ProjectEvent>());

/** Keyed by run id, or by `HOST_CHANNEL` for things that belong to the machine. */
export const opsEvents = (globalRef.__runpanelOpsEvents ??= new ChannelBus<OpsEvent>());

/** Keyed by service id. */
export const serviceEvents = (globalRef.__runpanelServiceEvents ??= new ChannelBus<ServiceEvent>());

export const HOST_CHANNEL = "host";
