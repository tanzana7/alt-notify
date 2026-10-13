#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decryptBuffer, encryptBuffer } from "./offsite-backup-format.mjs";
import { latestSafeOracleBackup, readPrivacyState, validateOracleBackup, PRIVACY_STATE_DIRECTORY, ORACLE_BACKUP_DIRECTORY } from "./privacy-deletion-state.mjs";
import { writeOffsiteStatus } from "./offsite-status.mjs";
import { R2Client, r2ConfigFromEnv } from "./r2-client.mjs";

const R2_FINAL_PATTERN = /(?:^|\/)alt-notify-\d{8}-\d{6}\.sqlite\.enc$/;
const KEY_BYTES = 32;
const RETAIN_COUNT = 14;
const RETAIN_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

async function defaultRestore(bytes, source, metadata, state) {
  const { runRestoreDrillFromBuffer } = await import("../dist/src/services/restore-drill.js");
  return runRestoreDrillFromBuffer(bytes, source, metadata, state);
}

function applicationGroupId() {
  if (process.platform === "win32") return undefined;
  const groupId = Number(execFileSync("id", ["-g", "altnoti"], { encoding: "utf8" }).trim());
  if (!Number.isSafeInteger(groupId)) throw new Error("application group unavailable");
  return groupId;
}

export function loadOracleEncryptionKey(file = process.env.ALTN_OFFSITE_KEY_FILE || "/etc/altnoti-offsite/backup.key") {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.uid !== 0 || (stat.mode & 0o077) !== 0))) throw new Error("offsite encryption key permissions invalid");
  const key = fs.readFileSync(file);
  if (key.length !== KEY_BYTES) { key.fill(0); throw new Error("offsite encryption key length invalid"); }
  return key;
}

function objectKey(createdAt, prefix = process.env.ALTN_R2_PREFIX || "backups") {
  if (!/^[A-Za-z0-9._/-]+$/.test(prefix) || prefix.startsWith("/") || prefix.includes("..")) throw new Error("invalid R2 prefix");
  const date = new Date(createdAt);
  const stamp = date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d{3}Z$/, "").slice(0, 15);
  return `${prefix.replace(/\/$/, "")}/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/alt-notify-${stamp}.sqlite.enc`;
}

function metadataFor(metadata) {
  return { format: String(metadata.formatVersion), sha256: metadata.sha256, "privacy-generation": String(metadata.privacyGeneration), "created-at": String(metadata.createdAt) };
}

function assertHead(head, expectedSize, metadata) {
  const actualSize = Number(head.headers["content-length"] ?? -1);
  const expected = metadataFor(metadata);
  if (actualSize !== expectedSize) throw new Error("R2 object size verification failed");
  for (const [name, value] of Object.entries(expected)) if (head.headers[`x-amz-meta-${name}`] !== value) throw new Error("R2 object metadata verification failed");
}

async function restoreDownloaded(bytes, encryptedKey, metadata, privacyState, restore = defaultRestore) {
  const decoded = decryptBuffer(bytes, encryptedKey);
  try {
    if (decoded.metadata.createdAt !== metadata.createdAt || decoded.metadata.privacyGeneration !== metadata.privacyGeneration || decoded.metadata.sha256 !== metadata.sha256) throw new Error("downloaded backup metadata mismatch");
    return await restore(decoded.database, "R2 encrypted backup", decoded.metadata, privacyState);
  } finally { decoded.database.fill(0); }
}

export function retentionKeys(keys, now = Date.now()) {
  const valid = keys.filter((key) => R2_FINAL_PATTERN.test(key)).sort().reverse();
  const keep = new Set(valid.filter((key, index) => index < RETAIN_COUNT && now - parseKeyTimestamp(key) <= RETAIN_AGE_MS));
  if (valid[0]) keep.add(valid[0]);
  return { keep, remove: valid.filter((key) => !keep.has(key)) };
}

function parseKeyTimestamp(key) {
  const match = /alt-notify-(\d{8})-(\d{6})\.sqlite\.enc$/.exec(key);
  if (!match) return Number.NaN;
  return Date.parse(`${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}T${match[2].slice(0, 2)}:${match[2].slice(2, 4)}:${match[2].slice(4, 6)}Z`);
}

export async function runOffsiteBackup({ client, backupDirectory = ORACLE_BACKUP_DIRECTORY, privacyDirectory = PRIVACY_STATE_DIRECTORY, key, now = Date.now(), restore = defaultRestore, statusDirectory = "/var/lib/altnoti-monitoring" }) {
  if (!client || !key) throw new Error("offsite backup dependencies unavailable");
  let temporaryKey;
  let encrypted;
  let success = false;
  try {
    const privacyState = readPrivacyState(privacyDirectory);
    const latest = latestSafeOracleBackup(privacyDirectory, backupDirectory);
    const metadata = validateOracleBackup(privacyDirectory, backupDirectory, latest.name);
    const source = fs.readFileSync(path.join(backupDirectory, latest.name));
    try { encrypted = encryptBuffer(source, key, { createdAt: metadata.createdAt, privacyGeneration: metadata.privacyGeneration }); }
    finally { source.fill(0); }
    const finalKey = objectKey(metadata.createdAt);
    temporaryKey = `${finalKey}.uploading`;
    await client.putObject(temporaryKey, encrypted.bytes, metadataFor(metadata));
    assertHead(await client.headObject(temporaryKey), encrypted.bytes.length, metadata);
    const downloaded = await client.getObject(temporaryKey);
    assertHead(downloaded, encrypted.bytes.length, metadata);
    await restoreDownloaded(downloaded.body, key, metadata, privacyState, restore);
    await client.putObject(finalKey, encrypted.bytes, metadataFor(metadata));
    assertHead(await client.headObject(finalKey), encrypted.bytes.length, metadata);
    const status = writeOffsiteStatus(statusDirectory, "ok", undefined, now, applicationGroupId(), metadata.privacyGeneration, { remoteVerified: true, restoreVerified: true, provider: "cloudflare-r2" });
    success = true;
    const listed = [];
    let cursor;
    do {
      const page = await client.listObjects(`${process.env.ALTN_R2_PREFIX || "backups"}/`, cursor);
      listed.push(...page.keys);
      cursor = page.truncated ? page.continuationToken : undefined;
    } while (cursor);
    const retention = retentionKeys(listed, now);
    const cleanupWarnings = [];
    for (const oldKey of retention.remove) { try { await client.deleteObject(oldKey); } catch { cleanupWarnings.push("retention_cleanup_failed"); } }
    try { await client.deleteObject(temporaryKey); } catch { cleanupWarnings.push("temporary_cleanup_failed"); }
    return { status, finalKey, retained: retention.keep.size, cleanupWarnings };
  } catch (error) {
    if (!success) {
      const code = error?.message?.includes("integrity") ? "sqlite_invalid" : error?.message?.includes("privacy") ? "privacy_mismatch" : error?.message?.includes("download") ? "download_failed" : error?.message?.includes("metadata") || error?.message?.includes("size") ? "remote_verification_failed" : "transfer_failed";
      try { writeOffsiteStatus(statusDirectory, "failed", code, now); } catch { /* Preserve the original failure category. */ }
    }
    throw error;
  } finally {
    key.fill(0);
    encrypted?.bytes.fill(0);
    if (!success && temporaryKey) { try { await client.deleteObject(temporaryKey); } catch { /* Temporary objects are harmless and remain outside final retention. */ } }
  }
}

async function main() {
  const client = new R2Client(r2ConfigFromEnv());
  const key = loadOracleEncryptionKey();
  try {
    const result = await runOffsiteBackup({ client, key });
    process.stdout.write(`R2 offsite backup verified; retained=${result.retained}\n`);
  } catch {
    process.stderr.write("Oracle R2 offsite backup failed.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
