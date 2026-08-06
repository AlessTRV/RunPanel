import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { spawn, type ChildProcess } from "child_process";
import { projectEvents } from "@/services/events";

// Store active shell sessions with last activity timestamp
const sessions = new Map<string, { proc: ChildProcess; buffer: string[]; lastActivity: number }>();

// Auto-cleanup: kill sessions idle for more than 10 minutes
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      try { session.proc.kill(); } catch { /* ignore */ }
      sessions.delete(key);
    }
  }
}, 60_000);

type Params = { params: Promise<{ projectId: string }> };

// POST: Send input to docker exec shell or start a new session
export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const body = await request.json();
  const { action, input } = body as { action?: string; input?: string };

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["slug", "runtime_type"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Only allow terminal for Docker projects
  if (project.runtime_type !== "docker") {
    return NextResponse.json({ error: "Terminal is only available for Docker containers" }, { status: 400 });
  }

  const containerName = `runpanel-${project.slug}`;
  const sessionKey = `term-${projectId}`;

  if (action === "start" || !sessions.has(sessionKey)) {
    // Kill existing session
    const existing = sessions.get(sessionKey);
    if (existing) {
      try { existing.proc.kill(); } catch { /* ignore */ }
      sessions.delete(sessionKey);
    }

    // Start docker exec -it shell inside the container
    const proc = spawn("docker", ["exec", "-i", containerName, "/bin/sh"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const session = { proc, buffer: [] as string[], lastActivity: Date.now() };
    sessions.set(sessionKey, session);

    // Output is published on the project's event stream as it arrives. The
    // buffer is kept only so a client that connects slightly late still sees
    // what it missed — it is no longer polled once per second.
    const pushLine = (data: Buffer) => {
      const text = data.toString();
      session.buffer.push(text);
      session.lastActivity = Date.now();
      if (session.buffer.length > 500) {
        session.buffer = session.buffer.slice(-250);
      }
      projectEvents.emit(projectId, { type: "terminal:output", text });
    };

    proc.stdout?.on("data", pushLine);
    proc.stderr?.on("data", pushLine);
    proc.on("close", (code) => {
      const notice = `\r\n[Container shell exited with code ${code}]\r\n`;
      session.buffer.push(notice);
      projectEvents.emit(projectId, { type: "terminal:output", text: notice });
      projectEvents.emit(projectId, { type: "terminal:closed", code });
    });

    return NextResponse.json({ status: "started", container: containerName });
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
      session.lastActivity = Date.now();
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

  session.lastActivity = Date.now();

  // Drain buffer
  const output = session.buffer.join("");
  session.buffer = [];

  const alive = session.proc.exitCode === null;

  return NextResponse.json({ active: alive, output });
}
