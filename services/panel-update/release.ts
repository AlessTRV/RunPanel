import { panelVersion, releaseLabel } from "@/lib/version";
import { readBuild, type PanelBuild } from "./git";

/**
 * Which RunPanel this is, assembled once.
 *
 * Cached for the life of the process, and that is a correctness decision rather
 * than a saving. What this describes is the build that is *running*, and the
 * working tree can move underneath it — somebody pulls over SSH and HEAD is
 * suddenly a commit whose code is not the code answering this request. Reading
 * it once, at the point the process started, keeps the answer true; a self
 * update restarts the panel, so it refreshes exactly when it should.
 */

export interface PanelRelease extends PanelBuild {
  version: string;
  /** `v0.1.0+142`, ready for a footer. */
  label: string;
}

const globalRef = globalThis as typeof globalThis & {
  __runpanelRelease?: Promise<PanelRelease>;
};

export function panelRelease(): Promise<PanelRelease> {
  return (globalRef.__runpanelRelease ??= produce());
}

async function produce(): Promise<PanelRelease> {
  const version = panelVersion();
  const build = await readBuild();
  return {
    ...build,
    version,
    label: releaseLabel({ version, build: build.number, short: build.short }),
  };
}
