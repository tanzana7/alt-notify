import crypto from "node:crypto";

interface PendingApproval { requesterId: string; codeHash: string; expiresAt: number; }

export class ApprovalStore {
  private readonly pending = new Map<string, PendingApproval>();

  public issue(requesterId: string, codeHash: string, now = Date.now()): string {
    const token = crypto.randomBytes(16).toString("hex");
    this.pending.set(token, { requesterId, codeHash, expiresAt: now + 5 * 60 * 1000 });
    return token;
  }

  public consume(token: string, requesterId: string, now = Date.now()): string {
    const approval = this.pending.get(token);
    if (!approval || approval.requesterId !== requesterId || approval.expiresAt <= now) throw new Error("この承認操作は無効です");
    this.pending.delete(token);
    return approval.codeHash;
  }
}
