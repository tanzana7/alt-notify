import type { SqliteDatabase } from "../db.js";
import type { Logger } from "../logger.js";

export interface HealthSnapshot { pending: number; failedIn15m: number; }
export interface HealthcheckResult { enabled: boolean; healthy: boolean; requestSent: boolean; reason: string; snapshot: HealthSnapshot; }
type HealthcheckRequest = (url: string) => Promise<boolean>;

export class HealthcheckService {
  public constructor(
    private readonly db: SqliteDatabase,
    private readonly logger: Logger,
    private readonly heartbeatUrl: string | undefined,
    private readonly maxPending: number,
    private readonly maxFailuresIn15m: number,
    private readonly request: HealthcheckRequest = async (url) => {
      const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5_000) });
      return response.ok;
    },
    private readonly now = () => Date.now()
  ) {}

  public async check(gatewayReady: boolean): Promise<HealthcheckResult> {
    const snapshot = this.snapshot();
    if (!this.heartbeatUrl) return { enabled: false, healthy: true, requestSent: false, reason: "disabled", snapshot };
    // A missing success ping is intentional while Gateway is down. The external
    // monitor then expires naturally, without pretending that the VM is healthy.
    if (!gatewayReady) return { enabled: true, healthy: false, requestSent: false, reason: "gateway_not_ready", snapshot };
    const healthy = snapshot.pending < this.maxPending && snapshot.failedIn15m < this.maxFailuresIn15m;
    const target = healthy ? this.heartbeatUrl : this.withSuffix(this.heartbeatUrl, "/fail");
    try {
      const accepted = await this.request(target);
      if (!accepted) throw new Error("healthcheck endpoint rejected request");
      return { enabled: true, healthy, requestSent: true, reason: healthy ? "ok" : "queue_or_failure_threshold", snapshot };
    } catch {
      // The heartbeat URL contains a secret path. Never include it or the
      // transport error in logs; the external service remains the source of truth.
      this.logger.warn("healthcheck request failed", { healthy, pending: snapshot.pending, failedIn15m: snapshot.failedIn15m });
      return { enabled: true, healthy: false, requestSent: true, reason: "healthcheck_request_failed", snapshot };
    }
  }

  private snapshot(): HealthSnapshot {
    const failedSince = this.now() - 15 * 60 * 1_000;
    const pending = Number((this.db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE status IN ('pending','processing')").get() as { count: number }).count);
    // A failed row is no longer due for delivery. Its available_at stores the
    // transition time, giving us a failure window without a schema migration.
    const failedIn15m = Number((this.db.raw.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE status='failed' AND available_at>=?").get(failedSince) as { count: number }).count);
    return { pending, failedIn15m };
  }

  private withSuffix(url: string, suffix: string): string {
    const target = new URL(url);
    if (!target.pathname.endsWith(suffix)) target.pathname = `${target.pathname.replace(/\/$/, "")}${suffix}`;
    return target.toString();
  }
}
