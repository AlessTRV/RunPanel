export interface BuildContext {
  projectDir: string;
  buildCmd?: string;
  startCmd?: string;
  installCmd?: string;
  packageManager?: "auto" | "npm" | "bun" | "pnpm" | "yarn";
  envVars: Record<string, string>;
  onLog: (line: string) => void;
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
