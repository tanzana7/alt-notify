import type { ButtonInteraction } from "discord.js";
import type { AccountService } from "./accounts.js";
import type { ApprovalStore } from "./approval.js";

export async function confirmAccountDeletion(
  interaction: Pick<ButtonInteraction, "user" | "deferUpdate" | "editReply">,
  token: string,
  approvals: ApprovalStore,
  accounts: AccountService
): Promise<void> {
  approvals.consume(token, interaction.user.id);
  // Deletion scans retained history to remove the user's details. Acknowledge
  // the button first so a large history does not exhaust Discord's response
  // deadline; only report completion after the transaction returns.
  await interaction.deferUpdate();
  const result = accounts.deleteAccount(interaction.user.id);
  await interaction.editReply({
    content: result === "none" ? "削除するデータがありません。" : "保存されていたAlt Notifyのデータを削除しました。",
    components: []
  });
}
