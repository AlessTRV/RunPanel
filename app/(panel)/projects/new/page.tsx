"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, TextField, Label, Input, Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

export default function NewProjectPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");

  async function handleCreate() {
    if (!name.trim()) {
      toast.error("Project name is required");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to create project");
        return;
      }

      const project = await res.json();
      toast.success("Project created");
      router.push("/home");
    } catch {
      toast.error("Failed to create project");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">New Project</h1>
        <p className="text-sm text-foreground-400">Create a project to group your app and services</p>
      </div>

      <div className="max-w-md">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Icon icon="solar:folder-bold-duotone" width={24} className="text-purple-400" />
              <div>
                <CardTitle>Project Name</CardTitle>
                <CardDescription>Give your project a name</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <TextField value={name} onChange={setName} autoFocus>
              <Label>Name</Label>
              <Input placeholder="my-project" onKeyDown={(e) => e.key === "Enter" && handleCreate()} />
            </TextField>
            <Button variant="primary" className="w-full" isDisabled={loading} onPress={handleCreate}>
              {loading ? <Spinner /> : "Create Project"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
