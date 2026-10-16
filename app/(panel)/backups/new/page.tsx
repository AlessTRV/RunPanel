"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { PolicyForm } from "../_components/PolicyForm";
import { useNode } from "@/lib/hooks/useNode";

export default function NewBackupPolicyPage() {
  // Keyed by server: switching server starts the form over, so no destination
  // or target of the previous server can be sent to the new one.
  const { selected } = useNode();
  return (
    <>
      <PageHeader
        title="Nuova pianificazione"
        description="Cosa salvare, ogni quanto, e per quanto tempo tenerlo."
      />
      <PolicyForm key={selected ?? "self"} />
    </>
  );
}
