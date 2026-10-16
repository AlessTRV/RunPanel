import { randomBytes } from "node:crypto";
import os from "node:os";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { clusterUrlSchema, memberNameSchema } from "@/lib/cluster-schema";
import { hashToken } from "@/lib/cluster-sign";
import { getDb, nowIso } from "@/lib/db";
import { panelBaseUrl } from "@/lib/panel-url";
import { generateId } from "@/lib/utils";
import { ensureCluster } from "@/services/cluster/state";

const TOKEN_HOURS = 1;

const bodySchema = z
  .object({
    name: memberNameSchema.optional(),
    url: clusterUrlSchema.optional(),
  })
  .strict();

/**
 * A one-time token for a fresh install to join with. The first one also
 * creates the cluster, with this panel as its first member — which is why it
 * needs to know its own address: that is what the other members will call.
 */
export async function POST(request: NextRequest) {
  const denied = await requirePermission("nodes");
  if (isDenied(denied)) return denied;

  let body: unknown = {};
  try {
    const raw = await request.text();
    if (raw.length > 4096) return NextResponse.json({ error: "Richiesta troppo grande" }, { status: 413 });
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
  }

  const selfUrl = parsed.data.url ?? (await panelBaseUrl(request))?.origin ?? null;
  if (!selfUrl) {
    return NextResponse.json({ error: "Imposta l'indirizzo pubblico del pannello nelle impostazioni" }, { status: 400 });
  }
  const state = await ensureCluster({ name: parsed.data.name ?? os.hostname(), url: selfUrl });

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_HOURS * 3_600_000).toISOString();
  const db = await getDb();
  await db
    .insertInto("cluster_link_tokens")
    .values({
      id: generateId(),
      token_hash: hashToken(token),
      created_by: denied.session.user.id,
      expires_at: expiresAt,
      used_at: null,
      created_at: nowIso(),
    })
    .execute();
  // Spent and expired tokens are not worth keeping.
  await db.deleteFrom("cluster_link_tokens").where("expires_at", "<", nowIso()).execute();

  await audit({ userId: denied.session.user.id, category: "security", action: "cluster.token.issue", request });

  const self = await db.selectFrom("cluster_members").select("url").where("id", "=", state.selfId).executeTakeFirst();
  return NextResponse.json(
    { token, expiresAt, panelUrl: self?.url ?? selfUrl },
    { headers: { "Cache-Control": "no-store" } }
  );
}
