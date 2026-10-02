export class SingleFlight {
  private active: Promise<unknown> | undefined;
  private stopping = false;

  public run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.stopping || this.active) return Promise.resolve(undefined);
    // Assign before invoking work so even a synchronous throw releases the lock.
    const task = Promise.resolve().then(work);
    const active = task.finally(() => { if (this.active === active) this.active = undefined; });
    this.active = active;
    return active;
  }

  public async stop(timeoutMs: number): Promise<boolean> {
    this.stopping = true;
    if (!this.active) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.active.then(() => true, () => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
