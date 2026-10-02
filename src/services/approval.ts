import crypto from "node:crypto";
import { UserFacingError } from "./user-error.js";

interface PendingApproval { requesterId: string; codeHash: string; expiresAt: number; }

export class ApprovalStore {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly maxPending = 1_000;

  public issue(requesterId: string, codeHash: string, now = Date.now()): string {
    this.cleanup(now);
    // Only the newest button for a user should remain valid.
    for (const [key, approval] of this.pending) if (approval.requesterId === requesterId) this.pending.delete(key);
    if (this.pending.size >= this.maxPending) this.pending.delete(this.pending.keys().next().value!);
    const token = crypto.randomBytes(16).toString("hex");
    this.pending.set(token, { requesterId, codeHash, expiresAt: now + 5 * 60 * 1000 });
    return token;
  }

  public consume(token: string, requesterId: string, now = Date.now()): string {
    const approval = this.pending.get(token);
    if (!approval || approval.requesterId !== requesterId || approval.expiresAt <= now) {
      if (approval?.expiresAt !== undefined && approval.expiresAt <= now) this.pending.delete(token);
      throw new UserFacingError("この承認操作は無効です");
    }
    this.pending.delete(token);
    return approval.codeHash;
  }

  public cleanup(now = Date.now()): void {
    for (const [token, approval] of this.pending) if (approval.expiresAt <= now) this.pending.delete(token);
  }

  public get size(): number { return this.pending.size; }
}
