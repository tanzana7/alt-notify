import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import { cleanupOracleArtifacts, inventoryOracleArtifacts, isAltNotifyDatabase } from "../deploy/oracle-artifact-cleanup.mjs";
import { initializePrivacyState, readPrivacyState, recordOracleBackup } from "../deploy/privacy-deletion-state.mjs";

const roots = [];
const SQL = await initSqlJs();
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-artifacts-")); roots.push(root);
  const paths = Object.fromEntries(["state", "backups", "legacy", "databaseDirectory", "staging"].map((key) => [key, path.join(root, key)]));
  for (const directory of Object.values(paths)) fs.mkdirSync(directory);
  paths.active = path.join(paths.databaseDirectory, "active.sqlite");
  initializePrivacyState(paths.state);
  database(paths.active, true);
  return paths;
}
function database(file, recognized) {
  const db = new SQL.Database();
  db.run("CREATE TABLE main_accounts(user_id TEXT); CREATE TABLE account_links(sub_user_id TEXT); CREATE TABLE notification_queue(id INTEGER); CREATE TABLE notification_dedup(main_user_id TEXT); CREATE TABLE guild_watches(sub_user_id TEXT); CREATE TABLE entitlements(user_id TEXT)");
  if (!recognized) db.run("DROP TABLE entitlements");
  fs.writeFileSync(file, Buffer.from(db.export())); db.close();
}
function safeBackup(paths) {
  const name = `discord-alt-notify-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-")}.sqlite`;
  database(path.join(paths.backups, name), true);
  recordOracleBackup(paths.state, paths.backups, name, readPrivacyState(paths.state), Date.now());
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("fixed-scope Oracle artifact cleanup", () => {
  it("keeps active, unrelated, corrupt, symlink and outside files while removing valid alternate and staging copies", () => {
    const paths = fixture(); safeBackup(paths);
    const legacy = path.join(paths.legacy, "historical.sqlite"); database(legacy, true);
    const alternate = path.join(paths.backups, "alternate-copy.sqlite"); database(alternate, true);
    const staging = path.join(paths.staging, "transfer.sqlite"); database(staging, true);
    fs.writeFileSync(`${staging}.meta.json`, "metadata");
    const unrelated = path.join(paths.legacy, "unrelated.sqlite"); database(unrelated, false);
    const corrupt = path.join(paths.legacy, "corrupt.sqlite"); fs.writeFileSync(corrupt, "not sqlite");
    const outside = path.join(path.dirname(paths.state), "outside.sqlite"); database(outside, true);
    if (process.platform !== "win32") fs.symlinkSync(legacy, path.join(paths.legacy, "link.sqlite"));
    expect(isAltNotifyDatabase(paths.active, paths.active)).toBe(false);
    expect(inventoryOracleArtifacts(paths)).toHaveLength(3);
    expect(cleanupOracleArtifacts(paths)).toMatchObject({ found: 3, deleted: 3 });
    for (const file of [legacy, alternate, staging, `${staging}.meta.json`]) expect(fs.existsSync(file)).toBe(false);
    for (const file of [paths.active, unrelated, corrupt, outside]) expect(fs.existsSync(file)).toBe(true);
  });

  it("never removes an old copy without a verified current backup", () => {
    const paths = fixture(); const old = path.join(paths.legacy, "old.sqlite"); database(old, true);
    expect(() => cleanupOracleArtifacts(paths)).toThrow();
    expect(fs.existsSync(old)).toBe(true);
  });

  it("is idempotent after a successful cleanup, including a staged transfer", () => {
    const paths = fixture(); safeBackup(paths);
    const staged = path.join(paths.staging, "interrupted.sqlite"); database(staged, true);
    expect(cleanupOracleArtifacts(paths).deleted).toBe(1);
    expect(cleanupOracleArtifacts(paths).deleted).toBe(0);
  });
});
