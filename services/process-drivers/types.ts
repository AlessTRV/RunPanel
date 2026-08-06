export interface ProcessInfo {
  running: boolean;
  pid?: number;
  uptime?: number;
  memory?: number;
  cpu?: number;
  containerId?: string;
}

export type RestartPolicy = "no" | "on-failure" | "unless-stopped" | "always";
export type NetworkMode = "project" | "bridge" | "host";

export interface StartOpts {
  cwd: string;
  env: Record<string, string>;
  port: number;
  onLog?: (line: string) => void;
  /** Stamped on the container so the GC can tell which build it came from. */
  deploymentId?: string;
  /** Defaults to `unless-stopped`, so a deploy survives a host reboot. */
  restartPolicy?: RestartPolicy;

  // --- container-only options, ignored by native drivers ---
  network?: NetworkMode;
  /** Useful under `network: host` to stop the app binding every interface. */
  hostname?: string;
  capAdd?: string[];
  extraHosts?: string[];
  /** `source:target[:ro]` bind mounts. */
  mounts?: string[];
  memory?: string;
  cpus?: string;
  shmSize?: string;
}

export type OutputCallback = (line: string, stream: "stdout" | "stderr") => void;

export interface IProcessDriver {
  start(slug: string, startCmd: string, opts: StartOpts): Promise<void>;
  stop(slug: string): Promise<void>;
  /**
   * Tear the process down for good.
   *
   * Distinct from `stop` on purpose: stopping a container must leave it in
   * place so it can be started again, but a stopped container still holds a
   * reference to its image — so deleting a project without this leaves both the
   * container and its image on disk forever.
   */
  remove(slug: string): Promise<void>;
  restart(slug: string): Promise<void>;
  status(slug: string): Promise<ProcessInfo>;
  logs(slug: string, lines: number): Promise<string[]>;
  onOutput(slug: string, callback: OutputCallback): () => void;
}
