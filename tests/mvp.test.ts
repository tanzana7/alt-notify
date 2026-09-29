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
import { HealthcheckService } from "../src/services/healthcheck.js";
import { commandDefinitions } from "../src/commands.js";
import { helpText } from "../src/help.js";
import { authorizeQueuedNotification } from "../src/services/authorization.js";
import { classifyDiscordError } from "../src/services/discord-errors.js";

const resources: Array<{ db: SqliteDatabase; dir: string }> = [];

async function setup(developerTestId?: string, freeLinkLimit = 5, notificationOptions: { maxPendingPerMain?: number; minIntervalMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-alt-notify-"));
  const db = await SqliteDatabase.open(path.join(dir, "test.sqlite"));
  const accounts = new AccountService(db, developerTestId, "test-pepper", freeLinkLimit);
  const watches = new WatchService(db, accounts);
  const notifications = new NotificationService(db, accounts, new Logger("error"), () => 1_000, notificationOptions);
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

function mockClient(options: { fetchMember: (userId: string) => Promise<unknown>; fetchChannel?: () => Promise<unknown>; channel?: unknown }) {
  const guild = {
    channels: { cache: { get: () => options.channel }, fetch: options.fetchChannel ?? (async () => options.channel) },
    members: { fetch: options.fetchMember }
  };
  return { guilds: { cache: { get: () => guild } } } as never;
}

function visibleChannel(hasView = true) {
  return { permissionsFor: () => ({ has: () => hasView }) };
}

function authorizedTarget() {
  return { kind: "authorized" as const, targets: [{ userId: "a", label: "a" }] };
}

function roleMember(roleIds: string[]) {
  return { roles: { cache: new Map(roleIds.map((roleId) => [roleId, {}])) } };
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

  it("allows five free links and rejects the sixth while preserving the developer five-link limit", async () => {
    const free = await setup();
    await registerMain(free.accounts);
    for (const sub of ["a", "b", "c", "d", "e"]) await link(free.accounts, "main", sub);
    expect(free.accounts.getStatus("main").links).toHaveLength(5);
    const code = free.accounts.issueLinkCode("main", 2_000);
    expect(() => free.accounts.approveLinkByHash("f", free.accounts.hashForApproval(code), "f", 2_001)).toThrow("上限");
    const dev = await setup("dev");
    await registerMain(dev.accounts, "dev", "developer");
    for (const sub of ["a", "b", "c", "d", "e"]) await link(dev.accounts, "dev", sub);
    expect(dev.accounts.getStatus("dev").links).toHaveLength(5);
  });

  it("can be configured back to a one-link Free limit", async () => {
    const state = await setup(undefined, 1);
    await registerMain(state.accounts); await link(state.accounts, "main", "a");
    const code = state.accounts.issueLinkCode("main", 2_000);
    expect(() => state.accounts.approveLinkByHash("b", state.accounts.hashForApproval(code), "b", 2_001)).toThrow("上限");
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

  it("publishes the user help and account deletion commands", () => {
    const names = commandDefinitions().map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(["help", "account"]));
    expect(helpText("AltNoti")).toContain("/link issue");
    expect(helpText("AltNoti")).toContain("/account delete");
  });

  it("deletes a main account and all directly stored account data", async () => {
    const { accounts, watches, notifications, db } = await setup();
    await registerMain(accounts); await link(accounts, "main", "sub", "sub");
    await watches.set("guild", "sub", false, { isMember: async () => true });
    await notifications.inspect({ id: "delete-me", guildId: "guild", authorBot: false, mentionedUserIds: ["sub"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    db.raw.prepare("INSERT INTO notification_dedup(main_user_id, message_id, created_at) VALUES ('main', 'dedup', 1000)").run();
    expect(accounts.deleteAccount("main")).toBe("main");
    expect(accounts.getStatus("main").kind).toBe("none");
    for (const table of ["main_accounts", "account_links", "guild_watches", "link_codes", "notification_queue", "notification_dedup", "entitlements"]) {
      expect((db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, table).toBe(0);
    }
  });

  it("deletes only a sub account while retaining the main account", async () => {
    const { accounts, watches, db } = await setup();
    await registerMain(accounts); await link(accounts, "main", "sub", "sub");
    await watches.set("guild", "sub", false, { isMember: async () => true });
    expect(accounts.deleteAccount("sub")).toBe("sub");
    expect(accounts.getStatus("sub").kind).toBe("none");
    expect(accounts.getStatus("main").kind).toBe("main");
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM account_links").get() as { count: number }).count).toBe(0);
  });
});

describe("watch and notification flow", () => {
  it("notifies when a linked sub account owns the mentioned role", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a", "subA");
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true };
    expect(await state.notifications.inspect({ id: "role-match", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, visibility)).toBe(1);
    const sent: string[] = [];
    expect(await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_000)).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]).toContain("ロールメンション");
  });

  it("does not notify a linked sub account without the mentioned role", async () => {
    const state = await setup(); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    let roleChecks = 0;
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => { roleChecks++; return ["other-role"]; }, canViewChannel: async () => true };
    expect(await state.notifications.inspect({ id: "role-no-match", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, visibility)).toBe(0);
    expect(roleChecks).toBe(1);
  });

  it("matches one role among multiple mentioned roles", async () => {
    const state = await setup(); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true };
    expect(await state.notifications.inspect({ id: "role-one-of-many", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["other-role", "role-splatoon"], mentionEveryone: false }, visibility)).toBe(1);
  });

  it("aggregates role mentions for multiple linked subs under one main account", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a", "A"); await link(state.accounts, "main", "b", "B");
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true };
    expect(await state.notifications.inspect({ id: "role-grouped", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, visibility)).toBe(1);
    expect((state.db.raw.prepare("SELECT target_user_ids FROM notification_queue WHERE message_id='role-grouped'").get() as { target_user_ids: string }).target_user_ids).toBe('["a","b"]');
    const sent: string[] = [];
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("A、B");
  });

  it("creates separate role notifications for separate main accounts", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts, "main-a"); await registerMain(state.accounts, "main-b"); await link(state.accounts, "main-a", "a"); await link(state.accounts, "main-b", "b");
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true };
    expect(await state.notifications.inspect({ id: "role-separate", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, visibility)).toBe(2);
    expect((state.db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE message_id='role-separate'").get() as { count: number }).count).toBe(2);
  });

  it("delivers role mentions before delayed everyone notifications", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true };
    await state.notifications.inspect({ id: "role-priority-everyone", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, visibility);
    await state.notifications.inspect({ id: "everyone-after-role", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionEveryone: true }, visibility);
    const sent: string[] = [];
    expect(await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 1)).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]).toContain("ロールメンション");
  });

  it("allows an immediate role mention to displace a delayed everyone row", async () => {
    const state = await setup(undefined, 5, { maxPendingPerMain: 1, minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true };
    await state.notifications.inspect({ id: "everyone-before-role", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionEveryone: true }, visibility);
    await state.notifications.inspect({ id: "role-at-capacity", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, visibility);
    expect((state.db.raw.prepare("SELECT status, last_error FROM notification_queue WHERE message_id='everyone-before-role'").get() as { status: string; last_error: string })).toMatchObject({ status: "failed", last_error: "evicted by role mention priority" });
    expect((state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='role-at-capacity'").get() as { status: string }).status).toBe("pending");
  });

  it("uses direct priority for a direct plus role plus everyone message", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a", "A"); await link(state.accounts, "main", "b", "B"); await link(state.accounts, "main", "c", "C");
    const roles = new Map([["a", [] as string[]], ["b", ["role-splatoon"]], ["c", [] as string[]]]);
    const visibility = { isMember: async () => true, getMemberRoleIds: async (userId: string) => roles.get(userId) ?? [], canViewChannel: async () => true };
    await state.notifications.inspect({ id: "mixed-direct-role-everyone", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionedRoleIds: ["role-splatoon"], mentionEveryone: true }, visibility);
    const row = state.db.raw.prepare("SELECT mention_type, target_user_ids, target_kinds, available_at FROM notification_queue WHERE message_id='mixed-direct-role-everyone'").get() as { mention_type: string; target_user_ids: string; target_kinds: string; available_at: number };
    expect(row).toMatchObject({ mention_type: "direct", target_user_ids: '["a","b","c"]', target_kinds: '["direct","role","everyone"]', available_at: 1_000 });
  });

  it("uses role priority for a role plus everyone message and keeps both targets", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "b", "B"); await link(state.accounts, "main", "c", "C");
    const roles = new Map([["b", ["role-splatoon"]], ["c", [] as string[]]]);
    const visibility = { isMember: async () => true, getMemberRoleIds: async (userId: string) => roles.get(userId) ?? [], canViewChannel: async () => true };
    await state.notifications.inspect({ id: "mixed-role-everyone", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: true }, visibility);
    const row = state.db.raw.prepare("SELECT mention_type, target_kinds, available_at FROM notification_queue WHERE message_id='mixed-role-everyone'").get() as { mention_type: string; target_kinds: string; available_at: number };
    expect(row).toMatchObject({ mention_type: "role", target_kinds: '["role","everyone"]', available_at: 1_000 });
    const client = mockClient({ channel: visibleChannel(), fetchMember: async (userId) => roleMember(userId === "b" ? ["role-splatoon"] : []) });
    const sent: string[] = [];
    expect(await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 50, { authorize: (input) => authorizeQueuedNotification(client, state.accounts, input) })).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]).toContain("ロールメンション");
  });

  it("uses direct priority for a direct plus everyone message", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a", "A"); await link(state.accounts, "main", "c", "C");
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => [], canViewChannel: async () => true };
    await state.notifications.inspect({ id: "mixed-direct-everyone", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: true }, visibility);
    const row = state.db.raw.prepare("SELECT mention_type, target_kinds, available_at FROM notification_queue WHERE message_id='mixed-direct-everyone'").get() as { mention_type: string; target_kinds: string; available_at: number };
    expect(row).toMatchObject({ mention_type: "direct", target_kinds: '["direct","everyone"]', available_at: 1_000 });
  });

  it("does not notify a role while watch is off", async () => {
    const state = await setup(); await registerMain(state.accounts); await link(state.accounts, "main", "a"); await state.watches.set("guild", "a", false, { isMember: async () => true });
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true };
    expect(await state.notifications.inspect({ id: "role-watch-off", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, visibility)).toBe(0);
  });

  it("does not notify an unlinked role member", async () => {
    const state = await setup(); await registerMain(state.accounts); await link(state.accounts, "main", "a"); state.accounts.unlink("main", "a");
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true };
    expect(await state.notifications.inspect({ id: "role-unlinked", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, visibility)).toBe(0);
  });

  it("does not notify a role member who left the guild", async () => {
    const state = await setup(); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    const visibility = { isMember: async () => false, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true };
    expect(await state.notifications.inspect({ id: "role-departed", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, visibility)).toBe(0);
  });

  it("does not notify a role member without channel view permission", async () => {
    const state = await setup(); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => false };
    expect(await state.notifications.inspect({ id: "role-hidden", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, visibility)).toBe(0);
  });

  it("retains a role candidate when member fetch is temporarily unavailable", async () => {
    const state = await setup(); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    const visibility = { isMember: async () => { throw { status: 503 }; }, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true };
    expect(await state.notifications.inspect({ id: "role-member-retry", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, visibility)).toBe(1);
    expect((state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='role-member-retry'").get() as { status: string }).status).toBe("pending");
  });

  it("sends a role notification after member retry recovery", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a", "A");
    await state.notifications.inspect({ id: "role-retry-success", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, { isMember: async () => true, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true });
    let attempts = 0;
    const client = mockClient({ channel: visibleChannel(), fetchMember: async () => { attempts++; if (attempts === 1) throw { status: 503 }; return roleMember(["role-splatoon"]); } });
    const sent: string[] = [];
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 50, { authorize: (input) => authorizeQueuedNotification(client, state.accounts, input) });
    const row = state.db.raw.prepare("SELECT available_at FROM notification_queue WHERE message_id='role-retry-success'").get() as { available_at: number };
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, row.available_at, 50, { authorize: (input) => authorizeQueuedNotification(client, state.accounts, input) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("ロールメンション");
    expect(attempts).toBe(2);
  });

  it("records a failed role notification after the retry budget", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    await state.notifications.inspect({ id: "role-retry-failed", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-splatoon"], mentionEveryone: false }, { isMember: async () => true, getMemberRoleIds: async () => ["role-splatoon"], canViewChannel: async () => true });
    const client = mockClient({ channel: visibleChannel(), fetchMember: async () => { throw { status: 503 }; } });
    for (const now of [1_000, 1_500, 2_500]) await state.notifications.drain({ send: async () => undefined }, now, 50, { authorize: (input) => authorizeQueuedNotification(client, state.accounts, input) });
    expect(state.db.raw.prepare("SELECT status, last_error FROM notification_queue WHERE message_id='role-retry-failed'").get()).toMatchObject({ status: "failed", last_error: "temporary discord api failure" });
  });

  it("does not perform role checks for an ordinary message", async () => {
    const state = await setup(); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    let memberChecks = 0; let roleChecks = 0;
    const visibility = { isMember: async () => { memberChecks++; return true; }, getMemberRoleIds: async () => { roleChecks++; return ["role-splatoon"]; }, canViewChannel: async () => true };
    expect(await state.notifications.inspect({ id: "ordinary", guildId: "guild", authorBot: false, mentionedUserIds: [], mentionEveryone: false }, visibility)).toBe(0);
    expect(memberChecks).toBe(0);
    expect(roleChecks).toBe(0);
  });

  it("does not notify when member fetch proves Unknown Member", async () => {
    const { accounts } = await setup(); await registerMain(accounts); await link(accounts, "main", "a");
    const result = await authorizeQueuedNotification(mockClient({ channel: visibleChannel(), fetchMember: async () => { throw { status: 404, code: 10007 }; } }), accounts, { mainUserId: "main", guildId: "guild", channelId: "channel", kind: "direct", targetUserIds: ["a"] });
    expect(result).toEqual({ kind: "authorized", targets: [] });
  });

  it("does not notify when member access is denied", async () => {
    const { accounts } = await setup(); await registerMain(accounts); await link(accounts, "main", "a");
    const result = await authorizeQueuedNotification(mockClient({ channel: visibleChannel(), fetchMember: async () => { throw { status: 403, code: 50013 }; } }), accounts, { mainUserId: "main", guildId: "guild", channelId: "channel", kind: "direct", targetUserIds: ["a"] });
    expect(result).toEqual({ kind: "authorized", targets: [] });
  });

  it("retries a temporary member API failure instead of dropping the candidate", async () => {
    const { accounts } = await setup(); await registerMain(accounts); await link(accounts, "main", "a");
    const result = await authorizeQueuedNotification(mockClient({ channel: visibleChannel(), fetchMember: async () => { throw { status: 503 }; } }), accounts, { mainUserId: "main", guildId: "guild", channelId: "channel", kind: "direct", targetUserIds: ["a"] });
    expect(result).toMatchObject({ kind: "retry", reason: "temporary discord api failure" });
  });

  it("retries a network failure during member lookup", async () => {
    const { accounts } = await setup(); await registerMain(accounts); await link(accounts, "main", "a");
    const result = await authorizeQueuedNotification(mockClient({ channel: visibleChannel(), fetchMember: async () => { throw { code: "ECONNRESET" }; } }), accounts, { mainUserId: "main", guildId: "guild", channelId: "channel", kind: "direct", targetUserIds: ["a"] });
    expect(result).toMatchObject({ kind: "retry", reason: "temporary discord api failure" });
  });

  it("uses discord.js RateLimitError retryAfter as milliseconds", () => {
    expect(classifyDiscordError({ name: "RateLimitError", status: 429, retryAfter: 750 }, "member")).toMatchObject({ kind: "temporary", retryAfterMs: 750 });
  });

  it("sends after a temporary member failure recovers", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    let memberAttempts = 0;
    const client = mockClient({ channel: visibleChannel(), fetchMember: async () => { memberAttempts++; if (memberAttempts === 1) throw { status: 503 }; return {}; } });
    await state.notifications.inspect({ id: "member-retry-success", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    const sent: string[] = [];
    expect(await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_000, 50, { authorize: (input) => authorizeQueuedNotification(client, state.accounts, input) })).toEqual({ sent: 0, failed: 0 });
    const availableAt = (state.db.raw.prepare("SELECT available_at FROM notification_queue WHERE message_id='member-retry-success'").get() as { available_at: number }).available_at;
    expect(await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, availableAt, 50, { authorize: (input) => authorizeQueuedNotification(client, state.accounts, input) })).toEqual({ sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it("records failed after the temporary member failure retry budget", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    const client = mockClient({ channel: visibleChannel(), fetchMember: async () => { throw { status: 503 }; } });
    await state.notifications.inspect({ id: "member-retry-failed", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    const sent: string[] = [];
    for (const now of [2_000, 2_500, 3_500]) await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, now, 50, { authorize: (input) => authorizeQueuedNotification(client, state.accounts, input) });
    expect(sent).toHaveLength(0);
    expect(state.db.raw.prepare("SELECT status, last_error FROM notification_queue WHERE message_id='member-retry-failed'").get()).toMatchObject({ status: "failed", last_error: "temporary discord api failure" });
  });

  it("retries a temporary channel fetch failure", async () => {
    const { accounts } = await setup(); await registerMain(accounts); await link(accounts, "main", "a");
    const result = await authorizeQueuedNotification(mockClient({ fetchMember: async () => ({}), fetchChannel: async () => { throw { status: 503 }; } }), accounts, { mainUserId: "main", guildId: "guild", channelId: "channel", kind: "direct", targetUserIds: ["a"] });
    expect(result).toMatchObject({ kind: "retry", reason: "temporary discord api failure" });
  });

  it("cancels when channel access is definitively unavailable", async () => {
    const { accounts } = await setup(); await registerMain(accounts); await link(accounts, "main", "a");
    const result = await authorizeQueuedNotification(mockClient({ fetchMember: async () => ({}), fetchChannel: async () => visibleChannel(false) }), accounts, { mainUserId: "main", guildId: "guild", channelId: "channel", kind: "direct", targetUserIds: ["a"] });
    expect(result).toEqual({ kind: "authorized", targets: [] });
  });

  it("does not send after watch off during authorization retry", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    await state.notifications.inspect({ id: "retry-watch-off", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    const sent: string[] = [];
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_000, 50, { authorize: async () => ({ kind: "retry", reason: "temporary discord api failure" }) });
    await state.watches.set("guild", "a", false, { isMember: async () => true });
    const client = mockClient({ channel: visibleChannel(), fetchMember: async () => ({}) });
    const availableAt = (state.db.raw.prepare("SELECT available_at FROM notification_queue WHERE message_id='retry-watch-off'").get() as { available_at: number }).available_at;
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, availableAt, 50, { authorize: (input) => authorizeQueuedNotification(client, state.accounts, input) });
    expect(sent).toHaveLength(0);
    expect((state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='retry-watch-off'").get() as { status: string }).status).toBe("cancelled");
  });

  it("does not send after unlink during authorization retry", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    await state.notifications.inspect({ id: "retry-unlink", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    const sent: string[] = [];
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_000, 50, { authorize: async () => ({ kind: "retry", reason: "temporary discord api failure" }) });
    await state.accounts.unlink("main", "a");
    expect(await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_500, 50, { authorize: async () => ({ kind: "authorized", targets: [] }) })).toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("does not send after main account deletion during authorization retry", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    await state.notifications.inspect({ id: "retry-delete", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    const sent: string[] = [];
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_000, 50, { authorize: async () => ({ kind: "retry", reason: "temporary discord api failure" }) });
    expect(state.accounts.deleteAccount("main")).toBe("main");
    expect(await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_500, 50, { authorize: async () => authorizedTarget() })).toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("does not duplicate a DM across authorization retries", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 }); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    await state.notifications.inspect({ id: "retry-once", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    let calls = 0;
    const sent: string[] = [];
    const authorization = { authorize: async () => { calls++; return calls === 1 ? { kind: "retry" as const, reason: "temporary discord api failure" } : authorizedTarget(); } };
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_000, 50, authorization);
    const availableAt = (state.db.raw.prepare("SELECT available_at FROM notification_queue WHERE message_id='retry-once'").get() as { available_at: number }).available_at;
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, availableAt, 50, authorization);
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, availableAt + 1_000, 50, authorization);
    expect(sent).toHaveLength(1);
  });

  it("does not send a success heartbeat while Gateway is unavailable", async () => {
    const { db } = await setup();
    const requests: string[] = [];
    const healthcheck = new HealthcheckService(db, new Logger("error"), "https://healthchecks.example/test", 200, 5, async (url) => { requests.push(url); return true; });
    await expect(healthcheck.check(false)).resolves.toMatchObject({ healthy: false, requestSent: false, reason: "gateway_not_ready" });
    expect(requests).toHaveLength(0);
  });

  it("sends a heartbeat only for a healthy queue and fail-pings threshold breaches", async () => {
    const { db, accounts, notifications } = await setup();
    await registerMain(accounts); await link(accounts, "main", "a", "a");
    await notifications.inspect({ id: "health-pending", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    const requests: string[] = [];
    const healthy = new HealthcheckService(db, new Logger("error"), "https://healthchecks.example/test", 2, 5, async (url) => { requests.push(url); return true; });
    await expect(healthy.check(true)).resolves.toMatchObject({ healthy: true, requestSent: true, reason: "ok" });
    expect(requests).toEqual(["https://healthchecks.example/test"]);
    const overloaded = new HealthcheckService(db, new Logger("error"), "https://healthchecks.example/test", 1, 5, async (url) => { requests.push(url); return true; });
    await expect(overloaded.check(true)).resolves.toMatchObject({ healthy: false, requestSent: true, reason: "queue_or_failure_threshold" });
    expect(requests[1]).toBe("https://healthchecks.example/test/fail");
  });
  it("does not enqueue from a watch that is off", async () => {
    const { accounts, watches, notifications, db } = await setup();
    await registerMain(accounts); await link(accounts, "main", "a", "a");
    await watches.set("guild", "a", true, { isMember: async () => true }, 1_000);
    await watches.set("guild", "a", false, { isMember: async () => true }, 1_001);
    expect(await notifications.inspect({ id: "message", guildId: "guild", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true })).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue").get()?.count).toBe(0);
  });

  it("automatically watches a new guild, preserves explicit off, and resumes with watch on", async () => {
    const { accounts, watches, notifications } = await setup();
    await registerMain(accounts); await link(accounts, "main", "a", "a");
    const visibility = { isMember: async () => true, canViewChannel: async () => true };
    expect(watches.status("new-guild", "a")).toBe("auto");
    expect(await notifications.inspect({ id: "auto", guildId: "new-guild", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, visibility)).toBe(1);
    await watches.set("new-guild", "a", false, { isMember: async () => true });
    expect(watches.status("new-guild", "a")).toBe("off");
    expect(await notifications.inspect({ id: "off", guildId: "new-guild", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, visibility)).toBe(0);
    await watches.set("new-guild", "a", true, { isMember: async () => true });
    expect(watches.status("new-guild", "a")).toBe("on");
    expect(await notifications.inspect({ id: "on", guildId: "new-guild", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, visibility)).toBe(1);
  });

  it("persists explicit watch off across a database reopen", async () => {
    const state = await setup(); await registerMain(state.accounts); await link(state.accounts, "main", "a");
    await state.watches.set("guild", "a", false, { isMember: async () => true });
    const dbPath = path.join(state.dir, "test.sqlite"); state.db.close();
    const reopened = await SqliteDatabase.open(dbPath);
    expect(new WatchService(reopened, new AccountService(reopened)).status("guild", "a")).toBe("off");
    reopened.close();
  });

  it("requires a linked sub account and membership before watch on", async () => {
    const { watches } = await setup();
    await expect(watches.set("guild", "unlinked", true, { isMember: async () => true })).rejects.toThrow("連携済み");
  });

  it("does not enable watch when the user is not a guild member", async () => {
    const { accounts, watches } = await setup(); await registerMain(accounts); await link(accounts, "main", "a");
    await expect(watches.set("guild", "a", true, { isMember: async () => false })).rejects.toThrow("メンバー");
    expect(watches.status("guild", "a")).toBe("auto");
  });

  it("does not enqueue when the target cannot view the source channel", async () => {
    const { accounts, watches, notifications } = await setup(); await registerMain(accounts); await link(accounts, "main", "a"); await watches.set("guild", "a", true, { isMember: async () => true });
    expect(await notifications.inspect({ id: "hidden", guildId: "guild", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => false })).toBe(0);
  });

  it("does not enqueue unrelated messages", async () => {
    const { accounts, watches, notifications } = await setup(); await registerMain(accounts); await link(accounts, "main", "a"); await watches.set("guild", "a", true, { isMember: async () => true });
    expect(await notifications.inspect({ id: "unrelated", guildId: "guild", authorBot: false, mentionedUserIds: ["someone-else"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true })).toBe(0);
  });

  it("does not forward a direct mention of the main account", async () => {
    const { accounts, watches, notifications } = await setup(); await registerMain(accounts); await link(accounts, "main", "a"); await watches.set("guild", "a", true, { isMember: async () => true });
    expect(await notifications.inspect({ id: "main-mention", guildId: "guild", authorBot: false, mentionedUserIds: ["main"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true })).toBe(0);
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

  it("targets linked accounts except those explicitly switched off for everyone mentions", async () => {
    const { accounts, watches, notifications, db } = await setup("main"); await registerMain(accounts); await link(accounts, "main", "a"); await link(accounts, "main", "b"); await watches.set("guild", "b", false, { isMember: async () => true });
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

  it("rechecks watch and membership authorization immediately before sending", async () => {
    const { accounts, watches, notifications, db } = await setup();
    await registerMain(accounts); await link(accounts, "main", "a", "a");
    await notifications.inspect({ id: "late-check", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    await watches.set("guild", "a", false, { isMember: async () => true });
    const sent: string[] = [];
    expect(await notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_000, 50, { authorize: async () => [] })).toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
    expect((db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='late-check'").get() as { status: string }).status).toBe("cancelled");
  });

  it("records queue pressure instead of allowing unbounded pending growth", async () => {
    const { accounts, notifications, db } = await setup(undefined, 5, { maxPendingPerMain: 1 });
    await registerMain(accounts); await link(accounts, "main", "a", "a");
    const visibility = { isMember: async () => true, canViewChannel: async () => true };
    expect(await notifications.inspect({ id: "capacity-1", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, visibility)).toBe(1);
    expect(await notifications.inspect({ id: "capacity-2", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, visibility)).toBe(1);
    expect((db.raw.prepare("SELECT status, last_error FROM notification_queue WHERE message_id='capacity-2'").get() as { status: string; last_error: string })).toMatchObject({ status: "failed", last_error: "notification queue capacity exceeded" });
  });

  it("keeps a bounded queue under a local mock burst", async () => {
    const { accounts, notifications, db } = await setup();
    await registerMain(accounts); await link(accounts, "main", "a", "a");
    const visibility = { isMember: async () => true, canViewChannel: async () => true };
    for (let index = 0; index < 250; index++) {
      await notifications.inspect({ id: `burst-${index}`, guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, visibility);
    }
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE status='pending'").get() as { count: number }).count).toBe(200);
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE status='failed'").get() as { count: number }).count).toBe(50);
  });

  it("prioritizes a direct mention over pending everyone notifications and records the eviction", async () => {
    const { accounts, notifications, db } = await setup(undefined, 5, { maxPendingPerMain: 2, minIntervalMs: 0 });
    await registerMain(accounts); await link(accounts, "main", "a", "a");
    const visibility = { isMember: async () => true, canViewChannel: async () => true };
    await notifications.inspect({ id: "everyone-1", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionEveryone: true }, visibility);
    await notifications.inspect({ id: "everyone-2", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionEveryone: true }, visibility);
    await notifications.inspect({ id: "direct-priority", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, visibility);
    expect((db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='direct-priority'").get() as { status: string }).status).toBe("pending");
    expect((db.raw.prepare("SELECT last_error FROM notification_queue WHERE message_id='everyone-2'").get() as { last_error: string }).last_error).toBe("evicted by direct mention priority");
    const sent: string[] = [];
    expect(await notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 61_000, 1)).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]).toContain("直接メンション");
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

  it("removes only the unlinked target from a grouped pending notification", async () => {
    const { accounts, notifications, db } = await setup();
    await registerMain(accounts); await link(accounts, "main", "a", "a"); await link(accounts, "main", "b", "b");
    await notifications.inspect({ id: "partial-unlink", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a", "b"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    expect(accounts.unlink("main", "a")).toBe(1);
    expect((db.raw.prepare("SELECT status, target_user_ids FROM notification_queue WHERE message_id='partial-unlink'").get() as { status: string; target_user_ids: string })).toMatchObject({ status: "pending", target_user_ids: '["b"]' });
  });

  it("recovers a processing notification after a database reopen", async () => {
    const state = await setup(undefined, 5, { minIntervalMs: 0 });
    await registerMain(state.accounts); await link(state.accounts, "main", "a", "a");
    await state.notifications.inspect({ id: "restart-queue", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["a"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    state.db.raw.prepare("UPDATE notification_queue SET status='processing' WHERE message_id='restart-queue'").run();
    const dbPath = path.join(state.dir, "test.sqlite"); state.db.close();
    const reopened = await SqliteDatabase.open(dbPath);
    reopened.cleanup();
    const reopenedAccounts = new AccountService(reopened);
    const reopenedNotifications = new NotificationService(reopened, reopenedAccounts, new Logger("error"), () => 2_000, { minIntervalMs: 0 });
    const sent: string[] = [];
    expect(await reopenedNotifications.drain({ send: async (_id, content) => { sent.push(content); } }, 2_000)).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]).toContain("直接メンション");
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
