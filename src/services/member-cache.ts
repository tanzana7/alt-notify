export type MemberLookup<T> = () => Promise<T>;

interface CacheEntry<T> { value: T | null; expiresAt: number; }

export class MemberCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  public constructor(private readonly ttlMs = 5_000, private readonly now = () => Date.now()) {}

  public async get(key: string, lookup: MemberLookup<T>): Promise<T | null> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    try {
      const value = await lookup();
      this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
      return value;
    } catch {
      // 不在メンバーや権限不足を短時間だけ負のキャッシュにし、全体メンションで同じAPIを連打しない。
      this.entries.set(key, { value: null, expiresAt: this.now() + this.ttlMs });
      return null;
    }
  }

  public clear(): void { this.entries.clear(); }
}
