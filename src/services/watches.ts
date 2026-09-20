import type { SqliteDatabase } from "../db.js";
import type { AccountService } from "./accounts.js";

export interface GuildAccess { isMember(userId: string): Promise<boolean>; }
export type WatchState = "auto" | "on" | "off" | "unlinked";

export class WatchService {
  public constructor(private readonly db: SqliteDatabase, private readonly accounts: AccountService) {}

  public async set(guildId: string, subUserId: string, enabled: boolean, access: GuildAccess, now = Date.now()): Promise<void> {
    if (!this.accounts.getMainForSub(subUserId)) throw new Error("連携済みサブアカウントだけが利用できます");
    if (!(await access.isMember(subUserId))) throw new Error("このサーバーのメンバーであることを確認できません");
    this.db.raw.prepare("INSERT INTO guild_watches(guild_id, sub_user_id, enabled, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, sub_user_id) DO UPDATE SET enabled=excluded.enabled").run(guildId, subUserId, enabled ? 1 : 0, now);
  }

  public status(guildId: string, subUserId: string): WatchState {
    if (!this.accounts.getMainForSub(subUserId)) return "unlinked";
    const row = this.db.raw.prepare("SELECT enabled FROM guild_watches WHERE guild_id=? AND sub_user_id=?").get(guildId, subUserId) as { enabled: number } | undefined;
    if (!row) return "auto";
    return row.enabled === 1 ? "on" : "off";
  }
}
