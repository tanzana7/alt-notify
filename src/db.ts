import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from "sql.js";

type Row = Record<string, unknown>;

export class FatalDatabasePersistenceError extends Error {
  public constructor() { super("Alt Notify database persistence failed; process must restart"); this.name = "FatalDatabasePersistenceError"; }
}

class Statement {
  public constructor(private readonly database: SqliteFacade, private readonly sql: string) {}
  public run(...params: unknown[]): { changes: number; lastInsertRowid: number } { return this.database.run(this.sql, params); }
  public get(...params: unknown[]): Row | undefined { return this.database.get(this.sql, params); }
  public all(...params: unknown[]): Row[] { return this.database.all(this.sql, params); }
}

class SqliteFacade {
  private inTransaction = false;
  private closed = false;
  private poisoned = false;
  public constructor(private readonly database: SqlJsDatabase, private readonly persist: () => void, private readonly onFatal?: () => void) {}
  public assertHealthy(): void { if (this.poisoned) throw new FatalDatabasePersistenceError(); }
  private save(): void {
    this.assertHealthy();
    try { this.persist(); }
    catch {
      // A committed sql.js change may now differ from the on-disk database.
      // No subsequent read, write, or graceful shutdown may use that memory.
      this.poisoned = true;
      try { this.onFatal?.(); } catch { /* Poison state takes precedence over callback diagnostics. */ }
      throw new FatalDatabasePersistenceError();
    }
  }
  public prepare(sql: string): Statement { this.assertHealthy(); return new Statement(this, sql); }
  public exec(sql: string): void { this.assertHealthy(); this.database.run(sql); this.save(); }
  public pragma(value: string): void { this.exec(`PRAGMA ${value}`); }
  public transaction<T>(callback: () => T): () => T {
    return () => {
      this.assertHealthy();
      this.database.run("BEGIN");
      this.inTransaction = true;
      let result: T;
      try { result = callback(); this.database.run("COMMIT"); }
      catch (error) { try { this.database.run("ROLLBACK"); } finally { this.inTransaction = false; } throw error; }
      this.inTransaction = false;
      // COMMIT has already happened. A failed disk save must never be followed
      // by ROLLBACK or treated as an ordinary recoverable transaction error.
      this.save();
      return result;
    };
  }
  public run(sql: string, params: unknown[]): { changes: number; lastInsertRowid: number } {
    this.assertHealthy();
    const statement = this.database.prepare(sql);
    let succeeded = false;
    try {
      statement.bind(params as SqlValue[]);
      statement.step();
      succeeded = true;
      const changes = this.database.getRowsModified();
      const lastInsertRowid = Number(this.database.exec("SELECT last_insert_rowid() AS id")[0]?.values[0]?.[0] ?? 0);
      return { changes, lastInsertRowid };
    } finally { statement.free(); if (succeeded && !this.inTransaction) this.save(); }
  }
  public get(sql: string, params: unknown[]): Row | undefined {
    const rows = this.query(sql, params);
    return rows[0];
  }
  public all(sql: string, params: unknown[]): Row[] { return this.query(sql, params); }
  private query(sql: string, params: unknown[]): Row[] {
    this.assertHealthy();
    const statement = this.database.prepare(sql);
    try {
      statement.bind(params as SqlValue[]);
      const rows: Row[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as Row);
      return rows;
    } finally { statement.free(); }
  }
  public close(): void { if (this.closed) return; if (!this.poisoned) this.save(); this.database.close(); this.closed = true; }
}

export class SqliteDatabase {
  public readonly raw: SqliteFacade;

  private constructor(private readonly filePath: string, database: SqlJsDatabase, persistToFile = true, onFatalPersistenceError?: () => void) {
    if (persistToFile) fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    this.raw = new SqliteFacade(database, () => {
      if (!persistToFile) return;
      const bytes = database.export();
      // sql.js exports the complete database. Rename a sibling temporary file
      // so a process crash cannot leave a half-written SQLite file.
      const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(temporaryPath, "wx", 0o600);
        fs.writeFileSync(descriptor, Buffer.from(bytes));
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor); descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
        // A successful rename without directory durability can still be lost
        // on a power failure, which matters for account deletion confirmation.
        if (process.platform !== "win32") {
          const directory = fs.openSync(path.dirname(path.resolve(filePath)), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
          try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        }
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      }
    }, onFatalPersistenceError);
    this.raw.pragma("foreign_keys = ON");
    this.migrate();
  }

  public static async open(filePath: string, options: { requireExisting?: boolean; onFatalPersistenceError?: () => void } = {}): Promise<SqliteDatabase> {
    const SQL = await loadSqlJs();
    if (!options.requireExisting) {
      const bytes = fs.existsSync(filePath) ? new Uint8Array(fs.readFileSync(filePath)) : undefined;
      return new SqliteDatabase(filePath, new SQL.Database(bytes), true, options.onFatalPersistenceError);
    }
    // Production must never turn a missing or damaged DB into a fresh empty
    // installation. Validate the existing file before the constructor migrates
    // or persists anything, and before index.ts attempts Gateway login.
    let database: SqlJsDatabase | undefined;
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.size === 0) throw new Error("invalid database file");
      database = new SQL.Database(new Uint8Array(fs.readFileSync(filePath)));
      const integrity = database.exec("PRAGMA integrity_check");
      if (integrity.length !== 1 || integrity[0]?.values.length !== 1 || integrity[0].values[0]?.[0] !== "ok") throw new Error("database integrity failure");
      const tables = database.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('main_accounts', 'account_links', 'notification_queue')");
      if (tables[0]?.values.length !== 3) throw new Error("required tables missing");
      const existing = database;
      database = undefined;
      return new SqliteDatabase(filePath, existing, true, options.onFatalPersistenceError);
    } catch {
      // A generic error avoids leaking file contents or SQL diagnostics to logs.
      throw new Error("Existing Alt Notify database validation failed; service not started");
    } finally {
      database?.close();
    }
  }

  /** Opens verified backup bytes in memory, so restore drills never write decrypted DBs to disk. */
  public static async openBuffer(bytes: Uint8Array): Promise<SqliteDatabase> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error("backup is empty");
    const SQL = await loadSqlJs();
    let database: SqlJsDatabase | undefined;
    try {
      database = new SQL.Database(bytes);
      const integrity = database.exec("PRAGMA integrity_check");
      if (integrity.length !== 1 || integrity[0]?.values.length !== 1 || integrity[0].values[0]?.[0] !== "ok") throw new Error("backup integrity failed");
      const tables = database.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('main_accounts', 'account_links', 'notification_queue')");
      if (tables[0]?.values.length !== 3) throw new Error("backup schema invalid");
      const existing = database;
      database = undefined;
      return new SqliteDatabase("memory:restore-drill", existing, false);
    } catch {
      throw new Error("Backup database validation failed");
    } finally { database?.close(); }
  }

  public close(): void { this.raw.close(); }

  /** Verify deletion against a separate on-disk instance, not the live WASM DB. */
  public async verifyUserDeletedOnDisk(userId: string): Promise<void> {
    this.raw.assertHealthy();
    if (!userId) throw new Error("invalid deletion identity");
    const stat = fs.lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error("database deletion verification failed");
    const SQL = await loadSqlJs();
    this.raw.assertHealthy();
    const disk = new SQL.Database(new Uint8Array(fs.readFileSync(this.filePath)));
    try {
      const integrity = disk.exec("PRAGMA integrity_check");
      if (integrity[0]?.values[0]?.[0] !== "ok") throw new Error("database deletion verification failed");
      const required = ["main_accounts", "account_links", "guild_watches", "link_codes", "notification_queue", "notification_dedup", "entitlements"];
      const tables = new Set(disk.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.map((row) => String(row[0])) ?? []);
      if (required.some((table) => !tables.has(table))) throw new Error("database deletion verification failed");
      const checks = [
        ["main_accounts", "user_id"], ["account_links", "sub_user_id"], ["account_links", "main_user_id"],
        ["guild_watches", "sub_user_id"], ["link_codes", "main_user_id"], ["notification_queue", "main_user_id"],
        ["notification_dedup", "main_user_id"], ["entitlements", "user_id"]
      ];
      for (const [table, column] of checks) {
        const statement = disk.prepare(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`);
        try { statement.bind([userId]); if (statement.step()) throw new Error("database deletion verification failed"); }
        finally { statement.free(); }
      }
      const rows = disk.exec("SELECT target_user_ids, target_labels, target_kinds FROM notification_queue")[0]?.values ?? [];
      for (const row of rows) {
        const ids: unknown = JSON.parse(String(row[0]));
        const labels: unknown = JSON.parse(String(row[1]));
        const kinds: unknown = JSON.parse(String(row[2]));
        if (!Array.isArray(ids) || !Array.isArray(labels) || !Array.isArray(kinds) || ids.length !== labels.length || (kinds.length !== 0 && kinds.length !== ids.length) || ids.some((id) => typeof id !== "string") || ids.includes(userId)) throw new Error("database deletion verification failed");
      }
      this.raw.assertHealthy();
    } catch { throw new Error("database deletion verification failed"); }
    finally { disk.close(); }
  }

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
        target_user_ids TEXT NOT NULL, target_labels TEXT NOT NULL, target_role_ids TEXT NOT NULL DEFAULT '[]', target_kinds TEXT NOT NULL DEFAULT '[]',
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
    if (!queueColumns.includes("target_kinds")) this.raw.exec("ALTER TABLE notification_queue ADD COLUMN target_kinds TEXT NOT NULL DEFAULT '[]'");
  }

  public cleanup(now = Date.now(), recoverProcessing = true): void {
    this.raw.prepare("DELETE FROM link_codes WHERE expires_at < ? OR used_at IS NOT NULL").run(now);
    this.raw.prepare("DELETE FROM notification_dedup WHERE created_at < ?").run(now - 7 * 24 * 60 * 60 * 1000);
    this.raw.prepare("DELETE FROM notification_queue WHERE status IN ('sent', 'failed', 'cancelled') AND created_at < ?").run(now - 7 * 24 * 60 * 60 * 1000);
    if (recoverProcessing) this.raw.prepare("UPDATE notification_queue SET status = 'pending' WHERE status = 'processing'").run();
  }
}

async function loadSqlJs() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(moduleDir, "..", "node_modules", "sql.js", "dist"), path.join(moduleDir, "..", "..", "node_modules", "sql.js", "dist")];
  const wasmDir = candidates.find((candidate) => fs.existsSync(path.join(candidate, "sql-wasm.wasm"))) ?? candidates[0]!;
  return initSqlJs({ locateFile: (file) => path.join(wasmDir, file) });
}
