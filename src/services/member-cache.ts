export type MemberLookup<T> = () => Promise<T | null>;

interface CacheEntry<T> { value: T | null; expiresAt: number; }

export class MemberCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  public constructor(private readonly ttlMs = 5_000, private readonly now = () => Date.now(), private readonly maxEntries = 10_000) {}

  public async get(key: string, lookup: MemberLookup<T>): Promise<T | null> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const value = await lookup();
    this.set(key, value);
    return value;
  }

  public set(key: string, value: T | null): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      this.cleanup();
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  public clear(): void { this.entries.clear(); }
  public cleanup(): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(key);
  }
  public get size(): number { return this.entries.size; }
}
