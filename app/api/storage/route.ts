import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-guard";
import { isDockerAvailable } from "@/services/docker/cli";
import { diskUsage, findOrphans, sweep, DEFAULT_RETENTION } from "@/services/docker/gc";
import { listOwnedImages } from "@/services/docker/images";
import { listOwnedVolumes } from "@/services/docker/volumes";

/**
 * Snapshot cache.
 *
 * Building this answer costs several docker CLI invocations, and each one is
 * hundreds of milliseconds — on the machine this was measured on, the endpoint
 * took 1.3s. Disk usage does not change second to second, so serving a recent
 * snapshot is both faster and no less accurate in practice. A sweep clears it,
 * so the numbers move as soon as something actually happens.
 */
let snapshot: { at: number; payload: unknown } | null = null;
const SNAPSHOT_TTL_MS = 20_000;

// Not exported: a Next route module may only export request handlers.
function invalidateStorageSnapshot() {
  snapshot = null;
}

/** What Docker is holding on RunPanel's behalf, and what can be reclaimed. */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) {
    return NextResponse.json(snapshot.payload, {
      headers: { "Cache-Control": "no-store", "X-Snapshot-Age": String(Date.now() - snapshot.at) },
    });
  }

  if (!(await isDockerAvailable())) {
    return NextResponse.json({
      dockerAvailable: false,
      usage: [],
      images: [],
      volumes: [],
      orphans: { containers: [], images: [], volumes: [], networks: [] },
      retention: DEFAULT_RETENTION,
    });
  }

  const [usage, images, volumes, orphans] = await Promise.all([
    diskUsage(),
    listOwnedImages(),
    listOwnedVolumes(),
    findOrphans(),
  ]);

  const payload = { dockerAvailable: true, usage, images, volumes, orphans, retention: DEFAULT_RETENTION };
  snapshot = { at: Date.now(), payload };

  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}

const sweepSchema = z.object({
  /**
   * Off by default. Orphaned volumes hold the data of deleted projects, so
   * removing them has to be an explicit choice rather than a side effect of
   * "free up some space".
   */
  removeOrphans: z.boolean().optional(),
  retention: z
    .object({
      imagesPerProject: z.number().int().min(1).max(50),
      buildCacheHours: z.number().int().min(1).max(24 * 365),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    /* an empty body means "defaults" */
  }

  const parsed = sweepSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.issues },
      { status: 400 }
    );
  }

  invalidateStorageSnapshot();

  const result = await sweep({
    removeOrphans: parsed.data.removeOrphans ?? false,
    retention: parsed.data.retention ?? DEFAULT_RETENTION,
  });

  return NextResponse.json(result);
}
