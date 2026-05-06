import { IServiceTemplate, ServiceConfig, DockerRunConfig } from "./types";

export const redisTemplate: IServiceTemplate = {
  type: "redis",
  defaultVersion: "7",
  availableVersions: ["7", "6"],

  getDockerConfig(config: ServiceConfig): DockerRunConfig {
    return {
      image: `redis:${config.version}`,
      env: {},
      volumes: [`runpanel-redis-${config.name}:/data`],
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
