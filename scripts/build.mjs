/**
 * Runs `next build` with a heap ceiling this machine can actually back.
 *
 * A plain `next build` inherits whatever limit Node derives from the machine's
 * RAM — roughly 2 GB on a 4 GB server. That is the wrong number twice over. V8
 * grows the heap towards whatever ceiling it is given, so a high one only means
 * more garbage kept around; and the panel builds itself on the box it serves
 * from, next to the projects it hosts, where that memory is not free. The build
 * then spends its time collecting garbage and dies at the ceiling:
 *
 *     FATAL ERROR: Ineffective mark-compacts near heap limit
 *
 * A lower ceiling makes V8 collect earlier and the build fits — this project
 * needs about 600 MB when measured on its own, so the floor below is well clear
 * of it.
 *
 * Why a wrapper script and not the updater: `services/panel-update/run.ts` runs
 * from the build already installed, so a ceiling set there only reaches the
 * update *after* the one that carries it. This file arrives with the checkout
 * being built, so it applies to the very build that would otherwise die — which
 * is the point, since a failed self-update is the failure this exists for.
 *
 * NODE_OPTIONS is passed through untouched when it already names a heap size:
 * an operator who set one had a reason.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { totalmem } from "node:os";

const MIN_MB = 1024;
const MAX_MB = 4096;

function heapCeiling() {
  const share = Math.floor((totalmem() * 0.4) / (1024 * 1024));
  return Math.min(MAX_MB, Math.max(MIN_MB, share));
}

const inherited = process.env.NODE_OPTIONS ?? "";
const nodeOptions = inherited.includes("--max-old-space-size")
  ? inherited
  : `${inherited} --max-old-space-size=${heapCeiling()}`.trim();

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const args = ["build", "--webpack", ...process.argv.slice(2)];

console.log(`NODE_OPTIONS=${nodeOptions}`);

const child = spawn(process.execPath, [nextBin, ...args], {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

child.on("exit", (code, signal) => {
  // A signal is not an exit code: reported as 0 it would let a killed build
  // pass for a successful one, and the updater would swap it in.
  process.exit(signal ? 1 : (code ?? 1));
});
