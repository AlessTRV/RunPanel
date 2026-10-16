import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { json } from "@/services/cluster/aggregate";
import { fanOut } from "@/services/cluster/fanout";

/**
 * Which server holds a project or service. Used when a page opens an id that
 * is not on the server it asked, so it can offer the right one instead of a
 * bare "not found". Each server answers with the user's own access, so an
 * object the user cannot see is not found anywhere.
 */
export async function GET(request: NextRequest) {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;
  const kind = request.nextUrl.searchParams.get("kind");
  const id = request.nextUrl.searchParams.get("id") ?? "";
  if ((kind !== "project" && kind !== "service") || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const results = await fanOut(`/api/${kind === "project" ? "projects" : "services"}/${id}`, { userId: denied.session.user.id });
  const found = results.find((r) => r.ok);
  return json({ memberId: found?.member.id ?? null, memberName: found?.member.name ?? null });
}
