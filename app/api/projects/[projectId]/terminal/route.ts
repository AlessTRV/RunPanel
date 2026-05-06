import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { spawn, type ChildProcess } from "child_process";
import { getShellPath, isWindows, buildEnv } from "@/services/env-utils";
import { getRepoPath } from "@/services/git-manager";
import { decrypt } from "@/lib/auth";

// Store active shell sessions
const sessions = new Map<string, { proc: ChildProcess; buffer: string[] }>();

type Params = { params: Promise<{ projectId: string }> };

// POST: Send input to shell or start a new session
export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const body = await request.json();
  const { action, input } = body as { action?: string; input?: string };

  const db = getDb();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const slug = project.slug as string;
  const sessionKey = `term-${projectId}`;

  if (action === "start" || !sessions.has(sessionKey)) {
    // Kill existing session if any
    const existing = sessions.get(sessionKey);
    if (existing) {
      try { existing.proc.kill(); } catch { /* ignore */ }
      sessions.delete(sessionKey);
    }

    // Load project env vars
    const envRows = db.prepare(
      "SELECT key, value FROM env_vars WHERE project_id = ?"
    ).all(projectId) as { key: string; value: string }[];

    const projectEnv: Record<string, string> = {};
    for (const row of envRows) {
      projectEnv[row.key] = decrypt(row.value);
    }
    projectEnv.PORT = (project.port as number || 3000).toString();

    const env = buildEnv(projectEnv);
    const cwd = getRepoPath(slug);
    const shell = getShellPath();

    const proc = spawn(shell, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const session = { proc, buffer: [] as string[] };
    sessions.set(sessionKey, session);

    const pushLine = (data: Buffer) => {
      const text = data.toString();
      session.buffer.push(text);
      // Keep only last 1000 entries
      if (session.buffer.length > 1000) {
        session.buffer = session.buffer.slice(-500);
      }
    };

    proc.stdout?.on("data", pushLine);
    proc.stderr?.on("data", pushLine);
    proc.on("close", (code) => {
      session.buffer.push(`\r\n[Process exited with code ${code}]\r\n`);
    });

    return NextResponse.json({ status: "started", cwd });
  }

  if (action === "stop") {
    const session = sessions.get(sessionKey);
    if (session) {
      try { session.proc.kill(); } catch { /* ignore */ }
      sessions.delete(sessionKey);
    }
    return NextResponse.json({ status: "stopped" });
  }

  // Send input to shell
  if (input !== undefined) {
    const session = sessions.get(sessionKey);
    if (session && session.proc.stdin?.writable) {
      session.proc.stdin.write(input);
    }
    return NextResponse.json({ status: "ok" });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

// GET: Poll for output
export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const sessionKey = `term-${projectId}`;

  const session = sessions.get(sessionKey);
  if (!session) {
    return NextResponse.json({ active: false, output: "" });
  }

  // Drain buffer
  const output = session.buffer.join("");
  session.buffer = [];

  const alive = session.proc.exitCode === null;

  return NextResponse.json({ active: alive, output });
}
