import type { Client } from "discord.js";
import type { NotificationSender } from "./notifications.js";

export function createDiscordNotificationSender(users: Pick<Client["users"], "fetch">): NotificationSender {
  return {
    send: async (mainUserId, content, nonce, beforeSend) => {
      const user = await users.fetch(mainUserId);
      // Keep this guard synchronous and adjacent to user.send(): any await
      // here would reopen the unlink/delete/watch-off race. A REST request
      // already started by user.send() cannot be withdrawn afterward.
      if (!beforeSend()) return false;
      await user.send({ content, nonce, enforceNonce: true, allowedMentions: { parse: [] } });
      return true;
    }
  };
}
