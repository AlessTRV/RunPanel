"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { PolicyForm } from "../_components/PolicyForm";

export default function NewBackupPolicyPage() {
  return (
    <>
      <PageHeader
        title="Nuova pianificazione"
        description="Cosa salvare, ogni quanto, e per quanto tempo tenerlo."
      />
      <PolicyForm />
    </>
  );
}
