import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { SqliteDatabase } from "../src/db.js";
import { decryptBuffer, encryptBuffer, encryptReadableToFile, loadOrCreateDpapiKey } from "../deploy/offsite-backup-format.mjs";
import { runRestoreDrillFromBuffer } from "../dist/src/services/restore-drill.js";

const roots = [];
function temp() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-encrypted-backup-")); roots.push(directory); return directory; }
const metadata = { createdAt: Date.now(), privacyGeneration: 3 };
const key = () => crypto.randomBytes(32);
const sample = Buffer.from("SQLite backup fixture without user data");

afterEach(() => { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("encrypted Windows backup format", () => {
  it("round-trips AES-256-GCM with authenticated epoch metadata and plaintext hash", () => {
    const secret = key();
    const encrypted = encryptBuffer(sample, secret, metadata);
    const decoded = decryptBuffer(encrypted.bytes, secret);
    expect(decoded.database).toEqual(sample);
    expect(decoded.metadata).toEqual({ formatVersion: 1, ...metadata, sha256: crypto.createHash("sha256").update(sample).digest("hex") });
    secret.fill(0); decoded.database.fill(0);
  });

  it("rejects wrong keys, altered authenticated header/ciphertext, truncation, and bad magic/version", () => {
    const secret = key(); const wrong = key(); const encrypted = encryptBuffer(sample, secret, metadata);
    expect(() => decryptBuffer(encrypted.bytes, wrong)).toThrow();
    const altered = Buffer.from(encrypted.bytes); altered[20] ^= 1;
    expect(() => decryptBuffer(altered, secret)).toThrow();
    expect(() => decryptBuffer(encrypted.bytes.subarray(0, encrypted.bytes.length - 4), secret)).toThrow();
    const badMagic = Buffer.from(encrypted.bytes); badMagic[0] ^= 1;
    expect(() => decryptBuffer(badMagic, secret)).toThrow();
    const headerLength = encrypted.bytes.readUInt32BE(8); const headerEnd = 12 + headerLength;
    const header = JSON.parse(encrypted.bytes.subarray(12, headerEnd).toString("utf8")); header.formatVersion = 2;
    const headerBytes = Buffer.from(JSON.stringify(header)); const len = Buffer.alloc(4); len.writeUInt32BE(headerBytes.length);
    const malformed = Buffer.concat([encrypted.bytes.subarray(0, 8), len, headerBytes, encrypted.bytes.subarray(headerEnd)]);
    expect(() => decryptBuffer(malformed, secret)).toThrow();
    secret.fill(0); wrong.fill(0);
  });

  it("writes only ciphertext and removes partial files on remote hash mismatch", async () => {
    const directory = temp(); const destination = path.join(directory, "backup.enc.partial"); const secret = key();
    await expect(encryptReadableToFile(Readable.from([sample]), destination, secret, metadata, "0".repeat(64))).rejects.toThrow("hash");
    expect(fs.existsSync(destination)).toBe(false);
    await encryptReadableToFile(Readable.from([sample.subarray(0, 7), sample.subarray(7)]), destination, secret, metadata, crypto.createHash("sha256").update(sample).digest("hex"));
    expect(fs.readFileSync(destination).indexOf(sample)).toBe(-1);
    expect(decryptBuffer(fs.readFileSync(destination), secret).database).toEqual(sample);
    secret.fill(0);
  });

  it("refuses to restore when authenticated metadata is stale or privacy state is pending", () => {
    const secret = key(); const encrypted = encryptBuffer(sample, secret, metadata); const decoded = decryptBuffer(encrypted.bytes, secret);
    const state = { generation: 4, lastDeletionAt: metadata.createdAt + 1, cleanupPending: false, databaseDeleted: false };
    return expect(runRestoreDrillFromBuffer(decoded.database, "fixture", decoded.metadata, state)).rejects.toThrow("predates");
  });

  it("passes encrypted database bytes through the production-path restore drill without a plaintext file", async () => {
    const directory = temp(); const sourcePath = path.join(directory, "source.sqlite");
    const sourceDb = await SqliteDatabase.open(sourcePath); sourceDb.close();
    const raw = fs.readFileSync(sourcePath); fs.rmSync(sourcePath);
    const secret = key(); const encrypted = encryptBuffer(raw, secret, metadata); const decoded = decryptBuffer(encrypted.bytes, secret);
    expect(fs.readdirSync(directory)).toEqual([]);
    const state = { generation: metadata.privacyGeneration, lastDeletionAt: metadata.createdAt, cleanupPending: false, databaseDeleted: false };
    const result = await runRestoreDrillFromBuffer(decoded.database, "windows encrypted", decoded.metadata, state);
    expect(result).toMatchObject({ integrity: "ok", databaseOpen: "ok", servicesInitialized: "ok", counts: { mains: 0, links: 0 } });
    expect(fs.readdirSync(directory)).toEqual([]);
    decoded.database.fill(0); raw.fill(0); secret.fill(0);
  });

  it("rejects authenticated ciphertext whose decrypted bytes are not a valid production database", async () => {
    const secret = key(); const encrypted = encryptBuffer(Buffer.from("not a SQLite database"), secret, metadata);
    const decoded = decryptBuffer(encrypted.bytes, secret);
    const state = { generation: metadata.privacyGeneration, lastDeletionAt: 0, cleanupPending: false, databaseDeleted: false };
    await expect(runRestoreDrillFromBuffer(decoded.database, "corrupt fixture", decoded.metadata, state)).rejects.toThrow();
    decoded.database.fill(0); secret.fill(0);
  });

  it.skipIf(process.platform !== "win32")("protects a random key with CurrentUser DPAPI and verified ACLs", () => {
    const directory = temp(); const keyDir = path.join(directory, "protected-key");
    const first = loadOrCreateDpapiKey({ keyDirectory: keyDir });
    const protectedFile = path.join(keyDir, "offsite-backup-key.dpapi");
    const blob = fs.readFileSync(protectedFile);
    expect(blob.length).toBeGreaterThan(32);
    expect(blob).not.toEqual(first);
    const second = loadOrCreateDpapiKey({ keyDirectory: keyDir });
    expect(second).toEqual(first);
    first.fill(0); second.fill(0);
  }, 30_000);
});
