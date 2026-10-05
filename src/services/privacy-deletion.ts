import type { AccountService } from "./accounts.js";

export interface PrivacyDeletionMaintenance {
  begin(): Promise<void>;
  databaseDeleted(): Promise<void>;
  finish(): Promise<void>;
}

/** Serialize deletion windows so a concurrent backup cannot snapshot between two users' deletions. */
export class PrivacyDeletionService {
  private tail: Promise<void> = Promise.resolve();
  private readonly activeUsers = new Map<string, number>();

  public constructor(private readonly accounts: AccountService, private readonly maintenance: PrivacyDeletionMaintenance) {}

  public deleteAccount(userId: string): Promise<"main" | "sub" | "none"> {
    this.accounts.setPrivacyDeletionActive(userId, true);
    this.activeUsers.set(userId, (this.activeUsers.get(userId) ?? 0) + 1);
    const operation = this.tail.then(async () => {
      if (!this.accounts.hasDataForUser(userId)) {
        // A prior deletion may have removed active rows but failed while
        // producing the post-deletion backup. finish() is idempotent and
        // completes that privacy maintenance without retaining a user ID.
        await this.maintenance.databaseDeleted();
        await this.maintenance.finish();
        return this.accounts.deleteAccount(userId);
      }
      await this.maintenance.begin();
      const result = this.accounts.deleteAccount(userId);
      await this.maintenance.databaseDeleted();
      await this.maintenance.finish();
      return result;
    }).finally(() => {
      const remaining = (this.activeUsers.get(userId) ?? 1) - 1;
      if (remaining <= 0) { this.activeUsers.delete(userId); this.accounts.setPrivacyDeletionActive(userId, false); }
      else this.activeUsers.set(userId, remaining);
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  public isDeleting(userId: string): boolean { return (this.activeUsers.get(userId) ?? 0) > 0; }
}
