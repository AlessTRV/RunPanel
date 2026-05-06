import { NextRequest, NextResponse } from "next/server";
import { getSession, getAdminPasswordHash, verifyPassword, setAdminPassword } from "@/lib/auth";

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { currentPassword, newPassword } = body;

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "Both passwords are required" }, { status: 400 });
  }

  if (newPassword.length < 8) {
    return NextResponse.json(
      { error: "New password must be at least 8 characters" },
      { status: 400 }
    );
  }

  const hash = getAdminPasswordHash();
  if (!hash) {
    return NextResponse.json({ error: "No password set" }, { status: 400 });
  }

  const valid = await verifyPassword(currentPassword, hash);
  if (!valid) {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 });
  }

  await setAdminPassword(newPassword);
  return NextResponse.json({ success: true });
}
