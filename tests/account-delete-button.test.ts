import { describe, expect, it } from "vitest";
import { confirmAccountDeletion } from "../src/services/account-delete-button.js";
import { ApprovalStore } from "../src/services/approval.js";

describe("account delete button acknowledgement", () => {
  function fixture(result: "main" | "sub" | "none") {
    const order: string[] = [];
    let reply: { content: string; components: unknown[] } | undefined;
    const interaction = {
      user: { id: "user" },
      deferUpdate: async () => { order.push("ack"); },
      editReply: async (message: { content: string; components: unknown[] }) => { reply = message; order.push("reply"); }
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
});
