"use client";

import { use } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { useResource } from "@/lib/hooks/useResource";
import { PolicyForm } from "../../_components/PolicyForm";
import type { PolicyView } from "../../_components/types";

export default function EditBackupPolicyPage({
  params,
}: {
  params: Promise<{ policyId: string }>;
}) {
  const { policyId } = use(params);
  const { data, loading, error } = useResource<PolicyView>(`/api/backups/policies/${policyId}`);

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Pianificazione" />
        <div className="space-y-4">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonBlock key={i} className="h-40" />
          ))}
        </div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <PageHeader title="Pianificazione" />
        <Panel>
          <EmptyState
            icon="solar:danger-triangle-linear"
            title="Pianificazione non trovata"
            description="Potrebbe essere stata eliminata da un'altra scheda."
          />
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={data.name}
        description={data.schedule}
      />
      {/* Keyed on the id so switching policies rebuilds the form state rather
          than leaving the previous one's selections behind. */}
      <PolicyForm key={data.id} policy={data} />
    </>
  );
}
