import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FatalDatabasePersistenceError, SqliteDatabase } from "../src/db.js";
import { AccountService } from "../src/services/accounts.js";
import { PrivacyDeletionService } from "../src/services/privacy-deletion.js";

const fixtures: Array<{ db: SqliteDatabase; directory: string }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { db, directory } of fixtures.splice(0)) { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

async function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-persist-"));
  const file = path.join(directory, "test.sqlite");
  const fatal = vi.fn();
  const db = await SqliteDatabase.open(file, { onFatalPersistenceError: fatal });
  const accounts = new AccountService(db);
  await accounts.registerMain("main", "Main", async () => undefined, 1000);
  fixtures.push({ db, directory });
  return { db, accounts, file, fatal };
}

describe("fatal persistence failure", () => {
  it.each(["write", "fsync", "rename"] as const)("poisons the DB on %s failure after memory commit", async (failure) => {
    const { db, accounts, file, fatal } = await setup();
    const operation = failure === "write" ? "writeFileSync" : failure === "fsync" ? "fsyncSync" : "renameSync";
    vi.spyOn(fs, operation).mockImplementation(() => { throw new Error("injected storage fault"); });
    expect(() => accounts.deleteAccount("main")).toThrow(FatalDatabasePersistenceError);
    expect(fatal).toHaveBeenCalledOnce();
    expect(() => db.raw.prepare("SELECT 1")).toThrow(FatalDatabasePersistenceError);
    expect(() => db.raw.prepare("INSERT INTO main_accounts VALUES ('x','x',0)").run()).toThrow(FatalDatabasePersistenceError);
    expect(() => db.raw.transaction(() => undefined)()).toThrow(FatalDatabasePersistenceError);
    vi.restoreAllMocks();
    const disk = await SqliteDatabase.open(file, { requireExisting: true });
    expect(disk.raw.prepare("SELECT 1 FROM main_accounts WHERE user_id='main'").get()).toBeDefined();
    disk.close();
  });

  it("never marks deletion durable or finishes after a persist failure", async () => {
    const { accounts, fatal } = await setup();
    const databaseDeleted = vi.fn(); const finish = vi.fn(); const unsafe = vi.fn();
    const service = new PrivacyDeletionService(accounts, { begin: async () => undefined, databaseDeleted, finish }, unsafe);
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("injected storage fault"); });
    await expect(service.deleteAccount("main")).rejects.toThrow(FatalDatabasePersistenceError);
    expect(databaseDeleted).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
    expect(fatal).toHaveBeenCalledOnce(); expect(unsafe).toHaveBeenCalledOnce();
  });

  it("verifies a deletion in a fresh disk instance and rejects stale or absent files", async () => {
    const { accounts, db, file } = await setup();
    await expect(db.verifyUserDeletedOnDisk("main")).rejects.toThrow();
    expect(accounts.deleteAccount("main")).toBe("main");
    await expect(db.verifyUserDeletedOnDisk("main")).resolves.toBeUndefined();
    fs.renameSync(file, `${file}.moved`);
    await expect(db.verifyUserDeletedOnDisk("main")).rejects.toThrow();
  });

  it("fails closed for malformed queued target JSON on disk", async () => {
    const { accounts, db } = await setup();
    expect(accounts.deleteAccount("main")).toBe("main");
    db.raw.pragma("foreign_keys = OFF");
    db.raw.prepare("INSERT INTO notification_queue(main_user_id,message_id,guild_id,kind,target_user_ids,target_labels,available_at,created_at) VALUES ('other','msg','guild','direct','not-json','[]',0,0)").run();
    await expect(db.verifyUserDeletedOnDisk("main")).rejects.toThrow("database deletion verification failed");
  });

  it("rolls back a callback failure before commit without poisoning", async () => {
    const { db } = await setup();
    expect(() => db.raw.transaction(() => { db.raw.prepare("INSERT INTO main_accounts VALUES ('second','Second',0)").run(); throw new Error("callback failed"); })()).toThrow("callback failed");
    expect(db.raw.prepare("SELECT 1 FROM main_accounts WHERE user_id='second'").get()).toBeUndefined();
    expect(db.raw.prepare("SELECT 1 FROM main_accounts WHERE user_id='main'").get()).toBeDefined();
  });
});
