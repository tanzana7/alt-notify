import type { SqliteDatabase } from "../db.js";
import type { AccountService } from "./accounts.js";
import type { Logger } from "../logger.js";

export type MentionKind = "direct" | "everyone";
export interface IncomingMessage { id: string; guildId: string | null; authorBot: boolean; mentionedUserIds: string[]; mentionEveryone: boolean; }
export interface GuildVisibility { isMember(userId: string): Promise<boolean>; canViewChannel(userId: string): Promise<boolean>; }
export interface NotificationSender { send(mainUserId: string, content: string): Promise<void>; }

interface Group { mainUserId: string; kind: MentionKind; targetLabels: string[]; targetUserIds: string[]; }

export class NotificationService {
  public constructor(private readonly db: SqliteDatabase, private readonly accounts: AccountService, private readonly logger: Logger, private readonly now = () => Date.now()) {}

  public async inspect(message: IncomingMessage, visibility: GuildVisibility, labels = new Map<string, string>()): Promise<number> {
    if (message.authorBot || !message.guildId) return 0;
    const links = this.accounts.linkedSubsForGuild(message.guildId);
    const candidates = links.filter((link) => message.mentionEveryone || message.mentionedUserIds.includes(link.subUserId));
    if (candidates.length === 0) return 0;
    const groups = new Map<string, Group>();
    for (const candidate of candidates) {
      if (!(await visibility.isMember(candidate.subUserId)) || !(await visibility.canViewChannel(candidate.subUserId))) continue;
      const existing = groups.get(candidate.mainUserId);
      const kind: MentionKind = message.mentionEveryone ? "everyone" : "direct";
      const label = labels.get(candidate.subUserId) ?? candidate.username;
      if (existing) {
        if (!existing.targetUserIds.includes(candidate.subUserId)) { existing.targetUserIds.push(candidate.subUserId); existing.targetLabels.push(label); }
        if (kind === "direct") existing.kind = "direct";
      } else groups.set(candidate.mainUserId, { mainUserId: candidate.mainUserId, kind, targetUserIds: [candidate.subUserId], targetLabels: [label] });
    }
    let enqueued = 0;
    for (const group of groups.values()) {
      const queue = this.db.raw.transaction(() => {
        const result = this.db.raw.prepare("INSERT OR IGNORE INTO notification_dedup(main_user_id, message_id, created_at) VALUES (?, ?, ?)").run(group.mainUserId, message.id, this.now());
        if (result.changes === 0) return false;
        const availableAt = this.now() + (group.kind === "everyone" ? 60_000 : 0);
        this.db.raw.prepare("INSERT INTO notification_queue(main_user_id, message_id, guild_id, kind, target_user_ids, target_labels, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(group.mainUserId, message.id, message.guildId, group.kind, JSON.stringify(group.targetUserIds), JSON.stringify(group.targetLabels), availableAt, this.now());
        return true;
      })();
      if (queue) enqueued++;
    }
    return enqueued;
  }

  public async drain(sender: NotificationSender, now = this.now(), max = 50): Promise<{ sent: number; failed: number }> {
    const rows = this.db.raw.prepare("SELECT * FROM notification_queue WHERE status='pending' AND available_at<=? ORDER BY id LIMIT ?").all(now, max) as Array<Record<string, unknown>>;
    let sent = 0; let failed = 0;
    for (const row of rows) {
      this.db.raw.prepare("UPDATE notification_queue SET status='processing', attempts=attempts+1 WHERE id=? AND status='pending'").run(row.id);
      const labels = JSON.parse(String(row.target_labels)) as string[];
      const content = `🔔 別アカウントにメンションがありました\n\n対象アカウント：${labels.join("、")}\nサーバー：${String(row.guild_id)}\n種類：${row.kind === "direct" ? "直接メンション" : "全体メンション"}`;
      try {
        await this.sendWithRetry(() => sender.send(String(row.main_user_id), content));
        this.db.raw.prepare("UPDATE notification_queue SET status='sent', sent_at=? WHERE id=?").run(now, row.id);
        sent++;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown send error";
        this.db.raw.prepare("UPDATE notification_queue SET status='failed', last_error=? WHERE id=?").run(message.slice(0, 500), row.id);
        this.logger.error("notification send failed", { queueId: row.id, mainUserId: row.main_user_id, error: message.slice(0, 200) });
        failed++;
      }
    }
    return { sent, failed };
  }

  private async sendWithRetry(send: () => Promise<void>): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await send(); return; }
      catch (error) {
        const retryAfter = typeof error === "object" && error !== null && "retryAfter" in error ? Number((error as { retryAfter: unknown }).retryAfter) : 0;
        if (attempt === 2 || !Number.isFinite(retryAfter) || retryAfter <= 0) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter * 1000, 10_000)));
      }
    }
    throw new Error("unreachable");
  }
}
