import type { SqliteDatabase } from "../db.js";
import type { Logger } from "../logger.js";
import { lstatSync, readFileSync } from "node:fs";

export interface HealthSnapshot { pending: number; failedIn15m: number; oldestDueAgeMs: number; offsiteBackupState: "disabled" | "ok" | "failed" | "missing" | "invalid"; offsiteBackupAgeMs: number | null; }
export interface HealthcheckResult { enabled: boolean; healthy: boolean; requestSent: boolean; reason: string; snapshot: HealthSnapshot; }
type HealthcheckRequest = (url: string) => Promise<boolean>;
interface HealthcheckThresholds { maxQueueAgeMs?: number; maxOffsiteBackupAgeMs?: number; offsiteStatusPath?: string | undefined; }

export class HealthcheckService {
  public constructor(
    private readonly db: SqliteDatabase,
    private readonly logger: Logger,
    private readonly heartbeatUrl: string | undefined,
    private readonly maxPending: number,
    private readonly maxFailuresIn15m: number,
    private readonly request: HealthcheckRequest = async (url) => {
      // Match the configuration probe: only the configured endpoint's own 2xx
      // may count as a heartbeat; redirects must not leave that trust boundary.
      const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000) });
      return response.ok;
    },
    private readonly now = () => Date.now(),
    private readonly thresholds: HealthcheckThresholds = {}
  ) {}

  public async check(gatewayReady: boolean): Promise<HealthcheckResult> {
    const snapshot = this.snapshot();
    if (!this.heartbeatUrl) return { enabled: false, healthy: true, requestSent: false, reason: "disabled", snapshot };
    // A missing success ping is intentional while Gateway is down. The external
    // monitor then expires naturally, without pretending that the VM is healthy.
    if (!gatewayReady) return { enabled: true, healthy: false, requestSent: false, reason: "gateway_not_ready", snapshot };
    const reason = this.unhealthyReason(snapshot);
    const healthy = reason === undefined;
    const target = healthy ? this.heartbeatUrl : this.withSuffix(this.heartbeatUrl, "/fail");
    try {
      const accepted = await this.request(target);
      if (!accepted) throw new Error("healthcheck endpoint rejected request");
      if (!healthy) this.logger.warn("healthcheck unhealthy", { reason, pending: snapshot.pending, failedIn15m: snapshot.failedIn15m, oldestDueAgeMs: snapshot.oldestDueAgeMs, offsiteBackupState: snapshot.offsiteBackupState, offsiteBackupAgeMs: snapshot.offsiteBackupAgeMs });
      return { enabled: true, healthy, requestSent: true, reason: reason ?? "ok", snapshot };
    } catch {
      // The heartbeat URL contains a secret path. Never include it or the
      // transport error in logs; the external service remains the source of truth.
      this.logger.warn("healthcheck request failed", { reason: reason ?? "ok", pending: snapshot.pending, failedIn15m: snapshot.failedIn15m, oldestDueAgeMs: snapshot.oldestDueAgeMs, offsiteBackupState: snapshot.offsiteBackupState, offsiteBackupAgeMs: snapshot.offsiteBackupAgeMs });
      return { enabled: true, healthy: false, requestSent: true, reason: "healthcheck_request_failed", snapshot };
    }
  }

  private snapshot(): HealthSnapshot {
    const now = this.now();
    const failedSince = now - 15 * 60 * 1_000;
    const pending = Number((this.db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE status IN ('pending','processing')").get() as { count: number }).count);
    // available_at is the first instant the worker may deliver. Future
    // everyone/retry work must not masquerade as an overdue notification.
    const due = this.db.raw.prepare("SELECT MIN(available_at) AS oldest FROM notification_queue WHERE status IN ('pending','processing') AND available_at<=?").get(now) as { oldest: number | null };
    const oldestDueAgeMs = due.oldest === null ? 0 : now - due.oldest;
    // A failed row is no longer due for delivery. Its available_at stores the
    // transition time, giving us a failure window without a schema migration.
    const failedIn15m = Number((this.db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE status='failed' AND available_at>=?").get(failedSince) as { count: number }).count);
    const offsite = this.offsiteSnapshot(now);
    return { pending, failedIn15m, oldestDueAgeMs, ...offsite };
  }

  private offsiteSnapshot(now: number): Pick<HealthSnapshot, "offsiteBackupState" | "offsiteBackupAgeMs"> {
    const path = this.thresholds.offsiteStatusPath;
    if (!path) return { offsiteBackupState: "disabled", offsiteBackupAgeMs: null };
    try {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) return { offsiteBackupState: "invalid", offsiteBackupAgeMs: null };
      const data: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof data !== "object" || data === null) throw new Error("invalid status");
      const status = data as Record<string, unknown>;
      if ((status.state !== "ok" && status.state !== "failed") || !Number.isSafeInteger(status.lastAttemptAt) || Number(status.lastAttemptAt) < 0 || (status.lastSuccessAt !== null && (!Number.isSafeInteger(status.lastSuccessAt) || Number(status.lastSuccessAt) < 0))) throw new Error("invalid status");
      if (status.state === "ok" && status.lastSuccessAt === null) throw new Error("invalid status");
      return { offsiteBackupState: status.state, offsiteBackupAgeMs: status.lastSuccessAt === null ? null : now - Number(status.lastSuccessAt) };
    } catch (error) {
      return { offsiteBackupState: error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "invalid", offsiteBackupAgeMs: null };
    }
  }

  private unhealthyReason(snapshot: HealthSnapshot): string | undefined {
    if (snapshot.pending >= this.maxPending || snapshot.failedIn15m >= this.maxFailuresIn15m) return "queue_or_failure_threshold";
    if (snapshot.oldestDueAgeMs >= (this.thresholds.maxQueueAgeMs ?? 300_000)) return "queue_age_exceeded";
    if (snapshot.offsiteBackupState === "missing") return "offsite_backup_missing";
    if (snapshot.offsiteBackupState === "invalid") return "offsite_backup_invalid";
    if (snapshot.offsiteBackupState === "failed") return "offsite_backup_failed";
    if (snapshot.offsiteBackupState === "ok") {
      if (snapshot.offsiteBackupAgeMs === null || snapshot.offsiteBackupAgeMs < 0) return "offsite_backup_future";
      if (snapshot.offsiteBackupAgeMs >= (this.thresholds.maxOffsiteBackupAgeMs ?? 129_600_000)) return "offsite_backup_stale";
    }
    return undefined;
  }

  private withSuffix(url: string, suffix: string): string {
    const target = new URL(url);
    if (!target.pathname.endsWith(suffix)) target.pathname = `${target.pathname.replace(/\/$/, "")}${suffix}`;
    return target.toString();
  }
}
