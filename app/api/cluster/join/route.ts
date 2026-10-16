import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { joinRequestSchema } from "@/lib/cluster-schema";
import { hashToken } from "@/lib/cluster-sign";
import { trustedClientIp } from "@/lib/client-ip";
import { getDb, nowIso } from "@/lib/db";
import { consumeRateLimit } from "@/lib/rate-limit";
import { generateId } from "@/lib/utils";
import { pingMember } from "@/services/cluster/client";
import { localSnapshot } from "@/services/cluster/directory";
import { clusterState } from "@/services/cluster/state";
import { broadcastDirectory } from "@/services/cluster/sync";

/**
 * A fresh install joins with a one-time token.
 *
 * Public: the caller has no session and no secret yet — the token is its only
 * credential, which is why it is single-use, expires in an hour and is
 * rate-limited like a login. The answer carries the cluster secret, so it is
 * only ever given to whoever spent a valid token.
 */

const MAX_BODY_BYTES = 8 * 1024;
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  const buckets = [{ key: "cluster:join", limit: 10 }];
  const ip = trustedClientIp(request);
  if (ip) buckets.unshift({ key: `cluster:join:${ip}`, limit: 5 });
  for (const bucket of buckets) {
    const limit = await consumeRateLimit(bucket.key, bucket.limit, WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Troppi tentativi. Riprova tra ${Math.ceil(limit.retryAfter / 60)} minuti.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
      );
    }
  }

  if (Number.parseInt(request.headers.get("content-length") ?? "0", 10) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Richiesta troppo grande" }, { status: 413 });
  }
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Richiesta troppo grande" }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = joinRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
  }

  const state = await clusterState();
  if (!state || state.role !== "panel") {
    return NextResponse.json({ error: "Questo server non accetta collegamenti" }, { status: 404 });
  }

  // The `used_at IS NULL` condition is the claim: a token sent twice at once
  // is spent once.
  const db = await getDb();
  const now = nowIso();
  const claimed = await db
    .updateTable("cluster_link_tokens")
    .set({ used_at: now })
    .where("token_hash", "=", hashToken(parsed.data.token))
    .where("used_at", "is", null)
    .where("expires_at", ">", now)
    .returning(["id", "created_by"])
    .executeTakeFirst();
  if (!claimed) {
    return NextResponse.json({ error: "Token di collegamento mancante, scaduto o già usato" }, { status: 403 });
  }

  const memberId = generateId();
  await db
    .insertInto("cluster_members")
    .values({
      id: memberId,
      name: parsed.data.name,
      url: parsed.data.url,
      role: parsed.data.role,
      status: "unknown",
      version: parsed.data.version ?? null,
      last_seen_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  await audit({
    userId: claimed.created_by,
    category: "security",
    action: "cluster.member.join",
    detail: `${parsed.data.name} (${parsed.data.role}) ${parsed.data.url}`,
    request,
  });

  const directory = await localSnapshot();

  // The new member saves the secret only after reading this answer, so the
  // first call back to it waits a moment and is retried. Other panels learn of
  // it through the usual broadcast.
  const member = { id: memberId, url: parsed.data.url };
  let attempts = 0;
  const callBack = async () => {
    attempts += 1;
    const ok = await pingMember(member);
    if (!ok && attempts < 3) setTimeout(() => void callBack(), 3_000).unref?.();
  };
  setTimeout(() => void callBack(), 2_000).unref?.();
  void broadcastDirectory();

  return NextResponse.json(
    { clusterId: state.clusterId, memberId, panelId: state.selfId, secret: state.secret, directory },
    { headers: { "Cache-Control": "no-store" } }
  );
}
