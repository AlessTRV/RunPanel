import { redirectToSection } from "@/lib/section-entry";

export default async function SystemPage() {
  await redirectToSection("system");
}
