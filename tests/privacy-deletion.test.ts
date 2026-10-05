import { describe, expect, it, vi } from "vitest";
import { PrivacyDeletionService } from "../src/services/privacy-deletion.js";

describe("privacy deletion ordering", () => {
  it("advances privacy state before deleting and finalizing the safe backup afterward", async () => {
    const order: string[] = [];
    const accounts = {
      setPrivacyDeletionActive: () => undefined,
      hasDataForUser: () => true,
      deleteAccount: () => { order.push("db-delete"); return "sub" as const; }
    };
    const service = new PrivacyDeletionService(accounts as never, {
      begin: async () => { order.push("epoch-advance"); },
      databaseDeleted: async () => { order.push("db-delete-committed"); },
      finish: async () => { order.push("safe-backup-and-prune"); }
    });
    await expect(service.deleteAccount("opaque-test-user")).resolves.toBe("sub");
    expect(order).toEqual(["epoch-advance", "db-delete", "db-delete-committed", "safe-backup-and-prune"]);
  });

  it("does not run the DB delete if advancing the privacy state fails", async () => {
    const remove = vi.fn();
    const service = new PrivacyDeletionService({ setPrivacyDeletionActive: () => undefined, hasDataForUser: () => true, deleteAccount: remove } as never, {
      begin: async () => { throw new Error("state unavailable"); }, databaseDeleted: async () => undefined, finish: async () => undefined
    });
    await expect(service.deleteAccount("user")).rejects.toThrow("state unavailable");
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not report completion when backup maintenance fails after active deletion", async () => {
    const remove = vi.fn(() => "main" as const);
    const service = new PrivacyDeletionService({ setPrivacyDeletionActive: () => undefined, hasDataForUser: () => true, deleteAccount: remove } as never, {
      begin: async () => undefined, databaseDeleted: async () => undefined, finish: async () => { throw new Error("backup cleanup failed"); }
    });
    await expect(service.deleteAccount("user")).rejects.toThrow("backup cleanup failed");
    expect(remove).toHaveBeenCalledOnce();
  });

  it("finishes an earlier pending deletion after active rows are already gone", async () => {
    const order: string[] = [];
    const service = new PrivacyDeletionService({ setPrivacyDeletionActive: () => undefined, hasDataForUser: () => false, deleteAccount: () => { order.push("check-active"); return "none" as const; } } as never, {
      begin: async () => { order.push("begin"); }, databaseDeleted: async () => { order.push("db-delete-committed"); }, finish: async () => { order.push("finish-if-pending"); }
    });
    await expect(service.deleteAccount("user")).resolves.toBe("none");
    expect(order).toEqual(["db-delete-committed", "finish-if-pending", "check-active"]);
  });

  it("serializes overlapping account deletions across the backup window", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let hasFirst = true;
    const accounts = {
      setPrivacyDeletionActive: () => undefined,
      hasDataForUser: () => true,
      deleteAccount: (userId: string) => { order.push(`delete:${userId}`); if (userId === "first") hasFirst = false; return "sub" as const; }
    };
    const service = new PrivacyDeletionService(accounts as never, {
      begin: async () => { order.push("begin"); if (order.filter((entry) => entry === "begin").length === 1) await firstGate; },
      databaseDeleted: async () => { order.push("db-delete-committed"); },
      finish: async () => { order.push("finish"); }
    });
    const first = service.deleteAccount("first");
    const second = service.deleteAccount("second");
    await Promise.resolve();
    expect(order).toEqual(["begin"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["begin", "delete:first", "db-delete-committed", "finish", "begin", "delete:second", "db-delete-committed", "finish"]);
    expect(hasFirst).toBe(false);
  });
});
