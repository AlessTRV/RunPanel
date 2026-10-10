import { SectionTabs } from "@/components/SectionTabs";

/** One sidebar entry, several pages: the tabs sit above each of them. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SectionTabs section="system" />
      {children}
    </>
  );
}
