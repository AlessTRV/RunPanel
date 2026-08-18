import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { panelVersion } from "@/lib/version";
import {
  DEFAULT_PANEL_UPDATE_INTERVAL,
  PANEL_UPDATE_INTERVAL_SETTING,
} from "@/lib/polling";
import { getSetting } from "@/lib/settings";
import { lastCheck } from "@/services/panel-update/check";
import { readCheckout } from "@/services/panel-update/git";
import {
  activePanelUpdate,
  canSelfUpdate,
  currentRun,
  updateBlockers,
} from "@/services/panel-update/run";
import { autostartProbeCache } from "@/services/autostart/probe";

/**
 * Everything the update screen and the banner need, in one answer.
 *
 * One endpoint rather than four, because every consumer wants all of it at
 * once: the banner needs the check to decide whether to appear and the run to
 * decide whether to say "in corso" instead, and the page needs the lot. Two
 * requests to draw one line would be two chances to draw it inconsistently.
 */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const [checkout, check, probe, interval] = await Promise.all([
    readCheckout(),
    lastCheck(),
    // The CACHED probe, which matters more here than anywhere else it is used.
    // One reading shells out to systemd, cron, Docker and pm2 *and opens a
    // socket on the panel's own port* to see whether it is free — and this
    // endpoint is polled by the update banner on every page of the panel, from
    // every open tab. `services/autostart/probe.ts` says exactly this about the
    // autostart page; calling the uncached function here undid it.
    autostartProbeCache.get(),
    getSetting(PANEL_UPDATE_INTERVAL_SETTING),
  ]);

  const verdict = canSelfUpdate(probe, process.platform, process.env.NODE_ENV);
  const run = currentRun();
  const busy = activePanelUpdate();

  // Only worth asking when there is something to press: this is a query, and
  // the banner polls it on every page.
  const blocker = check?.behind ? await updateBlockers() : null;

  return NextResponse.json(
    {
      version: panelVersion(),
      checkout: {
        isRepo: checkout.isRepo,
        branch: checkout.branch,
        detached: checkout.detached,
        head: checkout.head,
        short: checkout.head?.slice(0, 7) ?? null,
        remote: checkout.remote,
      },
      check,
      run,
      busy,
      canUpdate: verdict,
      blocker,
      interval: interval ?? DEFAULT_PANEL_UPDATE_INTERVAL,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
