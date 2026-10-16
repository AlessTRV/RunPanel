"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/ChoiceCard";
import { Field } from "@/components/ui/Field";
import type { DockerTemplate } from "../_data/catalog";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";

/**
 * A prebuilt image with a few fields, configured as the project's app.
 *
 * The template's own settings go into the contract's `docker.image` plus the
 * template fields, so nothing about a specific image is hardcoded elsewhere.
 */
export function TemplateForm({
  projectId,
  template,
}: {
  projectId: string;
  template: DockerTemplate;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(template.versions[0]);
  const [port, setPort] = useState(template.defaultPort);
  const [fields, setFields] = useState<Record<string, string>>(() =>
    Object.fromEntries(template.fields.map((f) => [f.key, f.default]))
  );

  async function create() {
    setSaving(true);
    try {
      const res = await fetch(api(`/api/projects/${projectId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType: "upload",
          runtimeType: "docker",
          port: port ? Number.parseInt(port, 10) : null,
          builderConfig: {
            version: 1,
            docker: { image: `${template.image}:${version}` },
            dockerTemplate: template.id,
            dockerFields: fields,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? "Configurazione non riuscita");
        return;
      }

      toast.success(`${template.label} configurato`);
      router.push(href(`/projects/${projectId}`));
    } catch {
      toast.error("Configurazione non riuscita");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <Panel className="space-y-4">
        <PanelHeader title={template.label} description={template.description} />

        {/* Same control as the database version picker — they used to disagree
            only by accident. */}
        <Field label="Versione">
          <ChoiceGroup label="Versione" className="flex flex-wrap">
            {template.versions.map((v) => (
              <ChoiceCard
                key={v}
                compact
                selected={version === v}
                onSelect={() => setVersion(v)}
                title={v}
                className="font-mono"
              />
            ))}
          </ChoiceGroup>
        </Field>

        <TextField value={port} onChange={setPort}>
          <Label>Porta sull&apos;host</Label>
          <Input type="number" />
        </TextField>

        {template.fields.map((field) => (
          <TextField
            key={field.key}
            value={fields[field.key] ?? ""}
            onChange={(v) => setFields((prev) => ({ ...prev, [field.key]: v }))}
          >
            <Label>{field.label}</Label>
            <Input placeholder={field.placeholder} className="font-mono text-sm" />
          </TextField>
        ))}
      </Panel>

      <div className="flex justify-end">
        <Button variant="primary" isPending={saving} onPress={create}>
          Configura {template.label}
        </Button>
      </div>
    </div>
  );
}
