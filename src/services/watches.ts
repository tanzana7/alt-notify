import type { SqliteDatabase } from "../db.js";
import type { AccountService } from "./accounts.js";

export interface GuildAccess { isMember(userId: string): Promise<boolean>; }

export class WatchService {
  public constructor(private readonly db: SqliteDatabase, private readonly accounts: AccountService) {}

  public async set(guildId: string, subUserId: string, enabled: boolean, access: GuildAccess, now = Date.now()): Promise<void> {
    if (!this.accounts.getMainForSub(subUserId)) throw new Error("連携済みサブアカウントだけが利用できます");
    if (!(await access.isMember(subUserId))) throw new Error("このサーバーのメンバーであることを確認できません");
    if (enabled) this.db.raw.prepare("INSERT INTO guild_watches(guild_id, sub_user_id, enabled, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(guild_id, sub_user_id) DO UPDATE SET enabled=1").run(guildId, subUserId, now);
    else this.db.raw.prepare("UPDATE guild_watches SET enabled=0 WHERE guild_id=? AND sub_user_id=?").run(guildId, subUserId);
  }

  public status(guildId: string, subUserId: string): boolean { return Boolean(this.db.raw.prepare("SELECT 1 FROM guild_watches WHERE guild_id=? AND sub_user_id=? AND enabled=1").get(guildId, subUserId)); }
}
