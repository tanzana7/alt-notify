import { describe, expect, it } from "vitest";
import { cancelAccountDeletion, confirmAccountDeletion } from "../src/services/account-delete-button.js";
import { ApprovalStore } from "../src/services/approval.js";

describe("account delete button acknowledgement", () => {
  function fixture(result: "main" | "sub" | "none") {
    const order: string[] = [];
    let reply: { content: string; components: unknown[] } | undefined;
    const interaction = {
      user: { id: "user" },
      deferUpdate: async () => { order.push("ack"); },
      editReply: async (message: { content: string; components: unknown[] }) => { reply = message; order.push("reply"); },
      update: async (message: { content: string; components: unknown[] }) => { reply = message; order.push("cancel"); }
    };
    const accounts = { deleteAccount: () => { order.push("delete"); return result; } };
    const approvals = new ApprovalStore();
    const token = approvals.issue("user", "delete");
    return { interaction, accounts, approvals, token, order, getReply: () => reply };
  }

  it("acknowledges before deletion and removes components on success", async () => {
    const state = fixture("sub");
    await confirmAccountDeletion(state.interaction as never, state.token, state.approvals, state.accounts as never);
    expect(state.order).toEqual(["ack", "delete", "reply"]);
    expect(state.getReply()).toEqual({ content: "保存されていたAlt Notifyのデータを削除しました。", components: [] });
  });

  it("acknowledges and clears components when there is no data", async () => {
    const state = fixture("none");
    await confirmAccountDeletion(state.interaction as never, state.token, state.approvals, state.accounts as never);
    expect(state.order).toEqual(["ack", "delete", "reply"]);
    expect(state.getReply()).toEqual({ content: "削除するデータがありません。", components: [] });
  });

  it("rejects an invalid token before acknowledgement or deletion", async () => {
    const state = fixture("main");
    await expect(confirmAccountDeletion(state.interaction as never, "invalid", state.approvals, state.accounts as never)).rejects.toThrow("この承認操作は無効です");
    expect(state.order).toEqual([]);
  });

  it("cancel consumes the token, so later confirm cannot delete", async () => {
    const state = fixture("main");
    await cancelAccountDeletion(state.interaction as never, state.token, state.approvals);
    await expect(confirmAccountDeletion(state.interaction as never, state.token, state.approvals, state.accounts as never)).rejects.toThrow("この承認操作は無効です");
    expect(state.order).toEqual(["cancel"]);
    expect(state.getReply()?.components).toEqual([]);
  });

  it("confirm consumes the token before awaiting acknowledgement, so late cancel cannot rewind deletion", async () => {
    const state = fixture("main");
    const confirming = confirmAccountDeletion(state.interaction as never, state.token, state.approvals, state.accounts as never);
    await expect(cancelAccountDeletion(state.interaction as never, state.token, state.approvals)).rejects.toThrow("この承認操作は無効です");
    await confirming;
    expect(state.order).toEqual(["ack", "delete", "reply"]);
  });

  it("near-simultaneous confirm and cancel permit exactly one winner", async () => {
    const state = fixture("sub");
    const outcomes = await Promise.allSettled([
      cancelAccountDeletion(state.interaction as never, state.token, state.approvals),
      confirmAccountDeletion(state.interaction as never, state.token, state.approvals, state.accounts as never)
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
    expect(state.order).toEqual(["cancel"]);
  });

  it("does not let another user cancel", async () => {
    const state = fixture("main");
    const intruder = { ...state.interaction, user: { id: "intruder" } };
    await expect(cancelAccountDeletion(intruder as never, state.token, state.approvals)).rejects.toThrow("この承認操作は無効です");
    await confirmAccountDeletion(state.interaction as never, state.token, state.approvals, state.accounts as never);
    expect(state.order).toEqual(["ack", "delete", "reply"]);
  });

  it("rejects expired cancel tokens", async () => {
    const state = fixture("main");
    const expired = state.approvals.issue("user", "delete", Date.now() - 6 * 60_000);
    await expect(cancelAccountDeletion(state.interaction as never, expired, state.approvals)).rejects.toThrow("この承認操作は無効です");
    expect(state.order).toEqual([]);
  });

  it("does not permit replay of a consumed cancel token", async () => {
    const state = fixture("main");
    await cancelAccountDeletion(state.interaction as never, state.token, state.approvals);
    await expect(cancelAccountDeletion(state.interaction as never, state.token, state.approvals)).rejects.toThrow("この承認操作は無効です");
    expect(state.order).toEqual(["cancel"]);
  });
});
