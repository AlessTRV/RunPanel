import { NextResponse } from "next/server";
import { mergeByMember, type Aggregated, type PerServer } from "@/lib/cluster-merge";
import { fanOut, memberStatuses, type FanOutResult } from "./fanout";

/**
 * The shape every aggregated list route answers with: the rows of every
 * server, each tagged with its server, plus how each server answered.
 */

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function aggregateList<T>(path: string, userId: string, pick?: (data: unknown) => T[]): Promise<Aggregated<T>> {
  const results = await fanOut<unknown>(path, { userId });
  return {
    items: mergeByMember(
      results.map((r) => ({
        member: r.member,
        items: r.ok && r.data ? (pick ? pick(r.data) : (r.data as T[])) : [],
      }))
    ),
    members: memberStatuses(results),
  };
}

export type { PerServer };

export function perServer<T>(results: FanOutResult<T>[]): PerServer<T>[] {
  return [...results]
    .sort((a, b) => (a.member.self !== b.member.self ? (a.member.self ? -1 : 1) : a.member.name.localeCompare(b.member.name)))
    .map((r) => ({
      memberId: r.member.id,
      memberName: r.member.name,
      self: r.member.self,
      data: r.ok ? r.data : null,
      error: r.error,
      reachable: r.status !== null,
    }));
}

export function json<T>(body: T): NextResponse {
  return NextResponse.json(body, { headers: NO_STORE });
}
