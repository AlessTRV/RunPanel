import { z } from "zod";

/**
 * Shapes shared by the cluster routes and the setup page. Members live on a
 * private network, so unlike `panelPublicUrlSchema` a private or loopback
 * host is exactly what is expected here.
 */

const URL_HINT = "Serve l'indirizzo del pannello, ad esempio http://100.64.0.5:3000";

export const clusterUrlSchema = z
  .string()
  .trim()
  .min(1, URL_HINT)
  .max(255)
  .transform((raw, ctx) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: URL_HINT });
      return z.NEVER;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: URL_HINT });
      return z.NEVER;
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: "custom", message: "L'indirizzo non può contenere credenziali" });
      return z.NEVER;
    }
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
      ctx.addIssue({ code: "custom", message: "Indica solo host e porta, senza percorso" });
      return z.NEVER;
    }
    return url.origin;
  });

export const memberRoleSchema = z.enum(["panel", "node"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const memberNameSchema = z.string().trim().min(1, "Serve un nome").max(60, "Nome troppo lungo");

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const isoSchema = z.string().max(40);

/** What a fresh install sends to the panel it wants to join. */
export const joinRequestSchema = z
  .object({
    token: z.string().min(16).max(200),
    name: memberNameSchema,
    url: clusterUrlSchema,
    role: memberRoleSchema,
    version: z.string().max(80).optional(),
  })
  .strict();

/** The `link` block of a setup request on a fresh install. */
export const linkSetupSchema = z
  .object({
    panelUrl: clusterUrlSchema,
    token: z.string().trim().min(16, "Token non valido").max(200),
    name: memberNameSchema,
    url: clusterUrlSchema,
    role: memberRoleSchema,
  })
  .strict();
export type LinkSetup = z.infer<typeof linkSetupSchema>;

export const patchMemberSchema = z
  .object({
    name: memberNameSchema.optional(),
    url: clusterUrlSchema.optional(),
    role: memberRoleSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Niente da modificare" });

const grantSchema = z.object({
  id: idSchema,
  scope: z.enum(["all", "folder", "project", "service"]),
  scope_id: z.string().max(64),
  level: z.enum(["read", "operate", "manage"]),
  terminal: z.union([z.literal(0), z.literal(1)]),
  created_at: isoSchema,
});

const directoryUserSchema = z.object({
  id: idSchema,
  email: z.string().max(255).nullable(),
  password_hash: z.string().max(255).nullable(),
  is_owner: z.union([z.literal(0), z.literal(1)]),
  disabled: z.union([z.literal(0), z.literal(1)]),
  created_by: z.string().max(64).nullable(),
  created_at: isoSchema,
  updated_at: isoSchema,
  permissions: z.array(z.string().max(40)).max(50),
  grants: z.array(grantSchema).max(500),
});

const directoryMemberSchema = z.object({
  id: idSchema,
  name: z.string().max(60),
  url: z.string().max(255),
  role: memberRoleSchema,
  created_at: isoSchema,
  updated_at: isoSchema,
});

const tombstoneSchema = z.object({
  kind: z.enum(["user", "member"]),
  id: idSchema,
  deleted_at: isoSchema,
});

const sharedSettingSchema = z.object({
  key: z.enum(["github_token", "telegram_bot_token", "telegram_chat_id"]),
  value: z.string().max(4096).nullable(),
  updated_at: isoSchema,
});

export const directorySchema = z
  .object({
    users: z.array(directoryUserSchema).max(5000),
    members: z.array(directoryMemberSchema).max(500),
    tombstones: z.array(tombstoneSchema).max(50000),
    sharedSettings: z.array(sharedSettingSchema).max(10),
  })
  .strict();

/** What a fresh install gets back from `POST /api/cluster/join`. */
export const joinResponseSchema = z.object({
  clusterId: idSchema,
  memberId: idSchema,
  panelId: idSchema,
  secret: z.string().regex(/^[0-9a-f]{64}$/),
  directory: directorySchema,
});

export const pingResponseSchema = z.object({
  memberId: idSchema,
  clusterId: idSchema,
  role: memberRoleSchema,
  version: z.string().max(80).nullable(),
  time: isoSchema,
  directoryHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PingResponse = z.infer<typeof pingResponseSchema>;
