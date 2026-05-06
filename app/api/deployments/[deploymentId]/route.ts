import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";

type Params = { params: Promise<{ deploymentId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { deploymentId } = await params;
  const db = getDb();
  const deployment = db.prepare("SELECT * FROM deployments WHERE id = ?").get(deploymentId);

  if (!deployment) {
    return NextResponse.json({ error: "Deployment not found" }, { status: 404 });
  }

  return NextResponse.json(deployment);
}
