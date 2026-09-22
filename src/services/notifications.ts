import type { SqliteDatabase } from "../db.js";
import type { AccountService } from "./accounts.js";
import type { Logger } from "../logger.js";

export type MentionKind = "direct" | "everyone";
export interface IncomingMessage { id: string; guildId: string | null; channelId?: string; authorBot: boolean; mentionedUserIds: string[]; mentionEveryone: boolean; }
export interface GuildVisibility { isMember(userId: string): Promise<boolean>; canViewChannel(userId: string): Promise<boolean>; }
export interface NotificationSender { send(mainUserId: string, content: string): Promise<void>; }
export interface AuthorizedTarget { userId: string; label: string; }
export interface NotificationAuthorization { authorize(input: { mainUserId: string; guildId: string; channelId: string; kind: MentionKind; targetUserIds: string[] }): Promise<AuthorizedTarget[]>; }

interface Group { mainUserId: string; kind: MentionKind; targetLabels: string[]; targetUserIds: string[]; }

export class NotificationService {
  private readonly lastSentAt = new Map<string, number>();

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly accounts: AccountService,
    private readonly logger: Logger,
    private readonly now = () => Date.now(),
    private readonly options: { maxPendingPerMain?: number; minIntervalMs?: number } = {}
  ) {}

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
        const pendingCount = Number((this.db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE main_user_id=? AND status IN ('pending','processing')").get(group.mainUserId) as { count: number }).count);
        const maxPending = this.options.maxPendingPerMain ?? 200;
        if (pendingCount >= maxPending) {
          this.db.raw.prepare("INSERT INTO notification_queue(main_user_id, message_id, guild_id, channel_id, kind, target_user_ids, target_labels, status, last_error, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)").run(group.mainUserId, message.id, message.guildId, message.channelId ?? "", group.kind, JSON.stringify(group.targetUserIds), JSON.stringify(group.targetLabels), "notification queue capacity exceeded", availableAt, this.now());
          this.logger.warn("notification queue capacity exceeded", { mainUserId: group.mainUserId, maxPending });
          return true;
        }
        this.db.raw.prepare("INSERT INTO notification_queue(main_user_id, message_id, guild_id, channel_id, kind, target_user_ids, target_labels, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(group.mainUserId, message.id, message.guildId, message.channelId ?? "", group.kind, JSON.stringify(group.targetUserIds), JSON.stringify(group.targetLabels), availableAt, this.now());
        return true;
      })();
      if (queue) enqueued++;
    }
    return enqueued;
  }

  public async drain(sender: NotificationSender, now = this.now(), max = 50, authorization?: NotificationAuthorization): Promise<{ sent: number; failed: number }> {
    const rows = this.db.raw.prepare("SELECT * FROM notification_queue WHERE status='pending' AND available_at<=? ORDER BY id LIMIT ?").all(now, max) as Array<Record<string, unknown>>;
    let sent = 0; let failed = 0;
    for (const row of rows) {
      const lastSentAt = this.lastSentAt.get(String(row.main_user_id));
      const minIntervalMs = this.options.minIntervalMs ?? 1_000;
      if (lastSentAt !== undefined && now - lastSentAt < minIntervalMs) continue;
      const claim = this.db.raw.prepare("UPDATE notification_queue SET status='processing', attempts=attempts+1 WHERE id=? AND status='pending'").run(row.id);
      if (claim.changes !== 1) continue;
      let targetIds = JSON.parse(String(row.target_user_ids)) as string[];
      let labels = JSON.parse(String(row.target_labels)) as string[];
      if (authorization) {
        let authorized: AuthorizedTarget[];
        try {
          authorized = await authorization.authorize({ mainUserId: String(row.main_user_id), guildId: String(row.guild_id), channelId: String(row.channel_id ?? ""), kind: row.kind as MentionKind, targetUserIds: targetIds });
        } catch (error) {
          const message = error instanceof Error ? error.message : "authorization error";
          this.db.raw.prepare("UPDATE notification_queue SET status='failed', last_error=? WHERE id=? AND status='processing'").run(message.slice(0, 500), row.id);
          this.logger.error("notification authorization failed", { queueId: row.id, error: message.slice(0, 200) });
          failed++;
          continue;
        }
        const authorizedById = new Map(authorized.map((target) => [target.userId, target.label]));
        targetIds = targetIds.filter((userId) => authorizedById.has(userId));
        labels = targetIds.map((userId) => authorizedById.get(userId) ?? userId);
        if (targetIds.length === 0) {
          this.db.raw.prepare("UPDATE notification_queue SET status='cancelled', last_error='authorization revoked before send' WHERE id=? AND status='processing'").run(row.id);
          continue;
        }
        this.db.raw.prepare("UPDATE notification_queue SET target_user_ids=?, target_labels=? WHERE id=? AND status='processing'").run(JSON.stringify(targetIds), JSON.stringify(labels), row.id);
      }
      const content = `🔔 別アカウントにメンションがありました\n\n対象アカウント：${labels.join("、")}\nサーバー：${String(row.guild_id)}\n種類：${row.kind === "direct" ? "直接メンション" : "全体メンション"}`;
      try {
        await this.sendWithRetry(() => sender.send(String(row.main_user_id), content));
        this.db.raw.prepare("UPDATE notification_queue SET status='sent', sent_at=? WHERE id=? AND status='processing'").run(now, row.id);
        this.lastSentAt.set(String(row.main_user_id), now);
        sent++;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown send error";
        this.db.raw.prepare("UPDATE notification_queue SET status='failed', last_error=? WHERE id=? AND status='processing'").run(message.slice(0, 500), row.id);
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
        const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : 0;
        const transient = status === 429 || [500, 502, 503, 504].includes(status) || retryAfter > 0;
        if (attempt === 2 || !transient) throw error;
        const delayMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 250 * (2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw new Error("unreachable");
  }
}
