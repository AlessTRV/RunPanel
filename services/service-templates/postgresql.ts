import { IServiceTemplate, ServiceConfig, DockerRunConfig } from "./types";

export const postgresqlTemplate: IServiceTemplate = {
  type: "postgresql",
  defaultVersion: "16",
  availableVersions: ["16", "15", "14", "13"],

  getDockerConfig(config: ServiceConfig): DockerRunConfig {
    return {
      image: `postgres:${config.version}`,
      env: {
        POSTGRES_USER: config.credentials.user,
        POSTGRES_PASSWORD: config.credentials.password,
        POSTGRES_DB: config.credentials.database,
      },
      volumes: [`runpanel-pg-${config.name}:/var/lib/postgresql/data`],
      port: 5432,
    };
  },

  getConnectionString(config: ServiceConfig): string {
    const { user, password, database } = config.credentials;
    return `postgresql://${user}:${password}@localhost:${config.port}/${database}`;
  },
};
