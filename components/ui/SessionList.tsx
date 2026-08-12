"use client";

import { Button } from "@heroui/react";
import { formatRelative } from "@/lib/format";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useResource } from "@/lib/hooks/useResource";
import { SkeletonBlock } from "./Skeletons";

interface Session {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

/** A user agent string is unreadable; this is the part anyone cares about. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Dispositivo sconosciuto";

  const os =
    /Windows/i.test(userAgent) ? "Windows"
    : /Android/i.test(userAgent) ? "Android"
    : /iPhone|iPad|iOS/i.test(userAgent) ? "iOS"
    : /Mac OS X|Macintosh/i.test(userAgent) ? "macOS"
    : /Linux/i.test(userAgent) ? "Linux"
    : null;

  const browser =
    /Edg\//i.test(userAgent) ? "Edge"
    : /OPR\/|Opera/i.test(userAgent) ? "Opera"
    : /Firefox\//i.test(userAgent) ? "Firefox"
    : /Chrome\//i.test(userAgent) ? "Chrome"
    : /Safari\//i.test(userAgent) ? "Safari"
    : null;

  if (browser && os) return `${browser} su ${os}`;
  return browser ?? os ?? userAgent.slice(0, 40);
}

/**
 * Signed-in devices, with a way to revoke one.
 *
 * Sessions became per-device but there was no way to see or end them
 * individually — the only lever was changing the password, which ends all of
 * them at once.
 */
export function SessionList() {
  const { data, loading, refresh } = useResource<{ sessions: Session[] }>("/api/sessions");
  const sessions = data?.sessions ?? [];

  async function revoke(id: string) {
    try {
      const res = await fetch(`/api/sessions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Dispositivo disconnesso");
      refresh();
    } catch {
      toast.error("Disconnessione non riuscita");
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }, (_, i) => (
          <SkeletonBlock key={i} className="h-14" />
        ))}
      </div>
    );
  }

  if (sessions.length === 0) {
    return <p className="text-muted text-sm">Nessuna sessione attiva.</p>;
  }

  return (
    <ul className="divide-border divide-y">
      {sessions.map((session) => (
        <li key={session.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
          <Icon icon="solar:monitor-linear" width={18} className="text-muted shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-sm">{describeDevice(session.user_agent)}</p>
            <p className="text-muted mt-0.5 truncate text-xs">
              {session.ip ? <span className="font-mono">{session.ip}</span> : "IP sconosciuto"}
              {" · attivo "}
              {formatRelative(session.last_seen_at)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Disconnetti questo dispositivo"
            onPress={() => revoke(session.id)}
          >
            Disconnetti
          </Button>
        </li>
      ))}
    </ul>
  );
}
