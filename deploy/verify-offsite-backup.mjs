import fs from "node:fs";
import initSqlJs from "sql.js";

const filePath = process.argv[2];
if (!filePath || !fs.statSync(filePath).isFile()) process.exit(1);
const SQL = await initSqlJs();
const database = new SQL.Database(new Uint8Array(fs.readFileSync(filePath)));
try {
  if (database.exec("PRAGMA integrity_check")[0]?.values[0]?.[0] !== "ok") process.exitCode = 1;
  if (database.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('main_accounts', 'account_links', 'notification_queue')")[0]?.values.length !== 3) process.exitCode = 1;
} finally {
  database.close();
}
