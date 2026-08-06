import { processManager } from "./process-manager";
import { projectEvents } from "./events";

/**
 * Follows a project's process output and republishes it on the event bus.
 *
 * Reference-counted on purpose: three browser tabs watching the same project
 * must not spawn three `docker logs -f` processes. The tail starts on the first
 * subscriber and is torn down shortly after the last one leaves — with a short
 * grace period, so a page navigation does not thrash it.
 */

interface Follower {
  stop: () => void;
  refs: number;
  idleTimer: NodeJS.Timeout | null;
}

const IDLE_GRACE_MS = 10_000;

class ProcessLogHub {
  private followers = new Map<string, Follower>();

  attach(projectId: string, slug: string, runtimeType: string): () => void {
    let follower = this.followers.get(projectId);

    if (follower) {
      follower.refs++;
      if (follower.idleTimer) {
        clearTimeout(follower.idleTimer);
        follower.idleTimer = null;
      }
    } else {
      let stop = () => {};
      try {
        stop = processManager.onOutput(slug, runtimeType, (line, stream) => {
          projectEvents.emit(projectId, { type: "process:log", line, stream });
        });
      } catch (err) {
        console.error(`[process-logs] Could not follow ${slug}:`, err);
      }
      follower = { stop, refs: 1, idleTimer: null };
      this.followers.set(projectId, follower);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const current = this.followers.get(projectId);
      if (!current) return;

      current.refs--;
      if (current.refs > 0) return;

      current.idleTimer = setTimeout(() => {
        const latest = this.followers.get(projectId);
        if (!latest || latest.refs > 0) return;
        latest.stop();
        this.followers.delete(projectId);
      }, IDLE_GRACE_MS);
    };
  }

  /** Tear everything down — used when a project is deleted. */
  detachAll(projectId: string): void {
    const follower = this.followers.get(projectId);
    if (!follower) return;
    if (follower.idleTimer) clearTimeout(follower.idleTimer);
    follower.stop();
    this.followers.delete(projectId);
  }
}

const globalRef = globalThis as typeof globalThis & { __runpanelLogHub?: ProcessLogHub };

export const processLogHub = (globalRef.__runpanelLogHub ??= new ProcessLogHub());
