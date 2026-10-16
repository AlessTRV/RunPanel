import { EMPTY_BODY_SHA256, sha256Hex, signedHeaders } from "@/lib/cluster-sign";
import { pingResponseSchema, type PingResponse } from "@/lib/cluster-schema";
import { clusterState } from "./state";
import { recordMemberSeen } from "./state";

/**
 * Calls from this install to another member.
 *
 * Every request is signed with the cluster secret (see lib/cluster-sign.ts).
 * The timeout covers only the wait for response headers: once a member has
 * started answering, a long body — a build log being streamed, a backup being
 * downloaded — must be allowed to take as long as it takes.
 */

export class MemberUnreachableError extends Error {
  constructor(
    public readonly memberId: string,
    message: string
  ) {
    super(message);
    this.name = "MemberUnreachableError";
  }
}

export interface SignedFetchInit {
  method?: string;
  body?: Uint8Array | string | null;
  /** The user the call acts for. Omit for member-to-member calls. */
  userId?: string | null;
  contentType?: string | null;
  accept?: string | null;
  /** How long to wait for response headers. Default 30 s. */
  headersTimeoutMs?: number;
  signal?: AbortSignal;
  /** Sign with this secret instead of the current one: re-sending a rotated secret to a member that missed it. */
  secret?: string;
}

export async function signedFetch(member: { id: string; url: string }, path: string, init: SignedFetchInit = {}): Promise<Response> {
  const state = await clusterState();
  if (!state) throw new MemberUnreachableError(member.id, "Questo server non fa parte di un cluster");

  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body ?? null;
  const bodyBytes = body === null ? null : typeof body === "string" ? new TextEncoder().encode(body) : body;
  const q = path.indexOf("?");
  const pathname = q === -1 ? path : path.slice(0, q);
  const query = q === -1 ? "" : path.slice(q);

  const headers: Record<string, string> = signedHeaders(init.secret ?? state.secret, {
    method,
    path: pathname,
    query,
    memberId: state.selfId,
    userId: init.userId ?? null,
    bodySha256: bodyBytes ? sha256Hex(bodyBytes) : EMPTY_BODY_SHA256,
  });
  if (init.contentType) headers["content-type"] = init.contentType;
  if (init.accept) headers.accept = init.accept;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), init.headersTimeoutMs ?? 30_000);
  const onOuterAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const res = await fetch(`${member.url}${path}`, {
      method,
      headers,
      // Handed over as is: `Buffer.from` would copy a 100 MB upload.
      body: (bodyBytes as unknown as BodyInit | null) ?? null,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    const message = describeFetchError(err);
    // The caller going away (a closed tab) says nothing about the member.
    if (!init.signal?.aborted) await recordMemberSeen(member.id, { error: message }).catch(() => undefined);
    throw new MemberUnreachableError(member.id, message);
  } finally {
    // Headers have arrived (or the call failed): the body is on its own clock.
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onOuterAbort);
  }
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message === "timeout") return "Nessuna risposta entro il tempo limite";
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `${cause.code}${cause.message ? `: ${cause.message}` : ""}`.slice(0, 200);
    return err.message.slice(0, 200);
  }
  return "Errore di rete";
}

/** Ask a member who it is. Updates its row either way; null when it did not answer properly. */
export async function pingMember(member: { id: string; url: string }): Promise<PingResponse | null> {
  try {
    const res = await signedFetch(member, "/api/cluster/ping", { headersTimeoutMs: 8_000 });
    if (!res.ok) {
      await recordMemberSeen(member.id, { error: `HTTP ${res.status} dal server` });
      return null;
    }
    const parsed = pingResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      await recordMemberSeen(member.id, { error: "Risposta non riconosciuta: versione diversa?" });
      return null;
    }
    await recordMemberSeen(member.id, { version: parsed.data.version });
    return parsed.data;
  } catch {
    // signedFetch already recorded the error.
    return null;
  }
}
