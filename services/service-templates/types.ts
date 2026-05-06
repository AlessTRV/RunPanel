export interface ServiceConfig {
  name: string;
  type: "postgresql" | "mysql" | "redis" | "mongodb";
  version: string;
  port: number;
  credentials: { user: string; password: string; database: string };
}

export interface DockerRunConfig {
  image: string;
  env: Record<string, string>;
  volumes: string[];
  port: number;
}

export interface IServiceTemplate {
  type: string;
  defaultVersion: string;
  availableVersions: string[];
  getDockerConfig(config: ServiceConfig): DockerRunConfig;
  getConnectionString(config: ServiceConfig): string;
}
