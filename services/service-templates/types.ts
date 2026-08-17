import type { ServiceMount } from "@/lib/mount";

export interface ServiceConfig {
  name: string;
  type: "postgresql" | "mysql" | "redis" | "mongodb";
  version: string;
  port: number;
  credentials: { user: string; password: string; database: string };
  projectSlug?: string;
  /**
   * The bind mounts this service runs with, on top of the volume the template
   * declares.
   *
   * The templates do not read them, on purpose. They keep declaring the volume
   * they would create, because that is the question `serviceVolumeNames` asks
   * them and the answer has to stay the same whatever is bound over it — the
   * merge happens once, in `provisionService`.
   */
  mounts?: ServiceMount[];
}

export interface DockerRunConfig {
  image: string;
  env: Record<string, string>;
  volumes: string[];
  port: number;
}

export interface IServiceTemplate {
  type: string;
  /**
   * Only ever used to fill in a probe config in `service-provisioner.ts`, where
   * the answer being computed does not depend on it. Read from
   * `lib/service-versions.ts` so it cannot contradict what the wizard offers.
   *
   * The sibling `availableVersions` that used to live here was read by nothing
   * at all, and had quietly drifted out of agreement with the list the wizard
   * actually shows. There is one list now, and it is not here.
   */
  defaultVersion: string;
  getDockerConfig(config: ServiceConfig): DockerRunConfig;
  getConnectionString(config: ServiceConfig): string;
}
