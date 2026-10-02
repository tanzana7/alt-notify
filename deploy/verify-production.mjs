// Read-only deployment check. Never print environment values except the Free limit.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);
const databasePath = process.argv[2];
if (!databasePath) throw new Error("database path is required");
const wasmDirectory = path.dirname(require.resolve("sql.js/dist/sql-wasm.wasm"));
const SQL = await initSqlJs({ locateFile: (file) => path.join(wasmDirectory, file) });
const database = new SQL.Database(new Uint8Array(fs.readFileSync(databasePath)));
try {
  const scalar = (query) => Number(database.exec(query)[0]?.values[0]?.[0] ?? 0);
  const integrity = String(database.exec("PRAGMA integrity_check")[0]?.values[0]?.[0] ?? "unknown");
  const queue = Object.fromEntries(database.exec("SELECT status, COUNT(*) FROM notification_queue GROUP BY status")[0]?.values ?? []);
  const result = {
    integrity,
    mains: scalar("SELECT COUNT(*) FROM main_accounts"),
    links: scalar("SELECT COUNT(*) FROM account_links"),
    queue: { pending: queue.pending ?? 0, processing: queue.processing ?? 0, failed: queue.failed ?? 0 }
  };
  if (process.argv[3]) {
    const env = fs.readFileSync(process.argv[3], "utf8");
    const value = (key) => env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    result.freeLinkLimit = Number(value("FREE_LINK_LIMIT"));
    result.tokenPresent = Boolean(value("DISCORD_TOKEN"));
    result.healthchecksConfigured = Boolean(value("HEALTHCHECKS_HEARTBEAT_URL"));
    result.appNameIsAltNotify = value("APP_NAME") === undefined || value("APP_NAME") === "Alt Notify";
  }
  console.log(JSON.stringify(result));
  if (integrity !== "ok") process.exitCode = 1;
} finally {
  database.close();
}
