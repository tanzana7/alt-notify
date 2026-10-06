import type { Client } from "discord.js";
import type { NotificationSender } from "./notifications.js";

export function createDiscordNotificationSender(users: Pick<Client["users"], "fetch">): NotificationSender {
  const prepare = async (mainUserId: string) => {
    const user = await users.fetch(mainUserId);
    return {
      send: (content: string, nonce: string, beforeSend: () => boolean) => {
        // The authorization has now completed. The final local guard and
        // user.send() start synchronously, with no intervening await.
        if (!beforeSend()) return Promise.resolve(false);
        return user.send({ content, nonce, enforceNonce: true, allowedMentions: { parse: [] } }).then(() => true);
      }
    };
  };
  return {
    prepare,
    send: async (mainUserId, content, nonce, beforeSend) => (await prepare(mainUserId)).send(content, nonce, beforeSend)
  };
}
