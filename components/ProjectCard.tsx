"use client";

import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@heroui/react";
import { Icon } from "@iconify/react";
import { StatusBadge } from "./StatusBadge";

interface Project {
  id: string;
  name: string;
  slug: string;
  source_type: string;
  runtime_type: string;
  status: string;
  port: number | null;
  deploy_count: number;
  last_deploy_at: string | null;
}

const runtimeIcons: Record<string, string> = {
  node: "solar:code-bold-duotone",
  static: "solar:document-bold-duotone",
  docker: "solar:box-minimalistic-bold-duotone",
};

export function ProjectCard({ project }: { project: Project }) {
  return (
    <Link href={`/projects/${project.id}`}>
      <Card className="transition-all hover:bg-content2 cursor-pointer">
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Icon
                  icon={runtimeIcons[project.runtime_type] || runtimeIcons.node}
                  className="text-primary"
                  width={22}
                />
              </div>
              <div>
                <CardTitle className="text-base">{project.name}</CardTitle>
                <CardDescription>{project.slug}</CardDescription>
              </div>
            </div>
            <StatusBadge status={project.status} />
          </div>
        </CardHeader>
        <CardFooter className="text-xs text-foreground-400 flex gap-4 border-t border-divider pt-3">
          <span className="flex items-center gap-1">
            <Icon icon="solar:upload-bold-duotone" width={14} />
            {project.deploy_count} deploys
          </span>
          {project.port && (
            <span className="flex items-center gap-1">
              <Icon icon="solar:link-bold-duotone" width={14} />
              :{project.port}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Icon icon={project.source_type === "github" ? "solar:global-bold-duotone" : "solar:archive-bold-duotone"} width={14} />
            {project.source_type}
          </span>
        </CardFooter>
      </Card>
    </Link>
  );
}
