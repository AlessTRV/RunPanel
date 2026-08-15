import { IServiceTemplate, ServiceConfig, DockerRunConfig } from "./types";
import { defaultVersionFor } from "@/lib/service-versions";

export const mongodbTemplate: IServiceTemplate = {
  type: "mongodb",
  defaultVersion: defaultVersionFor("mongodb"),

  getDockerConfig(config: ServiceConfig): DockerRunConfig {
    return {
      image: `mongo:${config.version}`,
      env: {
        MONGO_INITDB_ROOT_USERNAME: config.credentials.user,
        MONGO_INITDB_ROOT_PASSWORD: config.credentials.password,
        MONGO_INITDB_DATABASE: config.credentials.database,
      },
      volumes: [`runpanel-mongo-${config.projectSlug ? config.projectSlug + "-" : ""}${config.name}:/data/db`],
      port: 27017,
    };
  },

  getConnectionString(config: ServiceConfig): string {
    const { user, password, database } = config.credentials;
    return `mongodb://${user}:${password}@localhost:${config.port}/${database}?authSource=admin`;
  },
};
