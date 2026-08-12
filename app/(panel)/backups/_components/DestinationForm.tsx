"use client";

import { useState } from "react";
import { Input, Label, TextField } from "@heroui/react";
import { toast } from "sonner";
import { FormDialog } from "@/components/ui/FormDialog";
import { Segmented } from "@/components/ui/Segmented";
import { Field } from "@/components/ui/Field";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { MSG } from "@/lib/copy";

/**
 * Add a place for the archives to go.
 *
 * The `Destination` interface has always had two implementations' worth of
 * shape and one implementation, and the panel had no way to create a
 * destination at all — the local one was inserted at first boot and that was
 * the whole list. So an S3 adapter with no form is a feature that exists in the
 * source and not in the product, which is the thing this pass set out to
 * remove rather than add to.
 *
 * It also unlocks the only real test the signing code has: "Verifica" writes an
 * object and deletes it, which is what tells you the credentials, the endpoint
 * and the SigV4 chain are all correct — none of which can be checked offline.
 */

type Kind = "local" | "s3";

export function DestinationForm({
  isOpen,
  onOpenChange,
  onCreated,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<Kind>("s3");
  const [name, setName] = useState("");

  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("auto");
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [prefix, setPrefix] = useState("");
  const [pathStyle, setPathStyle] = useState<"virtual" | "path">("virtual");

  // Mirrors `s3ConfigSchema`: https anywhere, http only towards a private
  // address. Checked here too so a typo is caught before a round trip.
  const trimmedEndpoint = endpoint.trim();
  const privateHost =
    /^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(
      trimmedEndpoint
    );
  const endpointError =
    trimmedEndpoint && !/^https:\/\//i.test(trimmedEndpoint) && !privateHost
      ? "Serve https://, oppure http:// verso un indirizzo privato"
      : undefined;

  const incomplete =
    !name.trim() ||
    (kind === "s3" &&
      (!endpoint.trim() || !region.trim() || !bucket.trim() || !accessKeyId.trim() || !secretAccessKey));

  async function submit() {
    const res = await fetch("/api/backups/destinations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        type: kind,
        config:
          kind === "s3"
            ? {
                endpoint: endpoint.trim(),
                region: region.trim(),
                bucket: bucket.trim(),
                accessKeyId: accessKeyId.trim(),
                secretAccessKey,
                prefix: prefix.trim() || undefined,
                forcePathStyle: pathStyle === "path",
              }
            : {},
      }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? MSG.createFailed);
      // Thrown so the dialog stays open with the credentials still typed in.
      throw new Error(body.error ?? "destination failed");
    }

    toast.success("Destinazione aggiunta. Premi Verifica per collaudarla.");
    setName("");
    setSecretAccessKey("");
    onCreated();
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Nuova destinazione"
      submitLabel="Aggiungi"
      isSubmitDisabled={incomplete || Boolean(endpointError)}
      onSubmit={submit}
    >
      <Segmented
        label="Tipo di destinazione"
        value={kind}
        onChange={setKind}
        options={[
          { value: "local", label: "Disco locale" },
          { value: "s3", label: "S3 compatibile" },
        ]}
      />

      <TextField value={name} onChange={setName}>
        <Label>Nome</Label>
        <Input placeholder={kind === "s3" ? "Bucket remoto" : "Secondo disco"} />
      </TextField>

      {kind === "local" ? (
        <FieldHint>
          Gli archivi restano su questa macchina, in <code>data/backups</code>. Utile come copia
          rapida, ma un backup che muore insieme alla macchina che protegge è una copia, non un
          backup.
        </FieldHint>
      ) : (
        <>
          <Field
            label="Endpoint"
            error={endpointError}
            hint="S3, R2, B2, MinIO. In HTTP solo verso un indirizzo privato."
          >
            <TextField value={endpoint} onChange={setEndpoint} aria-label="Endpoint">
              <Input placeholder="https://s3.eu-central-1.amazonaws.com" className="font-mono text-sm" />
            </TextField>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField value={region} onChange={setRegion}>
              <Label>Region</Label>
              <Input placeholder="eu-central-1" className="font-mono text-sm" />
            </TextField>
            <TextField value={bucket} onChange={setBucket}>
              <Label>Bucket</Label>
              <Input placeholder="runpanel-backups" className="font-mono text-sm" />
            </TextField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField value={accessKeyId} onChange={setAccessKeyId}>
              <Label>Access key ID</Label>
              <Input className="font-mono text-sm" />
            </TextField>
            <TextField type="password" value={secretAccessKey} onChange={setSecretAccessKey}>
              <Label>Secret access key</Label>
              <Input className="font-mono text-sm" />
            </TextField>
          </div>

          <div>
            <TextField value={prefix} onChange={setPrefix}>
              <Label>Prefisso</Label>
              <Input placeholder="runpanel/" className="font-mono text-sm" />
            </TextField>
            <FieldHint>Facoltativo: una cartella dentro il bucket.</FieldHint>
          </div>

          <div>
            <span className="text-muted mb-2 block text-sm font-medium">Indirizzamento</span>
            <Segmented
              label="Stile di indirizzamento"
              value={pathStyle}
              onChange={setPathStyle}
              options={[
                { value: "virtual", label: "bucket nel dominio" },
                { value: "path", label: "bucket nel percorso" },
              ]}
            />
            <FieldHint>
              S3 e R2 accettano il primo. MinIO e la maggior parte delle installazioni proprie
              vogliono il secondo.
            </FieldHint>
          </div>

          <Hint tone="warn" title="La chiave viene salvata cifrata">
            Con la chiave di questo pannello, come ogni altro segreto. Dai al token i permessi
            minimi: lettura, scrittura ed eliminazione su questo solo bucket.
          </Hint>
        </>
      )}
    </FormDialog>
  );
}
