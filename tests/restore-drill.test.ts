import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "../src/db.js";
import { runRestoreDrill } from "../src/services/restore-drill.js";

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
    const result = await runRestoreDrill(source, "test");
    expect(result).toMatchObject({ source: "test", sha256Match: true, integrity: "ok", requiredTables: "ok", databaseOpen: "ok", servicesInitialized: "ok", counts: { mains: 1, links: 1, queuePending: 0, queueProcessing: 0, queueFailed: 0 } });
    expect(JSON.stringify(result)).not.toMatch(/private-id|private-name|private-sub|sub-id/);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("fails closed for an invalid source without returning its contents", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnotify-restore-invalid-")); directories.push(directory);
    const source = path.join(directory, "invalid.sqlite");
    fs.writeFileSync(source, "private-invalid-content");
    await expect(runRestoreDrill(source, "test")).rejects.toThrow();
  });
});
