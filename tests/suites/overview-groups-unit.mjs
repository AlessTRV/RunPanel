import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * How the Overview decides what goes where.
 *
 * The page shows a section per folder, then the projects that are in none,
 * then the services that belong to no project and sit in no folder. Two rules
 * carry the weight and both are easy to get subtly wrong in a component: a
 * service with a project is never listed on its own, whatever its `folder_id`
 * says, and a `folder_id` naming a folder the list no longer has — a folder
 * deleted between two polls — reads as the root rather than vanishing.
 */
export const meta = { name: "overview-groups-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("overview-groups-unit");

  const { groupOverview } = await import(pathToFileURL(join(repoRoot, "lib", "overview-groups.ts")).href);

  const folders = [
    { id: "f1", name: "Clienti" },
    { id: "f2", name: "Interni" },
  ];
  const projects = [
    { id: "p1", folder_id: "f1" },
    { id: "p2", folder_id: null },
    { id: "p3", folder_id: "gone" },
    { id: "p4", folder_id: "f1" },
  ];
  const services = [
    { id: "s1", project_id: "p1", folder_id: null },
    { id: "s2", project_id: null, folder_id: "f2" },
    { id: "s3", project_id: null, folder_id: null },
    { id: "s4", project_id: "p2", folder_id: "f1" },
    { id: "s5", project_id: null, folder_id: "gone" },
  ];

  const grouped = groupOverview(folders, projects, services);

  r.check("one group per folder, in the order the folders came", grouped.folders.map((g) => g.folder.id).join(",") === "f1,f2",
    JSON.stringify(grouped.folders.map((g) => g.folder.id)));
  r.check("a folder lists the projects filed in it, in the order they came",
    grouped.folders[0].projects.map((p) => p.id).join(",") === "p1,p4",
    JSON.stringify(grouped.folders[0].projects.map((p) => p.id)));
  r.check("a folder lists the standalone services filed in it",
    grouped.folders[1].services.map((s) => s.id).join(",") === "s2",
    JSON.stringify(grouped.folders[1].services.map((s) => s.id)));
  r.check("an empty folder is still a group", grouped.folders[1].projects.length === 0);

  r.check("projects in no folder go to the root", grouped.rootProjects.map((p) => p.id).includes("p2"),
    JSON.stringify(grouped.rootProjects.map((p) => p.id)));
  r.check("a project whose folder is gone goes to the root, not nowhere", grouped.rootProjects.map((p) => p.id).includes("p3"),
    JSON.stringify(grouped.rootProjects.map((p) => p.id)));
  r.check("the root keeps the projects' order", grouped.rootProjects.map((p) => p.id).join(",") === "p2,p3");

  r.check("a service with a project is never listed on its own — even with a folder_id",
    ![...grouped.looseServices, ...grouped.folders.flatMap((g) => g.services)].some((s) => s.id === "s1" || s.id === "s4"),
    JSON.stringify(grouped.looseServices.map((s) => s.id)));
  r.check("standalone services in no folder are loose", grouped.looseServices.map((s) => s.id).includes("s3"));
  r.check("a standalone service whose folder is gone is loose", grouped.looseServices.map((s) => s.id).includes("s5"));
  r.check("loose services keep their order", grouped.looseServices.map((s) => s.id).join(",") === "s3,s5",
    JSON.stringify(grouped.looseServices.map((s) => s.id)));

  const empty = groupOverview([], [], []);
  r.check("nothing in, nothing out", empty.folders.length === 0 && empty.rootProjects.length === 0 && empty.looseServices.length === 0);

  return r.result();
}
