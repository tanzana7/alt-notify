import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "../src/db.js";
import { AccountService } from "../src/services/accounts.js";
import { ApprovalStore } from "../src/services/approval.js";
import { WatchService } from "../src/services/watches.js";
import { NotificationService } from "../src/services/notifications.js";
import { Logger } from "../src/logger.js";
import { canUseAdminStats } from "../src/services/permissions.js";

const resources: Array<{ db: SqliteDatabase; dir: string }> = [];

async function setup(developerTestId?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-alt-notify-"));
  const db = await SqliteDatabase.open(path.join(dir, "test.sqlite"));
  const accounts = new AccountService(db, developerTestId, "test-pepper");
  const watches = new WatchService(db, accounts);
  const notifications = new NotificationService(db, accounts, new Logger("error"), () => 1_000);
  resources.push({ db, dir });
  return { db, dir, accounts, watches, notifications };
}

afterEach(() => {
  for (const resource of resources.splice(0)) { resource.db.close(); fs.rmSync(resource.dir, { recursive: true, force: true }); }
});

async function registerMain(accounts: AccountService, id = "main", username = "zana") {
  await accounts.registerMain(id, username, async () => undefined, 1_000);
}

async function link(accounts: AccountService, mainId: string, subId: string, username = subId) {
  const code = accounts.issueLinkCode(mainId, 1_000);
  accounts.previewLinkCode(subId, code, 1_001);
  return accounts.approveLinkByHash(subId, accounts.hashForApproval(code), username, 1_002);
}

describe("account lifecycle", () => {
  it("does not register a main account when the test DM fails", async () => {
    const { accounts } = await setup();
    await expect(accounts.registerMain("main", "zana", async () => { throw new Error("DM blocked"); })).rejects.toThrow("DM blocked");
    expect(accounts.getStatus("main").kind).toBe("none");
  });

  it("requires explicit approval, expires codes, and rejects reuse", async () => {
    const { accounts } = await setup();
    await registerMain(accounts);
    const code = accounts.issueLinkCode("main", 1_000);
    expect(accounts.getStatus("sub").kind).toBe("none");
    expect(() => accounts.previewLinkCode("sub", code, 601_001)).toThrow("期限切れ");
    const fresh = accounts.issueLinkCode("main", 700_000);
    accounts.previewLinkCode("sub", fresh, 700_001);
    accounts.approveLinkByHash("sub", accounts.hashForApproval(fresh), "a", 700_002);
    expect(() => accounts.approveLinkByHash("other", accounts.hashForApproval(fresh), "other", 700_003)).toThrow("無効");
  });

  it("limits free users to one and developer test users to five", async () => {
    const free = await setup();
    await registerMain(free.accounts);
    await link(free.accounts, "main", "a");
    const code = free.accounts.issueLinkCode("main", 2_000);
    expect(() => free.accounts.approveLinkByHash("b", free.accounts.hashForApproval(code), "b", 2_001)).toThrow("上限");
    const dev = await setup("dev");
    await registerMain(dev.accounts, "dev", "developer");
    for (const sub of ["a", "b", "c", "d", "e"]) await link(dev.accounts, "dev", sub);
    expect(dev.accounts.getStatus("dev").links).toHaveLength(5);
  });

  it("allows only the requesting user to consume an approval button", async () => {
    const store = new ApprovalStore();
    const token = store.issue("sub", "hash", 1_000);
    expect(() => store.consume(token, "attacker", 1_001)).toThrow("無効");
    expect(store.consume(token, "sub", 1_001)).toBe("hash");
    expect(() => store.consume(token, "sub", 1_002)).toThrow("無効");
  });

  it("rejects self-linking and invalidates an older code on reissue", async () => {
    const { accounts } = await setup(); await registerMain(accounts);
    const oldCode = accounts.issueLinkCode("main", 1_000);
    const newCode = accounts.issueLinkCode("main", 1_001);
    expect(() => accounts.previewLinkCode("main", newCode, 1_002)).toThrow("自分自身");
    expect(() => accounts.previewLinkCode("sub", oldCode, 1_002)).toThrow("無効");
  });

  it("limits repeated invalid code guesses", async () => {
    const { accounts } = await setup(); await registerMain(accounts);
    accounts.issueLinkCode("main", 1_000);
    for (let i = 0; i < 5; i++) expect(() => accounts.previewLinkCode("attacker", "bad", 1_001 + i)).toThrow();
    expect(() => accounts.previewLinkCode("attacker", "bad", 1_010)).toThrow("試行回数");
  });

  it("reports a linked sub account and its watches", async () => {
    const { accounts, watches } = await setup(); await registerMain(accounts); await link(accounts, "main", "a", "a");
    await watches.set("guild", "a", true, { isMember: async () => true });
    expect(accounts.getStatus("a")).toMatchObject({ kind: "sub", mainUserId: "main", watches: ["guild"] });
  });

  it("allows developer test entitlement only for the configured Discord ID", async () => {
    const developer = await setup("developer"); const regular = await setup("developer");
    await registerMain(developer.accounts, "developer", "developer"); await registerMain(regular.accounts, "regular", "regular");
    expect((developer.db.raw.prepare("SELECT plan FROM entitlements WHERE user_id='developer'").get() as { plan: string }).plan).toBe("developer_test");
    expect((regular.db.raw.prepare("SELECT plan FROM entitlements WHERE user_id='regular'").get() as { plan: string }).plan).toBe("free");
  });
});

describe("watch and notification flow", () => {
  it("does not enqueue from a watch that is off", async () => {
    const { accounts, watches, notifications, db } = await setup();
    await registerMain(accounts); await link(accounts, "main", "a", "a");
    await watches.set("guild", "a", true, { isMember: async () => true }, 1_000);
    await watches.set("guild", "a", false, { isMember: async () => true }, 1_001);
    expect(await notifications.inspect({ id: "message", guildId: "guild", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true })).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue").get()?.count).toBe(0);
  });

  it("requires a linked sub account and membership before watch on", async () => {
    const { watches } = await setup();
    await expect(watches.set("guild", "unlinked", true, { isMember: async () => true })).rejects.toThrow("連携済み");
  });

  it("does not enable watch when the user is not a guild member", async () => {
    const { accounts, watches } = await setup(); await registerMain(accounts); await link(accounts, "main", "a");
    await expect(watches.set("guild", "a", true, { isMember: async () => false })).rejects.toThrow("メンバー");
    expect(watches.status("guild", "a")).toBe(false);
  });

  it("does not enqueue when the target cannot view the source channel", async () => {
    const { accounts, watches, notifications } = await setup(); await registerMain(accounts); await link(accounts, "main", "a"); await watches.set("guild", "a", true, { isMember: async () => true });
    expect(await notifications.inspect({ id: "hidden", guildId: "guild", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => false })).toBe(0);
  });

  it("does not enqueue unrelated messages", async () => {
    const { accounts, watches, notifications } = await setup(); await registerMain(accounts); await link(accounts, "main", "a"); await watches.set("guild", "a", true, { isMember: async () => true });
    expect(await notifications.inspect({ id: "unrelated", guildId: "guild", authorBot: false, mentionedUserIds: ["someone-else"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true })).toBe(0);
  });

  it("groups direct mentions for the same main account and deduplicates the message", async () => {
    const { accounts, watches, notifications } = await setup("main");
    await registerMain(accounts); await link(accounts, "main", "a", "a");
    await link(accounts, "main", "b", "b");
    await watches.set("guild", "a", true, { isMember: async () => true });
    await watches.set("guild", "b", true, { isMember: async () => true });
    const message = { id: "message", guildId: "guild", authorBot: false, mentionedUserIds: ["a", "b"], mentionEveryone: false };
    expect(await notifications.inspect(message, { isMember: async () => true, canViewChannel: async () => true })).toBe(1);
    expect(await notifications.inspect(message, { isMember: async () => true, canViewChannel: async () => true })).toBe(0);
    const sent: string[] = [];
    expect(await notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_000)).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]).toContain("対象アカウント：a、b");
  });

  it("delays everyone notifications, ignores bot posts, and checks membership", async () => {
    const { accounts, watches, notifications } = await setup("main");
    await registerMain(accounts); await link(accounts, "main", "a", "a");
    await watches.set("guild", "a", true, { isMember: async () => true });
    const visibility = { isMember: async () => false, canViewChannel: async () => true };
    expect(await notifications.inspect({ id: "bot", guildId: "guild", authorBot: true, mentionedUserIds: [], mentionEveryone: true }, visibility)).toBe(0);
    expect(await notifications.inspect({ id: "departed", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionEveryone: true }, visibility)).toBe(0);
    expect(await notifications.inspect({ id: "everyone", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionEveryone: true }, { isMember: async () => true, canViewChannel: async () => true })).toBe(1);
    const sent: string[] = [];
    expect(await notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 59_999)).toEqual({ sent: 0, failed: 0 });
    expect(await notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 61_001)).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]).toContain("全体メンション");
  });

  it("targets only explicitly watched linked accounts for everyone mentions", async () => {
    const { accounts, watches, notifications, db } = await setup("main"); await registerMain(accounts); await link(accounts, "main", "a"); await link(accounts, "main", "b"); await watches.set("guild", "a", true, { isMember: async () => true });
    expect(await notifications.inspect({ id: "everyone-one", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionEveryone: true }, { isMember: async () => true, canViewChannel: async () => true })).toBe(1);
    expect((db.raw.prepare("SELECT target_user_ids FROM notification_queue WHERE message_id='everyone-one'").get() as { target_user_ids: string }).target_user_ids).toBe('["a"]');
  });

  it("records DM refusal, retries rate limits, and does not crash", async () => {
    const { accounts, watches, notifications, db } = await setup();
    await registerMain(accounts); await link(accounts, "main", "a", "a"); await watches.set("guild", "a", true, { isMember: async () => true });
    await notifications.inspect({ id: "refused", guildId: "guild", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    expect(await notifications.drain({ send: async () => { throw new Error("Cannot send messages to this user"); } }, 2_000)).toEqual({ sent: 0, failed: 1 });
    await notifications.inspect({ id: "retry", guildId: "guild", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    let attempts = 0;
    expect(await notifications.drain({ send: async () => { attempts++; if (attempts === 1) throw { retryAfter: 0.001 }; } }, 2_000)).toEqual({ sent: 1, failed: 0 });
    expect(attempts).toBe(2);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE status='failed'").get()?.count).toBe(1);
  });

  it("cancels pending notifications on unlink and survives a database reopen", async () => {
    const state = await setup();
    await registerMain(state.accounts); await link(state.accounts, "main", "a", "a"); await state.watches.set("guild", "a", true, { isMember: async () => true });
    await state.notifications.inspect({ id: "pending", guildId: "guild", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    expect(state.accounts.unlink("main", "a")).toBe(1);
    expect(state.db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE status='cancelled'").get()?.count).toBe(1);
    const dbPath = path.join(state.dir, "test.sqlite");
    state.db.close();
    const reopened = await SqliteDatabase.open(dbPath);
    const accounts = new AccountService(reopened);
    expect(accounts.getStatus("main").kind).toBe("main");
    reopened.close();
  });

  it("persists a link after closing and reopening SQLite", async () => {
    const state = await setup(); await registerMain(state.accounts); await link(state.accounts, "main", "a", "a");
    const dbPath = path.join(state.dir, "test.sqlite"); state.db.close();
    const reopened = await SqliteDatabase.open(dbPath); const accounts = new AccountService(reopened);
    expect(accounts.getMainForSub("a")).toMatchObject({ mainUserId: "main" }); reopened.close();
  });

  it("restricts admin statistics to the exact configured owner ID", () => {
    expect(canUseAdminStats("owner", "owner")).toBe(true);
    expect(canUseAdminStats("other", "owner")).toBe(false);
    expect(canUseAdminStats("owner", undefined)).toBe(false);
  });
});
