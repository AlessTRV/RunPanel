import { z } from "zod";
import { GLOBAL_PERMISSIONS, GRANT_SCOPES, LEVELS, type Grant, type GlobalPermission } from "./authz";

/** Bodies of the users API, shared by the routes and the pages. */

const grantSchema = z
  .object({
    scope: z.enum(GRANT_SCOPES as [Grant["scope"], ...Grant["scope"][]]),
    scopeId: z.string().min(1).max(64).nullable(),
    level: z.enum(LEVELS as [Grant["level"], ...Grant["level"][]]),
    terminal: z.boolean(),
  })
  .refine((g) => (g.scope === "all") === (g.scopeId === null), "Ambito non valido");

export const userAccessSchema = z.object({
  permissions: z.array(z.enum(GLOBAL_PERMISSIONS as unknown as [GlobalPermission, ...GlobalPermission[]])).max(64),
  grants: z.array(grantSchema).max(500),
});

export const updateUserSchema = z
  .object({
    access: userAccessSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

export const inviteSchema = z.object({
  email: z.string().max(254),
  hours: z.number().int().positive(),
});

export const reinviteSchema = z.object({ hours: z.number().int().positive() });
