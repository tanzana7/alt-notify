export function canUseAdminStats(userId: string, ownerId: string | undefined, adminIds: readonly string[] = []): boolean {
  // This allowlist only grants statistics access, not plan or other owner privileges.
  return Boolean(ownerId && userId === ownerId)
    || adminIds.some((id) => /^[0-9]{17,20}$/.test(id) && userId === id);
}
