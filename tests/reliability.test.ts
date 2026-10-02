import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord.js";
import { SqliteDatabase } from "../src/db.js";
import { Logger } from "../src/logger.js";
import { AccountService } from "../src/services/accounts.js";
import { ApprovalStore } from "../src/services/approval.js";
import { authorizeQueuedNotification } from "../src/services/authorization.js";
import { HealthcheckService } from "../src/services/healthcheck.js";
import { MemberCache } from "../src/services/member-cache.js";
import { NotificationService, type IncomingMessage } from "../src/services/notifications.js";
import { SingleFlight } from "../src/services/single-flight.js";
import { UserFacingError, userMessageForError } from "../src/services/user-error.js";
import { WatchService, memberAccessForWatch } from "../src/services/watches.js";

const resources: Array<{ db: SqliteDatabase; dir: string }> = [];
async function setup(now = () => 1_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "altnotify-reliability-"));
  const db = await SqliteDatabase.open(path.join(dir, "test.sqlite"));
  resources.push({ db, dir });
  const accounts = new AccountService(db);
  const watches = new WatchService(db, accounts);
  const notifications = new NotificationService(db, accounts, new Logger("error"), now);
  await accounts.registerMain("main", "Main", async () => undefined, 1_000);
  const code = accounts.issueLinkCode("main", 1_000);
  accounts.approveLinkByHash("sub", accounts.hashForApproval(code), "Sub", 1_001);
  return { db, accounts, watches, notifications };
}
afterEach(() => {
  for (const { db, dir } of resources.splice(0)) {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const roleMessage = (id: string, everyone = false): IncomingMessage => ({ id, guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: [], mentionedRoleIds: ["role-a"], mentionEveryone: everyone });
const visibleChannel = { permissionsFor: () => ({ has: () => true }) };
function memberWithRoles(roles: string[]) { return { roles: { cache: new Map(roles.map((id) => [id, {}])) } }; }
function clientFor(fetchMember: () => Promise<unknown>, channel: unknown = visibleChannel) {
  const guild = { channels: { cache: { get: () => channel }, fetch: async () => channel }, members: { fetch: fetchMember } };
  return { guilds: { cache: { get: () => guild } } } as never;
}
function freshClient(fetchChannel: () => Promise<unknown>, fetchMember: () => Promise<unknown>) {
  const channelRequests: Array<{ id: string; force: boolean }> = [];
  const memberRequests: Array<{ user: string; force: boolean }> = [];
  const guild = {
    channels: { cache: { get: () => visibleChannel }, fetch: async (id: string, options: { force: boolean }) => { channelRequests.push({ id, force: options.force }); return fetchChannel(); } },
    members: { cache: { get: () => memberWithRoles(["role-a"]) }, fetch: async (options: { user: string; force: boolean }) => { memberRequests.push(options); return fetchMember(); } }
  };
  return { client: { guilds: { cache: { get: () => guild } } } as never, channelRequests, memberRequests };
}
async function queuedRole(state: Awaited<ReturnType<typeof setup>>, id: string, visibility: { isMember: () => Promise<boolean>; getMemberRoleIds: () => Promise<string[]> }) {
  await state.notifications.inspect(roleMessage(id), { ...visibility, canViewChannel: async () => true });
  return state.db.raw.prepare("SELECT mention_type, target_role_ids, target_kinds, available_at, status FROM notification_queue WHERE message_id=?").get(id) as { mention_type: string; target_role_ids: string; target_kinds: string; available_at: number; status: string };
}

describe("private threads and fresh delivery authorization", () => {
  const visibility = { isMember: async () => true, getMemberRoleIds: async () => ["role-a"], canViewChannel: async () => true };
  const directMessage = (id: string): IncomingMessage => ({ id, guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["sub"], mentionEveryone: false });

  it.each(["direct", "role", "everyone"] as const)("does not inspect private-thread %s mentions", async (kind) => {
    const state = await setup();
    const message = kind === "direct" ? directMessage(kind) : kind === "role" ? roleMessage(kind) : { ...roleMessage(kind), mentionedRoleIds: [], mentionEveryone: true };
    expect(await state.notifications.inspect({ ...message, privateThread: true }, { isMember: async () => { throw new Error("private thread must not fetch members"); }, canViewChannel: async () => { throw new Error("private thread must not check permissions"); } })).toBe(0);
    expect(state.db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue").get()?.count).toBe(0);
  });

  it.each(["direct", "role", "everyone"] as const)("cancels queued private-thread %s mentions before delivery", async (kind) => {
    const state = await setup();
    const message = kind === "direct" ? directMessage(kind) : kind === "role" ? roleMessage(kind) : { ...roleMessage(kind), mentionedRoleIds: [], mentionEveryone: true };
    await state.notifications.inspect(message, visibility);
    const sent: string[] = [];
    const privateChannel = { type: ChannelType.PrivateThread, permissionsFor: () => ({ has: () => true }) };
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, kind === "everyone" ? 61_000 : 1_000, 50, { authorize: (input) => authorizeQueuedNotification(clientFor(async () => memberWithRoles(["role-a"]), privateChannel), state.accounts, input) });
    expect(sent).toHaveLength(0);
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id=?").get(kind)?.status).toBe("cancelled");
  });

  it.each([ChannelType.PublicThread, ChannelType.GuildText])("retains notifications in channel type %s", async (type) => {
    const state = await setup();
    await state.notifications.inspect(directMessage(`channel-${type}`), visibility);
    const sent: string[] = [];
    const channel = { type, permissionsFor: () => ({ has: () => true }) };
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 50, { authorize: (input) => authorizeQueuedNotification(clientFor(async () => memberWithRoles([]), channel), state.accounts, input) });
    expect(sent).toHaveLength(1);
  });

  it("cancels a direct mention when fresh member fetch proves departure", async () => {
    const state = await setup();
    await state.notifications.inspect(directMessage("departed"), visibility);
    const fresh = freshClient(async () => visibleChannel, async () => { throw { status: 404, code: 10007 }; });
    const sent: string[] = [];
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 50, { authorize: (input) => authorizeQueuedNotification(fresh.client, state.accounts, input) });
    expect(sent).toHaveLength(0);
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='departed'").get()?.status).toBe("cancelled");
    expect(fresh.channelRequests).toEqual([{ id: "channel", force: true }]);
    expect(fresh.memberRequests).toEqual([{ user: "sub", force: true }]);
  });

  it("cancels a role mention when only the cached member has the role", async () => {
    const state = await setup();
    await queuedRole(state, "role-removed", visibility);
    const fresh = freshClient(async () => visibleChannel, async () => memberWithRoles([]));
    await state.notifications.drain({ send: async () => { throw new Error("must not send"); } }, 1_000, 50, { authorize: (input) => authorizeQueuedNotification(fresh.client, state.accounts, input) });
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='role-removed'").get()?.status).toBe("cancelled");
    expect(fresh.memberRequests).toEqual([{ user: "sub", force: true }]);
  });

  it("cancels when only the cached channel grants ViewChannel", async () => {
    const state = await setup();
    await state.notifications.inspect(directMessage("permission-removed"), visibility);
    const fresh = freshClient(async () => ({ permissionsFor: () => ({ has: () => false }) }), async () => memberWithRoles([]));
    await state.notifications.drain({ send: async () => { throw new Error("must not send"); } }, 1_000, 50, { authorize: (input) => authorizeQueuedNotification(fresh.client, state.accounts, input) });
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='permission-removed'").get()?.status).toBe("cancelled");
    expect(fresh.channelRequests).toEqual([{ id: "channel", force: true }]);
  });

  it("cancels when a fresh channel fetch confirms 404", async () => {
    const state = await setup();
    await state.notifications.inspect(directMessage("channel-gone"), visibility);
    const fresh = freshClient(async () => { throw { status: 404, code: 10003 }; }, async () => memberWithRoles([]));
    await state.notifications.drain({ send: async () => { throw new Error("must not send"); } }, 1_000, 50, { authorize: (input) => authorizeQueuedNotification(fresh.client, state.accounts, input) });
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='channel-gone'").get()?.status).toBe("cancelled");
    expect(fresh.memberRequests).toHaveLength(0);
  });

  it("retries a fresh channel 5xx and sends after recovery", async () => {
    const state = await setup();
    await state.notifications.inspect(directMessage("channel-recovered"), visibility);
    let calls = 0;
    const fresh = freshClient(async () => { if (++calls === 1) throw { status: 503 }; return visibleChannel; }, async () => memberWithRoles([]));
    const sent: string[] = [];
    const authorization = { authorize: (input: Parameters<typeof authorizeQueuedNotification>[2]) => authorizeQueuedNotification(fresh.client, state.accounts, input) };
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 50, authorization);
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='channel-recovered'").get()?.status).toBe("pending");
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_500, 50, authorization);
    expect(sent).toHaveLength(1);
    expect(fresh.channelRequests).toHaveLength(2);
  });

  it("retries a fresh member 5xx and sends after recovery", async () => {
    const state = await setup();
    await state.notifications.inspect(directMessage("fresh-recovery"), visibility);
    let calls = 0;
    const fresh = freshClient(async () => visibleChannel, async () => { if (++calls === 1) throw { status: 503 }; return memberWithRoles([]); });
    const sent: string[] = [];
    const authorization = { authorize: (input: Parameters<typeof authorizeQueuedNotification>[2]) => authorizeQueuedNotification(fresh.client, state.accounts, input) };
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 50, authorization);
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='fresh-recovery'").get()?.status).toBe("pending");
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_500, 50, authorization);
    expect(sent).toHaveLength(1);
    expect(fresh.memberRequests).toEqual([{ user: "sub", force: true }, { user: "sub", force: true }]);
  });

  it("retries a fresh channel 5xx, then records failed at the finite limit", async () => {
    const state = await setup();
    await state.notifications.inspect({ ...directMessage("fresh-channel-failed"), mentionedUserIds: [], mentionEveryone: true }, visibility);
    const fresh = freshClient(async () => { throw { status: 503 }; }, async () => memberWithRoles([]));
    for (const now of [61_000, 61_500, 62_500]) await state.notifications.drain({ send: async () => { throw new Error("must not send"); } }, now, 50, { authorize: (input) => authorizeQueuedNotification(fresh.client, state.accounts, input) });
    expect(state.db.raw.prepare("SELECT status, last_error FROM notification_queue WHERE message_id='fresh-channel-failed'").get()).toMatchObject({ status: "failed", last_error: "temporary discord api failure" });
    expect(fresh.channelRequests).toHaveLength(3);
    expect(fresh.memberRequests).toHaveLength(0);
  });

  it("fresh-checks membership for delayed everyone notifications", async () => {
    const state = await setup();
    await state.notifications.inspect({ ...directMessage("everyone-left"), mentionedUserIds: [], mentionEveryone: true }, visibility);
    const fresh = freshClient(async () => visibleChannel, async () => { throw { status: 404, code: 10007 }; });
    await state.notifications.drain({ send: async () => { throw new Error("must not send"); } }, 61_000, 50, { authorize: (input) => authorizeQueuedNotification(fresh.client, state.accounts, input) });
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='everyone-left'").get()?.status).toBe("cancelled");
    expect(fresh.memberRequests).toEqual([{ user: "sub", force: true }]);
  });
});

describe("role candidates survive temporary Discord failures", () => {
  it("retains role IDs when the member lookup returns 5xx and cancels a nonmember of that role", async () => {
    const state = await setup();
    const row = await queuedRole(state, "member-5xx", { isMember: async () => { throw { status: 503 }; }, getMemberRoleIds: async () => ["role-a"] });
    expect(row).toMatchObject({ mention_type: "role", target_role_ids: '["role-a"]', target_kinds: '["role"]', available_at: 1_000 });
    const sent: string[] = [];
    const client = clientFor(async () => memberWithRoles([]));
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 50, { authorize: (input) => authorizeQueuedNotification(client, state.accounts, input) });
    expect(sent).toHaveLength(0);
    expect((state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='member-5xx'").get() as { status: string }).status).toBe("cancelled");
  });

  it("retains role IDs when role retrieval returns 5xx and sends after recovery", async () => {
    const state = await setup();
    const row = await queuedRole(state, "role-5xx", { isMember: async () => true, getMemberRoleIds: async () => { throw { status: 503 }; } });
    expect(row).toMatchObject({ mention_type: "role", target_role_ids: '["role-a"]', target_kinds: '["role"]' });
    const sent: string[] = [];
    const client = clientFor(async () => memberWithRoles(["role-a"]));
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 50, { authorize: (input) => authorizeQueuedNotification(client, state.accounts, input) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("ロールメンション");
  });

  it("retries a role candidate until recovery, then sends once", async () => {
    const state = await setup();
    await queuedRole(state, "retry-recovery", { isMember: async () => { throw { status: 503 }; }, getMemberRoleIds: async () => [] });
    let calls = 0;
    const client = clientFor(async () => { calls++; if (calls === 1) throw { status: 503 }; return memberWithRoles(["role-a"]); });
    const sent: string[] = [];
    const sender = { send: async (_id: string, content: string) => { sent.push(content); } };
    const authorization = { authorize: (input: Parameters<typeof authorizeQueuedNotification>[2]) => authorizeQueuedNotification(client, state.accounts, input) };
    await state.notifications.drain(sender, 1_000, 50, authorization);
    const due = Number(state.db.raw.prepare("SELECT available_at FROM notification_queue WHERE message_id='retry-recovery'").get()?.available_at);
    await state.notifications.drain(sender, due, 50, authorization);
    await state.notifications.drain(sender, due + 1_000, 50, authorization);
    expect(sent).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("records failed after the role authorization retry limit", async () => {
    const state = await setup();
    await queuedRole(state, "retry-exhausted", { isMember: async () => { throw { status: 503 }; }, getMemberRoleIds: async () => [] });
    const client = clientFor(async () => { throw { status: 503 }; });
    const sent: string[] = [];
    for (const now of [1_000, 1_500, 2_500]) await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, now, 50, { authorize: (input) => authorizeQueuedNotification(client, state.accounts, input) });
    expect(sent).toHaveLength(0);
    expect(state.db.raw.prepare("SELECT status, last_error FROM notification_queue WHERE message_id='retry-exhausted'").get()).toMatchObject({ status: "failed", last_error: "temporary discord api failure" });
  });

  it("preserves role priority for role plus everyone and direct priority for direct plus role", async () => {
    const state = await setup();
    const visibility = { isMember: async () => true, getMemberRoleIds: async () => ["role-a"], canViewChannel: async () => true };
    await state.notifications.inspect(roleMessage("role-everyone", true), visibility);
    for (const [id, everyone] of [["direct-role", false], ["direct-role-everyone", true]] as const) {
      await state.notifications.inspect({ ...roleMessage(id, everyone), mentionedUserIds: ["sub"] }, visibility);
    }
    const rows = state.db.raw.prepare("SELECT message_id, mention_type, available_at FROM notification_queue ORDER BY id").all() as Array<{ message_id: string; mention_type: string; available_at: number }>;
    expect(rows.map(({ mention_type, available_at }) => [mention_type, available_at])).toEqual([["role", 1_000], ["direct", 1_000], ["direct", 1_000]]);
  });

  it("delays an everyone fallback after an uncertain role match, without sending a false role DM", async () => {
    const state = await setup();
    await state.notifications.inspect(roleMessage("mixed-unknown", true), { isMember: async () => { throw { status: 503 }; }, getMemberRoleIds: async () => [], canViewChannel: async () => true });
    expect(state.db.raw.prepare("SELECT mention_type, target_role_ids, target_kinds FROM notification_queue WHERE message_id='mixed-unknown'").get()).toMatchObject({ mention_type: "role", target_role_ids: '["role-a"]', target_kinds: '["role_or_everyone"]' });
    const sent: string[] = [];
    const sender = { send: async (_id: string, content: string) => { sent.push(content); } };
    const client = clientFor(async () => memberWithRoles([]));
    const authorization = { authorize: (input: Parameters<typeof authorizeQueuedNotification>[2]) => authorizeQueuedNotification(client, state.accounts, input) };
    await state.notifications.drain(sender, 1_000, 50, authorization);
    expect(sent).toHaveLength(0);
    expect(state.db.raw.prepare("SELECT status, available_at FROM notification_queue WHERE message_id='mixed-unknown'").get()).toMatchObject({ status: "pending", available_at: 61_000 });
    await state.notifications.drain(sender, 61_000, 50, authorization);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("全体メンション");
  });
});

describe("worker and shutdown", () => {
  it("uses one bounded nonce across retries and a different nonce for another queue row", async () => {
    const state = await setup();
    const visibility = { isMember: async () => true, canViewChannel: async () => true };
    for (const id of ["nonce-one", "nonce-two"]) await state.notifications.inspect({ id, guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["sub"], mentionEveryone: false }, visibility);
    const nonces: string[] = [];
    const sender = { send: async (_id: string, _content: string, nonce: string) => { nonces.push(nonce); if (nonces.length === 1) throw { name: "AbortError" }; } };
    await state.notifications.drain(sender, 1_000);
    await state.notifications.drain(sender, 2_000);
    expect(nonces).toHaveLength(3);
    expect(nonces[0]).toBe(nonces[1]);
    expect(nonces[2]).not.toBe(nonces[0]);
    expect(nonces.every((nonce) => nonce.length <= 25)).toBe(true);
  });

  it("isolates a rejected nonce to its failed row and continues processing", async () => {
    const state = await setup();
    const visibility = { isMember: async () => true, canViewChannel: async () => true };
    for (const id of ["bad-nonce", "good-nonce"]) await state.notifications.inspect({ id, guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["sub"], mentionEveryone: false }, visibility);
    let rejectedNonce: string | undefined;
    const result = await state.notifications.drain({ send: async (_id, _content, nonce) => {
      rejectedNonce ??= nonce;
      if (nonce === rejectedNonce) throw Object.assign(new Error("invalid nonce"), { status: 400 });
    } }, 1_000);
    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='bad-nonce'").get()?.status).toBe("failed");
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='good-nonce'").get()?.status).toBe("sent");
  });

  it("skips overlapping ticks and accepts the next tick after completion", async () => {
    const flight = new SingleFlight();
    let release!: () => void;
    let runs = 0;
    const first = flight.run(async () => { runs++; await new Promise<void>((resolve) => { release = resolve; }); return 1; });
    await Promise.resolve();
    expect(await flight.run(async () => { runs++; return 2; })).toBeUndefined();
    release();
    expect(await first).toBe(1);
    expect(await flight.run(async () => { runs++; return 3; })).toBe(3);
    expect(runs).toBe(2);
  });

  it("releases the lock after an exception and waits for a running job on stop", async () => {
    const flight = new SingleFlight();
    await expect(flight.run(async () => { throw new Error("worker failed"); })).rejects.toThrow("worker failed");
    let release!: () => void;
    const running = flight.run(async () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const stopping = flight.stop(1_000);
    expect(await flight.run(async () => 1)).toBeUndefined();
    release();
    await running;
    expect(await stopping).toBe(true);
  });

  it("uses a finite shutdown deadline for a stuck drain", async () => {
    const flight = new SingleFlight();
    let release!: () => void;
    const running = flight.run(async () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    expect(await flight.stop(1)).toBe(false);
    release();
    await running;
  });

  it("keeps the per-main DM interval across successive drains", async () => {
    const state = await setup();
    const visibility = { isMember: async () => true, canViewChannel: async () => true };
    for (const id of ["first", "second"]) await state.notifications.inspect({ id, guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["sub"], mentionEveryone: false }, visibility);
    const sent: string[] = [];
    const sender = { send: async (_id: string, content: string) => { sent.push(content); } };
    await state.notifications.drain(sender, 1_000);
    await state.notifications.drain(sender, 1_500);
    expect(sent).toHaveLength(1);
    await state.notifications.drain(sender, 2_000);
    expect(sent).toHaveLength(2);
  });

  it("starts the per-main interval when a slow DM actually finishes", async () => {
    let clock = 1_000;
    const state = await setup(() => clock);
    const visibility = { isMember: async () => true, canViewChannel: async () => true };
    for (const id of ["slow-first", "slow-second"]) await state.notifications.inspect({ id, guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["sub"], mentionEveryone: false }, visibility);
    let sent = 0;
    const sender = { send: async () => { sent++; if (sent === 1) clock = 5_000; } };
    await state.notifications.drain(sender, 1_000);
    expect(sent).toBe(1);
    clock = 5_500;
    await state.notifications.drain(sender, 5_500);
    expect(sent).toBe(1);
    clock = 6_000;
    await state.notifications.drain(sender, 6_000);
    expect(sent).toBe(2);
  });
});

describe("watch off and bounded memory", () => {
  it.each([{ status: 503 }, { name: "TimeoutError" }])("saves watch off without calling a failing member API: %j", async (error) => {
    const state = await setup();
    let calls = 0;
    await state.watches.set("guild", "sub", false, { isMember: async () => { calls++; throw error; } });
    expect(calls).toBe(0);
    expect(state.watches.status("guild", "sub")).toBe("off");
  });

  it("cancels a queued notification after watch off and rejects watch on without membership", async () => {
    const state = await setup();
    await state.notifications.inspect({ id: "queued", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["sub"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    await state.watches.set("guild", "sub", false, { isMember: async () => { throw { status: 503 }; } });
    const sent: string[] = [];
    await state.notifications.drain({ send: async (_id, content) => { sent.push(content); } }, 1_000, 50, { authorize: (input) => authorizeQueuedNotification(clientFor(async () => memberWithRoles([])), state.accounts, input) });
    expect(sent).toHaveLength(0);
    expect(state.db.raw.prepare("SELECT status FROM notification_queue WHERE message_id='queued'").get()?.status).toBe("cancelled");
    await expect(state.watches.set("guild", "sub", true, memberAccessForWatch(async () => { throw { status: 404, code: 10007 }; }))).rejects.toThrow("メンバー");
    await expect(state.watches.set("guild", "sub", true, memberAccessForWatch(async () => { throw { status: 503 }; }))).rejects.toThrow("確認できません");
  });

  it("expires and replaces approvals and stays within a fixed maximum", () => {
    const store = new ApprovalStore();
    const old = store.issue("same", "old", 1_000);
    const fresh = store.issue("same", "new", 1_001);
    expect(store.size).toBe(1);
    expect(() => store.consume(old, "same", 1_002)).toThrow();
    expect(store.consume(fresh, "same", 1_002)).toBe("new");
    store.issue("expired", "x", 1_000);
    store.cleanup(301_000);
    expect(store.size).toBe(0);
    for (let i = 0; i < 1_100; i++) store.issue(`user-${i}`, "x", 400_000);
    expect(store.size).toBe(1_000);
    store.cleanup(700_000);
    expect(store.size).toBe(0);
    expect(store.consume(store.issue("reused", "ok", 700_001), "reused", 700_002)).toBe("ok");
  });

  it("bounds failed attempt users and member cache entries", async () => {
    const state = await setup();
    for (let i = 0; i < 1_100; i++) expect(() => state.accounts.previewLinkCode(`unknown-${i}`, "invalid", 1_000)).toThrow();
    expect(state.accounts.failedAttemptUsers).toBe(1_000);
    state.accounts.cleanupFailedAttempts(61_000);
    expect(state.accounts.failedAttemptUsers).toBe(0);
    const cache = new MemberCache<string>(5_000, () => 1_000, 2);
    for (const id of ["a", "b", "c"]) await cache.get(id, async () => id);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("failure age and error display", () => {
  it("counts the actual failure time, including an older queued notification", async () => {
    let now = 1_000;
    const state = await setup(() => now);
    await state.notifications.inspect({ id: "old", guildId: "guild", channelId: "channel", authorBot: false, mentionedUserIds: ["sub"], mentionEveryone: false }, { isMember: async () => true, canViewChannel: async () => true });
    now = 20 * 60_000;
    await state.notifications.drain({ send: async () => { throw new Error("DM denied"); } }, now);
    const requests: string[] = [];
    const health = new HealthcheckService(state.db, new Logger("error"), "https://healthchecks.example/test", 200, 1, async (url) => { requests.push(url); return true; }, () => now);
    expect((await health.check(true)).snapshot.failedIn15m).toBe(1);
    expect(requests).toEqual(["https://healthchecks.example/test/fail"]);
  });

  it("does not show unexpected internal errors to Discord users", () => {
    expect(userMessageForError(new Error("database file path and SQL internals"))).toBe("内部エラーが発生しました。時間をおいて再度お試しください。");
    expect(userMessageForError(new UserFacingError("連携コードが無効です"))).toBe("連携コードが無効です");
  });
});
