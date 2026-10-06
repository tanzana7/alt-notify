import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "../src/db.js";
import { AccountService } from "../src/services/accounts.js";
import { Logger } from "../src/logger.js";
import { NotificationService } from "../src/services/notifications.js";
import { WatchService } from "../src/services/watches.js";
import { createDiscordNotificationSender } from "../src/services/discord-notification-sender.js";
import { PrivacyDeletionService } from "../src/services/privacy-deletion.js";

const resources: Array<{ db: SqliteDatabase; dir: string }> = [];

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-privacy-races-"));
  const db = await SqliteDatabase.open(path.join(dir, "test.sqlite"));
  const accounts = new AccountService(db, undefined, "test-pepper", 5);
  const watches = new WatchService(db, accounts);
  const notifications = new NotificationService(db, accounts, new Logger("error"), () => 1_000, { minIntervalMs: 0 });
  resources.push({ db, dir });
  await accounts.registerMain("main", "Main", async () => undefined, 1_000);
  return { db, accounts, watches, notifications };
}

afterEach(() => {
  for (const { db, dir } of resources.splice(0)) { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function link(accounts: AccountService, subId: string, username = subId) {
  const code = accounts.issueLinkCode("main", 1_000);
  accounts.approveLinkByHash(subId, accounts.hashForApproval(code), username, 1_001);
}

async function enqueue(state: Awaited<ReturnType<typeof setup>>, messageId: string, userIds: string[]) {
  for (const userId of userIds) if (!state.accounts.getMainForSub(userId)) await link(state.accounts, userId, `Name-${userId}`);
  await state.notifications.inspect({ id: messageId, guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: userIds, mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
}

function queueCount(db: SqliteDatabase, messageId: string): number {
  return Number(db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE message_id=?").get(messageId)?.count ?? 0);
}

describe("local revalidation after inspect checks", () => {
  it("does not enqueue or deduplicate when unlink happens during member lookup", async () => {
    const state = await setup(); await link(state.accounts, "sub");
    const gate = deferred<boolean>();
    const inspect = state.notifications.inspect({ id: "inspect-unlink", guildId: "guild", authorBot: false, mentionedUserIds: ["sub"], mentionEveryone: false }, { isMember: () => gate.promise, canViewChannel: async () => true });
    expect(state.accounts.unlink("sub")).toBe(1);
    gate.resolve(true); await inspect;
    expect(queueCount(state.db, "inspect-unlink")).toBe(0);
    expect(state.db.raw.prepare("SELECT 1 FROM notification_dedup WHERE main_user_id='main' AND message_id='inspect-unlink'").get()).toBeUndefined();
  });

  it("does not recreate personal data when account deletion happens during member lookup", async () => {
    const state = await setup(); await link(state.accounts, "sub", "Deleted Name");
    const gate = deferred<boolean>();
    const inspect = state.notifications.inspect({ id: "inspect-delete", guildId: "guild", authorBot: false, mentionedUserIds: ["sub"], mentionEveryone: false }, { isMember: () => gate.promise, canViewChannel: async () => true });
    expect(state.accounts.deleteAccount("sub")).toBe("sub");
    gate.resolve(true); await inspect;
    expect(queueCount(state.db, "inspect-delete")).toBe(0);
    expect(state.db.raw.prepare("SELECT 1 FROM notification_dedup WHERE message_id='inspect-delete'").get()).toBeUndefined();
    expect(state.db.raw.prepare("SELECT 1 FROM notification_queue WHERE target_user_ids LIKE '%sub%' OR target_labels LIKE '%Deleted Name%'").get()).toBeUndefined();
  });

  it("does not enqueue when watch is turned off during member lookup", async () => {
    const state = await setup(); await link(state.accounts, "sub");
    const gate = deferred<boolean>();
    const inspect = state.notifications.inspect({ id: "inspect-watch-off", guildId: "guild", authorBot: false, mentionedUserIds: ["sub"], mentionEveryone: false }, { isMember: () => gate.promise, canViewChannel: async () => true });
    await state.watches.set("guild", "sub", false, { isMember: async () => true });
    gate.resolve(true); await inspect;
    expect(queueCount(state.db, "inspect-watch-off")).toBe(0);
    expect(state.db.raw.prepare("SELECT 1 FROM notification_dedup WHERE message_id='inspect-watch-off'").get()).toBeUndefined();
  });

  it("keeps only the other target when one target unlinks during a grouped lookup", async () => {
    const state = await setup(); await link(state.accounts, "a", "A"); await link(state.accounts, "b", "B");
    const gate = deferred<boolean>();
    const inspect = state.notifications.inspect({ id: "inspect-partial", guildId: "guild", authorBot: false, mentionedUserIds: ["a", "b"], mentionEveryone: false }, { isMember: (id) => id === "a" ? gate.promise : Promise.resolve(true), canViewChannel: async () => true });
    expect(state.accounts.unlink("a")).toBe(1);
    gate.resolve(true); await inspect;
    expect(state.db.raw.prepare("SELECT target_user_ids, target_labels, target_kinds FROM notification_queue WHERE message_id='inspect-partial'").get()).toMatchObject({ target_user_ids: '["b"]', target_labels: '["B"]', target_kinds: '["direct"]' });
  });

  it("keeps the everyone delay if a direct target unlinks during inspection", async () => {
    const state = await setup(); await link(state.accounts, "a"); await link(state.accounts, "b");
    const gate = deferred<boolean>();
    const inspection = state.notifications.inspect({ id: "inspect-priority", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: true }, {
      isMember: (id) => id === "a" ? gate.promise : Promise.resolve(true), canViewChannel: async () => true
    });
    state.accounts.unlink("a");
    gate.resolve(true); await inspection;
    expect(state.db.raw.prepare("SELECT mention_type, target_user_ids, target_kinds, available_at FROM notification_queue WHERE message_id='inspect-priority'").get()).toMatchObject({ mention_type: "everyone", target_user_ids: '["b"]', target_kinds: '["everyone"]', available_at: 61_000 });
  });
});

describe("local revalidation before notification delivery", () => {
  it("does not send if unlink happens during fresh authorization", async () => {
    const state = await setup(); await enqueue(state, "drain-unlink", ["sub"]);
    const gate = deferred<Array<{ userId: string; label: string }>>();
    let sends = 0;
    const draining = state.notifications.drain({ send: async () => { sends++; } }, 1_000, 50, { authorize: () => gate.promise });
    expect(state.accounts.unlink("sub")).toBe(1);
    gate.resolve([{ userId: "sub", label: "sub" }]); await draining;
    expect(sends).toBe(0);
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='drain-unlink'").get()?.status).toBe("cancelled");
  });

  it("does not send or revive a row deleted during fresh authorization", async () => {
    const state = await setup(); await enqueue(state, "drain-delete", ["sub"]);
    const gate = deferred<Array<{ userId: string; label: string }>>();
    let sends = 0;
    const draining = state.notifications.drain({ send: async () => { sends++; } }, 1_000, 50, { authorize: () => gate.promise });
    expect(state.accounts.deleteAccount("sub")).toBe("sub");
    gate.resolve([{ userId: "sub", label: "Deleted Name" }]); await draining;
    expect(sends).toBe(0); expect(queueCount(state.db, "drain-delete")).toBe(0);
    expect(state.db.raw.prepare("SELECT 1 FROM notification_queue WHERE target_user_ids LIKE '%sub%' OR target_labels LIKE '%Deleted Name%'").get()).toBeUndefined();
  });

  it("does not send when watch is turned off during fresh authorization", async () => {
    const state = await setup(); await enqueue(state, "drain-watch-off", ["sub"]);
    const gate = deferred<Array<{ userId: string; label: string }>>();
    let sends = 0;
    const draining = state.notifications.drain({ send: async () => { sends++; } }, 1_000, 50, { authorize: () => gate.promise });
    await state.watches.set("guild", "sub", false, { isMember: async () => true });
    gate.resolve([{ userId: "sub", label: "sub" }]); await draining;
    expect(sends).toBe(0);
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='drain-watch-off'").get()?.status).toBe("cancelled");
  });

  it("sends only to the remaining grouped target after the other target is deleted", async () => {
    const state = await setup(); await link(state.accounts, "a", "Deleted Name"); await link(state.accounts, "b", "Other Name");
    await enqueue(state, "drain-partial", ["a", "b"]);
    const gate = deferred<Array<{ userId: string; label: string }>>();
    const sent: string[] = [];
    const draining = state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 50, { authorize: () => gate.promise });
    expect(state.accounts.deleteAccount("a")).toBe("sub");
    gate.resolve([{ userId: "a", label: "Deleted Name" }, { userId: "b", label: "Other Name" }]); await draining;
    expect(sent).toHaveLength(1); expect(sent[0]).toContain("Other Name"); expect(sent[0]).not.toContain("Deleted Name");
    expect(state.db.raw.prepare("SELECT target_user_ids, target_labels FROM notification_queue WHERE message_id='drain-partial'").get()).toMatchObject({ target_user_ids: '["b"]', target_labels: '["Other Name"]' });
  });

  it("defers an everyone-only survivor after the direct target is deleted during authorization", async () => {
    const state = await setup(); await link(state.accounts, "a", "Deleted Name"); await link(state.accounts, "b", "Other Name");
    await state.notifications.inspect({ id: "drain-priority", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: true }, { isMember: async () => true, canViewChannel: async () => true });
    const gate = deferred<Array<{ userId: string; label: string; kind: "direct" | "everyone" }>>();
    const sent: string[] = [];
    const draining = state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 50, { authorize: () => gate.promise });
    state.accounts.deleteAccount("a");
    gate.resolve([{ userId: "a", label: "Deleted Name", kind: "direct" }, { userId: "b", label: "Other Name", kind: "everyone" }]);
    await draining;
    expect(sent).toHaveLength(0);
    expect(state.db.raw.prepare("SELECT status, available_at, target_user_ids FROM notification_queue WHERE message_id='drain-priority'").get()).toMatchObject({ status: "pending", available_at: 61_000, target_user_ids: '["b"]' });
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 61_000, 50, { authorize: async () => [{ userId: "b", label: "Other Name", kind: "everyone" }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("全体メンション");
    expect(sent[0]).not.toContain("Deleted Name");
  });

  it("does not send when the queue row is deleted just after authorization resolves", async () => {
    const state = await setup(); await enqueue(state, "drain-row-gone", ["sub"]);
    const gate = deferred<Array<{ userId: string; label: string }>>();
    let sends = 0;
    const draining = state.notifications.drain({ send: async () => { sends++; } }, 1_000, 50, { authorize: () => gate.promise });
    gate.resolve([{ userId: "sub", label: "sub" }]);
    state.db.raw.prepare("DELETE FROM notification_queue WHERE message_id='drain-row-gone'").run();
    await draining;
    expect(sends).toBe(0); expect(queueCount(state.db, "drain-row-gone")).toBe(0);
  });

  it("does not recreate queue PII when account deletion occurs after REST send starts", async () => {
    const state = await setup(); await link(state.accounts, "sub", "Deleted Name"); await enqueue(state, "send-started", ["sub"]);
    const started = deferred<void>(); const finish = deferred<void>();
    const draining = state.notifications.drain({ send: async () => { started.resolve(); await finish.promise; } }, 1_000);
    await started.promise;
    expect(state.accounts.deleteAccount("sub")).toBe("sub");
    finish.resolve(); await draining;
    expect(queueCount(state.db, "send-started")).toBe(0);
    expect(state.db.raw.prepare("SELECT 1 FROM notification_queue WHERE target_user_ids LIKE '%sub%' OR target_labels LIKE '%Deleted Name%'").get()).toBeUndefined();
  });

  it("revalidates again before a retry after the first REST attempt fails", async () => {
    const state = await setup(); await link(state.accounts, "sub"); await enqueue(state, "retry-unlink", ["sub"]);
    const started = deferred<void>(); const failFirst = deferred<void>();
    let sends = 0;
    const draining = state.notifications.drain({ send: async () => { sends++; if (sends === 1) { started.resolve(); await failFirst.promise; throw { status: 503 }; } } }, 1_000);
    await started.promise; expect(state.accounts.unlink("sub")).toBe(1); failFirst.resolve(); await draining;
    expect(sends).toBe(1); expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='retry-unlink'").get()?.status).toBe("cancelled");
  });
});

describe("privacy deletion write barrier", () => {
  it("blocks a delayed watch update while deletion backup maintenance is in flight", async () => {
    const state = await setup(); await link(state.accounts, "sub");
    const barrier = deferred<void>();
    const deletion = new PrivacyDeletionService(state.accounts, { begin: () => barrier.promise, databaseDeleted: async () => undefined, finish: async () => undefined });
    const removing = deletion.deleteAccount("sub");
    await expect(state.watches.set("guild", "sub", true, { isMember: async () => true })).rejects.toThrow("削除処理中");
    barrier.resolve(undefined);
    await expect(removing).resolves.toBe("sub");
    expect(state.db.raw.prepare("SELECT 1 FROM guild_watches WHERE sub_user_id='sub'").get()).toBeUndefined();
  });
});

describe("unlink then account delete history cleanup", () => {
  it.each(["sent", "failed", "cancelled"] as const)("removes %s history after unlink", async (status) => {
    const state = await setup(); await link(state.accounts, "sub", "Historical Name");
    state.db.raw.prepare("INSERT INTO notification_queue(main_user_id,message_id,guild_id,kind,mention_type,target_user_ids,target_labels,status,available_at,created_at) VALUES ('main',?,'guild','direct','direct','[\"sub\"]','[\"Historical Name\"]',?,1000,1000)").run(`history-${status}`, status);
    expect(state.accounts.unlink("sub")).toBe(1);
    expect(state.db.raw.prepare("SELECT 1 FROM notification_queue WHERE message_id=?").get(`history-${status}`)).toBeDefined();
    expect(state.accounts.deleteAccount("sub")).toBe("sub");
    expect(state.db.raw.prepare("SELECT 1 FROM notification_queue WHERE message_id=?").get(`history-${status}`)).toBeUndefined();
    expect(state.db.raw.prepare("SELECT 1 FROM notification_queue WHERE target_labels LIKE '%Historical Name%'").get()).toBeUndefined();
  });

  it("removes only the unlinked account from grouped historical rows", async () => {
    const state = await setup(); await link(state.accounts, "sub", "Historical Name"); await link(state.accounts, "other", "Other Name");
    state.db.raw.prepare("INSERT INTO notification_queue(main_user_id,message_id,guild_id,kind,mention_type,target_user_ids,target_labels,target_kinds,status,available_at,created_at) VALUES ('main','group-history','guild','direct','direct','[\"sub\",\"other\"]','[\"Historical Name\",\"Other Name\"]','[\"direct\",\"role\"]','sent',1000,1000)").run();
    expect(state.accounts.unlink("sub")).toBe(1); expect(state.accounts.deleteAccount("sub")).toBe("sub");
    expect(state.db.raw.prepare("SELECT target_user_ids,target_labels,target_kinds FROM notification_queue WHERE message_id='group-history'").get()).toMatchObject({ target_user_ids: '["other"]', target_labels: '["Other Name"]', target_kinds: '["role"]' });
  });

  it("deletes retained history when no link remains and reports no data only when empty", async () => {
    const state = await setup(); await link(state.accounts, "sub", "Historical Name");
    state.db.raw.prepare("INSERT INTO notification_queue(main_user_id,message_id,guild_id,kind,mention_type,target_user_ids,target_labels,status,available_at,created_at) VALUES ('main','orphan-history','guild','direct','direct','[\"sub\"]','[\"Historical Name\"]','sent',1000,1000)").run();
    state.accounts.unlink("sub");
    expect(state.accounts.deleteAccount("sub")).toBe("sub");
    expect(queueCount(state.db, "orphan-history")).toBe(0);
    expect(state.accounts.deleteAccount("never-saved")).toBe("none");
  });
});

describe("final guard after Discord user fetch", () => {
  async function pendingFetch(messageId: string) {
    const state = await setup();
    await enqueue(state, messageId, ["sub"]);
    const started = deferred<void>();
    const release = deferred<void>();
    const sent: Array<{ content: string; nonce: string; enforceNonce: boolean; allowedMentions: { parse: string[] } }> = [];
    const sender = createDiscordNotificationSender({ fetch: async () => {
      started.resolve();
      await release.promise;
      return { send: async (message: { content: string; nonce: string; enforceNonce: boolean; allowedMentions: { parse: string[] } }) => { sent.push(message); } };
    } } as never);
    const draining = state.notifications.drain(sender, 1_000, 50, { authorize: async () => [{ userId: "sub", label: "Name-sub", kind: "direct" }] });
    await started.promise;
    return { state, release, draining, sent };
  }

  it("cancels if unlink occurs while users.fetch waits", async () => {
    const pending = await pendingFetch("fetch-unlink");
    pending.state.accounts.unlink("sub");
    pending.release.resolve(); await pending.draining;
    expect(pending.sent).toHaveLength(0);
    expect(pending.state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='fetch-unlink'").get()?.status).toBe("cancelled");
  });

  it("cancels if watch is turned off while users.fetch waits", async () => {
    const pending = await pendingFetch("fetch-watch-off");
    await pending.state.watches.set("guild", "sub", false, { isMember: async () => true });
    pending.release.resolve(); await pending.draining;
    expect(pending.sent).toHaveLength(0);
    expect(pending.state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='fetch-watch-off'").get()?.status).toBe("cancelled");
  });

  it("does not send or restore deleted history if account delete occurs during users.fetch", async () => {
    const pending = await pendingFetch("fetch-account-delete");
    expect(pending.state.accounts.deleteAccount("sub")).toBe("sub");
    pending.release.resolve(); await pending.draining;
    expect(pending.sent).toHaveLength(0);
    expect(queueCount(pending.state.db, "fetch-account-delete")).toBe(0);
  });

  it("sends once with the same nonce and mentions disabled in the normal case", async () => {
    const pending = await pendingFetch("fetch-normal");
    pending.release.resolve(); await pending.draining;
    expect(pending.sent).toHaveLength(1);
    expect(pending.sent[0]?.enforceNonce).toBe(true);
    expect(pending.sent[0]?.nonce).toMatch(/^an:/);
    expect(pending.sent[0]?.allowedMentions).toEqual({ parse: [] });
    expect(pending.state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='fetch-normal'").get()?.status).toBe("sent");
  });

  it("checks again after users.fetch on a retry", async () => {
    const state = await setup(); await enqueue(state, "fetch-retry", ["sub"]);
    const secondStarted = deferred<void>(); const release = deferred<void>();
    let fetches = 0; let sends = 0;
    const sender = createDiscordNotificationSender({ fetch: async () => {
      fetches++;
      if (fetches === 2) { secondStarted.resolve(); await release.promise; }
      return { send: async () => { sends++; if (sends === 1) throw { status: 503 }; } };
    } } as never);
    const draining = state.notifications.drain(sender, 1_000, 50, { authorize: async () => [{ userId: "sub", label: "Name-sub", kind: "direct" }] });
    await secondStarted.promise;
    state.accounts.unlink("sub");
    release.resolve(); await draining;
    expect(fetches).toBe(2);
    expect(sends).toBe(1);
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='fetch-retry'").get()?.status).toBe("cancelled");
  });

  it("sends only the surviving grouped target after destination fetch", async () => {
    const state = await setup(); await enqueue(state, "fetch-grouped", ["a", "b"]);
    const started = deferred<void>(); const release = deferred<void>();
    const sent: string[] = [];
    const sender = createDiscordNotificationSender({ fetch: async () => {
      started.resolve(); await release.promise;
      return { send: async (message: { content: string }) => { sent.push(message.content); } };
    } } as never);
    const authorize = { authorize: async () => [{ userId: "a", label: "Name-a", kind: "direct" as const }, { userId: "b", label: "Name-b", kind: "direct" as const }] };
    const draining = state.notifications.drain(sender, 1_000, 50, authorize);
    await started.promise; state.accounts.unlink("a"); release.resolve(); await draining;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Name-b"); expect(sent[0]).not.toContain("Name-a");
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='fetch-grouped'").get()?.status).toBe("sent");
  });
});

describe("legacy dual-role deletion and new-role boundaries", () => {
  it("deletes both directions and all-status target history while preserving other targets", async () => {
    const state = await setup();
    await state.accounts.registerMain("other-main", "Other Main", async () => undefined, 1_000);
    await state.accounts.registerMain("dual", "Dual Name", async () => undefined, 1_000);
    const ownCode = state.accounts.issueLinkCode("dual", 1_000);
    state.accounts.approveLinkByHash("own-sub", state.accounts.hashForApproval(ownCode), "Own Sub", 1_001);
    const otherCode = state.accounts.issueLinkCode("other-main", 1_000);
    state.accounts.approveLinkByHash("other-sub", state.accounts.hashForApproval(otherCode), "Other Sub", 1_001);
    // Legacy rows can contain both roles even though new approvals forbid it.
    state.db.raw.prepare("INSERT INTO account_links(sub_user_id, main_user_id, username, created_at) VALUES ('dual','other-main','Dual Name',1000)").run();
    state.db.raw.prepare("INSERT INTO guild_watches(guild_id, sub_user_id, enabled, created_at) VALUES ('guild','dual',0,1000),('guild','own-sub',0,1000)").run();
    state.accounts.issueLinkCode("dual", 1_000);
    state.db.raw.prepare("INSERT INTO notification_dedup(main_user_id,message_id,created_at) VALUES ('dual','own-message',1000)").run();
    const insert = state.db.raw.prepare("INSERT INTO notification_queue(main_user_id,message_id,guild_id,kind,mention_type,target_user_ids,target_labels,target_kinds,status,available_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,1000,1000)");
    insert.run("dual", "own-message", "guild", "direct", "direct", '["own-sub"]', '["Own Sub"]', '["direct"]', "sent");
    for (const status of ["pending", "processing", "sent", "failed", "cancelled"]) {
      insert.run("other-main", `dual-${status}`, "guild", "direct", "direct", '["dual"]', '["Dual Name"]', '["direct"]', status);
    }
    insert.run("other-main", "grouped", "guild", "direct", "direct", '["dual","other-sub"]', '["Dual Name","Other Sub"]', '["direct","role"]', "sent");
    expect(state.accounts.getStatus("dual")).toMatchObject({ kind: "main", alsoLinkedAsSub: true });
    expect(state.accounts.deleteAccount("dual")).toBe("main");
    for (const [table, clause] of [
      ["main_accounts", "user_id='dual'"], ["entitlements", "user_id='dual'"],
      ["link_codes", "main_user_id='dual'"], ["account_links", "main_user_id='dual' OR sub_user_id='dual'"],
      ["guild_watches", "sub_user_id IN ('dual','own-sub')"], ["notification_dedup", "main_user_id='dual'"],
      ["notification_queue", "main_user_id='dual' OR target_user_ids LIKE '%dual%' OR target_labels LIKE '%Dual Name%' OR target_kinds LIKE '%dual%'" ]
    ]) expect(state.db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${clause}`).get()?.count).toBe(0);
    expect(state.db.raw.prepare("SELECT target_user_ids,target_labels,target_kinds FROM notification_queue WHERE message_id='grouped'").get()).toMatchObject({ target_user_ids: '["other-sub"]', target_labels: '["Other Sub"]', target_kinds: '["role"]' });
    expect(state.accounts.deleteAccount("dual")).toBe("none");
  });

  it("rejects a linked sub becoming main and a registered main becoming sub", async () => {
    const state = await setup(); await link(state.accounts, "sub");
    await expect(async () => state.accounts.registerMain("sub", "Sub", async () => { throw new Error("must not send DM"); })).rejects.toThrow("サブアカウントとして連携");
    await state.accounts.registerMain("already-main", "Main", async () => undefined);
    const code = state.accounts.issueLinkCode("main", 1_000);
    expect(() => state.accounts.approveLinkByHash("already-main", state.accounts.hashForApproval(code), "Main", 1_001)).toThrow("メインアカウントとして登録済み");
  });
});
