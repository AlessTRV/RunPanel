import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { DEPLOY_PRESETS } from "@/services/deploy-presets";

/**
 * The deploy presets, for the wizard to offer.
 *
 * The presets have always existed and have always been applied — `detectPreset`
 * runs on every deploy and picks one by looking at the repository. What was
 * missing is the other half: choosing one deliberately, for a repository whose
 * shape the detector cannot see (a Dockerfile that is not at the root, a static
 * site with no index at the top level, anything before the first clone).
 *
 * Served from here rather than duplicated into the client bundle because the
 * preset list carries `detect` functions that read the filesystem: they cannot
 * cross to the browser, and a hand-maintained copy of the labels would drift
 * from the contracts they name.
 */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  return NextResponse.json({
    presets: DEPLOY_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      runtime: preset.runtime,
    })),
  });
}
