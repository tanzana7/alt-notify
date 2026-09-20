export type LogLevel = "debug" | "info" | "warn" | "error";

const weights: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  public constructor(private readonly minimum: LogLevel = "info") {}
  public debug(message: string, fields: Record<string, unknown> = {}): void { this.write("debug", message, fields); }
  public info(message: string, fields: Record<string, unknown> = {}): void { this.write("info", message, fields); }
  public warn(message: string, fields: Record<string, unknown> = {}): void { this.write("warn", message, fields); }
  public error(message: string, fields: Record<string, unknown> = {}): void { this.write("error", message, fields); }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    if (weights[level] < weights[this.minimum]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}
