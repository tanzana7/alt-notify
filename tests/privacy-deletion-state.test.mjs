import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  advancePrivacyState,
  completePrivacyMaintenance,
  initializePrivacyState,
  markPrivacyDataDeleted,
  pruneOracleBackups,
  readPrivacyState,
  recordOracleBackup,
  validateOracleBackup
} from "../deploy/privacy-deletion-state.mjs";
import initSqlJs from "sql.js";

const directories = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-privacy-state-")); directories.push(root);
  const state = path.join(root, "monitoring"); const backups = path.join(root, "backups");
  fs.mkdirSync(state); fs.mkdirSync(backups);
  return { root, state, backups };
}
function nameFor(timestamp) {
  const value = new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
  return `discord-alt-notify-${value}.sqlite`;
}
async function createDatabase(file) {
  const SQL = await initSqlJs(); const db = new SQL.Database();
  db.run("CREATE TABLE main_accounts(user_id TEXT PRIMARY KEY,username TEXT,created_at INTEGER); CREATE TABLE account_links(sub_user_id TEXT PRIMARY KEY,main_user_id TEXT,username TEXT,created_at INTEGER); CREATE TABLE notification_queue(id INTEGER PRIMARY KEY,status TEXT); CREATE TABLE notification_dedup(main_user_id TEXT); CREATE TABLE guild_watches(sub_user_id TEXT); CREATE TABLE entitlements(user_id TEXT)");
  fs.writeFileSync(file, Buffer.from(db.export())); db.close();
}

afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("privacy deletion state and Oracle backup epochs", () => {
  it("initializes without user identifiers and advances monotonically", () => {
    const { state } = fixture();
    const initial = { generation: 0, lastDeletionAt: 0, cleanupPending: false, databaseDeleted: false };
    expect(initializePrivacyState(state)).toEqual(initial);
    expect(markPrivacyDataDeleted(state)).toEqual(initial);
    const first = advancePrivacyState(state, 100);
    expect(() => advancePrivacyState(state, 50)).toThrow("privacy deletion pending");
    expect(first).toEqual({ generation: 1, lastDeletionAt: 100, cleanupPending: true, databaseDeleted: false });
    expect(JSON.stringify(readPrivacyState(state))).not.toMatch(/user|username|snowflake/i);
  });

  it("never assigns a pending epoch to another deletion", () => {
    const { state } = fixture(); initializePrivacyState(state);
    const pending = advancePrivacyState(state, 100);
    expect(markPrivacyDataDeleted(state)).toMatchObject({ generation: 1, cleanupPending: true, databaseDeleted: true });
    expect(() => advancePrivacyState(state, 200)).toThrow("privacy deletion pending");
    expect(readPrivacyState(state)).toEqual({ ...pending, databaseDeleted: true });
  });

  it("fails closed for missing, malformed, inconsistent, and symlink state", () => {
    const { state } = fixture();
    expect(() => readPrivacyState(state)).toThrow();
    initializePrivacyState(state);
    fs.writeFileSync(path.join(state, "privacy-deletion-state.json"), '{"generation":1,"lastDeletionAt":0,"cleanupPending":false,"databaseDeleted":false}');
    expect(() => readPrivacyState(state)).toThrow();
    fs.rmSync(path.join(state, "privacy-deletion-state.json"));
    const target = path.join(state, "real.json"); fs.writeFileSync(target, JSON.stringify({ generation: 0, lastDeletionAt: 0, cleanupPending: false, databaseDeleted: false }));
    if (process.platform !== "win32") {
      fs.symlinkSync(target, path.join(state, "privacy-deletion-state.json"));
      expect(() => readPrivacyState(state)).toThrow();
    }
  });

  it("does not accept an arbitrary filesystem path through the production helper CLI", () => {
    const helper = path.resolve("deploy/privacy-deletion-state.mjs");
    const result = spawnSync(process.execPath, [helper, "status", "C:\\private\\state.json"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("private");
  });

  it("rejects legacy backups until a current-generation verified backup exists, then retains the newest safe copy", async () => {
    const { state, backups } = fixture();
    initializePrivacyState(state);
    const oldName = nameFor(Date.now() - 10_000);
    await createDatabase(path.join(backups, oldName));
    const initial = readPrivacyState(state);
    recordOracleBackup(state, backups, oldName, initial, Date.now());
    expect(validateOracleBackup(state, backups, oldName).privacyGeneration).toBe(0);

    const advanced = advancePrivacyState(state, Date.now());
    expect(() => completePrivacyMaintenance(state, backups)).toThrow("active database deletion not confirmed");
    const committed = markPrivacyDataDeleted(state);
    expect(committed).toMatchObject({ generation: 1, cleanupPending: true, databaseDeleted: true });
    const freshName = nameFor(advanced.lastDeletionAt + 2_000);
    await createDatabase(path.join(backups, freshName));
    recordOracleBackup(state, backups, freshName, { ...committed, _finalize: true }, advanced.lastDeletionAt + 2_000);
    expect(() => pruneOracleBackups(state, backups, Date.now())).toThrow("pending");
    completePrivacyMaintenance(state, backups);
    expect(readPrivacyState(state)).toMatchObject({ generation: 1, cleanupPending: false });
    expect(fs.existsSync(path.join(backups, oldName))).toBe(false);
    expect(validateOracleBackup(state, backups, freshName).privacyGeneration).toBe(1);
    expect(fs.readdirSync(backups).filter((file) => file.endsWith(".sqlite"))).toEqual([freshName]);
  });

  it("never prunes the only current safe backup", async () => {
    const { state, backups } = fixture(); initializePrivacyState(state);
    const time = Date.now(); const name = nameFor(time);
    await createDatabase(path.join(backups, name));
    recordOracleBackup(state, backups, name, readPrivacyState(state), time);
    expect(pruneOracleBackups(state, backups, time + 40 * 24 * 60 * 60 * 1000)).toMatchObject({ retained: 1, newest: name });
    expect(fs.existsSync(path.join(backups, name))).toBe(true);
  });

  it("retains the newest seven backups within 14 days and preserves unrelated files", async () => {
    const { state, backups } = fixture(); initializePrivacyState(state);
    const names = [];
    for (const days of [1, 2, 3, 4, 5, 6, 7, 21, 22]) {
      const createdAt = Date.now() - days * 24 * 60 * 60 * 1000;
      const name = nameFor(createdAt); names.push(name);
      await createDatabase(path.join(backups, name));
      recordOracleBackup(state, backups, name, readPrivacyState(state), createdAt + 1000);
    }
    fs.writeFileSync(path.join(backups, "keep-me.sqlite"), "unrelated");
    fs.writeFileSync(path.join(backups, `${names[0]}.tmp`), "partial");
    expect(pruneOracleBackups(state, backups, Date.now()).retained).toBe(7);
    for (const name of names.slice(0, 7)) expect(fs.existsSync(path.join(backups, name))).toBe(true);
    for (const name of names.slice(7)) expect(fs.existsSync(path.join(backups, name))).toBe(false);
    expect(fs.existsSync(path.join(backups, "keep-me.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(backups, `${names[0]}.tmp`))).toBe(true);
  });
});
