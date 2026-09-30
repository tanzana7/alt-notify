import { z } from "zod";

const envSchema = z.object({
  APP_NAME: z.string().min(1).max(50).default("AltNoti"),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_DEV_GUILD_ID: z.string().optional(),
  OWNER_DISCORD_ID: z.string().optional(),
  DATABASE_PATH: z.string().default("./data/discord-alt-notify.sqlite"),
  FREE_LINK_LIMIT: z.coerce.number().int().min(1).max(100).default(1),
  MAX_PENDING_PER_MAIN: z.coerce.number().int().min(1).max(10_000).default(200),
  DM_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(1_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEVELOPER_TEST_DISCORD_ID: z.string().optional(),
  LINK_CODE_PEPPER: z.string().optional(),
  HEALTHCHECKS_HEARTBEAT_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().refine((value) => value.startsWith("https://"), "HTTPS URLが必要です").optional()),
  HEALTHCHECKS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(60_000),
  HEALTHCHECKS_MAX_PENDING_QUEUE: z.coerce.number().int().min(1).max(100_000).default(200),
  HEALTHCHECKS_MAX_FAILURES_15M: z.coerce.number().int().min(1).max(10_000).default(5)
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
