import { PermissionFlagsBits, type GuildMember, type Message } from "discord.js";
import { classifyDiscordError } from "./discord-errors.js";
import type { MemberCache } from "./member-cache.js";
import type { GuildVisibility } from "./notifications.js";

export function createMessageVisibility(message: Message, memberCache: MemberCache<GuildMember>): GuildVisibility {
  const guild = message.guild!;
  const cacheKey = (userId: string) => `${guild.id}:${userId}`;
  const getMember = (userId: string): Promise<GuildMember | null> => memberCache.get(cacheKey(userId), async () => {
    try { return guild.members.cache.get(userId) ?? await guild.members.fetch(userId); }
    catch (error) {
      const failure = classifyDiscordError(error, "member");
      if (failure.kind === "permanent") return null;
      throw error;
    }
  });
  return {
    isMember: async (userId: string) => {
      try { return Boolean(await getMember(userId)); }
      catch (error) {
        const failure = classifyDiscordError(error, "member");
        return failure.kind === "temporary" ? { kind: "retry" as const, reason: failure.reason, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) } : { kind: "denied" as const, reason: failure.reason };
      }
    },
    canViewChannel: async (userId: string) => {
      try {
        const member = await getMember(userId);
        if (!member) return false;
        const permissions = (message.channel as unknown as { permissionsFor: (member: GuildMember) => { has: (permission: bigint) => boolean } | null }).permissionsFor(member);
        return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel));
      } catch (error) {
        const failure = classifyDiscordError(error, "permission");
        return failure.kind === "temporary" ? { kind: "retry" as const, reason: failure.reason, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) } : { kind: "denied" as const, reason: failure.reason };
      }
    },
    getMemberRoleIds: async (userId: string) => {
      try {
        const member = await getMember(userId);
        return member ? [...member.roles.cache.keys()] : { kind: "denied" as const, reason: "discord member not found" };
      } catch (error) {
        const failure = classifyDiscordError(error, "member");
        return failure.kind === "temporary" ? { kind: "retry" as const, reason: failure.reason, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) } : { kind: "denied" as const, reason: failure.reason };
      }
    },
    refreshMemberRoleIds: async (userId: string) => {
      try {
        const member = await guild.members.fetch({ user: userId, force: true });
        // The next permission check must use the fresh member, not a stale
        // five-second entry or the discord.js member cache we just bypassed.
        memberCache.set(cacheKey(userId), member);
        return [...member.roles.cache.keys()];
      } catch (error) {
        const failure = classifyDiscordError(error, "member");
        if (failure.kind === "permanent") memberCache.set(cacheKey(userId), null);
        return failure.kind === "temporary" ? { kind: "retry" as const, reason: failure.reason, ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}) } : { kind: "denied" as const, reason: failure.reason };
      }
    }
  };
}
