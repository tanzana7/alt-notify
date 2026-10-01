import type { SqliteDatabase } from "../db.js";
import type { AccountService } from "./accounts.js";
import type { Logger } from "../logger.js";
import { classifyDiscordError } from "./discord-errors.js";

export type MentionKind = "direct" | "role" | "everyone";
export interface IncomingMessage { id: string; guildId: string | null; channelId?: string; authorBot: boolean; mentionedUserIds: string[]; mentionedRoleIds?: string[]; mentionEveryone: boolean; }
export type AccessDecision = { kind: "allowed" } | { kind: "denied"; reason?: string } | { kind: "retry"; reason: string; retryAfterMs?: number };
export type AccessCheck = boolean | AccessDecision;
export type RoleAccessCheck = string[] | AccessDecision;
export interface GuildVisibility { isMember(userId: string): Promise<AccessCheck>; getMemberRoleIds?(userId: string): Promise<RoleAccessCheck>; canViewChannel(userId: string): Promise<AccessCheck>; }
export interface NotificationSender { send(mainUserId: string, content: string): Promise<void>; }
export interface NotificationDisplayNames { guildName?: string; channelName?: string; }
export type NotificationDisplayNameResolver = (guildId: string, channelId: string) => NotificationDisplayNames;
export interface AuthorizedTarget { userId: string; label: string; }
export type AuthorizationDecision = { kind: "authorized"; targets: AuthorizedTarget[] } | { kind: "retry"; reason: string; retryAfterMs?: number };
export interface NotificationAuthorization { authorize(input: { mainUserId: string; guildId: string; channelId: string; kind: MentionKind; targetUserIds: string[]; targetKinds?: MentionKind[]; mentionedRoleIds?: string[] }): Promise<AuthorizedTarget[] | AuthorizationDecision>; }

interface Group { mainUserId: string; kind: MentionKind; targetLabels: string[]; targetUserIds: string[]; targetKinds: MentionKind[]; mentionedRoleIds: string[]; }

const MAX_AUTHORIZATION_ATTEMPTS = 3;

function accessDecision(result: AccessCheck): AccessDecision {
  return typeof result === "boolean" ? (result ? { kind: "allowed" } : { kind: "denied" }) : result;
}

function decisionFromError(error: unknown, resource: "member" | "channel" | "permission"): AccessDecision {
  const failure = classifyDiscordError(error, resource);
  return failure.kind === "permanent" ? { kind: "denied", reason: failure.reason } : { kind: "retry", reason: failure.reason, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) };
}

function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  const exponential = Math.min(500 * (2 ** Math.max(0, attempt - 1)), 10_000);
  return Math.min(Math.max(retryAfterMs ?? exponential, 250), 10_000);
}

function mentionPriority(kind: MentionKind): number {
  return kind === "direct" ? 0 : kind === "role" ? 1 : 2;
}

function safeUserLabel(label: string): string | undefined {
  const normalized = label.trim().replace(/[\r\n]+/g, " ");
  // Old or partially authorized queue rows may contain a user ID as the
  // label. It is useful for internal authorization, but must never leak into
  // a user-facing DM.
  if (!normalized || /^\d{15,20}$/.test(normalized)) return undefined;
  return normalized;
}

function safeDisplayName(name: string | undefined): string | undefined {
  const normalized = name?.trim().replace(/[\r\n]+/g, " ");
  return normalized || undefined;
}

export function formatNotificationContent(mentionType: MentionKind, targetLabels: string[], displayNames: NotificationDisplayNames = {}): string {
  const lines = ["🔔 別アカウントにメンションがありました", ""];
  const kindLabel = mentionType === "direct" ? "直接メンション" : mentionType === "role" ? "ロールメンション" : "全体メンション";
  lines.push(`種類：${kindLabel}`);
  const labels = targetLabels.map(safeUserLabel).filter((label): label is string => Boolean(label));
  if (labels.length > 0) lines.push(`対象：${labels.join("、")}`);
  const guildName = safeDisplayName(displayNames.guildName);
  if (guildName) lines.push(`サーバー：${guildName}`);
  const channelName = safeDisplayName(displayNames.channelName);
  if (channelName) lines.push(`チャンネル：#${channelName.replace(/^#+/, "")}`);
  return lines.join("\n");
}

export class NotificationService {
  private readonly lastSentAt = new Map<string, number>();

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly accounts: AccountService,
    private readonly logger: Logger,
    private readonly now = () => Date.now(),
    private readonly options: { maxPendingPerMain?: number; minIntervalMs?: number } = {},
    private readonly resolveDisplayNames?: NotificationDisplayNameResolver
  ) {}

  public async inspect(message: IncomingMessage, visibility: GuildVisibility, labels = new Map<string, string>()): Promise<number> {
    if (message.authorBot || !message.guildId) return 0;
    const mentionedRoleIds = message.mentionedRoleIds ?? [];
    // This fast path avoids even the linked-account query for ordinary
    // messages. Role IDs come from Discord's message payload, not content.
    if (!message.mentionEveryone && message.mentionedUserIds.length === 0 && mentionedRoleIds.length === 0) return 0;
    const links = this.accounts.linkedSubsForGuild(message.guildId);
    const candidates = links.filter((link) => message.mentionEveryone || message.mentionedUserIds.includes(link.subUserId) || mentionedRoleIds.length > 0);
    if (candidates.length === 0) return 0;
    const groups = new Map<string, Group>();
    for (const candidate of candidates) {
      let member: AccessDecision;
      try { member = accessDecision(await visibility.isMember(candidate.subUserId)); }
      catch (error) { member = decisionFromError(error, "member"); }
      if (member.kind === "denied") continue;
      const directMatch = message.mentionedUserIds.includes(candidate.subUserId);
      let roleMatch = false;
      // Direct mentions already identify the target. Role IDs require a member
      // lookup; everyone remains a fallback for linked subs without a matched
      // role in the same message.
      if (member.kind === "allowed" && !directMatch && mentionedRoleIds.length > 0) {
        if (!visibility.getMemberRoleIds) {
          member = { kind: "retry", reason: "temporary discord api failure" };
        } else {
          try {
            const roleIds = await visibility.getMemberRoleIds(candidate.subUserId);
            if (Array.isArray(roleIds)) roleMatch = roleIds.some((roleId) => mentionedRoleIds.includes(roleId));
            else if (roleIds.kind === "retry") member = roleIds;
            else member = roleIds;
          } catch (error) { member = decisionFromError(error, "member"); }
        }
      }
      if (member.kind === "denied" || (!directMatch && !message.mentionEveryone && !roleMatch && member.kind === "allowed")) continue;
      if (member.kind === "allowed") {
        let channel: AccessDecision;
        try { channel = accessDecision(await visibility.canViewChannel(candidate.subUserId)); }
        catch (error) { channel = decisionFromError(error, "permission"); }
        if (channel.kind === "denied") continue;
      }
      // Temporary failures remain candidates for deferred, fail-closed
      // authorization in the delivery worker.
      const existing = groups.get(candidate.mainUserId);
      const kind: MentionKind = directMatch ? "direct" : roleMatch ? "role" : "everyone";
      const label = labels.get(candidate.subUserId) ?? candidate.username;
      if (existing) {
        if (!existing.targetUserIds.includes(candidate.subUserId)) { existing.targetUserIds.push(candidate.subUserId); existing.targetLabels.push(label); existing.targetKinds.push(kind); }
        if (kind === "direct") existing.kind = "direct";
        if (mentionPriority(kind) < mentionPriority(existing.kind)) existing.kind = kind;
      } else groups.set(candidate.mainUserId, { mainUserId: candidate.mainUserId, kind, targetUserIds: [candidate.subUserId], targetLabels: [label], targetKinds: [kind], mentionedRoleIds: kind === "role" ? [...mentionedRoleIds] : [] });
      if (existing && kind === "role") for (const roleId of mentionedRoleIds) if (!existing.mentionedRoleIds.includes(roleId)) existing.mentionedRoleIds.push(roleId);
    }
    let enqueued = 0;
    for (const group of groups.values()) {
      const queue = this.db.raw.transaction(() => {
        const result = this.db.raw.prepare("INSERT OR IGNORE INTO notification_dedup(main_user_id, message_id, created_at) VALUES (?, ?, ?)").run(group.mainUserId, message.id, this.now());
        if (result.changes === 0) return false;
        const availableAt = this.now() + (group.kind === "everyone" ? 60_000 : 0);
        const pendingCount = Number((this.db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE main_user_id=? AND status IN ('pending','processing')").get(group.mainUserId) as { count: number }).count);
        const maxPending = this.options.maxPendingPerMain ?? 200;
        let effectivePendingCount = pendingCount;
        if (group.kind !== "everyone" && pendingCount >= maxPending) {
          // Direct mentions are highest priority; role mentions are immediate
          // but remain below direct mentions and above delayed everyone rows.
          // Only pending lower-priority rows can be displaced; processing rows
          // are already in the send path.
          const evicted = group.kind === "direct"
            ? this.db.raw.prepare("SELECT id FROM notification_queue WHERE main_user_id=? AND mention_type IN ('role', 'everyone') AND status='pending' ORDER BY CASE mention_type WHEN 'everyone' THEN 0 ELSE 1 END, id DESC LIMIT 1").get(group.mainUserId) as { id: number } | undefined
            : this.db.raw.prepare("SELECT id FROM notification_queue WHERE main_user_id=? AND mention_type='everyone' AND status='pending' ORDER BY id DESC LIMIT 1").get(group.mainUserId) as { id: number } | undefined;
          if (evicted) {
            const evictionReason = group.kind === "direct" ? "evicted by direct mention priority" : "evicted by role mention priority";
            this.db.raw.prepare("UPDATE notification_queue SET status='failed', last_error=? WHERE id=? AND status='pending'").run(evictionReason, evicted.id);
            effectivePendingCount--;
            this.logger.warn("lower priority notification evicted", { mainUserId: group.mainUserId, priority: group.kind, evictedQueueId: evicted.id });
          }
        }
        if (effectivePendingCount >= maxPending) {
          this.db.raw.prepare("INSERT INTO notification_queue(main_user_id, message_id, guild_id, channel_id, kind, mention_type, target_user_ids, target_labels, target_role_ids, target_kinds, status, last_error, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)").run(group.mainUserId, message.id, message.guildId, message.channelId ?? "", group.kind === "role" ? "direct" : group.kind, group.kind, JSON.stringify(group.targetUserIds), JSON.stringify(group.targetLabels), JSON.stringify(group.mentionedRoleIds), JSON.stringify(group.targetKinds), "notification queue capacity exceeded", availableAt, this.now());
          this.logger.warn("notification queue capacity exceeded", { mainUserId: group.mainUserId, maxPending });
          return true;
        }
        this.db.raw.prepare("INSERT INTO notification_queue(main_user_id, message_id, guild_id, channel_id, kind, mention_type, target_user_ids, target_labels, target_role_ids, target_kinds, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(group.mainUserId, message.id, message.guildId, message.channelId ?? "", group.kind === "role" ? "direct" : group.kind, group.kind, JSON.stringify(group.targetUserIds), JSON.stringify(group.targetLabels), JSON.stringify(group.mentionedRoleIds), JSON.stringify(group.targetKinds), availableAt, this.now());
        return true;
      })();
      if (queue) enqueued++;
    }
    return enqueued;
  }

  public async drain(sender: NotificationSender, now = this.now(), max = 50, authorization?: NotificationAuthorization): Promise<{ sent: number; failed: number }> {
    const rows = this.db.raw.prepare("SELECT * FROM notification_queue WHERE status='pending' AND available_at<=? ORDER BY CASE mention_type WHEN 'direct' THEN 0 WHEN 'role' THEN 1 ELSE 2 END, id LIMIT ?").all(now, max) as Array<Record<string, unknown>>;
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
        let decision: AuthorizationDecision;
        try {
          const result = await authorization.authorize({ mainUserId: String(row.main_user_id), guildId: String(row.guild_id), channelId: String(row.channel_id ?? ""), kind: row.mention_type as MentionKind, targetUserIds: targetIds, targetKinds: JSON.parse(String(row.target_kinds ?? "[]")) as MentionKind[], mentionedRoleIds: JSON.parse(String(row.target_role_ids ?? "[]")) as string[] });
          decision = Array.isArray(result) ? { kind: "authorized", targets: result } : result;
        } catch (error) {
          const failure = classifyDiscordError(error);
          decision = failure.kind === "temporary" ? { kind: "retry", reason: failure.reason, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) } : { kind: "authorized", targets: [] };
        }
        if (decision.kind === "retry") {
          // The SELECT snapshot contains the value before the conditional
          // claim increments it, so include the current authorization attempt.
          const attempts = Number(row.attempts ?? 0) + 1;
          if (attempts >= MAX_AUTHORIZATION_ATTEMPTS) {
            this.db.raw.prepare("UPDATE notification_queue SET status='failed', last_error=? WHERE id=? AND status='processing'").run(decision.reason, row.id);
            this.logger.warn("notification authorization retry limit reached", { queueId: row.id, reason: decision.reason });
            failed++;
          } else {
            const availableAt = now + retryDelayMs(attempts, decision.retryAfterMs);
            this.db.raw.prepare("UPDATE notification_queue SET status='pending', available_at=?, last_error=? WHERE id=? AND status='processing'").run(availableAt, decision.reason, row.id);
          }
          continue;
        }
        const authorizedById = new Map(decision.targets.map((target) => [target.userId, target.label]));
        targetIds = targetIds.filter((userId) => authorizedById.has(userId));
        labels = targetIds.map((userId) => authorizedById.get(userId) ?? userId);
        if (targetIds.length === 0) {
          this.db.raw.prepare("UPDATE notification_queue SET status='cancelled', last_error='authorization revoked before send' WHERE id=? AND status='processing'").run(row.id);
          continue;
        }
        this.db.raw.prepare("UPDATE notification_queue SET target_user_ids=?, target_labels=?, last_error=NULL WHERE id=? AND status='processing'").run(JSON.stringify(targetIds), JSON.stringify(labels), row.id);
      }
      let displayNames: NotificationDisplayNames = {};
      try { displayNames = this.resolveDisplayNames?.(String(row.guild_id), String(row.channel_id ?? "")) ?? {}; }
      catch (error) { this.logger.warn("notification display name lookup failed", { queueId: row.id, error: error instanceof Error ? error.message : "unknown" }); }
      const content = formatNotificationContent(row.mention_type as MentionKind, labels, displayNames);
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
        const failure = classifyDiscordError(error);
        if (attempt === 2 || failure.kind !== "temporary") throw error;
        const delayMs = failure.retryAfterMs ?? 250 * (2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw new Error("unreachable");
  }
}
