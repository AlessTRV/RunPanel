/**
 * How the Overview decides what goes where.
 *
 * Pure and dependency-free on purpose: the rules below are the ones a page
 * component gets subtly wrong, and a function with no React in it can be
 * asserted on in milliseconds (`tests/suites/overview-groups-unit.mjs`).
 */

export interface FolderLike {
  id: string;
  name: string;
}

interface Filed {
  folder_id: string | null;
}

interface ServiceLike extends Filed {
  project_id: string | null;
}

export interface FolderGroup<P, S> {
  folder: FolderLike;
  projects: P[];
  services: S[];
}

export interface OverviewGroups<P, S> {
  /** One per folder, in the order the folders were given, empty ones included. */
  folders: FolderGroup<P, S>[];
  /** Projects filed nowhere — or somewhere that no longer exists. */
  rootProjects: P[];
  /** Services with no project and no folder. */
  looseServices: S[];
}

/**
 * Two rules carry the weight.
 *
 * A service that belongs to a project is never listed on its own, whatever
 * its `folder_id` says: it shows under the project. And a `folder_id` naming
 * a folder the list does not have — one deleted between two polls, since the
 * folders and the rows are fetched separately — reads as the root rather than
 * making the row vanish until the next refresh.
 */
export function groupOverview<P extends Filed, S extends ServiceLike>(
  folders: FolderLike[],
  projects: P[],
  services: S[]
): OverviewGroups<P, S> {
  const groups = new Map<string, FolderGroup<P, S>>();
  for (const folder of folders) groups.set(folder.id, { folder, projects: [], services: [] });

  const rootProjects: P[] = [];
  for (const project of projects) {
    const group = project.folder_id ? groups.get(project.folder_id) : undefined;
    if (group) group.projects.push(project);
    else rootProjects.push(project);
  }

  const looseServices: S[] = [];
  for (const service of services) {
    if (service.project_id) continue;
    const group = service.folder_id ? groups.get(service.folder_id) : undefined;
    if (group) group.services.push(service);
    else looseServices.push(service);
  }

  return { folders: [...groups.values()], rootProjects, looseServices };
}
