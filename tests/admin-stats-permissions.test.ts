import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { canUseAdminStats } from "../src/services/permissions.js";

const owner = "111111111111111111";
const first = "222222222222222222";
const second = "333333333333333333";
const env = { DISCORD_TOKEN: "test", DISCORD_CLIENT_ID: "test" };

describe("admin statistics allowlist", () => {
  it("keeps owner access without an additional list", () => {
    expect(canUseAdminStats(owner, owner)).toBe(true);
    expect(canUseAdminStats(first, owner)).toBe(false);
  });
  it("allows one configured admin", () => {
    const config = loadConfig({ ...env, ADMIN_STATS_DISCORD_IDS: first });
    expect(canUseAdminStats(first, undefined, config.ADMIN_STATS_DISCORD_IDS)).toBe(true);
  });
  it("allows both admins and the existing owner", () => {
    const config = loadConfig({ ...env, ADMIN_STATS_DISCORD_IDS: `${first},${second}` });
    for (const id of [owner, first, second]) {
      expect(canUseAdminStats(id, owner, config.ADMIN_STATS_DISCORD_IDS)).toBe(true);
    }
    expect(canUseAdminStats("444444444444444444", owner, config.ADMIN_STATS_DISCORD_IDS)).toBe(false);
  });
  it("denies access when configuration is absent, empty or contains only empty elements", () => {
    for (const value of [undefined, "", " , , "]) {
      const config = loadConfig({ ...env, ADMIN_STATS_DISCORD_IDS: value });
      expect(config.ADMIN_STATS_DISCORD_IDS).toEqual([]);
      expect(canUseAdminStats(first, undefined, config.ADMIN_STATS_DISCORD_IDS)).toBe(false);
    }
  });
  it("trims whitespace and ignores empty entries and duplicates", () => {
    const config = loadConfig({ ...env, ADMIN_STATS_DISCORD_IDS: ` , ${first},, ${second},${first}, ` });
    expect(config.ADMIN_STATS_DISCORD_IDS).toEqual([first, second]);
  });
  it("rejects partial matches", () => {
    expect(canUseAdminStats(first.slice(1), undefined, [first])).toBe(false);
    expect(canUseAdminStats(`${first}0`, undefined, [first])).toBe(false);
  });
  it("never grants access using usernames or wildcard entries", () => {
    for (const value of ["zanaspl", "l1gu", "*", `${first},zanaspl`, "123", "-222222222222222222"]) {
      expect(() => loadConfig({ ...env, ADMIN_STATS_DISCORD_IDS: value })).toThrow(/ADMIN_STATS_DISCORD_IDS/);
      expect(canUseAdminStats(value, undefined, [value])).toBe(false);
    }
    expect(canUseAdminStats("zanaspl", undefined, [first, second])).toBe(false);
    expect(canUseAdminStats("l1gu", undefined, [first, second])).toBe(false);
  });
});
