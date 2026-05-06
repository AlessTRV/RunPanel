"use client";

import { useEffect, useState } from "react";
import { Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import Link from "next/link";
import { ProjectCard } from "@/components/ProjectCard";

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

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => setProjects(data))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-sm text-foreground-400">
            Manage your deployed applications
          </p>
        </div>
        <Link href="/projects/new">
          <Button variant="primary">
            <Icon icon="solar:add-circle-bold-duotone" width={20} />
            New Project
          </Button>
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-divider py-20">
          <Icon
            icon="solar:box-bold-duotone"
            className="mb-4 text-foreground-300"
            width={48}
          />
          <p className="text-foreground-400">No projects yet</p>
          <p className="text-sm text-foreground-500">
            Create your first project to get started
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
