"use client";

import { useCallback, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useLineBuffer } from "@/lib/hooks/useLineBuffer";
import { useServiceStream, type ConsoleMode } from "@/lib/hooks/useServiceStream";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import type { LogLine } from "@/components/ui/LogViewer";
import { StatusBadge } from "@/components/StatusBadge";
import { serviceLabel } from "@/lib/service-env";
import { cn } from "@/lib/utils";
import { ConnectionPanel } from "./_components/ConnectionPanel";
import { ConsolePanel } from "./_components/ConsolePanel";
import { DataSection } from "./_components/DataSection";
import type { Credentials, From, Service, ServiceTabId } from "./_components/types";

/**
 * A provisioned service.
 *
 * The page used to be one component in one `max-w-2xl` column: on a phone a
 * very long scroll, on a wide screen half an empty window. It is three sections
 * now — how you reach it, how you talk to it, what it holds — laid out as two
 * columns where there is room and as tabs where there is not.
 *
 * Each section is mounted **once** and re-flowed by CSS. Two sibling trees, one
 * per breakpoint, would mean two consoles: two event streams, two transcripts,
 * and two live `docker exec` sessions on the same container.
 */

const TABS: readonly TabItem<ServiceTabId>[] = [
  { id: "connection", label: "Collegamento", icon: "solar:link-circle-linear" },
  { id: "console", label: "Console", icon: "solar:monitor-linear" },
  { id: "data", label: "Database", icon: "solar:database-linear" },
];

const TAB_IDS = TABS.map((tab) => tab.id);

/** Same cap as the project page's transcript, for the same burst of output. */
const MAX_CONSOLE_LINES = 2000;

let lineId = 0;
const toLine = (text: string): LogLine => ({ id: lineId++, text });

export default function ServiceDetailPage() {
  const poll5000 = usePollInterval(5000);
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const serviceId = params.serviceId as string;

  const { data: service, loading, refresh } = useResource<Service>(
    `/api/services/${serviceId}`,
    { intervalMs: poll5000 }
  );

  const [creds, setCreds] = useState<Credentials | null>(null);
  // Null until chosen, so the sensible default can depend on data that has not
  // loaded yet when the hook runs.
  const [fromChoice, setFromChoice] = useState<From | null>(null);

  const tabParam = searchParams.get("tab") as ServiceTabId | null;
  const [activeTab, setActiveTab] = useState<ServiceTabId>(
    tabParam && TAB_IDS.includes(tabParam) ? tabParam : "connection"
  );

  // The project the service belongs to, if any: without one nothing is injected
  // anywhere, and that is worth saying out loud rather than leaving to be
  // discovered after a deploy.
  const { data: project } = useResource<{ id: string; name: string }>(
    service?.project_id ? `/api/projects/${service.project_id}` : null
  );

  const [consoleMode, setConsoleMode] = useState<ConsoleMode>("engine");
  const [consoleActive, setConsoleActive] = useState(false);
  const consoleLines = useLineBuffer<LogLine>(MAX_CONSOLE_LINES);

  /**
   * What is left of a chunk that did not end on a newline.
   *
   * `proc.stdout` delivers whatever the pipe had, which is not line-aligned,
   * and `LogViewer` renders one row per line. Splitting here — the same way
   * `dockerStream` does on the server — is what lets the console reuse the
   * viewer with its "you scrolled up, stop following" behaviour instead of
   * hand-rolling a scroller the way the project terminal had to.
   */
  const carry = useRef("");

  const pushOutput = useCallback(
    (text: string) => {
      carry.current += text;
      const parts = carry.current.split("\n");
      carry.current = parts.pop() ?? "";
      for (const part of parts) consoleLines.push(toLine(part));
    },
    [consoleLines]
  );

  const flushCarry = useCallback(() => {
    if (!carry.current) return;
    consoleLines.push(toLine(carry.current));
    carry.current = "";
  }, [consoleLines]);

  useServiceStream(serviceId, (event) => {
    switch (event.type) {
      case "ready":
        setConsoleActive(Boolean(event.console?.active));
        if (event.console) setConsoleMode(event.console.mode);
        break;
      case "console:output":
        pushOutput(event.text);
        break;
      case "console:closed":
        flushCarry();
        setConsoleActive(false);
        break;
    }
  });

  const handleModeChange = useCallback(
    (next: ConsoleMode) => {
      // One session at a time, and its transcript belongs to the mode that
      // produced it: leaving `psql` output above a shell would read as one
      // conversation.
      if (consoleActive) {
        void fetch(`/api/services/${serviceId}/console`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        });
      }
      setConsoleActive(false);
      carry.current = "";
      consoleLines.reset();
      setConsoleMode(next);
    },
    [consoleActive, consoleLines, serviceId]
  );

  const echo = useCallback((text: string) => consoleLines.push(toLine(text.trimEnd())), [consoleLines]);

  async function revealCredentials() {
    const res = await fetch(`/api/services/${serviceId}?reveal=true`);
    if (!res.ok) {
      toast.error("Impossibile leggere le credenziali");
      return;
    }
    const data = await res.json();
    try {
      setCreds(JSON.parse(data.credentials));
    } catch {
      toast.error("Credenziali illeggibili");
    }
  }

  async function handleControl(action: "start" | "stop" | "restart") {
    try {
      const res = await fetch(`/api/services/${serviceId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json();
        toast.error(body.error ?? `Azione "${action}" fallita`);
        return;
      }
      toast.success(`Azione "${action}" eseguita`);
      refresh();
    } catch {
      toast.error(`Azione "${action}" fallita`);
    }
  }

  if (loading && !service) return <PageSkeleton />;

  if (!service) {
    return (
      <>
        <PageHeader title="Servizio" />
        <Panel>
          <EmptyState
            icon="solar:danger-triangle-linear"
            title="Servizio non trovato"
            description="È stato eliminato, oppure il link non è più valido."
            action={
              <Link href="/services" className="text-accent text-sm hover:underline">
                Torna ai servizi
              </Link>
            }
          />
        </Panel>
      </>
    );
  }

  const running = service.status === "running";
  const label = serviceLabel(service.type);
  // Il default è la riga che serve davvero: il nome del container solo se
  // l'app del progetto ci arriva così, altrimenti l'host — che è anche quello
  // che il deploy inietta per un progetto nativo.
  const from: From =
    fromChoice ??
    (service.reachedByContainerName ? "network" : service.project_id ? "host" : "container");

  /**
   * Visible in both columns on the wide layout, one at a time on the narrow
   * one. `hidden` rather than a conditional mount: a section that unmounts on
   * every tab switch loses what it was holding, and this one holds a live
   * shell whose server-side session outlives the component by ten minutes.
   */
  const section = (id: ServiceTabId) => cn("lg:block", activeTab === id ? "block" : "hidden");

  return (
    <>
      <PageHeader
        title={service.name}
        description={`${label} ${service.version} · porta ${service.port} sull'host`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={service.status} />
            {running ? (
              <>
                <Button variant="outline" size="sm" onPress={() => handleControl("restart")}>
                  <Icon icon="solar:refresh-linear" width={16} aria-hidden />
                  Riavvia
                </Button>
                <Button variant="outline" size="sm" onPress={() => handleControl("stop")}>
                  <Icon icon="solar:stop-linear" width={16} className="text-danger" aria-hidden />
                  Ferma
                </Button>
              </>
            ) : (
              <Button variant="primary" size="sm" onPress={() => handleControl("start")}>
                <Icon icon="solar:play-linear" width={16} aria-hidden />
                Avvia
              </Button>
            )}
          </div>
        }
      />

      <Tabs
        tabs={TABS}
        value={activeTab}
        onChange={setActiveTab}
        label="Sezioni del servizio"
        className="lg:hidden"
      />

      {/*
        Row-flow places these three at (1,1), (1,2) and (2,1) without any
        explicit placement: the reading column on the left, the console beside
        it, the databases underneath. The console takes the wider half because
        it is the one whose content is unreadable when it wraps.
      */}
      <div className="max-w-2xl space-y-4 lg:grid lg:max-w-none lg:grid-cols-[minmax(0,32rem)_minmax(0,1fr)] lg:items-start lg:gap-4 lg:space-y-0">
        <div className={section("connection")}>
          <ConnectionPanel
            service={service}
            project={project ?? null}
            creds={creds}
            from={from}
            onFromChange={setFromChoice}
            onReveal={revealCredentials}
            onSaved={refresh}
          />
        </div>

        <div className={cn(section("console"), "lg:sticky lg:top-[4.5rem]")}>
          <ConsolePanel
            serviceId={serviceId}
            running={running}
            mode={consoleMode}
            onModeChange={handleModeChange}
            active={consoleActive}
            onActiveChange={setConsoleActive}
            lines={consoleLines.lines}
            onLocalEcho={echo}
          />
        </div>

        <div className={cn(section("data"), "lg:mt-4")}>
          <DataSection
            service={service}
            from={from}
            creds={creds}
            onDeleted={() => router.push("/services")}
          />
        </div>
      </div>
    </>
  );
}
