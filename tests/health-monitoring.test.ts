import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "../src/db.js";
import { Logger } from "../src/logger.js";
import { HealthcheckService } from "../src/services/healthcheck.js";
import { loadConfig } from "../src/config.js";

const resources: Array<{ db: SqliteDatabase; directory: string }> = [];
const NOW = 200_000_000;

async function fixture(options: { offsite?: boolean; maxPending?: number; maxFailures?: number } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-health-monitor-"));
  const db = await SqliteDatabase.open(path.join(directory, "test.sqlite"));
  resources.push({ db, directory });
  db.raw.prepare("INSERT INTO main_accounts(user_id,username,created_at) VALUES ('main','Main',0)").run();
  const requests: string[] = [];
  const statusPath = path.join(directory, "offsite-status.json");
  const privacyPath = path.join(directory, "privacy-state.json");
  fs.writeFileSync(privacyPath, JSON.stringify({ generation: 0, lastDeletionAt: 0, cleanupPending: false, databaseDeleted: false }));
  const service = new HealthcheckService(db, new Logger("error"), "https://healthchecks.example/private", options.maxPending ?? 200, options.maxFailures ?? 5,
    async (url) => { requests.push(url); return true; }, () => NOW,
    { maxQueueAgeMs: 300_000, maxOffsiteBackupAgeMs: 129_600_000, ...(options.offsite ? { offsiteStatusPath: statusPath, privacyDeletionStatePath: privacyPath } : {}) });
  const queue = (status: "pending" | "processing", availableAt: number) => db.raw.prepare("INSERT INTO notification_queue(main_user_id,message_id,guild_id,kind,target_user_ids,target_labels,status,available_at,created_at) VALUES ('main',?,'guild','direct','[]','[]',?,?,0)").run(`${status}-${availableAt}`, status, availableAt);
  const offsite = (state: "ok" | "failed", lastSuccessAt: number | null, lastAttemptAt = NOW, privacyGeneration = 0) => fs.writeFileSync(statusPath, JSON.stringify({ state, lastAttemptAt, lastSuccessAt, privacyGeneration, ...(state === "failed" ? { failureCode: "transfer_failed" } : {}) }));
  return { db, service, requests, statusPath, privacyPath, queue, offsite };
}

afterEach(() => {
  for (const { db, directory } of resources.splice(0)) { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

describe("due queue age monitoring", () => {
  it("keeps a pending item due 10 seconds ago healthy", async () => {
    const state = await fixture(); state.queue("pending", NOW - 10_000);
    expect(await state.service.check(true)).toMatchObject({ healthy: true, snapshot: { pending: 1, oldestDueAgeMs: 10_000 } });
    expect(state.requests).toEqual(["https://healthchecks.example/private"]);
  });

  it.each(["pending", "processing"] as const)("fails a %s item overdue by six minutes", async (status) => {
    const state = await fixture(); state.queue(status, NOW - 360_000);
    expect(await state.service.check(true)).toMatchObject({ healthy: false, reason: "queue_age_exceeded", snapshot: { oldestDueAgeMs: 360_000 } });
    expect(state.requests).toEqual(["https://healthchecks.example/private/fail"]);
  });

  it("does not fail an intentional future everyone delay", async () => {
    const state = await fixture(); state.queue("pending", NOW + 60_000);
    state.db.raw.prepare("UPDATE notification_queue SET mention_type='everyone' WHERE status='pending'").run();
    expect(await state.service.check(true)).toMatchObject({ healthy: true, snapshot: { pending: 1, oldestDueAgeMs: 0 } });
  });

  it("does not fail a retry scheduled for the future", async () => {
    const state = await fixture(); state.queue("pending", NOW + 300_000);
    state.db.raw.prepare("UPDATE notification_queue SET attempts=1 WHERE status='pending'").run();
    expect(await state.service.check(true)).toMatchObject({ healthy: true, snapshot: { oldestDueAgeMs: 0 } });
  });

  it("treats an empty queue as healthy", async () => {
    const state = await fixture();
    expect(await state.service.check(true)).toMatchObject({ healthy: true, snapshot: { pending: 0, oldestDueAgeMs: 0 } });
  });

  it("retains pending-count and recent-failure thresholds", async () => {
    const pending = await fixture({ maxPending: 1 }); pending.queue("pending", NOW + 60_000);
    expect(await pending.service.check(true)).toMatchObject({ healthy: false, reason: "queue_or_failure_threshold" });
    const failed = await fixture({ maxFailures: 1 }); failed.queue("pending", NOW + 60_000);
    failed.db.raw.prepare("UPDATE notification_queue SET status='failed', available_at=?").run(NOW);
    expect(await failed.service.check(true)).toMatchObject({ healthy: false, reason: "queue_or_failure_threshold", snapshot: { failedIn15m: 1 } });
  });
});

describe("Windows offsite backup status monitoring", () => {
  it("uses the root-managed production status path by default", () => {
    const config = loadConfig({ DISCORD_TOKEN: "fixture", DISCORD_CLIENT_ID: "fixture" });
    expect(config.HEALTHCHECKS_OFFSITE_STATUS_PATH).toBe("/var/lib/altnoti-monitoring/offsite-backup-status.json");
    expect(config.PRIVACY_DELETION_STATE_PATH).toBe("/var/lib/altnoti-monitoring/privacy-deletion-state.json");
    expect(config.HEALTHCHECKS_MAX_OFFSITE_BACKUP_AGE_MS).toBe(129_600_000);
    expect(config.HEALTHCHECKS_MAX_INSPECTION_FAILURES_15M).toBe(1);
  });

  it("accepts a fresh successful backup", async () => {
    const state = await fixture({ offsite: true }); state.offsite("ok", NOW - 3_600_000);
    expect(await state.service.check(true)).toMatchObject({ healthy: true, snapshot: { offsiteBackupState: "ok", offsiteBackupAgeMs: 3_600_000 } });
  });

  it("fails an explicit failure even when the previous success is fresh", async () => {
    const state = await fixture({ offsite: true }); state.offsite("failed", NOW - 60_000);
    expect(await state.service.check(true)).toMatchObject({ healthy: false, reason: "offsite_backup_failed" });
    expect(state.requests).toEqual(["https://healthchecks.example/private/fail"]);
  });

  it("fails when the last successful backup is at least 36 hours old", async () => {
    const state = await fixture({ offsite: true }); state.offsite("ok", NOW - 129_600_000, NOW - 129_600_000);
    expect(await state.service.check(true)).toMatchObject({ healthy: false, reason: "offsite_backup_stale", snapshot: { offsiteBackupAgeMs: 129_600_000 } });
  });

  it("fails closed for missing and malformed status", async () => {
    const state = await fixture({ offsite: true });
    expect(await state.service.check(true)).toMatchObject({ healthy: false, reason: "offsite_backup_missing" });
    fs.writeFileSync(state.statusPath, "not json");
    expect(await state.service.check(true)).toMatchObject({ healthy: false, reason: "offsite_backup_invalid" });
  });

  it("rejects a future success timestamp", async () => {
    const state = await fixture({ offsite: true }); state.offsite("ok", NOW + 1);
    expect(await state.service.check(true)).toMatchObject({ healthy: false, reason: "offsite_backup_future" });
  });

  it("recovers on the next valid success after a failure", async () => {
    const state = await fixture({ offsite: true }); state.offsite("failed", NOW - 60_000);
    expect((await state.service.check(true)).healthy).toBe(false);
    state.offsite("ok", NOW);
    expect(await state.service.check(true)).toMatchObject({ healthy: true, reason: "ok", snapshot: { offsiteBackupState: "ok", offsiteBackupAgeMs: 0 } });
  });

  it("fails heartbeat while privacy deletion is pending or Windows has not caught up to the generation", async () => {
    const state = await fixture({ offsite: true }); state.offsite("ok", NOW, NOW, 0);
    fs.writeFileSync(state.privacyPath, JSON.stringify({ generation: 1, lastDeletionAt: 1, cleanupPending: true, databaseDeleted: false }));
    expect(await state.service.check(true)).toMatchObject({ healthy: false, reason: "privacy_deletion_pending" });
    fs.writeFileSync(state.privacyPath, JSON.stringify({ generation: 1, lastDeletionAt: 1, cleanupPending: false, databaseDeleted: false }));
    expect(await state.service.check(true)).toMatchObject({ healthy: false, reason: "offsite_backup_privacy_stale" });
    expect(state.requests).toEqual(["https://healthchecks.example/private/fail", "https://healthchecks.example/private/fail"]);
  });
});
