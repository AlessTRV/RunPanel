/**
 * Ownership labels.
 *
 * Every container, image, volume and network RunPanel creates is stamped with
 * these. Without them there is no safe way to clean anything up: a prune would
 * either be scoped by name prefix (fragile) or unscoped (and would delete a
 * user's unrelated containers on the same host). Every destructive operation in
 * this module filters on `runpanel.managed=true`.
 */

export const LABEL_MANAGED = "runpanel.managed";
export const LABEL_PROJECT = "runpanel.project";
export const LABEL_KIND = "runpanel.kind";
export const LABEL_DEPLOYMENT = "runpanel.deployment";
export const LABEL_SERVICE = "runpanel.service";

export type ResourceKind = "app" | "service" | "network";

export interface OwnershipLabels {
  project?: string;
  kind?: ResourceKind;
  deployment?: string;
  service?: string;
}

/** `--label k=v` arguments for a create/run/build command. */
export function labelArgs(labels: OwnershipLabels): string[] {
  const pairs: [string, string][] = [[LABEL_MANAGED, "true"]];
  if (labels.project) pairs.push([LABEL_PROJECT, labels.project]);
  if (labels.kind) pairs.push([LABEL_KIND, labels.kind]);
  if (labels.deployment) pairs.push([LABEL_DEPLOYMENT, labels.deployment]);
  if (labels.service) pairs.push([LABEL_SERVICE, labels.service]);

  return pairs.flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

/**
 * `--filter` arguments restricting a listing or prune to RunPanel's own
 * resources. Never call a destructive docker command without these.
 */
export function ownedFilters(labels: OwnershipLabels = {}): string[] {
  const filters = [`${LABEL_MANAGED}=true`];
  if (labels.project) filters.push(`${LABEL_PROJECT}=${labels.project}`);
  if (labels.kind) filters.push(`${LABEL_KIND}=${labels.kind}`);
  if (labels.deployment) filters.push(`${LABEL_DEPLOYMENT}=${labels.deployment}`);

  return filters.flatMap((f) => ["--filter", `label=${f}`]);
}

// --- Naming -----------------------------------------------------------------
// Kept in one place so the GC and the drivers cannot drift apart on what a
// RunPanel-owned name looks like.

export const appContainerName = (slug: string) => `runpanel-${slug}`;
export const imageRepo = (slug: string) => `runpanel/${slug}`;
export const networkName = (slug: string) => `runpanel-net-${slug}`;

export function serviceContainerName(serviceName: string, projectSlug?: string | null): string {
  return projectSlug ? `runpanel-svc-${projectSlug}-${serviceName}` : `runpanel-svc-${serviceName}`;
}
