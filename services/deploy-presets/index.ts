import fs from "fs";
import path from "path";
import type { DeployContract } from "@/lib/deploy-contract";

/**
 * Starting points, by SHAPE of application — never by project.
 *
 * A preset is a guess that fills the form; the operator can change anything.
 * Nothing here encodes knowledge of a particular repository, because a panel
 * that needs a hardcoded entry per app is a panel that cannot deploy the next
 * one.
 */

export interface DeployPreset {
  id: string;
  label: string;
  description: string;
  /** Runtime this preset assumes. */
  runtime: "node" | "docker" | "static" | "custom";
  contract: Partial<DeployContract>;
  /** Returns true when the repository looks like this shape. */
  detect?: (repoDir: string) => boolean;
}

function hasFile(repoDir: string, ...names: string[]): boolean {
  return names.some((name) => fs.existsSync(path.join(repoDir, name)));
}

function readPackageJson(repoDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function hasDependency(repoDir: string, name: string): boolean {
  const pkg = readPackageJson(repoDir);
  if (!pkg) return false;
  const deps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };
  return name in deps;
}

export const DEPLOY_PRESETS: DeployPreset[] = [
  {
    id: "dockerfile",
    label: "Dockerfile",
    description:
      "Il repository porta il proprio Dockerfile. RunPanel lo costruisce e ne avvia il container.",
    runtime: "docker",
    detect: (dir) => hasFile(dir, "Dockerfile"),
    contract: {
      docker: {
        context: ".",
        network: "project",
        capAdd: [],
        extraHosts: [],
        mounts: [],
      } as DeployContract["docker"],
      healthcheck: {
        enabled: true,
        path: "/",
        expectStatus: [],
        startPeriodSec: 10,
        timeoutSec: 90,
        intervalSec: 2,
      },
    },
  },
  {
    id: "next-server",
    label: "Next.js (server)",
    description:
      "Next.js con rendering server. Le variabili NEXT_PUBLIC_* vengono passate al build, non solo al runtime.",
    runtime: "node",
    detect: (dir) => hasDependency(dir, "next"),
    contract: {
      commands: { build: "npm run build", start: "npm run start" },
      buildEnvPrefixes: ["NEXT_PUBLIC_"],
      build: { timeoutSec: 1800, nodeOptions: "--max-old-space-size=4096" },
      healthcheck: {
        enabled: true,
        path: "/",
        expectStatus: [],
        startPeriodSec: 5,
        timeoutSec: 90,
        intervalSec: 2,
      },
    },
  },
  {
    id: "vite-static",
    label: "Vite / SPA statica",
    description: "Build statico servito da un web server. Le VITE_* servono al build.",
    runtime: "static",
    detect: (dir) => hasDependency(dir, "vite"),
    contract: {
      commands: { build: "npm run build" },
      buildEnvPrefixes: ["VITE_"],
      healthcheck: { enabled: true, path: "/", expectStatus: [], startPeriodSec: 2, timeoutSec: 30, intervalSec: 1 },
    },
  },
  {
    id: "python",
    label: "Python (uvicorn / gunicorn)",
    description: "Progetto Python con requirements.txt e un server ASGI/WSGI.",
    runtime: "custom",
    detect: (dir) => hasFile(dir, "requirements.txt", "pyproject.toml"),
    contract: {
      commands: {
        install: "python3 -m venv venv\nvenv/bin/pip install -r requirements.txt",
        start: "venv/bin/python -m uvicorn main:app --host 0.0.0.0",
      },
      healthcheck: { enabled: true, path: "/", expectStatus: [], startPeriodSec: 3, timeoutSec: 45, intervalSec: 2 },
    },
  },
  {
    id: "go",
    label: "Go",
    description: "Modulo Go compilato in un binario.",
    runtime: "custom",
    detect: (dir) => hasFile(dir, "go.mod"),
    contract: {
      commands: { build: "go build -o app .", start: "./app" },
      healthcheck: { enabled: true, path: "/", expectStatus: [], startPeriodSec: 2, timeoutSec: 30, intervalSec: 1 },
    },
  },
];

/** The first preset whose detector matches the checked-out repository. */
export function detectPreset(repoDir: string): DeployPreset | null {
  if (!fs.existsSync(repoDir)) return null;
  return DEPLOY_PRESETS.find((preset) => preset.detect?.(repoDir)) ?? null;
}

export function getPreset(id: string): DeployPreset | null {
  return DEPLOY_PRESETS.find((preset) => preset.id === id) ?? null;
}

export const RUNPANEL_CONFIG_FILE = "runpanel.json";

/**
 * A repository can describe its own deploy contract. This is what lets RunPanel
 * deploy a project it has never seen without anybody adding code for it.
 */
export function readRepoContract(repoDir: string): unknown | null {
  const file = path.join(repoDir, RUNPANEL_CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
