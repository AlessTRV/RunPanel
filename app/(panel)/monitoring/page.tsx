"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";

interface Metrics {
  cpu: { usage: number; cores: number; model: string };
  memory: { total: number; used: number; available: number };
  uptime: number;
  platform: string;
  hostname: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export default function MonitoringPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    function fetchMetrics() {
      fetch("/api/metrics")
        .then((r) => r.json())
        .then(setMetrics)
        .finally(() => setLoading(false));
    }
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading || !metrics) {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }

  const memPercent = Math.round((metrics.memory.used / metrics.memory.total) * 100);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Monitoring</h1>
        <p className="text-sm text-foreground-400">
          {metrics.hostname} · {metrics.platform} · Up {formatUptime(metrics.uptime)}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* CPU */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Icon icon="solar:cpu-bold-duotone" width={24} className="text-primary" />
              <CardTitle>CPU</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-2">
              <span className="text-3xl font-bold">{metrics.cpu.usage.toFixed(1)}%</span>
              <span className="text-sm text-foreground-400 mb-1">{metrics.cpu.cores} cores</span>
            </div>
            <div className="mt-3 h-2 rounded-full bg-default-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.min(metrics.cpu.usage, 100)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-foreground-400 truncate">{metrics.cpu.model}</p>
          </CardContent>
        </Card>

        {/* Memory */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Icon icon="solar:server-bold-duotone" width={24} className="text-secondary" />
              <CardTitle>Memory</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-2">
              <span className="text-3xl font-bold">{memPercent}%</span>
              <span className="text-sm text-foreground-400 mb-1">
                {formatBytes(metrics.memory.used)} / {formatBytes(metrics.memory.total)}
              </span>
            </div>
            <div className="mt-3 h-2 rounded-full bg-default-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-secondary transition-all"
                style={{ width: `${memPercent}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-foreground-400">
              {formatBytes(metrics.memory.available)} available
            </p>
          </CardContent>
        </Card>

        {/* Uptime */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Icon icon="solar:clock-circle-bold-duotone" width={24} className="text-success" />
              <CardTitle>Uptime</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <span className="text-3xl font-bold">{formatUptime(metrics.uptime)}</span>
            <p className="mt-2 text-xs text-foreground-400">System uptime since last restart</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
