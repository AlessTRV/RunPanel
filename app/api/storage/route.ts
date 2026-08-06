import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-guard";
import { isDockerAvailable } from "@/services/docker/cli";
import { diskUsage, findOrphans, sweep, DEFAULT_RETENTION } from "@/services/docker/gc";
import { listOwnedImages } from "@/services/docker/images";
import { listOwnedVolumes } from "@/services/docker/volumes";

/** What Docker is holding on RunPanel's behalf, and what can be reclaimed. */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

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

  return NextResponse.json(
    { dockerAvailable: true, usage, images, volumes, orphans, retention: DEFAULT_RETENTION },
    { headers: { "Cache-Control": "no-store" } }
  );
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

  const result = await sweep({
    removeOrphans: parsed.data.removeOrphans ?? false,
    retention: parsed.data.retention ?? DEFAULT_RETENTION,
  });

  return NextResponse.json(result);
}
