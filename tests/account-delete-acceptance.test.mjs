import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "../src/db.js";
import { AccountService } from "../src/services/accounts.js";
import { PrivacyDeletionService } from "../src/services/privacy-deletion.js";
import { runRestoreDrillFromBuffer } from "../src/services/restore-drill.js";
import {
  advancePrivacyState,
  completePrivacyMaintenance,
  initializePrivacyState,
  markPrivacyDataDeleted,
  readPrivacyState,
  recordOracleBackup,
  validateOracleBackup
} from "../deploy/privacy-deletion-state.mjs";
import { cleanupOracleArtifacts, inventoryOracleArtifacts } from "../deploy/oracle-artifact-cleanup.mjs";

function backupName(timestamp) {
  return `discord-alt-notify-${new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-")}.sqlite`;
}

it("isolates account deletion through disk verification, privacy epochs, cleanup, and restore", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-delete-acceptance-"));
  const paths = {
    active: path.join(root, "database", "active.sqlite"),
    state: path.join(root, "monitoring"),
    backups: path.join(root, "backups"),
    legacy: path.join(root, "backups", "legacy"),
    databaseDirectory: path.join(root, "database"),
    staging: path.join(root, "staging")
  };
  for (const directory of [paths.databaseDirectory, paths.state, paths.backups, paths.legacy, paths.staging]) fs.mkdirSync(directory);
  let db;
  try {
    initializePrivacyState(paths.state);
    db = await SqliteDatabase.open(paths.active);
    const accounts = new AccountService(db);
    await accounts.registerMain("synthetic-target", "target", async () => undefined);
    await accounts.registerMain("synthetic-other", "other", async () => undefined);
    const code = accounts.issueLinkCode("synthetic-target");
    accounts.approveLinkByHash("synthetic-sub", accounts.hashForApproval(code), "sub");

    const beforeTime = Math.floor((Date.now() - 5_000) / 1_000) * 1_000;
    const beforeName = backupName(beforeTime);
    fs.copyFileSync(paths.active, path.join(paths.backups, beforeName));
    const beforeMetadata = recordOracleBackup(paths.state, paths.backups, beforeName, readPrivacyState(paths.state), beforeTime + 1);
    const beforeBytes = new Uint8Array(fs.readFileSync(path.join(paths.backups, beforeName)));
    fs.copyFileSync(paths.active, path.join(paths.legacy, "older.sqlite"));
    fs.copyFileSync(paths.active, path.join(paths.backups, "alternate.sqlite"));
    fs.copyFileSync(paths.active, path.join(paths.staging, "transfer.sqlite"));
    fs.writeFileSync(path.join(paths.staging, "transfer.sqlite.meta.json"), "{}");

    let afterName = "";
    let cleanupCount = -1;
    const maintenance = {
      begin: async () => { advancePrivacyState(paths.state); },
      databaseDeleted: async () => { markPrivacyDataDeleted(paths.state); },
      finish: async () => {
        // The production helper checks a current-generation backup before it
        // removes any older copy. Keep the same order in this isolated drill.
        const afterTime = Math.floor((Date.now() + 5_000) / 1_000) * 1_000;
        afterName = backupName(afterTime);
        fs.copyFileSync(paths.active, path.join(paths.backups, afterName));
        recordOracleBackup(paths.state, paths.backups, afterName, { ...readPrivacyState(paths.state), _finalize: true }, afterTime + 1);
        cleanupCount = cleanupOracleArtifacts(paths).deleted;
        completePrivacyMaintenance(paths.state, paths.backups);
      }
    };
    const deletion = new PrivacyDeletionService(accounts, maintenance);
    await expect(deletion.deleteAccount("synthetic-target")).resolves.toBe("main");

    const disk = await SqliteDatabase.open(paths.active, { requireExisting: true });
    try {
      expect(disk.raw.prepare("SELECT COUNT(*) AS count FROM main_accounts").get()).toMatchObject({ count: 1 });
      expect(disk.raw.prepare("SELECT COUNT(*) AS count FROM account_links").get()).toMatchObject({ count: 0 });
      await expect(disk.verifyUserDeletedOnDisk("synthetic-target")).resolves.toBeUndefined();
      expect(disk.raw.prepare("SELECT 1 FROM main_accounts WHERE user_id=?").get("synthetic-other")).toBeDefined();
    } finally { disk.close(); }

    const finalState = readPrivacyState(paths.state);
    expect(finalState).toMatchObject({ generation: 1, cleanupPending: false, databaseDeleted: false });
    await expect(runRestoreDrillFromBuffer(beforeBytes, "isolated-old", beforeMetadata, finalState)).rejects.toThrow();
    expect(fs.existsSync(path.join(paths.backups, beforeName))).toBe(false);
    const afterMetadata = validateOracleBackup(paths.state, paths.backups, afterName);
    const restored = await runRestoreDrillFromBuffer(new Uint8Array(fs.readFileSync(path.join(paths.backups, afterName))), "isolated-new", afterMetadata, finalState);
    expect(restored).toMatchObject({ integrity: "ok", requiredTables: "ok", databaseOpen: "ok", servicesInitialized: "ok", counts: { mains: 1, links: 0 } });
    expect(cleanupCount).toBe(3);
    expect(inventoryOracleArtifacts(paths)).toHaveLength(0);
    expect(fs.existsSync(path.join(paths.staging, "transfer.sqlite.meta.json"))).toBe(false);
    expect(fs.existsSync(paths.active)).toBe(true);
  } finally {
    db?.close();
    // Delete only this test's newly created directory, never a broad temp root.
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("altnoti-delete-acceptance-")) throw new Error("unsafe test cleanup target");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
