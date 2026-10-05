import { createHash } from "node:crypto";
import { SqliteDatabase } from "../db.js";
import { Logger } from "../logger.js";
import { AccountService } from "./accounts.js";
import { WatchService } from "./watches.js";
import { NotificationService } from "./notifications.js";
import { HealthcheckService } from "./healthcheck.js";

export interface RestoreMetadata {
  formatVersion: number;
  createdAt: number;
  privacyGeneration: number;
  sha256: string;
}

export interface PrivacyDeletionState {
  generation: number;
  lastDeletionAt: number;
  cleanupPending: boolean;
  databaseDeleted: boolean;
}

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

function validateRestoreMetadata(metadata: RestoreMetadata, state: PrivacyDeletionState, bytes: Uint8Array): void {
  if (!state || !Number.isSafeInteger(state.generation) || state.generation < 0
    || !Number.isSafeInteger(state.lastDeletionAt) || state.lastDeletionAt < 0
    || typeof state.cleanupPending !== "boolean" || state.cleanupPending || typeof state.databaseDeleted !== "boolean" || state.databaseDeleted) throw new Error("privacy deletion state unavailable");
  if (!metadata || metadata.formatVersion !== 1 || !Number.isSafeInteger(metadata.createdAt) || metadata.createdAt <= 0
    || !Number.isSafeInteger(metadata.privacyGeneration) || metadata.privacyGeneration < 0
    || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new Error("backup metadata invalid");
  if (metadata.privacyGeneration !== state.generation || metadata.createdAt < state.lastDeletionAt) throw new Error("backup predates privacy deletion state");
  if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw new Error("backup hash mismatch");
}

export async function runRestoreDrillFromBuffer(bytes: Uint8Array, source: string, metadata: RestoreMetadata, state: PrivacyDeletionState): Promise<RestoreDrillResult> {
  const started = performance.now();
  validateRestoreMetadata(metadata, state, bytes);
  // Decrypted Windows bytes stay in memory: openBuffer uses the same
  // production integrity/schema gate and additive migrations without a temp DB.
  const db = await SqliteDatabase.openBuffer(bytes);
  try {
    const integrity = db.raw.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== "ok") throw new Error("database integrity check failed");
    const tables = new Set(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
    for (const table of ["main_accounts", "account_links", "notification_queue"]) if (!tables.has(table)) throw new Error("required database table missing");

    const accounts = new AccountService(db);
    const watches = new WatchService(db, accounts);
    const notifications = new NotificationService(db, accounts, new Logger("error"));
    const healthchecks = new HealthcheckService(db, new Logger("error"), undefined, 200, 5);
    if (!watches || !notifications || !healthchecks) throw new Error("application services failed to initialize");
    const count = (sql: string) => Number((db.raw.prepare(sql).get() as { count: number }).count);
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
  } finally { db.close(); }
}
