import { redirect } from "next/navigation";

type Props = { params: Promise<{ projectId: string }> };

export default async function DeploymentsPage({ params }: Props) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}?tab=deployments`);
}
