import { z } from "zod";

export const loginSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

export const setupSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  sourceType: z.enum(["github", "upload"]).optional(),
  sourceUrl: z.string().url().optional(),
  sourceBranch: z.string().optional(),
  runtimeType: z.enum(["node", "static", "docker"]).optional(),
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

export const createAppSchema = z.object({
  projectId: z.string().min(1),
  sourceType: z.enum(["github", "upload"]),
  sourceUrl: z.string().url().optional(),
  sourceBranch: z.string().default("main"),
  runtimeType: z.enum(["node", "static", "docker"]),
  port: z.number().int().min(1).max(65535).optional(),
  builderConfig: z.object({
    buildCmd: z.string().optional(),
    startCmd: z.string().optional(),
    installCmd: z.string().optional(),
    packageManager: z.enum(["auto", "npm", "bun", "pnpm", "yarn"]).optional(),
  }).optional(),
});
