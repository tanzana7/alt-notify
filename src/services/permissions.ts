export function canUseAdminStats(userId: string, ownerId: string | undefined): boolean {
  return Boolean(ownerId && userId === ownerId);
}
