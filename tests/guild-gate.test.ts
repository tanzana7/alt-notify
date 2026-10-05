import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { getGuildGateState, shouldLeaveNewGuild } from "../src/services/guild-gate.js";

describe("guild expansion gate", () => {
  it("prepares at 75 while allowing new guilds through 90", () => {
    expect(getGuildGateState(74, 75, 90)).toBe("normal");
    expect(getGuildGateState(75, 75, 90)).toBe("verification_prep");
    expect(getGuildGateState(89, 75, 90)).toBe("verification_prep");
    expect(getGuildGateState(90, 75, 90)).toBe("expansion_stopped");
    expect(shouldLeaveNewGuild({ guildId: "new-at-90", currentGuildCount: 90, hardLimit: 90, startupGuildIds: new Set() })).toBe(false);
    expect(shouldLeaveNewGuild({ guildId: "91st", currentGuildCount: 91, hardLimit: 90, startupGuildIds: new Set() })).toBe(true);
  });

  it("retains all guilds already present when the process starts over limit", () => {
    const startupGuildIds = new Set(["one", "two", "three"]);
    expect(shouldLeaveNewGuild({ guildId: "two", currentGuildCount: 91, hardLimit: 90, startupGuildIds })).toBe(false);
    expect(shouldLeaveNewGuild({ guildId: "new", currentGuildCount: 92, hardLimit: 90, startupGuildIds })).toBe(true);
  });

  it("validates threshold ordering and exposes the configured defaults", () => {
    expect(loadConfig({ DISCORD_TOKEN: "fixture", DISCORD_CLIENT_ID: "fixture" })).toMatchObject({ GUILD_VERIFICATION_PREP_THRESHOLD: 75, GUILD_HARD_LIMIT: 90 });
    expect(() => loadConfig({ DISCORD_TOKEN: "fixture", DISCORD_CLIENT_ID: "fixture", GUILD_VERIFICATION_PREP_THRESHOLD: "90", GUILD_HARD_LIMIT: "90" })).toThrow();
    expect(() => loadConfig({ DISCORD_TOKEN: "fixture", DISCORD_CLIENT_ID: "fixture", GUILD_VERIFICATION_PREP_THRESHOLD: "101" })).toThrow();
  });
});
