import { IServiceTemplate, ServiceConfig, DockerRunConfig } from "./types";

export const mysqlTemplate: IServiceTemplate = {
  type: "mysql",
  defaultVersion: "8",
  availableVersions: ["8", "5.7"],

  getDockerConfig(config: ServiceConfig): DockerRunConfig {
    return {
      image: `mysql:${config.version}`,
      env: {
        MYSQL_ROOT_PASSWORD: config.credentials.password,
        MYSQL_DATABASE: config.credentials.database,
        MYSQL_USER: config.credentials.user,
        MYSQL_PASSWORD: config.credentials.password,
      },
      volumes: [`runpanel-mysql-${config.name}:/var/lib/mysql`],
      port: 3306,
    };
  },

  getConnectionString(config: ServiceConfig): string {
    const { user, password, database } = config.credentials;
    return `mysql://${user}:${password}@localhost:${config.port}/${database}`;
  },
};
