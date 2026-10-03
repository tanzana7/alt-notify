import { Status } from "discord.js";

type ShardStatusSource = { ws: { shards: ReadonlyMap<number, { status: Status }> } };

export function isGatewayReady(client: ShardStatusSource): boolean {
  // discord.js can leave the manager status at Ready while a shard reconnects.
  // Use every current shard so monitoring and operator status cannot claim
  // connectivity from that stale manager-wide value.
  const shards = client.ws.shards;
  if (shards.size === 0) return false;
  for (const shard of shards.values()) {
    if (shard.status !== Status.Ready) return false;
  }
  return true;
}
