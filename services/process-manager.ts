import { IProcessDriver, ProcessInfo, StartOpts, OutputCallback } from "./process-drivers/types";
import { pm2Driver } from "./process-drivers/pm2-driver";
import { dockerDriver } from "./process-drivers/docker-driver";

function getDriver(runtimeType: string): IProcessDriver {
  if (runtimeType === "docker") return dockerDriver;
  return pm2Driver; // node and static use PM2
}

export const processManager = {
  start(slug: string, startCmd: string, runtimeType: string, opts: StartOpts): Promise<void> {
    return getDriver(runtimeType).start(slug, startCmd, opts);
  },

  stop(slug: string, runtimeType: string): Promise<void> {
    return getDriver(runtimeType).stop(slug);
  },

  /** Stop AND tear down. Use on delete, never on a plain stop. */
  remove(slug: string, runtimeType: string): Promise<void> {
    return getDriver(runtimeType).remove(slug);
  },

  restart(slug: string, runtimeType: string): Promise<void> {
    return getDriver(runtimeType).restart(slug);
  },

  status(slug: string, runtimeType: string): Promise<ProcessInfo> {
    return getDriver(runtimeType).status(slug);
  },

  logs(slug: string, runtimeType: string, lines: number): Promise<string[]> {
    return getDriver(runtimeType).logs(slug, lines);
  },

  onOutput(slug: string, runtimeType: string, callback: OutputCallback): () => void {
    return getDriver(runtimeType).onOutput(slug, callback);
  },
};
