import { describe, expect, it } from "vitest";
import { Status } from "discord.js";
import { isGatewayReady } from "../src/services/gateway-state.js";

function gateway(shardStatuses: Status[], managerStatus = Status.Ready) {
  return {
    // This deliberately keeps the manager Ready during reconnect cases.
    ws: { status: managerStatus, shards: new Map(shardStatuses.map((status, id) => [id, { status }])) }
  };
}

describe("Gateway readiness", () => {
  it.each([
    ["no shards", [], false],
    ["one ready", [Status.Ready], true],
    ["one reconnecting", [Status.Reconnecting], false],
    ["one disconnected", [Status.Disconnected], false],
    ["all shards ready", [Status.Ready, Status.Ready], true],
    ["ready plus reconnecting", [Status.Ready, Status.Reconnecting], false],
    ["ready plus disconnected", [Status.Ready, Status.Disconnected], false]
  ] as const)("%s", (_description, statuses, expected) => {
    expect(isGatewayReady(gateway([...statuses]))).toBe(expected);
  });

  it("rejects a reconnecting shard even when the manager still claims Ready", () => {
    const client = gateway([Status.Ready, Status.Reconnecting], Status.Ready);
    expect(client.ws.status).toBe(Status.Ready);
    expect(isGatewayReady(client)).toBe(false);
  });
});
