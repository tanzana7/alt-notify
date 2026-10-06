import fs from "node:fs";
import path from "node:path";

const WINDOW_MS = 15 * 60_000;

/** Timestamp-only event file: survives a Bot restart without retaining message identities. */
export class InspectionFailures {
  public constructor(private readonly file: string, private readonly now = () => Date.now()) {}

  private recent(now: number): number[] {
    let events: unknown;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error("inspection failure state invalid");
      events = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw new Error("inspection failure state invalid");
    }
    if (!Array.isArray(events) || events.some((event) => !Number.isSafeInteger(event) || event < 0 || event > now)) throw new Error("inspection failure state invalid");
    return events.filter((event) => event > now - WINDOW_MS);
  }

  public count(): number { return this.recent(this.now()).length; }

  public record(): number {
    const now = this.now();
    // One event already exceeds the default threshold; a bounded ring avoids
    // unbounded disk work during a sustained Discord/API incident.
    const events = [...this.recent(now), now].slice(-1_000);
    const directory = path.dirname(this.file);
    const temporary = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(events));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
      if (process.platform !== "win32") {
        const dir = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return events.length;
  }
}
