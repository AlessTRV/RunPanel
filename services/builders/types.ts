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
