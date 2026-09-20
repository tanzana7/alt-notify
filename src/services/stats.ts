import type { SqliteDatabase } from "../db.js";

export function getStats(db: SqliteDatabase, gatewayReady: boolean, guilds: number, now = Date.now()): Record<string, number | boolean> {
  const count = (sql: string, ...params: unknown[]) => Number((db.raw.prepare(sql).get(...params) as { count: number }).count);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return { guilds, mainAccounts: count("SELECT COUNT(*) AS count FROM main_accounts"), linkedAccounts: count("SELECT COUNT(*) AS count FROM account_links"), notificationsSentToday: count("SELECT COUNT(*) AS count FROM notification_queue WHERE status='sent' AND sent_at>=?", start.getTime()), notificationFailures: count("SELECT COUNT(*) AS count FROM notification_queue WHERE status='failed'"), pendingQueue: count("SELECT COUNT(*) AS count FROM notification_queue WHERE status IN ('pending','processing')"), gatewayReady };
}
