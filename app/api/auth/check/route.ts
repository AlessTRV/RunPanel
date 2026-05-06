import { NextResponse } from "next/server";
import { getSession, isFirstRun } from "@/lib/auth";

export async function GET() {
  const authenticated = await getSession();
  const firstRun = isFirstRun();

  return NextResponse.json({ authenticated, firstRun });
}
