"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  TextField,
  Label,
  Input,
  Button,
  Spinner,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

interface EnvVar {
  key: string;
  value: string;
}

export default function EnvVarsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/env?reveal=true`)
      .then((r) => r.json())
      .then((data) => {
        setVars(data.map((v: { key: string; value: string }) => ({ key: v.key, value: v.value })));
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  function addVar() {
    setVars([...vars, { key: "", value: "" }]);
  }

  function removeVar(index: number) {
    setVars(vars.filter((_, i) => i !== index));
  }

  function updateVar(index: number, field: "key" | "value", val: string) {
    const updated = [...vars];
    updated[index] = { ...updated[index], [field]: val };
    setVars(updated);
  }

  async function handleSave() {
    const validVars = vars.filter((v) => v.key.trim());
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vars: validVars }),
      });
      if (res.ok) {
        toast.success("Environment variables saved");
        setVars(validVars);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function handleImportEnv() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".env,.env.local,.env.production";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      const parsed = text
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("#"))
        .map((line) => {
          const eqIdx = line.indexOf("=");
          if (eqIdx === -1) return null;
          return {
            key: line.slice(0, eqIdx).trim(),
            value: line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, ""),
          };
        })
        .filter(Boolean) as EnvVar[];

      setVars((prev) => {
        const existing = new Set(prev.map((v) => v.key));
        const newVars = parsed.filter((v) => !existing.has(v.key));
        return [...prev, ...newVars];
      });
      toast.success(`Imported ${parsed.length} variables`);
    };
    input.click();
  }

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
          <h1 className="text-2xl font-bold">Environment Variables</h1>
          <p className="text-sm text-foreground-400">
            Manage environment variables for this project
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onPress={handleImportEnv}>
            <Icon icon="solar:import-bold-duotone" width={16} />
            Import .env
          </Button>
          <Button variant="outline" size="sm" onPress={addVar}>
            <Icon icon="solar:add-circle-bold-duotone" width={16} />
            Add Variable
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-3 py-4">
          {vars.length === 0 ? (
            <div className="text-center py-8 text-foreground-400">
              <Icon icon="solar:key-bold-duotone" width={32} className="mx-auto mb-2" />
              <p>No environment variables</p>
              <p className="text-sm">Add variables or import from a .env file</p>
            </div>
          ) : (
            vars.map((v, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1">
                  <TextField value={v.key} onChange={(val) => updateVar(i, "key", val)}>
                    <Label className="text-xs">Key</Label>
                    <Input placeholder="VARIABLE_NAME" className="font-mono text-sm" />
                  </TextField>
                </div>
                <div className="flex-[2]">
                  <TextField value={v.value} onChange={(val) => updateVar(i, "value", val)}>
                    <Label className="text-xs">Value</Label>
                    <Input placeholder="value" className="font-mono text-sm" />
                  </TextField>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  onPress={() => removeVar(i)}
                  className="mb-0.5"
                >
                  <Icon icon="solar:trash-bin-trash-bold-duotone" width={18} className="text-danger" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {vars.length > 0 && (
        <div className="mt-4 flex justify-end">
          <Button variant="primary" isDisabled={saving} onPress={handleSave}>
            {saving ? <Spinner /> : "Save Variables"}
          </Button>
        </div>
      )}
    </div>
  );
}
