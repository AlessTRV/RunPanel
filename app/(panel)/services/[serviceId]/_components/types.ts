import type { AccessValue, GateValue } from "@/components/AccessSection";
import type { MountApply } from "@/lib/hooks/useServiceStream";
import type { ServiceMount } from "@/lib/mount";

/**
 * What the page and its panels agree a service looks like.
 *
 * Moved out of `page.tsx` when the page stopped being one component: the
 * connection panel, the console and the data section all need the same shape,
 * and three private copies would drift the moment the API grew a field.
 */

export interface Service {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  port: number;
  credentials: string;
  project_id: string | null;
  created_at: string;
  /** Resolved server-side, from the service template and the owning project. */
  containerName: string;
  internalPort: number;
  envKey: string;
  projectSlug: string | null;
  networkName: string | null;
  /** Whether the linked app really reaches it by container name — see the API. */
  reachedByContainerName: boolean;
  access: AccessValue;
  gate: GateValue;
  /** The bind list this service is declared to run with. */
  mounts: ServiceMount[];
  /** The application in flight, or the last one that finished. */
  mountApply: MountApply | null;
  /** What Docker says is really mounted — the declaration's counterpart. */
  containerMounts: { source: string; target: string }[];
}

export interface Credentials {
  user?: string;
  password?: string;
  database?: string;
}

/**
 * Where the caller is calling from. Owned by the page rather than by the
 * connection panel, because the per-database URLs have to be built for the same
 * viewpoint — a host that answers for one and not the other is the bug this
 * choice exists to prevent.
 */
export type From = "network" | "container" | "host";

/** The sections, on the layout narrow enough to need them one at a time. */
export type ServiceTabId = "connection" | "console" | "data";
