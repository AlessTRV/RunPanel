import { NextResponse } from "next/server";
import { getSession, isFirstRun } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  const firstRun = await isFirstRun();

  return NextResponse.json({
    authenticated: session !== null,
    firstRun,
    emailRequired: session !== null && session.user.email === null,
  });
}
