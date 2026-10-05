import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BACKUP_MAGIC = Buffer.from("ALTNENC1", "ascii");
export const BACKUP_FORMAT_VERSION = 1;
const TRAILER_MAGIC = Buffer.from("ALTNEND1", "ascii");
const AUTH_TAG_BYTES = 16;
const TRAILER_BYTES = 48;
const MAX_HEADER_BYTES = 16 * 1024;
const KEY_BYTES = 32;
const KEY_FILENAME = "offsite-backup-key.dpapi";

function windowsPowerShellPath() {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function legacyPowerShellEnvironment() {
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  return {
    ...process.env,
    PSModulePath: [
      path.join(windows, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      path.join(programFiles, "WindowsPowerShell", "Modules")
    ].join(";")
  };
}

function encodeHeader(metadata, nonce) {
  if (!Number.isSafeInteger(metadata.createdAt) || metadata.createdAt <= 0
    || !Number.isSafeInteger(metadata.privacyGeneration) || metadata.privacyGeneration < 0) throw new Error("invalid backup metadata");
  return Buffer.from(JSON.stringify({ formatVersion: BACKUP_FORMAT_VERSION, createdAt: metadata.createdAt, privacyGeneration: metadata.privacyGeneration, nonce: nonce.toString("hex") }), "utf8");
}

function aadFor(header) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([BACKUP_MAGIC, length, header]);
}

function createTrailer(byteCount, digest) {
  const trailer = Buffer.alloc(TRAILER_BYTES);
  TRAILER_MAGIC.copy(trailer, 0);
  trailer.writeBigUInt64BE(BigInt(byteCount), 8);
  Buffer.from(digest, "hex").copy(trailer, 16);
  return trailer;
}

export function encryptBuffer(plaintext, key, metadata, nonce = crypto.randomBytes(12)) {
  if (!Buffer.isBuffer(plaintext) || !Buffer.isBuffer(key) || key.length !== KEY_BYTES || nonce.length !== 12) throw new Error("invalid encryption input");
  const hash = crypto.createHash("sha256").update(plaintext).digest("hex");
  const header = encodeHeader(metadata, nonce);
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadFor(header));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.update(createTrailer(plaintext.length, hash)), cipher.final()]);
  return { bytes: Buffer.concat([BACKUP_MAGIC, length, header, ciphertext, cipher.getAuthTag()]), sha256: hash };
}

export async function encryptReadableToFile(readable, partialPath, key, metadata, expectedSha256) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("invalid encryption input");
  const nonce = crypto.randomBytes(12);
  const header = encodeHeader(metadata, nonce);
  if (header.length > MAX_HEADER_BYTES) throw new Error("backup header too large");
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadFor(header));
  const hash = crypto.createHash("sha256");
  let byteCount = 0;
  let file;
  try {
    file = await fs.promises.open(partialPath, "wx", 0o600);
    await file.writeFile(Buffer.concat([BACKUP_MAGIC, length, header]));
    for await (const input of readable) {
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
      hash.update(chunk);
      byteCount += chunk.length;
      if (!Number.isSafeInteger(byteCount)) throw new Error("backup exceeds supported size");
      const encryptedChunk = cipher.update(chunk);
      if (encryptedChunk.length) await file.writeFile(encryptedChunk);
    }
    const actualHash = hash.digest("hex");
    if (actualHash !== expectedSha256) throw new Error("remote backup hash mismatch");
    const trailerCiphertext = cipher.update(createTrailer(byteCount, actualHash));
    if (trailerCiphertext.length) await file.writeFile(trailerCiphertext);
    const finalBytes = cipher.final();
    if (finalBytes.length) await file.writeFile(finalBytes);
    await file.writeFile(cipher.getAuthTag());
    await file.sync();
    return { sha256: actualHash, byteCount };
  } catch (error) {
    await file?.close().catch(() => undefined);
    file = undefined;
    await fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await file?.close();
  }
}

export function decryptBuffer(encrypted, key) {
  if (!Buffer.isBuffer(encrypted) || !Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error("invalid encrypted backup");
  if (encrypted.length < BACKUP_MAGIC.length + 4 + AUTH_TAG_BYTES + TRAILER_BYTES || !encrypted.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error("invalid backup magic or truncated file");
  const headerLength = encrypted.readUInt32BE(BACKUP_MAGIC.length);
  const headerStart = BACKUP_MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || headerEnd + AUTH_TAG_BYTES + TRAILER_BYTES > encrypted.length) throw new Error("invalid backup header length");
  const headerBytes = encrypted.subarray(headerStart, headerEnd);
  let header;
  try { header = JSON.parse(headerBytes.toString("utf8")); } catch { throw new Error("invalid backup header"); }
  if (!header || Object.keys(header).sort().join(",") !== "createdAt,formatVersion,nonce,privacyGeneration"
    || header.formatVersion !== BACKUP_FORMAT_VERSION || !Number.isSafeInteger(header.createdAt) || header.createdAt <= 0
    || !Number.isSafeInteger(header.privacyGeneration) || header.privacyGeneration < 0
    || !/^[a-f0-9]{24}$/.test(header.nonce)) throw new Error("unsupported backup header");
  const nonce = Buffer.from(header.nonce, "hex");
  const tag = encrypted.subarray(encrypted.length - AUTH_TAG_BYTES);
  const ciphertext = encrypted.subarray(headerEnd, encrypted.length - AUTH_TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aadFor(headerBytes));
  decipher.setAuthTag(tag);
  let clear;
  try { clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]); }
  catch { throw new Error("backup authentication failed"); }
  try {
    if (clear.length < TRAILER_BYTES || !clear.subarray(clear.length - TRAILER_BYTES, clear.length - TRAILER_BYTES + 8).equals(TRAILER_MAGIC)) throw new Error("backup trailer invalid");
    const databaseBytes = Number(clear.readBigUInt64BE(clear.length - TRAILER_BYTES + 8));
    const database = clear.subarray(0, databaseBytes);
    const expectedHash = clear.subarray(clear.length - 32).toString("hex");
    if (!Number.isSafeInteger(databaseBytes) || databaseBytes !== clear.length - TRAILER_BYTES || crypto.createHash("sha256").update(database).digest("hex") !== expectedHash) throw new Error("backup plaintext hash mismatch");
    return { database: Buffer.from(database), metadata: { formatVersion: header.formatVersion, createdAt: header.createdAt, privacyGeneration: header.privacyGeneration, sha256: expectedHash } };
  } finally { clear.fill(0); }
}

function powershell(operation, input, scriptPath) {
  if (process.platform !== "win32") throw new Error("Windows DPAPI is required");
  const result = spawnSync(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Operation", operation], {
    input: input.toString("base64"), encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}\s*$/.test(result.stdout)) throw new Error("Windows DPAPI operation failed");
  return Buffer.from(result.stdout.trim(), "base64");
}

function secureAcl(target, kind, aclScript) {
  const result = spawnSync(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", aclScript, "-Path", target, "-Kind", kind], { encoding: "utf8", env: legacyPowerShellEnvironment(), windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("backup key ACL validation failed");
}

export function loadOrCreateDpapiKey({ keyDirectory = path.join(process.env.LOCALAPPDATA ?? "", "AltNotify", "keys"), protectorScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "dpapi-key.ps1"), aclScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "secure-offsite-key-acl.ps1") } = {}) {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) throw new Error("Windows user profile unavailable");
  fs.mkdirSync(keyDirectory, { recursive: true });
  const dirStat = fs.lstatSync(keyDirectory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("backup key directory invalid");
  const keyPath = path.join(keyDirectory, KEY_FILENAME);
  for (const entry of fs.readdirSync(keyDirectory)) {
    if (entry === KEY_FILENAME) continue;
    const entryPath = path.join(keyDirectory, entry);
    const entryStat = fs.lstatSync(entryPath);
    if (!entry.startsWith(`${KEY_FILENAME}.`) || !entry.endsWith(".partial") || !entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error("unexpected item in backup key directory");
    fs.rmSync(entryPath);
  }
  secureAcl(keyDirectory, "Directory", aclScript);
  if (fs.existsSync(keyPath)) {
    const stat = fs.lstatSync(keyPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("backup key file invalid");
    secureAcl(keyPath, "File", aclScript);
    const protectedKey = fs.readFileSync(keyPath);
    const key = powershell("unprotect", protectedKey, protectorScript);
    if (key.length !== KEY_BYTES) { key.fill(0); throw new Error("backup key length invalid"); }
    return key;
  }
  const plaintextKey = crypto.randomBytes(KEY_BYTES);
  try {
    const protectedKey = powershell("protect", plaintextKey, protectorScript);
    const temporary = `${keyPath}.${crypto.randomBytes(8).toString("hex")}.partial`;
    try {
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(descriptor, protectedKey); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      secureAcl(temporary, "File", aclScript);
      fs.renameSync(temporary, keyPath);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return Buffer.from(plaintextKey);
  } finally { plaintextKey.fill(0); }
}
