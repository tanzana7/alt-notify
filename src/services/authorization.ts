import { PermissionFlagsBits, type Client, type GuildBasedChannel, type GuildMember } from "discord.js";
import type { AccountService } from "./accounts.js";
import { classifyDiscordError } from "./discord-errors.js";
import type { AuthorizationDecision, AuthorizedTarget, MentionKind, TargetMentionKind } from "./notifications.js";

export async function authorizeQueuedNotification(
  client: Pick<Client, "guilds">,
  accounts: AccountService,
  input: { mainUserId: string; guildId: string; channelId: string; kind: MentionKind; targetUserIds: string[]; targetKinds?: TargetMentionKind[]; mentionedRoleIds?: string[] }
): Promise<AuthorizationDecision> {
  if (!input.channelId) return { kind: "authorized", targets: [] };
  const guild = client.guilds.cache.get(input.guildId);
  // A missing cache entry is not proof that the bot left the guild; retry
  // briefly and only fail after the queue's finite authorization budget.
  if (!guild) return { kind: "retry", reason: "temporary discord api failure" };

  let channel: GuildBasedChannel | null | undefined = guild.channels.cache.get(input.channelId);
  if (!channel) {
    try { channel = await guild.channels.fetch(input.channelId); }
    catch (error) {
      const failure = classifyDiscordError(error, "channel");
      return failure.kind === "temporary" ? { kind: "retry", reason: failure.reason, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) } : { kind: "authorized", targets: [] };
    }
  }
  if (!channel || !("permissionsFor" in channel)) return { kind: "authorized", targets: [] };

  const permissionChannel = channel as unknown as { permissionsFor: (member: GuildMember) => { has: (permission: bigint) => boolean } | null };
  const mentionedRoleIds = input.mentionedRoleIds ?? [];
  const targetKinds = input.targetKinds?.length === input.targetUserIds.length ? input.targetKinds : input.targetUserIds.map(() => input.kind);
  const activeLinks = accounts.linkedSubsForGuild(input.guildId).filter((link) => link.mainUserId === input.mainUserId && input.targetUserIds.includes(link.subUserId));
  const authorized: AuthorizedTarget[] = [];
  for (const link of activeLinks) {
    let member: GuildMember;
    try {
      member = await guild.members.fetch(link.subUserId);
      if (!member) continue;
    } catch (error) {
      const failure = classifyDiscordError(error, "member");
      if (failure.kind === "temporary") return { kind: "retry", reason: failure.reason, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) };
      continue;
    }
    try {
      const targetIndex = input.targetUserIds.indexOf(link.subUserId);
      const targetKind = targetKinds[targetIndex];
      const roleMatch = mentionedRoleIds.some((roleId) => member.roles.cache.has(roleId));
      if (targetKind === "role" && !roleMatch) continue;
      const verifiedKind = targetKind === "role_or_everyone" ? (roleMatch ? "role" : "everyone") : targetKind;
      if (permissionChannel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) authorized.push({ userId: link.subUserId, label: link.username, ...(verifiedKind ? { kind: verifiedKind } : {}) });
    } catch (error) {
      const failure = classifyDiscordError(error, "permission");
      if (failure.kind === "temporary") return { kind: "retry", reason: failure.reason, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) };
    }
  }
  return { kind: "authorized", targets: authorized };
}
