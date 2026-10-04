import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OFFSITE_STATUS_DIRECTORY = "/var/lib/altnoti-monitoring";
export const OFFSITE_STATUS_FILENAME = "offsite-backup-status.json";
export const FAILURE_CODES = new Set(["prepare_failed", "transfer_failed", "hash_mismatch", "sqlite_invalid", "final_save_failed", "status_update_failed"]);

function statusPath(directory) { return path.join(directory, OFFSITE_STATUS_FILENAME); }

function validateStatus(value) {
  if (!value || typeof value !== "object" || !["ok", "failed"].includes(value.state) || !Number.isSafeInteger(value.lastAttemptAt) || value.lastAttemptAt < 0 || !(value.lastSuccessAt === null || (Number.isSafeInteger(value.lastSuccessAt) && value.lastSuccessAt >= 0))) throw new Error("invalid offsite status");
  if (value.state === "ok" && (value.lastSuccessAt === null || value.failureCode !== undefined)) throw new Error("invalid offsite status");
  if (value.state === "failed" && !FAILURE_CODES.has(value.failureCode)) throw new Error("invalid offsite status");
  return value;
}

export function readOffsiteStatus(directory) {
  const file = statusPath(directory);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("status file must be regular");
  return validateStatus(JSON.parse(fs.readFileSync(file, "utf8")));
}

function ensureDirectory(directory, rootGroupId) {
  try { fs.mkdirSync(directory, { mode: 0o750 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("status directory must be regular");
  if (rootGroupId !== undefined) {
    // The Bot may read the state but must never replace it or its parent.
    if (stat.uid !== 0 || stat.gid !== rootGroupId || (stat.mode & 0o027) !== 0) throw new Error("status directory ownership or mode invalid");
  }
}

export function writeOffsiteStatus(directory, state, failureCode, now = Date.now(), rootGroupId) {
  if (state !== "ok" && state !== "failed") throw new Error("invalid state");
  if (state === "failed" ? !FAILURE_CODES.has(failureCode) : failureCode !== undefined) throw new Error("invalid failure code");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid timestamp");
  ensureDirectory(directory, rootGroupId);
  const previous = readOffsiteStatus(directory);
  const next = state === "ok"
    ? { state, lastAttemptAt: now, lastSuccessAt: now }
    : { state, lastAttemptAt: now, lastSuccessAt: previous?.lastSuccessAt ?? null, failureCode };
  const temporary = path.join(directory, `.offsite-status-${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(next)}\n`, "utf8");
    if (rootGroupId !== undefined) fs.fchownSync(fd, 0, rootGroupId);
    fs.fchmodSync(fd, 0o640);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, statusPath(directory));
    if (process.platform !== "win32") {
      const dirFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return next;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, code, extra] = process.argv.slice(2);
    if (extra !== undefined || !["mark-success", "mark-failure", "status"].includes(command)) throw new Error("invalid command");
    if (command === "status") {
      if (code !== undefined) throw new Error("invalid command");
      const current = readOffsiteStatus(OFFSITE_STATUS_DIRECTORY);
      if (!current) throw new Error("status missing");
      console.log(JSON.stringify(current));
    } else {
      const groupId = Number(execFileSync("id", ["-g", "altnoti"], { encoding: "utf8" }).trim());
      if (!Number.isSafeInteger(groupId)) throw new Error("group missing");
      writeOffsiteStatus(OFFSITE_STATUS_DIRECTORY, command === "mark-success" ? "ok" : "failed", code, Date.now(), groupId);
    }
  } catch {
    // This privileged helper never prints paths, exception text, or secrets.
    console.error("offsite status operation failed");
    process.exitCode = 1;
  }
}
