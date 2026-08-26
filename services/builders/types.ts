import type { BuildPhase } from "@/lib/deploy-phases";

export interface BuildContext {
  projectDir: string;
  /** Project slug — used for image naming and ownership labels. */
  slug?: string;
  /** Deployment id, so each build gets an immutable image tag. */
  deploymentId?: string;

  buildCmd?: string;
  startCmd?: string;
  installCmd?: string;
  packageManager?: "auto" | "npm" | "bun" | "pnpm" | "yarn";
  envVars: Record<string, string>;
  onLog: (line: string) => void;

  /**
   * Run whatever one-time commands are pinned to this point of the build.
   *
   * Resolves when they are done and REJECTS when a critical one failed, which
   * is what fails the build. The phase type is narrowed to the two a builder
   * owns, so it cannot be handed one it does not run.
   *
   * Optional because the deploy pipeline is the only caller that supplies it,
   * and a builder invoked from anywhere else has nothing to run. Only the
   * native builders call it: under Docker install and build are a single
   * `docker build`, so there is no boundary between them to offer.
   */
  onPhase?: (phase: BuildPhase) => Promise<void>;

  // Docker template fields
  dockerImage?: string;
  dockerTemplate?: string;
  dockerFields?: Record<string, string>;

  // Docker build inputs
  /**
   * Values passed as `--build-arg`. Distinct from `envVars`: a Dockerfile only
   * sees ARGs at build time, so anything a framework inlines into a client
   * bundle (NEXT_PUBLIC_*, VITE_*) has to arrive this way or the build either
   * fails or silently ships the wrong value.
   */
  buildArgs?: Record<string, string>;
  dockerfile?: string;
  buildContext?: string;
  target?: string;
  buildTimeout?: number;
}

export interface BuildResult {
  success: boolean;
  artifactDir: string;
  startCmd: string;
  error?: string;
}

export interface IBuilder {
  name: string;
  detect(projectDir: string): Promise<boolean>;
  build(ctx: BuildContext): Promise<BuildResult>;
}
