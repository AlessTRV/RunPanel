/** The shapes `/api/autostart` returns, as the page consumes them. */

export interface AutostartEntry {
  kind: "service" | "project";
  id: string;
  name: string;
  subtitle: string;
  status: string;
  autostart: boolean;
  order: number;
  delaySeconds: number;
  waitHealthy: boolean;
  /** What Docker will actually do, which is not always what the panel says. */
  restartPolicy: string | null;
  /** Null where the question does not apply — a compose stack owns its own. */
  policyMatches: boolean | null;
  container: string;
}

export interface ReconcileEntry {
  kind: string;
  id: string;
  name: string;
  order: number;
  action: string;
  detail: string;
}

export interface AutostartData {
  probe: {
    environment: {
      platform: string;
      user: string;
      root: boolean;
      containerised: boolean;
      port: number;
      workingDirectory: string;
    };
    recommended: "systemd" | "cron" | "container" | "manual";
    recommendedReason: string;
    systemd: {
      available: boolean;
      installed: boolean;
      enabled: boolean;
      active: boolean;
      /** Null when no unit is installed — see `UnitState` in the probe. */
      killMode: string | null;
    };
    cron: { available: boolean; installed: boolean; line: string | null };
    docker: { available: boolean; enabledAtBoot: boolean | null };
    pm2: { available: boolean; startupInstalled: boolean; dumpSaved: boolean };
    selfContainer: { id: string | null; restartPolicy: string | null };
    port: { free: boolean; detail: string };
  };
  stored: { method: string; installedAt: string } | null;
  report: {
    startedAt: string;
    finishedAt: string;
    dryRun: boolean;
    started: number;
    failed: number;
    entries: ReconcileEntry[];
  } | null;
  entries: AutostartEntry[];
  reconcilerEnabled: boolean;
}
