import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { terminalActionSchema } from "@/lib/validation";
import { getDb } from "@/lib/db";
import { spawn, type ChildProcess } from "child_process";
import { projectEvents } from "@/services/events";

interface ShellSession {
  proc: ChildProcess;
  buffer: string[];
  lastActivity: number;
}

/**
 * Live shells, and the timer that reaps them.
 *
 * Both hang off `globalThis`, like the database handle and the housekeeping
 * schedulers do, and for the same reason with an extra edge: this module owns
 * running `docker exec` processes. Re-evaluated on a dev reload, a plain module
 * constant gave the new copy an empty Map — the shells from before were still
 * running with nothing left holding a reference — and started a second reaper
 * that would never see them either.
 *
 * `unref()` because a cleanup timer must never be the reason the process
 * refuses to exit.
 */
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

const globalRef = globalThis as typeof globalThis & {
  __runpanelShellSessions?: Map<string, ShellSession>;
  __runpanelShellReaper?: NodeJS.Timeout;
};

const sessions = (globalRef.__runpanelShellSessions ??= new Map<string, ShellSession>());

if (!globalRef.__runpanelShellReaper) {
  globalRef.__runpanelShellReaper = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        try { session.proc.kill(); } catch { /* ignore */ }
        sessions.delete(key);
      }
    }
  }, 60_000);
  globalRef.__runpanelShellReaper.unref?.();
}

type Params = { params: Promise<{ projectId: string }> };

// POST: Send input to docker exec shell or start a new session
export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  // A malformed body is a bad request, not a 500.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = terminalActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { action, input } = parsed.data;

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["slug", "runtime_type"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  // Only allow terminal for Docker projects
  if (project.runtime_type !== "docker") {
    return NextResponse.json({ error: "Il terminale è disponibile solo per i progetti che girano in un container Docker" }, { status: 400 });
  }

  const containerName = `runpanel-${project.slug}`;
  const sessionKey = `term-${projectId}`;

  /*
    A `stop` is never a reason to start one.

    The condition used to be `action === "start" || !sessions.has(...)`, so a
    stop arriving after the shell had already gone — which is exactly when a
    client sends one — opened a fresh container shell and reported it started.
  */
  if (action === "stop") {
    const session = sessions.get(sessionKey);
    if (session) {
      try { session.proc.kill(); } catch { /* ignore */ }
      sessions.delete(sessionKey);
    }
    return NextResponse.json({ status: "stopped" });
  }

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

      // Out of the map as soon as it is gone. Left in, a dead session kept the
      // reaper from collecting it for as long as anything polled the route, and
      // every later write answered `ok` into a shell that no longer existed.
      // Compared by identity: a restart puts a NEW session under this same key,
      // and the old one's close must not take it down with it.
      if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
    });

    return NextResponse.json({ status: "started", container: containerName });
  }

  // Send input to shell
  if (input !== undefined) {
    const session = sessions.get(sessionKey);
    // Answered rather than swallowed: writing into a shell that has exited used
    // to return `ok` and do nothing, so the operator typed into a dead terminal
    // with no way to tell.
    if (!session || !session.proc.stdin?.writable) {
      return NextResponse.json({ status: "dead" });
    }
    session.proc.stdin.write(input);
    session.lastActivity = Date.now();
    return NextResponse.json({ status: "ok" });
  }

  return NextResponse.json({ error: "Azione non valida" }, { status: 400 });
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
