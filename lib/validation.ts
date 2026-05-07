import { z } from "zod";

export const loginSchema = z.object({
  password: z.string().min(1, "Password is required").max(128, "Password too long"),
});

export const setupSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters").max(128, "Password too long"),
  confirmPassword: z.string().max(128),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

export const runtimeTypes = ["node", "docker", "custom"] as const;
export type RuntimeType = (typeof runtimeTypes)[number];

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  appName: z.string().max(100).optional().nullable(),
  sourceType: z.enum(["github", "upload"]).optional(),
  sourceUrl: z.string().url().optional().nullable(),
  sourceBranch: z.string().optional(),
  runtimeType: z.enum(runtimeTypes).optional().nullable(),
  port: z.number().int().min(1).max(65535).optional().nullable(),
  autoDeploy: z.boolean().optional(),
  builderConfig: z.object({
    buildCmd: z.string().optional(),
    startCmd: z.string().optional(),
    installCmd: z.string().optional(),
    packageManager: z.enum(["auto", "npm", "bun", "pnpm", "yarn"]).optional(),
  }).optional(),
});

export const envVarsSchema = z.object({
  vars: z.array(z.object({
    key: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid env var name"),
    value: z.string(),
  })),
});

export const controlActionSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
});

export const createServiceSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["postgresql", "mysql", "redis", "mongodb"]),
  version: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  projectId: z.string().optional(),
  credentials: z.object({
    user: z.string().optional(),
    password: z.string().optional(),
    database: z.string().optional(),
  }).optional(),
});
