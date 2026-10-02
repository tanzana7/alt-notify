export class UserFacingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export function userMessageForError(error: unknown): string {
  return error instanceof UserFacingError ? error.message : "内部エラーが発生しました。時間をおいて再度お試しください。";
}
