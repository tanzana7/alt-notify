import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "../src/db.js";
import { runRestoreDrillFromBuffer } from "../src/services/restore-drill.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("isolated production-path restore drill", () => {
  it("opens an isolated copy with requireExisting and reports counts only", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnotify-restore-fixture-")); directories.push(directory);
    const source = path.join(directory, "backup.sqlite");
    const db = await SqliteDatabase.open(source);
    db.raw.prepare("INSERT INTO main_accounts(user_id,username,created_at) VALUES ('private-id','private-name',0)").run();
    db.raw.prepare("INSERT INTO account_links(sub_user_id,main_user_id,username,created_at) VALUES ('sub-id','private-id','private-sub',0)").run();
    db.close();
    const bytes = fs.readFileSync(source);
    const state = { generation: 0, lastDeletionAt: 0, cleanupPending: false, databaseDeleted: false };
    const metadata = { formatVersion: 1, createdAt: 1, privacyGeneration: 0, sha256: (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex") };
    const result = await runRestoreDrillFromBuffer(bytes, "test", metadata, state);
    expect(result).toMatchObject({ source: "test", sha256Match: true, integrity: "ok", requiredTables: "ok", databaseOpen: "ok", servicesInitialized: "ok", counts: { mains: 1, links: 1, queuePending: 0, queueProcessing: 0, queueFailed: 0 } });
    expect(JSON.stringify(result)).not.toMatch(/private-id|private-name|private-sub|sub-id/);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("fails closed for an invalid source without returning its contents", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnotify-restore-invalid-")); directories.push(directory);
    const source = path.join(directory, "invalid.sqlite");
    fs.writeFileSync(source, "private-invalid-content");
    const bytes = fs.readFileSync(source);
    const state = { generation: 0, lastDeletionAt: 0, cleanupPending: false, databaseDeleted: false };
    const metadata = { formatVersion: 1, createdAt: 1, privacyGeneration: 0, sha256: (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex") };
    await expect(runRestoreDrillFromBuffer(bytes, "test", metadata, state)).rejects.toThrow();
  });

  it("rejects pre-deletion, stale-generation, pending, and missing privacy state", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnotify-restore-epoch-")); directories.push(directory);
    const source = path.join(directory, "backup.sqlite");
    const db = await SqliteDatabase.open(source); db.close();
    const bytes = fs.readFileSync(source);
    const hash = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    const metadata = { formatVersion: 1, createdAt: 100, privacyGeneration: 0, sha256: hash };
    const current = { generation: 1, lastDeletionAt: 101, cleanupPending: false, databaseDeleted: false };
    await expect(runRestoreDrillFromBuffer(bytes, "test", metadata, current)).rejects.toThrow("predates");
    await expect(runRestoreDrillFromBuffer(bytes, "test", metadata, { generation: 0, lastDeletionAt: 0, cleanupPending: true, databaseDeleted: false })).rejects.toThrow("unavailable");
    await expect(runRestoreDrillFromBuffer(bytes, "test", metadata, undefined as never)).rejects.toThrow("unavailable");
  });
});
