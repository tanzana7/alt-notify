import crypto from "node:crypto";
import type { SqliteDatabase } from "../db.js";

export type Plan = "free" | "pro" | "developer_test";
export interface AccountStatus { kind: "main" | "sub" | "none"; mainUserId?: string; mainUsername?: string; links: Array<{ userId: string; username: string; watchOffGuilds?: string[] }>; watches: string[]; watchOffGuilds: string[]; }

export class AccountService {
  private readonly failedCodeAttempts = new Map<string, { since: number; count: number }>();
  public constructor(private readonly db: SqliteDatabase, private readonly developerTestId?: string, private readonly pepper = "") {}

  public registerMain(userId: string, username: string, testDm: () => Promise<void>, now = Date.now()): Promise<void> {
    return testDm().then(() => {
      const tx = this.db.raw.transaction(() => {
        this.db.raw.prepare("INSERT INTO main_accounts(user_id, username, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username").run(userId, username, now);
        const plan: Plan = userId === this.developerTestId ? "developer_test" : "free";
        this.db.raw.prepare("INSERT INTO entitlements(user_id, plan, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan, updated_at=excluded.updated_at").run(userId, plan, now);
      });
      tx();
    });
  }

  public issueLinkCode(mainUserId: string, now = Date.now()): string {
    this.requireMain(mainUserId);
    const code = crypto.randomBytes(18).toString("base64url");
    const hash = this.hashCode(code);
    const tx = this.db.raw.transaction(() => {
      this.db.raw.prepare("DELETE FROM link_codes WHERE main_user_id = ?").run(mainUserId);
      this.db.raw.prepare("INSERT INTO link_codes(code_hash, main_user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(hash, mainUserId, now + 10 * 60 * 1000, now);
    });
    tx();
    return code;
  }

  public previewLinkCode(subUserId: string, code: string, now = Date.now()): { mainUserId: string; mainUsername: string } {
    const attempt = this.failedCodeAttempts.get(subUserId);
    if (attempt && attempt.since + 60_000 > now && attempt.count >= 5) throw new Error("試行回数が多すぎます。しばらく待ってください");
    try {
      const row = this.getCodeRow(this.hashCode(code));
      this.validateCode(row, subUserId, now);
      this.failedCodeAttempts.delete(subUserId);
      return { mainUserId: row.mainUserId, mainUsername: row.mainUsername };
    } catch (error) {
      const current = attempt && attempt.since + 60_000 > now ? attempt : { since: now, count: 0 };
      this.failedCodeAttempts.set(subUserId, { since: current.since, count: current.count + 1 });
      throw error;
    }
  }

  public approveLinkByHash(subUserId: string, codeHash: string, username: string, now = Date.now()): { mainUserId: string; mainUsername: string } {
    const tx = this.db.raw.transaction(() => {
      const row = this.getCodeRow(codeHash);
      this.validateCode(row, subUserId, now);
      const count = (this.db.raw.prepare("SELECT COUNT(*) AS count FROM account_links WHERE main_user_id=?").get(row.mainUserId) as { count: number }).count;
      const entitlement = this.db.raw.prepare("SELECT plan FROM entitlements WHERE user_id=?").get(row.mainUserId) as { plan: Plan } | undefined;
      const limit = entitlement?.plan === "developer_test" || entitlement?.plan === "pro" ? 5 : 1;
      if (count >= limit) throw new Error("連携可能なサブアカウント数の上限に達しています");
      this.db.raw.prepare("INSERT INTO account_links(sub_user_id, main_user_id, username, created_at) VALUES (?, ?, ?, ?)").run(subUserId, row.mainUserId, username, now);
      this.db.raw.prepare("UPDATE link_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL").run(now, codeHash);
      return { mainUserId: row.mainUserId, mainUsername: row.mainUsername };
    });
    return tx() as { mainUserId: string; mainUsername: string };
  }

  public unlink(requesterId: string, targetSubUserId?: string, now = Date.now()): number {
    const target = targetSubUserId ?? null;
    const row = this.db.raw.prepare(`
      SELECT sub_user_id AS subUserId, main_user_id AS mainUserId FROM account_links
      WHERE (main_user_id=? AND (? IS NULL OR sub_user_id=?)) OR (sub_user_id=? AND ? IS NULL)
    `).get(requesterId, target, target, requesterId, target) as { subUserId: string; mainUserId: string } | undefined;
    if (!row) return 0;
    const tx = this.db.raw.transaction(() => {
      this.db.raw.prepare("UPDATE notification_queue SET status='cancelled', last_error='account unlinked' WHERE main_user_id=? AND status IN ('pending','processing')").run(row.mainUserId);
      this.db.raw.prepare("DELETE FROM link_codes WHERE main_user_id=?").run(row.mainUserId);
      this.db.raw.prepare("DELETE FROM account_links WHERE sub_user_id=?").run(row.subUserId);
    });
    tx();
    return 1;
  }

  public getStatus(userId: string): AccountStatus {
    const main = this.db.raw.prepare("SELECT user_id AS userId FROM main_accounts WHERE user_id=?").get(userId) as { userId: string } | undefined;
    if (main) {
      const links = this.db.raw.prepare(`
        SELECT l.sub_user_id AS userId, l.username,
          COALESCE((SELECT json_group_array(w.guild_id) FROM guild_watches w WHERE w.sub_user_id=l.sub_user_id AND w.enabled=0), '[]') AS watchOffGuilds
        FROM account_links l WHERE l.main_user_id=? ORDER BY l.created_at
      `).all(userId).map((row) => ({ ...(row as { userId: string; username: string; watchOffGuilds: string }), watchOffGuilds: JSON.parse((row as { watchOffGuilds: string }).watchOffGuilds) as string[] }));
      const watches = this.db.raw.prepare("SELECT guild_id FROM guild_watches WHERE sub_user_id IN (SELECT sub_user_id FROM account_links WHERE main_user_id=?) AND enabled=1").all(userId).map((r) => (r as { guild_id: string }).guild_id);
      const watchOffGuilds = this.db.raw.prepare("SELECT DISTINCT guild_id FROM guild_watches WHERE sub_user_id IN (SELECT sub_user_id FROM account_links WHERE main_user_id=?) AND enabled=0").all(userId).map((r) => (r as { guild_id: string }).guild_id);
      return { kind: "main", links, watches, watchOffGuilds };
    }
    const sub = this.getMainForSub(userId);
    if (!sub) return { kind: "none", links: [], watches: [], watchOffGuilds: [] };
    const watches = this.db.raw.prepare("SELECT guild_id FROM guild_watches WHERE sub_user_id=? AND enabled=1").all(userId).map((r) => (r as { guild_id: string }).guild_id);
    const watchOffGuilds = this.db.raw.prepare("SELECT guild_id FROM guild_watches WHERE sub_user_id=? AND enabled=0").all(userId).map((r) => (r as { guild_id: string }).guild_id);
    return { kind: "sub", mainUserId: sub.mainUserId, mainUsername: sub.mainUsername, links: [], watches, watchOffGuilds };
  }

  public getMainForSub(subUserId: string): { mainUserId: string; mainUsername: string } | undefined {
    return this.db.raw.prepare("SELECT l.main_user_id AS mainUserId, m.username AS mainUsername FROM account_links l JOIN main_accounts m ON m.user_id=l.main_user_id WHERE l.sub_user_id=?").get(subUserId) as { mainUserId: string; mainUsername: string } | undefined;
  }

  public linkedSubsForGuild(guildId: string): Array<{ mainUserId: string; subUserId: string; username: string }> {
    // 設定行がない場合は自動監視ON。enabled=0だけが明示的なOFFとして除外される。
    return this.db.raw.prepare(`
      SELECT l.main_user_id AS mainUserId, l.sub_user_id AS subUserId, l.username
      FROM account_links l LEFT JOIN guild_watches w ON w.sub_user_id=l.sub_user_id AND w.guild_id=?
      WHERE w.enabled IS NULL OR w.enabled=1
    `).all(guildId) as Array<{ mainUserId: string; subUserId: string; username: string }>;
  }

  private getCodeRow(codeHash: string): { mainUserId: string; mainUsername: string; expiresAt: number; usedAt: number | null } {
    const row = this.db.raw.prepare(`SELECT c.main_user_id AS mainUserId, m.username AS mainUsername, c.expires_at AS expiresAt, c.used_at AS usedAt FROM link_codes c JOIN main_accounts m ON m.user_id=c.main_user_id WHERE c.code_hash=?`).get(codeHash) as { mainUserId: string; mainUsername: string; expiresAt: number; usedAt: number | null } | undefined;
    if (!row) throw new Error("連携コードが無効または期限切れです");
    return row;
  }

  private validateCode(row: { mainUserId: string; expiresAt: number; usedAt: number | null }, subUserId: string, now: number): void {
    if (row.usedAt !== null || row.expiresAt <= now) throw new Error("連携コードが無効または期限切れです");
    if (row.mainUserId === subUserId) throw new Error("自分自身は連携できません");
    if (this.db.raw.prepare("SELECT 1 FROM account_links WHERE sub_user_id=?").get(subUserId)) throw new Error("このアカウントは既に連携済みです");
  }

  private requireMain(userId: string): void { if (!this.db.raw.prepare("SELECT 1 FROM main_accounts WHERE user_id=?").get(userId)) throw new Error("先に /main set を実行してください"); }
  private hashCode(code: string): string { return crypto.createHash("sha256").update(`${this.pepper}:${code}`).digest("hex"); }
  public hashForApproval(code: string): string { return this.hashCode(code); }
}
