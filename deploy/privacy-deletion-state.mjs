import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const PRIVACY_STATE_DIRECTORY = "/var/lib/altnoti-monitoring";
export const PRIVACY_STATE_FILE = "privacy-deletion-state.json";
export const ORACLE_BACKUP_DIRECTORY = "/var/lib/altnoti/backups";
const BACKUP_PATTERN = /^discord-alt-notify-(\d{8}-\d{6})\.sqlite$/;
const GENERATION_COUNT = 7;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const require = createRequire(fs.existsSync("/opt/altnoti/package.json") ? "/opt/altnoti/package.json" : path.resolve(process.cwd(), "package.json"));
const initSqlJs = require("sql.js");
const sqlJsDirectory = path.dirname(require.resolve("sql.js"));
const SQL = await initSqlJs({ locateFile: (file) => path.join(sqlJsDirectory, file) });

function statePath(directory) { return path.join(directory, PRIVACY_STATE_FILE); }

export function validatePrivacyState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !Number.isSafeInteger(value.lastDeletionAt) || value.lastDeletionAt < 0
    || typeof value.cleanupPending !== "boolean"
    || typeof value.databaseDeleted !== "boolean"
    || Object.keys(value).some((key) => !["generation", "lastDeletionAt", "cleanupPending", "databaseDeleted"].includes(key))) {
    throw new Error("privacy deletion state invalid");
  }
  if ((value.generation === 0) !== (value.lastDeletionAt === 0)
    || (!value.cleanupPending && value.databaseDeleted)
    || (value.generation === 0 && (value.cleanupPending || value.databaseDeleted))) throw new Error("privacy deletion state inconsistent");
  return value;
}

function assertRegularDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("privacy state directory invalid");
}

export function readPrivacyState(directory = PRIVACY_STATE_DIRECTORY) {
  const directoryStat = fs.lstatSync(directory);
  assertRegularDirectory(directory);
  const file = statePath(directory);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("privacy state file invalid");
  if (directory === PRIVACY_STATE_DIRECTORY) {
    const groupId = Number(execFileSync("id", ["-g", "altnoti"], { encoding: "utf8" }).trim());
    if (directoryStat.uid !== 0 || directoryStat.gid !== groupId || (directoryStat.mode & 0o027) !== 0
      || stat.uid !== 0 || stat.gid !== groupId || (stat.mode & 0o137) !== 0) throw new Error("privacy state permissions invalid");
  }
  return validatePrivacyState(JSON.parse(fs.readFileSync(file, "utf8")));
}

function atomicWriteState(directory, value, options = {}) {
  assertRegularDirectory(directory);
  const payload = `${JSON.stringify(validatePrivacyState(value))}\n`;
  const temporary = path.join(directory, `.privacy-deletion-${crypto.randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, payload, "utf8");
    if (options.groupId !== undefined) fs.fchownSync(descriptor, 0, options.groupId);
    fs.fchmodSync(descriptor, 0o640);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, statePath(directory));
    if (process.platform !== "win32") {
      const dir = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function initializePrivacyState(directory = PRIVACY_STATE_DIRECTORY, options = {}) {
  assertRegularDirectory(directory);
  const file = statePath(directory);
  try {
    fs.lstatSync(file);
    return readPrivacyState(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const initial = { generation: 0, lastDeletionAt: 0, cleanupPending: false, databaseDeleted: false };
  atomicWriteState(directory, initial, options);
  return initial;
}

export function advancePrivacyState(directory = PRIVACY_STATE_DIRECTORY, now = Date.now(), options = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("invalid deletion timestamp");
  const previous = readPrivacyState(directory);
  if (previous.cleanupPending) {
    // A pending epoch cannot be assigned to another user. Startup resumes
    // only a previously disk-confirmed deletion; uncertain ones stay closed.
    throw new Error("privacy deletion pending");
  }
  if (previous.generation >= Number.MAX_SAFE_INTEGER) throw new Error("privacy deletion generation exhausted");
  const next = { generation: previous.generation + 1, lastDeletionAt: Math.max(now, previous.lastDeletionAt + 1), cleanupPending: true, databaseDeleted: false };
  atomicWriteState(directory, next, options);
  return next;
}

export function markPrivacyDataDeleted(directory = PRIVACY_STATE_DIRECTORY, options = {}) {
  const state = readPrivacyState(directory);
  if (!state.cleanupPending) return state;
  if (state.databaseDeleted) return state;
  const next = { ...state, databaseDeleted: true };
  atomicWriteState(directory, next, options);
  return next;
}

function backupTimeFromName(name) {
  const match = BACKUP_PATTERN.exec(name);
  if (!match) throw new Error("invalid backup filename");
  const parsed = Date.parse(`${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}T${match[1].slice(9, 11)}:${match[1].slice(11, 13)}:${match[1].slice(13, 15)}Z`);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid backup timestamp");
  return parsed;
}

function assertRegularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("backup must be a regular file");
}

function sqliteIntegrity(file) {
  const database = new SQL.Database(new Uint8Array(fs.readFileSync(file)));
  try {
    const integrity = database.exec("PRAGMA integrity_check");
    if (integrity.length !== 1 || integrity[0]?.values.length !== 1 || integrity[0].values[0]?.[0] !== "ok") throw new Error("backup integrity failed");
    const tables = new Set(database.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.map((row) => String(row[0])) ?? []);
    if (["main_accounts", "account_links", "notification_queue", "notification_dedup", "guild_watches", "entitlements"].some((table) => !tables.has(table))) throw new Error("backup schema invalid");
  } finally { database.close(); }
}

export function recordOracleBackup(directory, backupDirectory, name, state = readPrivacyState(directory), now = Date.now()) {
  if (state.cleanupPending && (!state._finalize || !state.databaseDeleted)) throw new Error("privacy cleanup pending");
  const timestamp = backupTimeFromName(name);
  const file = path.join(backupDirectory, name);
  assertRegularFile(file);
  sqliteIntegrity(file);
  const metadata = {
    formatVersion: 1,
    createdAt: now,
    privacyGeneration: state.generation,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  };
  const metaPath = `${file}.meta.json`;
  const temporary = `${metaPath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(metadata)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, metaPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return metadata;
}

export function validateOracleBackup(directory, backupDirectory, name) {
  const timestamp = backupTimeFromName(name);
  const file = path.join(backupDirectory, name);
  const metaFile = `${file}.meta.json`;
  assertRegularFile(file);
  assertRegularFile(metaFile);
  const metadata = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  if (!metadata || metadata.formatVersion !== 1 || !Number.isSafeInteger(metadata.createdAt)
    || !Number.isSafeInteger(metadata.privacyGeneration) || metadata.privacyGeneration < 0
    || !/^[a-f0-9]{64}$/.test(metadata.sha256)
    || metadata.createdAt < timestamp || metadata.createdAt >= timestamp + 5 * 60 * 1000
    || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== metadata.sha256) {
    throw new Error("backup metadata invalid");
  }
  sqliteIntegrity(file);
  return metadata;
}

export function latestSafeOracleBackup(directory = PRIVACY_STATE_DIRECTORY, backupDirectory = ORACLE_BACKUP_DIRECTORY) {
  const state = readPrivacyState(directory);
  if (state.cleanupPending) throw new Error("privacy cleanup pending");
  const candidates = fs.readdirSync(backupDirectory).filter((name) => BACKUP_PATTERN.test(name)).sort().reverse();
  for (const name of candidates) {
    try {
      const metadata = validateOracleBackup(directory, backupDirectory, name);
      if (metadata.privacyGeneration === state.generation && metadata.createdAt >= state.lastDeletionAt) return { name, ...metadata };
    } catch { /* Never return a corrupt or obsolete generation. */ }
  }
  throw new Error("no safe Oracle backup found");
}

export function pruneOracleBackups(directory = PRIVACY_STATE_DIRECTORY, backupDirectory = ORACLE_BACKUP_DIRECTORY, now = Date.now(), allowPending = false) {
  const state = readPrivacyState(directory);
  if (state.cleanupPending && !allowPending) throw new Error("privacy cleanup pending");
  const valid = [];
  const all = fs.readdirSync(backupDirectory).filter((name) => BACKUP_PATTERN.test(name));
  for (const name of all) {
    try {
      const metadata = validateOracleBackup(directory, backupDirectory, name);
      if (metadata.privacyGeneration === state.generation && metadata.createdAt >= state.lastDeletionAt) valid.push({ name, metadata });
    } catch { /* Unknown/corrupt backups are not restore candidates. */ }
  }
  if (valid.length === 0) throw new Error("no safe backup to retain");
  valid.sort((a, b) => b.name.localeCompare(a.name));
  const keep = new Set(valid.filter(({ metadata }, index) => index < GENERATION_COUNT && now - metadata.createdAt <= MAX_AGE_MS).map(({ name }) => name));
  const newest = valid[0].name;
  keep.add(newest);
  // Only start deleting recognized generations after one independently
  // validated backup for the current privacy epoch is known to survive.
  for (const name of all) {
    if (keep.has(name)) continue;
    fs.rmSync(path.join(backupDirectory, name), { force: true });
    fs.rmSync(`${path.join(backupDirectory, name)}.meta.json`, { force: true });
  }
  return { retained: keep.size, newest };
}

export function completePrivacyMaintenance(directory = PRIVACY_STATE_DIRECTORY, backupDirectory = ORACLE_BACKUP_DIRECTORY, options = {}) {
  const state = readPrivacyState(directory);
  if (!state.cleanupPending) return state;
  if (!state.databaseDeleted) throw new Error("active database deletion not confirmed");
  const safe = fs.readdirSync(backupDirectory).filter((name) => BACKUP_PATTERN.test(name)).some((name) => {
    try {
      const metadata = validateOracleBackup(directory, backupDirectory, name);
      return metadata.privacyGeneration === state.generation && metadata.createdAt >= state.lastDeletionAt;
    }
    catch { return false; }
  });
  if (!safe) throw new Error("post-deletion backup not verified");
  // Prune while the state is still pending; restore remains closed until the
  // backup set is safe and the flag is durably cleared.
  pruneOracleBackups(directory, backupDirectory, Date.now(), true);
  const completed = { ...state, cleanupPending: false, databaseDeleted: false };
  atomicWriteState(directory, completed, options);
  return completed;
}

function requireRoot() {
  if (process.platform !== "win32" && process.getuid?.() !== 0) throw new Error("root required");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, name, extra] = process.argv.slice(2);
    if (extra !== undefined || !["initialize", "status", "generation", "begin", "database-deleted", "record", "complete", "prune", "latest", "verify"].includes(command)) throw new Error("invalid command");
    if (!["status", "generation"].includes(command)) requireRoot();
    const groupId = process.platform === "win32" ? undefined : Number(execFileSync("id", ["-g", "altnoti"], { encoding: "utf8" }).trim());
    if (groupId !== undefined && !Number.isSafeInteger(groupId)) throw new Error("application group unavailable");
    if (["initialize", "status", "generation", "begin", "database-deleted", "complete", "prune", "latest"].includes(command) && name !== undefined) throw new Error("invalid command");
    let result;
    if (command === "initialize") result = initializePrivacyState(PRIVACY_STATE_DIRECTORY, { groupId });
    else if (command === "status") result = readPrivacyState();
    else if (command === "generation") result = readPrivacyState().generation;
    else if (command === "begin") result = advancePrivacyState(PRIVACY_STATE_DIRECTORY, Date.now(), { groupId });
    else if (command === "database-deleted") result = markPrivacyDataDeleted(PRIVACY_STATE_DIRECTORY, { groupId });
    else if (command === "record") {
      if (!name || !BACKUP_PATTERN.test(name)) throw new Error("invalid command");
      const state = readPrivacyState();
      result = recordOracleBackup(PRIVACY_STATE_DIRECTORY, ORACLE_BACKUP_DIRECTORY, name, { ...state, _finalize: state.cleanupPending && state.databaseDeleted });
    } else if (command === "verify") {
      if (!name || !BACKUP_PATTERN.test(name)) throw new Error("invalid command");
      result = validateOracleBackup(PRIVACY_STATE_DIRECTORY, ORACLE_BACKUP_DIRECTORY, name);
    } else if (command === "latest") result = latestSafeOracleBackup();
    else if (command === "complete") result = completePrivacyMaintenance(PRIVACY_STATE_DIRECTORY, ORACLE_BACKUP_DIRECTORY, { groupId });
    else result = pruneOracleBackups();
    process.stdout.write(typeof result === "number" ? `${result}\n` : `${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("privacy backup state operation failed\n");
    process.exitCode = 1;
  }
}
