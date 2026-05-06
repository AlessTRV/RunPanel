export interface ProcessInfo {
  running: boolean;
  pid?: number;
  uptime?: number;
  memory?: number;
  cpu?: number;
  containerId?: string;
}

export interface StartOpts {
  cwd: string;
  env: Record<string, string>;
  port: number;
  onLog?: (line: string) => void;
}

export type OutputCallback = (line: string, stream: "stdout" | "stderr") => void;

export interface IProcessDriver {
  start(slug: string, startCmd: string, opts: StartOpts): Promise<void>;
  stop(slug: string): Promise<void>;
  restart(slug: string): Promise<void>;
  status(slug: string): Promise<ProcessInfo>;
  logs(slug: string, lines: number): Promise<string[]>;
  onOutput(slug: string, callback: OutputCallback): () => void;
}
