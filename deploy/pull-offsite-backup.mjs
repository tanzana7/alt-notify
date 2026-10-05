import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decryptBuffer, encryptReadableToFile, loadOrCreateDpapiKey } from "./offsite-backup-format.mjs";
import { runRestoreDrillFromBuffer } from "../dist/src/services/restore-drill.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REMOTE_HOST = "151.145.66.148";
const BACKUP_PATTERN = /^discord-alt-notify-(\d{8}-\d{6})\.sqlite$/;
const ENCRYPTED_PATTERN = /^discord-alt-notify-(\d{8}-\d{6})\.sqlite\.enc$/;

function safeName(value) { return typeof value === "string" && BACKUP_PATTERN.test(value); }
function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, ...options, stdio: [options.input ? "pipe" : "ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) throw new Error("backup operation failed");
  return String(result.stdout).trim();
}

function getOracleKeyPath() {
  return runCapture(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(SCRIPT_DIR, "resolve-oracle-key.ps1")]);
}

function runSsh(keyPath, remoteCommand, capture = true) {
  const args = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-i", keyPath, `ubuntu@${REMOTE_HOST}`, remoteCommand];
  if (!capture) return spawn("ssh", args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  return runCapture("ssh", args);
}

function prepareDestination(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("backup destination invalid");
  const keyPath = path.join(process.env.LOCALAPPDATA ?? "", "AltNotify", "keys", "offsite-backup-key.dpapi");
  if (!fs.existsSync(keyPath) && fs.readdirSync(directory).some((name) => ENCRYPTED_PATTERN.test(name))) throw new Error("encrypted backups exist but their DPAPI key is missing");
  const who = runCapture("whoami.exe", []);
  const names = fs.readdirSync(directory);
  for (const name of names) {
    if (!BACKUP_PATTERN.test(name) && !ENCRYPTED_PATTERN.test(name) && !/^discord-alt-notify-\d{8}-\d{6}\.sqlite\.enc\.partial$/.test(name)) throw new Error("unexpected backup destination item");
    const entryStat = fs.lstatSync(path.join(directory, name));
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error("backup destination item invalid");
  }
  const acl = spawnSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `${who}:(OI)(CI)F`, "SYSTEM:(OI)(CI)F"], { encoding: "utf8", windowsHide: true, timeout: 15_000, stdio: "ignore" });
  if (acl.error || acl.status !== 0) throw new Error("backup directory ACL update failed");
  for (const name of names) {
    const fileAcl = spawnSync("icacls.exe", [path.join(directory, name), "/inheritance:r", "/grant:r", `${who}:F`, "SYSTEM:F"], { encoding: "utf8", windowsHide: true, timeout: 15_000, stdio: "ignore" });
    if (fileAcl.error || fileAcl.status !== 0) throw new Error("backup file ACL update failed");
  }
}

function parseMetadata(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("remote backup metadata invalid"); }
  if (!value || Object.keys(value).sort().join(",") !== "createdAt,name,privacyGeneration,sha256"
    || !safeName(value.name) || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
    || !Number.isSafeInteger(value.privacyGeneration) || value.privacyGeneration < 0) throw new Error("remote backup metadata invalid");
  return value;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("backup transfer failed")));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("backup transfer failed")));
  });
}

export function cleanupLegacyPlaintext(directory) {
  const legacy = fs.readdirSync(directory).filter((name) => BACKUP_PATTERN.test(name));
  for (const name of legacy) fs.rmSync(path.join(directory, name));
  if (fs.readdirSync(directory).some((name) => BACKUP_PATTERN.test(name))) throw new Error("plaintext backup remains");
  return legacy.length;
}

export function pruneEncrypted(directory, key, currentGeneration, now = Date.now()) {
  const files = fs.readdirSync(directory).filter((name) => ENCRYPTED_PATTERN.test(name)).sort().reverse();
  const valid = [];
  for (const name of files) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    try {
      const decoded = decryptBuffer(fs.readFileSync(file), key);
      const stamp = Date.parse(`${name.slice(19, 23)}-${name.slice(23, 25)}-${name.slice(25, 27)}T${name.slice(28, 30)}:${name.slice(30, 32)}:${name.slice(32, 34)}Z`);
      if (decoded.metadata.privacyGeneration === currentGeneration && decoded.metadata.createdAt >= stamp && decoded.metadata.createdAt < stamp + 5 * 60_000) valid.push({ name, time: decoded.metadata.createdAt });
      else if (decoded.metadata.privacyGeneration !== currentGeneration) fs.rmSync(file);
      decoded.database.fill(0);
    } catch {
      // A recognized backup with invalid authentication is not recoverable.
      // A separately verified current backup is already saved before pruning.
      fs.rmSync(file, { force: true });
    }
  }
  if (valid.length === 0) throw new Error("no encrypted backup remains");
  const safeNames = new Set(valid.filter((entry, index) => index < 14 && now - entry.time <= 30 * 24 * 60 * 60_000).map((entry) => entry.name));
  safeNames.add(valid[0].name);
  for (const entry of valid) if (!safeNames.has(entry.name)) fs.rmSync(path.join(directory, entry.name));
  return safeNames.size;
}

async function pull(directory) {
  if (!process.env.LOCALAPPDATA) throw new Error("Windows user profile unavailable");
  prepareDestination(directory);
  const keyPath = getOracleKeyPath();
  const key = loadOrCreateDpapiKey();
  let remoteName;
  let remoteHash;
  let privacyGeneration;
  let partialPath;
  let finalPath;
  let remotePrepared = false;
  try {
    const prepared = parseMetadata(runSsh(keyPath, "sudo -n /usr/local/sbin/altnoti-offsite-prepare"));
    ({ name: remoteName, sha256: remoteHash, privacyGeneration } = prepared);
    remotePrepared = true;
    const filenameTime = Date.parse(`${remoteName.slice(19, 23)}-${remoteName.slice(23, 25)}-${remoteName.slice(25, 27)}T${remoteName.slice(28, 30)}:${remoteName.slice(30, 32)}:${remoteName.slice(32, 34)}Z`);
    const partialName = `${remoteName}.enc.partial`;
    partialPath = path.join(directory, partialName);
    finalPath = path.join(directory, `${remoteName}.enc`);
    if (fs.existsSync(finalPath)) throw new Error("encrypted backup name already exists");
    fs.rmSync(partialPath, { force: true });

    const remoteFile = `/home/ubuntu/.altnoti-offsite-staging/${remoteName}`;
    const ssh = runSsh(keyPath, `cat -- ${remoteFile}`, false);
    const transferDone = waitForChild(ssh);
    try {
      await encryptReadableToFile(ssh.stdout, partialPath, key, { createdAt: prepared.createdAt, privacyGeneration }, remoteHash);
      await transferDone;
    } catch (error) {
      ssh.kill();
      await transferDone.catch(() => undefined);
      throw error;
    }

    const encrypted = fs.readFileSync(partialPath);
    const decoded = decryptBuffer(encrypted, key);
    try {
      if (decoded.metadata.createdAt !== prepared.createdAt || decoded.metadata.privacyGeneration !== privacyGeneration || decoded.metadata.sha256 !== remoteHash) throw new Error("encrypted metadata mismatch");
      if (!Number.isFinite(filenameTime) || decoded.metadata.createdAt < filenameTime || decoded.metadata.createdAt >= filenameTime + 5 * 60_000) throw new Error("backup timestamp mismatch");
      const stateText = runSsh(keyPath, "sudo -n /usr/local/sbin/altnoti-privacy status");
      const state = JSON.parse(stateText);
      if (!state || state.cleanupPending !== false || state.databaseDeleted !== false || state.generation !== privacyGeneration || !Number.isSafeInteger(state.lastDeletionAt)) throw new Error("privacy state changed during backup");
      await runRestoreDrillFromBuffer(decoded.database, "windows encrypted", decoded.metadata, state);
    } finally { decoded.database.fill(0); }

    fs.renameSync(partialPath, finalPath);
    const plainRemoved = cleanupLegacyPlaintext(directory);
    const retained = pruneEncrypted(directory, key, privacyGeneration);
    const mark = runSsh(keyPath, `sudo -n /usr/local/sbin/altnoti-offsite-prepare mark-success ${remoteName} ${remoteHash} ${privacyGeneration}`);
    if (mark) throw new Error("remote backup status rejected");
    return { retained, plainRemoved };
  } catch (error) {
    const code = error instanceof Error && error.message.includes("hash") ? "hash_mismatch" : "transfer_failed";
    try { runSsh(keyPath, `sudo -n /usr/local/sbin/altnoti-offsite-prepare mark-failure ${code}`); } catch { /* stale Healthchecks status remains authoritative */ }
    throw error;
  } finally {
    key.fill(0);
    if (partialPath) fs.rmSync(partialPath, { force: true });
    if (remotePrepared) {
      try { runSsh(keyPath, `sudo -n /usr/local/sbin/altnoti-offsite-prepare cleanup ${remoteName}`); } catch { /* staging expires on the VM */ }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error("invalid arguments");
    const destination = process.argv[2] || path.join(process.env.LOCALAPPDATA ?? "", "AltNotify", "offsite-backups");
    const result = await pull(destination);
    process.stdout.write(`encrypted backup verified; retained=${result.retained}; plaintextRemoved=${result.plainRemoved}\n`);
  } catch {
    process.stderr.write("VM外バックアップに失敗しました。詳細を含まない固定エラーです。\n");
    process.exitCode = 1;
  }
}
