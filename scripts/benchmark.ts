import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { SqliteDatabase } from "../src/db.js";
import { AccountService } from "../src/services/accounts.js";
import { NotificationService } from "../src/services/notifications.js";
import { Logger } from "../src/logger.js";

type Workload = "ordinary" | "direct" | "role" | "everyone";

interface Options {
  workload: Workload;
  messages: number;
  links: number;
  drain: boolean;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(): Options {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (key?.startsWith("--") && value !== undefined) args.set(key.slice(2), value);
  }
  const workload = args.get("workload") as Workload | undefined;
  if (workload && !["ordinary", "direct", "role", "everyone"].includes(workload)) throw new Error(`unsupported workload: ${workload}`);
  return { workload: workload ?? "ordinary", messages: parseNumber(args.get("messages"), 100_000), links: parseNumber(args.get("links"), 5_000), drain: args.get("drain") === "true" };
}

async function createState(linkCount: number): Promise<{ db: SqliteDatabase; notifications: NotificationService; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-benchmark-"));
  const db = await SqliteDatabase.open(path.join(dir, "benchmark.sqlite"));
  const accounts = new AccountService(db, undefined, "benchmark-pepper", 5);
  await accounts.registerMain("main", "benchmark", async () => undefined, 1_000);
  db.raw.transaction(() => {
    const insert = db.raw.prepare("INSERT INTO account_links(sub_user_id, main_user_id, username, created_at) VALUES (?, ?, ?, ?)");
    for (let index = 0; index < linkCount; index += 1) insert.run(`sub-${index}`, "main", `sub-${index}`, 1_001 + index);
  })();
  const notifications = new NotificationService(db, accounts, new Logger("error"), () => Date.now(), { maxPendingPerMain: 200, minIntervalMs: 0 });
  return { db, notifications, dir };
}

function messageFor(workload: Workload, index: number) {
  return {
    id: `${workload}-${index}`,
    guildId: "guild",
    channelId: "channel",
    authorBot: false,
    mentionedUserIds: workload === "direct" ? ["sub-0"] : [],
    mentionedRoleIds: workload === "role" ? ["role-1"] : [],
    mentionEveryone: workload === "everyone"
  };
}

async function run(options: Options) {
  const state = await createState(options.links);
  const visibility = {
    isMember: async () => true,
    getMemberRoleIds: async () => ["role-1"],
    canViewChannel: async () => true
  };
  const started = process.hrtime.bigint();
  const cpuStarted = process.cpuUsage();
  let peakRss = process.memoryUsage().rss;
  for (let index = 0; index < options.messages; index += 1) {
    await state.notifications.inspect(messageFor(options.workload, index), visibility);
    if ((index + 1) % 1_000 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  const drainResult = options.drain
    ? await state.notifications.drain({ send: async () => undefined }, Date.now(), options.messages)
    : undefined;
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const cpu = process.cpuUsage(cpuStarted);
  const databasePath = path.join(state.dir, "benchmark.sqlite");
  const result = {
    workload: options.workload,
    messages: options.messages,
    links: options.links,
    elapsedMs: Math.round(elapsedMs),
    messagesPerSecond: Math.round(options.messages / (elapsedMs / 1_000)),
    cpuMs: Math.round((cpu.user + cpu.system) / 1_000),
    peakRssMb: Math.round(peakRss / 1024 / 1024),
    databaseBytes: fs.statSync(databasePath).size,
    ...(drainResult ? { drain: drainResult } : {}),
    queue: state.db.raw.prepare("SELECT status, COUNT(*) AS count FROM notification_queue GROUP BY status ORDER BY status").all()
  };
  state.db.close();
  fs.rmSync(state.dir, { recursive: true, force: true });
  console.log(JSON.stringify(result));
}

await run(parseArgs());
