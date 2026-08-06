/**
 * The catalogue of things that can be added to a project.
 *
 * Module constants, not values rebuilt inside the component on every render —
 * the docker template list used to be declared in the render body, so every
 * keystroke in the wizard allocated it again.
 */

export type ServiceType = "postgresql" | "mysql" | "redis" | "mongodb";

export interface DatabaseOption {
  type: ServiceType;
  label: string;
  icon: string;
  defaultPort: number;
  versions: string[];
  /** Redis has no user or database name, only a password. */
  credentialled: boolean;
}

export const DATABASE_OPTIONS: DatabaseOption[] = [
  { type: "postgresql", label: "PostgreSQL", icon: "solar:database-linear", defaultPort: 5432, versions: ["16", "15", "14"], credentialled: true },
  { type: "mysql", label: "MySQL", icon: "solar:database-linear", defaultPort: 3306, versions: ["8", "5.7"], credentialled: true },
  { type: "redis", label: "Redis", icon: "solar:bolt-linear", defaultPort: 6379, versions: ["7", "6"], credentialled: false },
  { type: "mongodb", label: "MongoDB", icon: "solar:database-linear", defaultPort: 27017, versions: ["7", "6", "5"], credentialled: true },
];

export interface TemplateField {
  key: string;
  label: string;
  placeholder: string;
  default: string;
}

export interface DockerTemplate {
  id: string;
  label: string;
  icon: string;
  description: string;
  image: string;
  versions: string[];
  defaultPort: string;
  fields: TemplateField[];
}

export const DOCKER_TEMPLATES: DockerTemplate[] = [
  {
    id: "nginx",
    label: "Nginx",
    icon: "solar:server-2-linear",
    description: "Web server e reverse proxy",
    image: "nginx",
    versions: ["1.27", "1.26", "1.25"],
    defaultPort: "80",
    fields: [
      { key: "serverName", label: "Server name", placeholder: "localhost", default: "localhost" },
      { key: "rootDir", label: "Root directory", placeholder: "/usr/share/nginx/html", default: "/usr/share/nginx/html" },
      { key: "configFile", label: "Config (opzionale)", placeholder: "nginx.conf", default: "" },
    ],
  },
  {
    id: "apache",
    label: "Apache",
    icon: "solar:server-2-linear",
    description: "HTTP server",
    image: "httpd",
    versions: ["2.4"],
    defaultPort: "80",
    fields: [
      { key: "documentRoot", label: "Document root", placeholder: "/var/www/html", default: "/var/www/html" },
      { key: "serverAdmin", label: "Email amministratore", placeholder: "admin@example.com", default: "" },
    ],
  },
  {
    id: "caddy",
    label: "Caddy",
    icon: "solar:shield-check-linear",
    description: "Web server con HTTPS automatico",
    image: "caddy",
    versions: ["2.9", "2.8", "2.7"],
    defaultPort: "80",
    fields: [
      { key: "domain", label: "Dominio", placeholder: "example.com", default: "" },
      { key: "rootDir", label: "Root directory", placeholder: "/srv", default: "/srv" },
      { key: "caddyfile", label: "Caddyfile (opzionale)", placeholder: "Caddyfile", default: "" },
    ],
  },
];

export function databaseOption(type: ServiceType): DatabaseOption {
  return DATABASE_OPTIONS.find((o) => o.type === type) ?? DATABASE_OPTIONS[0];
}

export function dockerTemplate(id: string): DockerTemplate | undefined {
  return DOCKER_TEMPLATES.find((t) => t.id === id);
}
