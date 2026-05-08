import { redirect } from "next/navigation";

type Props = { params: Promise<{ projectId: string }> };

export default async function ProjectSettingsPage({ params }: Props) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}?tab=settings`);
}
