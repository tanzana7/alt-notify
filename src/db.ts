import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from "sql.js";

type Row = Record<string, unknown>;

class Statement {
  public constructor(private readonly database: SqliteFacade, private readonly sql: string) {}
  public run(...params: unknown[]): { changes: number; lastInsertRowid: number } { return this.database.run(this.sql, params); }
  public get(...params: unknown[]): Row | undefined { return this.database.get(this.sql, params); }
  public all(...params: unknown[]): Row[] { return this.database.all(this.sql, params); }
}

class SqliteFacade {
  private inTransaction = false;
  private closed = false;
  public constructor(private readonly database: SqlJsDatabase, private readonly persist: () => void) {}
  public prepare(sql: string): Statement { return new Statement(this, sql); }
  public exec(sql: string): void { this.database.run(sql); this.persist(); }
  public pragma(value: string): void { this.exec(`PRAGMA ${value}`); }
  public transaction<T>(callback: () => T): () => T {
    return () => {
      this.database.run("BEGIN");
      this.inTransaction = true;
      try { const result = callback(); this.database.run("COMMIT"); this.inTransaction = false; this.persist(); return result; }
      catch (error) { this.database.run("ROLLBACK"); this.inTransaction = false; throw error; }
    };
  }
  public run(sql: string, params: unknown[]): { changes: number; lastInsertRowid: number } {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(params as SqlValue[]);
      statement.step();
      const changes = this.database.getRowsModified();
      const lastInsertRowid = Number(this.database.exec("SELECT last_insert_rowid() AS id")[0]?.values[0]?.[0] ?? 0);
      return { changes, lastInsertRowid };
    } finally { statement.free(); if (!this.inTransaction) this.persist(); }
  }
  public get(sql: string, params: unknown[]): Row | undefined {
    const rows = this.query(sql, params);
    return rows[0];
  }
  public all(sql: string, params: unknown[]): Row[] { return this.query(sql, params); }
  private query(sql: string, params: unknown[]): Row[] {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(params as SqlValue[]);
      const rows: Row[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as Row);
      return rows;
    } finally { statement.free(); }
  }
  public close(): void { if (this.closed) return; this.persist(); this.database.close(); this.closed = true; }
}

export class SqliteDatabase {
  public readonly raw: SqliteFacade;

  private constructor(filePath: string, database: SqlJsDatabase) {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    this.raw = new SqliteFacade(database, () => {
      const bytes = database.export();
      // sql.js exports the complete database. Rename a sibling temporary file
      // so a process crash cannot leave a half-written SQLite file.
      const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      fs.writeFileSync(temporaryPath, Buffer.from(bytes), { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    });
    this.raw.pragma("foreign_keys = ON");
    this.migrate();
  }

  public static async open(filePath: string): Promise<SqliteDatabase> {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [path.join(moduleDir, "..", "node_modules", "sql.js", "dist"), path.join(moduleDir, "..", "..", "node_modules", "sql.js", "dist")];
    const wasmDir = candidates.find((candidate) => fs.existsSync(path.join(candidate, "sql-wasm.wasm"))) ?? candidates[0]!;
    const SQL = await initSqlJs({ locateFile: (file) => path.join(wasmDir, file) });
    const bytes = fs.existsSync(filePath) ? new Uint8Array(fs.readFileSync(filePath)) : undefined;
    return new SqliteDatabase(filePath, new SQL.Database(bytes));
  }

  public close(): void { this.raw.close(); }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS main_accounts (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_links (
        sub_user_id TEXT PRIMARY KEY,
        main_user_id TEXT NOT NULL REFERENCES main_accounts(user_id) ON DELETE CASCADE,
        username TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(main_user_id, sub_user_id)
      );
      CREATE TABLE IF NOT EXISTS link_codes (
        code_hash TEXT PRIMARY KEY, main_user_id TEXT NOT NULL REFERENCES main_accounts(user_id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guild_watches (
        guild_id TEXT NOT NULL, sub_user_id TEXT NOT NULL REFERENCES account_links(sub_user_id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, PRIMARY KEY(guild_id, sub_user_id)
      );
      CREATE TABLE IF NOT EXISTS notification_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, main_user_id TEXT NOT NULL REFERENCES main_accounts(user_id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK(kind IN ('direct', 'everyone')),
        mention_type TEXT NOT NULL DEFAULT 'direct' CHECK(mention_type IN ('direct', 'role', 'everyone')),
        target_user_ids TEXT NOT NULL, target_labels TEXT NOT NULL, target_role_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS notification_dedup (main_user_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(main_user_id, message_id));
      CREATE TABLE IF NOT EXISTS entitlements (user_id TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free', 'pro', 'developer_test')), updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_queue_due ON notification_queue(status, available_at);
      CREATE INDEX IF NOT EXISTS idx_watches_guild ON guild_watches(guild_id, enabled);
      CREATE INDEX IF NOT EXISTS idx_link_codes_expiry ON link_codes(expires_at);
    `);
    const queueColumns = this.raw.prepare("PRAGMA table_info(notification_queue)").all().map((row) => String(row.name));
    if (!queueColumns.includes("channel_id")) this.raw.exec("ALTER TABLE notification_queue ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''");
    if (!queueColumns.includes("mention_type")) {
      // Keep the legacy kind column for old tooling and add the role-aware type
      // separately so existing SQLite files do not need a destructive rebuild.
      this.raw.exec("ALTER TABLE notification_queue ADD COLUMN mention_type TEXT NOT NULL DEFAULT 'direct' CHECK(mention_type IN ('direct', 'role', 'everyone'))");
      this.raw.prepare("UPDATE notification_queue SET mention_type='everyone' WHERE kind='everyone'").run();
    }
    if (!queueColumns.includes("target_role_ids")) this.raw.exec("ALTER TABLE notification_queue ADD COLUMN target_role_ids TEXT NOT NULL DEFAULT '[]'");
  }

  public cleanup(now = Date.now(), recoverProcessing = true): void {
    this.raw.prepare("DELETE FROM link_codes WHERE expires_at < ? OR used_at IS NOT NULL").run(now);
    this.raw.prepare("DELETE FROM notification_dedup WHERE created_at < ?").run(now - 7 * 24 * 60 * 60 * 1000);
    this.raw.prepare("DELETE FROM notification_queue WHERE status IN ('sent', 'failed', 'cancelled') AND created_at < ?").run(now - 7 * 24 * 60 * 60 * 1000);
    if (recoverProcessing) this.raw.prepare("UPDATE notification_queue SET status = 'pending' WHERE status = 'processing'").run();
  }
}
