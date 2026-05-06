import { IBuilder, BuildContext, BuildResult } from "./builders/types";
import { dockerBuilder } from "./builders/docker-builder";
import { nodeBuilder } from "./builders/node-builder";
import { staticBuilder } from "./builders/static-builder";

// Detection order: Docker first, then Node, then Static (fallback)
const builders: IBuilder[] = [dockerBuilder, nodeBuilder, staticBuilder];

export async function detectBuilder(projectDir: string): Promise<IBuilder | null> {
  for (const builder of builders) {
    if (await builder.detect(projectDir)) {
      return builder;
    }
  }
  return null;
}

export async function buildProject(
  projectDir: string,
  runtimeType: string,
  ctx: Omit<BuildContext, "projectDir">
): Promise<BuildResult> {
  // If runtime type is explicitly set, use that builder
  const builderMap: Record<string, IBuilder> = {
    node: nodeBuilder,
    static: staticBuilder,
    docker: dockerBuilder,
  };

  let builder = builderMap[runtimeType];

  // If not found by type, auto-detect
  if (!builder) {
    builder = (await detectBuilder(projectDir)) || staticBuilder;
  }

  return builder.build({ projectDir, ...ctx });
}

export { type IBuilder, type BuildContext, type BuildResult };
