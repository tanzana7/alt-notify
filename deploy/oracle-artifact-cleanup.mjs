import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { latestSafeOracleBackup, readPrivacyState, validateOracleBackup } from "./privacy-deletion-state.mjs";

const require = createRequire(fs.existsSync("/opt/altnoti/package.json") ? "/opt/altnoti/package.json" : path.resolve(process.cwd(), "package.json"));
const initSqlJs = require("sql.js");
const sqlJsDirectory = path.dirname(require.resolve("sql.js"));
const SQL = await initSqlJs({ locateFile: (file) => path.join(sqlJsDirectory, file) });
const REQUIRED_TABLES = ["main_accounts", "account_links", "notification_queue", "notification_dedup", "guild_watches", "entitlements"];
const MANAGED_NAME = /^discord-alt-notify-\d{8}-\d{6}\.sqlite$/;

export const PRODUCTION_ARTIFACT_PATHS = Object.freeze({
  active: "/var/lib/altnoti/discord-alt-notify.sqlite",
  state: "/var/lib/altnoti-monitoring",
  backups: "/var/lib/altnoti/backups",
  legacy: "/var/lib/altnoti/backups/legacy-unverified-20261006",
  databaseDirectory: "/var/lib/altnoti",
  staging: "/home/ubuntu/.altnoti-offsite-staging"
});

function regularDirectory(directory) {
  try { const stat = fs.lstatSync(directory); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

export function isAltNotifyDatabase(file, active) {
  const stat = fs.lstatSync(file);
  const activeStat = fs.lstatSync(active);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100 || fs.realpathSync(file) === fs.realpathSync(active)
    || (stat.dev === activeStat.dev && stat.ino === activeStat.ino)) return false;
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 16).toString("ascii") !== "SQLite format 3\0") return false;
  const db = new SQL.Database(new Uint8Array(bytes));
  try {
    if (db.exec("PRAGMA integrity_check")[0]?.values[0]?.[0] !== "ok") return false;
    const tables = new Set(db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.map((row) => String(row[0])) ?? []);
    return REQUIRED_TABLES.every((table) => tables.has(table));
  } catch { return false; }
  finally { db.close(); }
}

/** Only fixed, non-recursive production directories are scanned; caller-supplied paths exist for synthetic tests only. */
export function inventoryOracleArtifacts(paths = PRODUCTION_ARTIFACT_PATHS) {
  const categories = [
    ["legacy", paths.legacy], ["alternate-backup", paths.backups],
    ["alternate-root", paths.databaseDirectory], ["staging", paths.staging]
  ];
  const result = [];
  for (const [category, directory] of categories) {
    if (!regularDirectory(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || !name.includes(".sqlite")) continue;
      if (category === "alternate-backup" && MANAGED_NAME.test(name)) continue;
      // A staged manifest is not a database; it is removed only alongside its
      // verified staged DB, never used as an input to the DB classifier.
      let recognized = false;
      try { recognized = isAltNotifyDatabase(file, paths.active); } catch { /* Unknown/corrupt files are not deletion candidates. */ }
      if (recognized) result.push({ category, file, size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino });
    }
  }
  return result;
}

export function cleanupOracleArtifacts(paths = PRODUCTION_ARTIFACT_PATHS, options = {}) {
  const active = fs.lstatSync(paths.active);
  if (!active.isFile() || active.isSymbolicLink() || active.size < 100) throw new Error("active database unavailable");
  const state = readPrivacyState(paths.state);
  if (state.cleanupPending && !state.databaseDeleted) throw new Error("active database deletion not confirmed");
  // Validation reopens the backup and checks hash, integrity, and generation.
  // In a pending deletion the normal latest helper is closed, so check its
  // current-generation candidates explicitly before removing any old copy.
  const safe = state.cleanupPending
    ? fs.readdirSync(paths.backups).filter((name) => MANAGED_NAME.test(name)).some((name) => {
      try { const metadata = validateOracleBackup(paths.state, paths.backups, name); return metadata.privacyGeneration === state.generation && metadata.createdAt >= state.lastDeletionAt; }
      catch { return false; }
    })
    : Boolean(latestSafeOracleBackup(paths.state, paths.backups));
  if (!safe) throw new Error("current-generation safe backup unavailable");
  const artifacts = inventoryOracleArtifacts(paths);
  if (options.dryRun) return { found: artifacts.length, deleted: 0, byCategory: Object.fromEntries(artifacts.reduce((map, item) => map.set(item.category, (map.get(item.category) ?? 0) + 1), new Map())) };
  let deleted = 0;
  for (const artifact of artifacts) {
    // Recheck immediately before unlink to reject swapped files and symlinks.
    const current = fs.lstatSync(artifact.file);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== artifact.dev || current.ino !== artifact.ino) throw new Error("artifact changed during cleanup");
    if (!isAltNotifyDatabase(artifact.file, paths.active)) continue;
    fs.unlinkSync(artifact.file);
    if (artifact.category === "staging") {
      const manifest = `${artifact.file}.meta.json`;
      try { const stat = fs.lstatSync(manifest); if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(manifest); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    deleted++;
  }
  return { found: artifacts.length, deleted };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== "win32" && process.getuid?.() !== 0) throw new Error("root required");
    const command = process.argv[2];
    if (process.argv.length !== 3 || !["inventory", "cleanup"].includes(command)) throw new Error("invalid command");
    const result = cleanupOracleArtifacts(PRODUCTION_ARTIFACT_PATHS, { dryRun: command === "inventory" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch { process.stderr.write("Oracle artifact validation or cleanup failed\n"); process.exitCode = 1; }
}
