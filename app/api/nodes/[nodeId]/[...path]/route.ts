import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser, type AuthContext } from "@/lib/auth-guard";
import { refuseCrossOrigin } from "@/lib/request-origin";
import { MemberUnreachableError, signedFetch } from "@/services/cluster/client";
import { clusterState, getMember } from "@/services/cluster/state";

/**
 * The panel forwards a page's API call to another member of the cluster.
 *
 * `/api/nodes/<id>/projects/x/deploy` becomes `POST <member>/api/projects/x/deploy`,
 * signed with the cluster secret and carrying the signed-in user's id; the
 * member applies its own copy of that user's grants. The response body is
 * streamed back untouched, so a build log over SSE flows as it does locally.
 *
 * The body is read whole before forwarding because the signature covers its
 * hash. The cap is the upload route's own, which is the largest body any
 * route accepts; everything else is a few kilobytes.
 */

type Params = { params: Promise<{ nodeId: string; path: string[] }> };

const MAX_BODY_BYTES = 110 * 1024 * 1024;
const BODYLESS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Hop-by-hop or already-consumed by undici: wrong if repeated on our response. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "x-powered-by",
]);

export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;
  return forward(denied, request, await params);
}

export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;
  return forward(denied, request, await params);
}

export async function PUT(request: NextRequest, { params }: Params) {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;
  return forward(denied, request, await params);
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;
  return forward(denied, request, await params);
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;
  return forward(denied, request, await params);
}

async function forward(ctx: AuthContext, request: NextRequest, { nodeId, path }: { nodeId: string; path: string[] }) {
  // Kept out of `proxy.ts` because of the upload it may carry, so the
  // cross-origin check the proxy would have made is here.
  const refused = refuseCrossOrigin(request);
  if (refused) return refused;

  const state = await clusterState();
  const member = state ? await getMember(nodeId) : null;
  if (!state || !member) return NextResponse.json({ error: "Server non trovato" }, { status: 404 });
  if (member.id === state.selfId) {
    return NextResponse.json({ error: "Per questo server si usa l'API locale" }, { status: 400 });
  }

  const target = `/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;

  let body: Uint8Array | null = null;
  if (!BODYLESS.has(request.method)) {
    if (Number.parseInt(request.headers.get("content-length") ?? "0", 10) > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Richiesta troppo grande" }, { status: 413 });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Richiesta troppo grande" }, { status: 413 });
    }
    body = bytes;
  }

  // Closing the tab closes the stream on the member too.
  const controller = new AbortController();
  request.signal.addEventListener("abort", () => controller.abort(), { once: true });

  let upstream: Response;
  try {
    upstream = await signedFetch(member, target, {
      method: request.method,
      body,
      userId: ctx.session.user.id,
      contentType: request.headers.get("content-type"),
      accept: request.headers.get("accept"),
      headersTimeoutMs: 30_000,
      signal: controller.signal,
    });
  } catch (err) {
    const detail = err instanceof MemberUnreachableError ? err.message : null;
    return NextResponse.json(
      { error: `${member.name} non raggiungibile${detail ? `: ${detail}` : ""}` },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }

  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("Cache-Control", "no-store");
  headers.set("X-Accel-Buffering", "no");

  return new Response(upstream.body, { status: upstream.status, headers });
}
