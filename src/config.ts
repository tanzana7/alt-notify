import { z } from "zod";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_DEV_GUILD_ID: z.string().optional(),
  OWNER_DISCORD_ID: z.string().optional(),
  DATABASE_PATH: z.string().default("./data/discord-alt-notify.sqlite"),
  FREE_LINK_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEVELOPER_TEST_DISCORD_ID: z.string().optional(),
  LINK_CODE_PEPPER: z.string().optional()
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`必要な環境変数が不足しています: ${missing}`);
  }
  return result.data;
}
