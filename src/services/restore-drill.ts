import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "../db.js";
import { Logger } from "../logger.js";
import { AccountService } from "./accounts.js";
import { WatchService } from "./watches.js";
import { NotificationService } from "./notifications.js";
import { HealthcheckService } from "./healthcheck.js";

export interface RestoreDrillResult {
  source: string;
  sha256Match: boolean;
  integrity: "ok";
  requiredTables: "ok";
  databaseOpen: "ok";
  servicesInitialized: "ok";
  counts: { mains: number; links: number; queuePending: number; queueProcessing: number; queueFailed: number };
  elapsedMs: number;
}

export async function runRestoreDrill(sourcePath: string, source: string): Promise<RestoreDrillResult> {
  if (!fs.statSync(sourcePath).isFile()) throw new Error("backup source is not a regular file");
  const started = performance.now();
  const sourceHash = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnotify-restore-drill-"));
  const isolatedPath = path.join(directory, "restore.sqlite");
  let db: SqliteDatabase | undefined;
  try {
    fs.copyFileSync(sourcePath, isolatedPath, fs.constants.COPYFILE_EXCL);
    const copiedHash = createHash("sha256").update(fs.readFileSync(isolatedPath)).digest("hex");
    if (sourceHash !== copiedHash) throw new Error("isolated backup copy hash mismatch");

    // Use the same fail-closed validation and additive migrations as production,
    // but only against the isolated copy. Never point this at the live DB.
    db = await SqliteDatabase.open(isolatedPath, { requireExisting: true });
    const integrity = db.raw.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== "ok") throw new Error("isolated database integrity check failed");
    const tables = new Set(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
    for (const table of ["main_accounts", "account_links", "notification_queue"]) if (!tables.has(table)) throw new Error("required database table missing");

    const accounts = new AccountService(db);
    const watches = new WatchService(db, accounts);
    const notifications = new NotificationService(db, accounts, new Logger("error"));
    const healthchecks = new HealthcheckService(db, new Logger("error"), undefined, 200, 5);
    if (!watches || !notifications || !healthchecks) throw new Error("application services failed to initialize");

    const count = (sql: string) => Number((db!.raw.prepare(sql).get() as { count: number }).count);
    return {
      source,
      sha256Match: true,
      integrity: "ok",
      requiredTables: "ok",
      databaseOpen: "ok",
      servicesInitialized: "ok",
      counts: {
        mains: count("SELECT COUNT(*) AS count FROM main_accounts"),
        links: count("SELECT COUNT(*) AS count FROM account_links"),
        queuePending: count("SELECT COUNT(*) AS count FROM notification_queue WHERE status='pending'"),
        queueProcessing: count("SELECT COUNT(*) AS count FROM notification_queue WHERE status='processing'"),
        queueFailed: count("SELECT COUNT(*) AS count FROM notification_queue WHERE status='failed'")
      },
      elapsedMs: Math.max(0, Math.round(performance.now() - started))
    };
  } finally {
    try { db?.close(); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}
