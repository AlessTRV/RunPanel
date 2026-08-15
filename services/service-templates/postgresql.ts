import { IServiceTemplate, ServiceConfig, DockerRunConfig } from "./types";
import { defaultVersionFor, postgresVolumePath } from "@/lib/service-versions";

export const postgresqlTemplate: IServiceTemplate = {
  type: "postgresql",
  defaultVersion: defaultVersionFor("postgresql"),

  getDockerConfig(config: ServiceConfig): DockerRunConfig {
    return {
      image: `postgres:${config.version}`,
      env: {
        POSTGRES_USER: config.credentials.user,
        POSTGRES_PASSWORD: config.credentials.password,
        POSTGRES_DB: config.credentials.database,
      },
      /*
        The mount point follows the major — see `postgresVolumePath`. The volume
        NAME deliberately does not: `serviceVolumeNames` probes this function
        with the template's default version rather than the service's own, and
        takes only the part before the colon. A name that varied by version
        would make deleting a PostgreSQL 15 service compute the volume of a
        PostgreSQL 18 one.
      */
      volumes: [
        `runpanel-pg-${config.projectSlug ? config.projectSlug + "-" : ""}${config.name}:${postgresVolumePath(config.version)}`,
      ],
      port: 5432,
    };
  },

  getConnectionString(config: ServiceConfig): string {
    const { user, password, database } = config.credentials;
    return `postgresql://${user}:${password}@localhost:${config.port}/${database}`;
  },
};
