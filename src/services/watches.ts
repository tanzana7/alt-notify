import type { SqliteDatabase } from "../db.js";
import type { AccountService } from "./accounts.js";
import { classifyDiscordError } from "./discord-errors.js";
import { UserFacingError } from "./user-error.js";

export interface GuildAccess { isMember(userId: string): Promise<boolean>; }
export type WatchState = "auto" | "on" | "off" | "unlinked";

export function memberAccessForWatch(fetchMember: (userId: string) => Promise<unknown>): GuildAccess {
  return { isMember: async (userId) => {
    try { return Boolean(await fetchMember(userId)); }
    catch (error) {
      const failure = classifyDiscordError(error, "member");
      if (failure.kind === "permanent") return false;
      throw new UserFacingError("メンバーを確認できません。時間をおいて再度お試しください。");
    }
  } };
}

export class WatchService {
  public constructor(private readonly db: SqliteDatabase, private readonly accounts: AccountService) {}

  public async set(guildId: string, subUserId: string, enabled: boolean, access: GuildAccess, now = Date.now()): Promise<void> {
    if (this.accounts.isPrivacyDeletionActive(subUserId)) throw new UserFacingError("アカウント削除処理中です。完了後に再度お試しください。");
    if (!this.accounts.getMainForSub(subUserId)) throw new UserFacingError("連携済みサブアカウントだけが利用できます");
    // A user who invoked this guild command can always revoke local monitoring,
    // even when Discord's member API is temporarily unavailable.
    if (enabled && !(await access.isMember(subUserId))) throw new UserFacingError("このサーバーのメンバーであることを確認できません");
    if (this.accounts.isPrivacyDeletionActive(subUserId) || !this.accounts.getMainForSub(subUserId)) throw new UserFacingError("連携状態が変更されました。もう一度お試しください。");
    this.db.raw.prepare("INSERT INTO guild_watches(guild_id, sub_user_id, enabled, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, sub_user_id) DO UPDATE SET enabled=excluded.enabled").run(guildId, subUserId, enabled ? 1 : 0, now);
  }

  public status(guildId: string, subUserId: string): WatchState {
    if (!this.accounts.getMainForSub(subUserId)) return "unlinked";
    const row = this.db.raw.prepare("SELECT enabled FROM guild_watches WHERE guild_id=? AND sub_user_id=?").get(guildId, subUserId) as { enabled: number } | undefined;
    if (!row) return "auto";
    return row.enabled === 1 ? "on" : "off";
  }
}
