import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import initSqlJs from "sql.js";
import { SqliteDatabase } from "../src/db.js";

const directories: string[] = [];
function fixturePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnotify-db-preflight-"));
  directories.push(directory);
  return path.join(directory, "bot.sqlite");
}
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("production database preflight", () => {
  it("rejects a missing database without creating it", async () => {
    const file = fixturePath();
    await expect(SqliteDatabase.open(file, { requireExisting: true })).rejects.toThrow("Existing Alt Notify database validation failed");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("stops the bot entrypoint before Gateway login when the production DB is missing", () => {
    const file = fixturePath();
    const started = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, DISCORD_TOKEN: "test-only", DISCORD_CLIENT_ID: "test-only", DATABASE_PATH: file },
      encoding: "utf8",
      timeout: 15_000
    });
    expect(started.status).not.toBe(0);
    expect(started.stderr).toContain("Existing Alt Notify database validation failed");
    expect(fs.existsSync(file)).toBe(false);
  }, 20_000);

  it.each(["zero", "garbage"] as const)("rejects a %s file without changing it", async (kind) => {
    const file = fixturePath();
    const bytes = kind === "zero" ? Buffer.alloc(0) : Buffer.from("not a SQLite database");
    fs.writeFileSync(file, bytes);
    await expect(SqliteDatabase.open(file, { requireExisting: true })).rejects.toThrow("Existing Alt Notify database validation failed");
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it("rejects an otherwise valid empty SQLite database before migration", async () => {
    const file = fixturePath();
    const SQL = await initSqlJs();
    const empty = new SQL.Database();
    const bytes = Buffer.from(empty.export());
    empty.close();
    fs.writeFileSync(file, bytes);
    await expect(SqliteDatabase.open(file, { requireExisting: true })).rejects.toThrow("Existing Alt Notify database validation failed");
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it("opens an existing Alt Notify database and preserves data", async () => {
    const file = fixturePath();
    const created = await SqliteDatabase.open(file);
    created.raw.prepare("INSERT INTO main_accounts(user_id, username, created_at) VALUES ('main', 'Main', 1000)").run();
    created.close();
    const existing = await SqliteDatabase.open(file, { requireExisting: true });
    expect(existing.raw.prepare("SELECT username FROM main_accounts WHERE user_id='main'").get()?.username).toBe("Main");
    existing.close();
  });

  it("accepts a legacy base schema and lets the normal migration add columns", async () => {
    const file = fixturePath();
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.run("CREATE TABLE main_accounts(user_id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL)");
    legacy.run("CREATE TABLE account_links(sub_user_id TEXT PRIMARY KEY, main_user_id TEXT NOT NULL, username TEXT NOT NULL, created_at INTEGER NOT NULL)");
    legacy.run("CREATE TABLE notification_queue(id INTEGER PRIMARY KEY, main_user_id TEXT NOT NULL, message_id TEXT NOT NULL, guild_id TEXT NOT NULL, kind TEXT NOT NULL, target_user_ids TEXT NOT NULL, target_labels TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, available_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER)");
    fs.writeFileSync(file, Buffer.from(legacy.export()));
    legacy.close();
    const opened = await SqliteDatabase.open(file, { requireExisting: true });
    expect(opened.raw.prepare("PRAGMA table_info(notification_queue)").all().map((column) => column.name)).toContain("mention_type");
    opened.close();
  });

  it("rejects a database whose integrity check is not ok", async () => {
    const file = fixturePath();
    const SQL = await initSqlJs();
    const damaged = new SQL.Database();
    damaged.run("CREATE TABLE main_accounts(user_id TEXT PRIMARY KEY)");
    damaged.run("CREATE TABLE account_links(sub_user_id TEXT PRIMARY KEY)");
    damaged.run("CREATE TABLE notification_queue(id INTEGER PRIMARY KEY)");
    damaged.run("PRAGMA writable_schema=ON");
    damaged.run("UPDATE sqlite_master SET rootpage=999 WHERE name='main_accounts'");
    damaged.run("PRAGMA writable_schema=OFF");
    const bytes = Buffer.from(damaged.export());
    fs.writeFileSync(file, bytes);
    damaged.close();
    const reopened = new SQL.Database(bytes);
    expect(() => reopened.exec("PRAGMA integrity_check")).toThrow("malformed database schema");
    reopened.close();
    await expect(SqliteDatabase.open(file, { requireExisting: true })).rejects.toThrow("Existing Alt Notify database validation failed");
  });

  it("keeps local fixture creation available by default", async () => {
    const file = fixturePath();
    const local = await SqliteDatabase.open(file);
    expect(fs.statSync(file).size).toBeGreaterThan(0);
    local.close();
  });
});
