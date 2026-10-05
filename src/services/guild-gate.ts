export type GuildGateState = "normal" | "verification_prep" | "expansion_stopped";

export function getGuildGateState(guildCount: number, prepThreshold: number, hardLimit: number): GuildGateState {
  if (guildCount >= hardLimit) return "expansion_stopped";
  if (guildCount >= prepThreshold) return "verification_prep";
  return "normal";
}

export function shouldLeaveNewGuild(input: {
  guildId: string;
  currentGuildCount: number;
  hardLimit: number;
  startupGuildIds: ReadonlySet<string>;
}): boolean {
  return input.currentGuildCount > input.hardLimit && !input.startupGuildIds.has(input.guildId);
}
