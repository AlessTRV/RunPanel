import { IServiceTemplate, ServiceConfig, DockerRunConfig } from "./types";
import { defaultVersionFor } from "@/lib/service-versions";

export const mysqlTemplate: IServiceTemplate = {
  type: "mysql",
  defaultVersion: defaultVersionFor("mysql"),

  getDockerConfig(config: ServiceConfig): DockerRunConfig {
    return {
      image: `mysql:${config.version}`,
      env: {
        MYSQL_ROOT_PASSWORD: config.credentials.password,
        MYSQL_DATABASE: config.credentials.database,
        MYSQL_USER: config.credentials.user,
        MYSQL_PASSWORD: config.credentials.password,
      },
      volumes: [`runpanel-mysql-${config.projectSlug ? config.projectSlug + "-" : ""}${config.name}:/var/lib/mysql`],
      port: 3306,
    };
  },

  getConnectionString(config: ServiceConfig): string {
    const { user, password, database } = config.credentials;
    return `mysql://${user}:${password}@localhost:${config.port}/${database}`;
  },
};
