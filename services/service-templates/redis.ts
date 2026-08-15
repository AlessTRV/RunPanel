import { IServiceTemplate, ServiceConfig, DockerRunConfig } from "./types";
import { defaultVersionFor } from "@/lib/service-versions";

export const redisTemplate: IServiceTemplate = {
  type: "redis",
  defaultVersion: defaultVersionFor("redis"),

  getDockerConfig(config: ServiceConfig): DockerRunConfig {
    return {
      image: `redis:${config.version}`,
      env: {},
      volumes: [`runpanel-redis-${config.projectSlug ? config.projectSlug + "-" : ""}${config.name}:/data`],
      port: 6379,
    };
  },

  getConnectionString(config: ServiceConfig): string {
    const { password } = config.credentials;
    if (password) {
      return `redis://:${password}@localhost:${config.port}`;
    }
    return `redis://localhost:${config.port}`;
  },
};
