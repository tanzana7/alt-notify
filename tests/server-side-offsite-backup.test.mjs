import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { R2Client, R2RequestError, r2ConfigFromEnv } from "../deploy/r2-client.mjs";
import { initializePrivacyState } from "../deploy/privacy-deletion-state.mjs";
import { readOffsiteStatus } from "../deploy/offsite-status.mjs";
import { runOffsiteBackup, retentionKeys } from "../deploy/oracle-offsite-backup.mjs";

const roots = [];
const require = createRequire(import.meta.url);
const SQL = await initSqlJs({ locateFile: (file) => path.join(path.dirname(require.resolve("sql.js")), file) });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-r2-offsite-"));
  roots.push(root);
  const backupDirectory = path.join(root, "backups");
  const privacyDirectory = path.join(root, "privacy");
  const statusDirectory = path.join(root, "status");
  fs.mkdirSync(backupDirectory); fs.mkdirSync(privacyDirectory); fs.mkdirSync(statusDirectory);
  initializePrivacyState(privacyDirectory);
  const db = new SQL.Database();
  db.run("CREATE TABLE main_accounts (user_id TEXT, username TEXT, created_at INTEGER); CREATE TABLE account_links (sub_user_id TEXT); CREATE TABLE notification_queue (status TEXT, available_at INTEGER); CREATE TABLE notification_dedup (id TEXT); CREATE TABLE guild_watches (id TEXT); CREATE TABLE entitlements (id TEXT);");
  const bytes = Buffer.from(db.export()); db.close();
  const createdAt = Date.parse("2026-10-13T04:00:01Z");
  const name = "discord-alt-notify-20261013-040000.sqlite";
  fs.writeFileSync(path.join(backupDirectory, name), bytes, { mode: 0o600 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(backupDirectory, `${name}.meta.json`), JSON.stringify({ formatVersion: 1, createdAt, privacyGeneration: 0, sha256 }));
  return { root, backupDirectory, privacyDirectory, statusDirectory, name, bytes };
}

class FakeR2 {
  constructor() { this.objects = new Map(); this.fail = new Set(); }
  async putObject(key, bytes, metadata) { if (this.fail.has("put")) throw new Error("R2 put transport failed"); this.objects.set(key, { body: Buffer.from(bytes), metadata: { ...metadata } }); }
  async headObject(key) { if (this.fail.has("head")) throw new Error("R2 head transport failed"); const object = this.objects.get(key); if (!object) throw new R2RequestError(404, "head"); return { headers: { "content-length": String(object.body.length), ...Object.fromEntries(Object.entries(object.metadata).map(([name, value]) => [`x-amz-meta-${name}`, value])) } }; }
  async getObject(key) { if (this.fail.has("get")) throw new Error("R2 download transport failed"); const object = this.objects.get(key); if (!object) throw new R2RequestError(404, "get"); return { body: Buffer.from(object.body), headers: { "content-length": String(object.body.length), ...Object.fromEntries(Object.entries(object.metadata).map(([name, value]) => [`x-amz-meta-${name}`, value])) } }; }
  async deleteObject(key) { if (this.fail.has("delete")) throw new Error("R2 delete transport failed"); this.objects.delete(key); }
  async listObjects(prefix) { return { keys: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).filter((key) => !key.endsWith(".uploading")), truncated: false }; }
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("server-side R2 offsite backup", () => {
  it("uploads, verifies, downloads, restores separately, and records only after success", async () => {
    const f = fixture();
    const client = new FakeR2();
    const restore = async (bytes, source, metadata, state) => { expect(source).toBe("R2 encrypted backup"); expect(bytes.length).toBeGreaterThan(0); expect(metadata.privacyGeneration).toBe(state.generation); };
    const result = await runOffsiteBackup({ client, ...f, key: Buffer.alloc(32, 7), restore, now: Date.parse("2026-10-13T05:00:00Z") });
    expect(result.finalKey).toMatch(/^backups\/2026\/10\/alt-notify-20261013-040001\.sqlite\.enc$/);
    expect(result.cleanupWarnings).toEqual([]);
    expect([...client.objects.keys()]).toEqual([result.finalKey]);
    expect(readOffsiteStatus(f.statusDirectory)).toMatchObject({ state: "ok", remoteVerified: true, restoreVerified: true, provider: "cloudflare-r2" });
  });

  it.each(["put", "head", "get"])("does not mark success when R2 %s fails", async (operation) => {
    const f = fixture(); const client = new FakeR2(); client.fail.add(operation);
    await expect(runOffsiteBackup({ client, ...f, key: Buffer.alloc(32, 3), restore: async () => undefined })).rejects.toThrow();
    expect(readOffsiteStatus(f.statusDirectory)?.state).toBe("failed");
    expect([...client.objects.keys()].every((key) => !key.endsWith(".uploading"))).toBe(true);
  });

  it("does not mark success when downloaded ciphertext cannot decrypt", async () => {
    const f = fixture(); const client = new FakeR2();
    const original = client.getObject.bind(client);
    client.getObject = async (key) => { const result = await original(key); result.body[20] ^= 0xff; return result; };
    await expect(runOffsiteBackup({ client, ...f, key: Buffer.alloc(32, 5), restore: async () => undefined })).rejects.toThrow();
    expect(readOffsiteStatus(f.statusDirectory)?.state).toBe("failed");
  });

  it("fails closed on restore integrity or privacy errors", async () => {
    for (const message of ["database integrity check failed", "privacy generation mismatch"]) {
      const f = fixture(); const client = new FakeR2();
      await expect(runOffsiteBackup({ client, ...f, key: Buffer.alloc(32, 9), restore: async () => { throw new Error(message); } })).rejects.toThrow(message);
      expect(readOffsiteStatus(f.statusDirectory)?.state).toBe("failed");
    }
  });

  it("keeps backup success when only retention cleanup fails", async () => {
    const f = fixture(); const client = new FakeR2(); client.fail.add("delete");
    client.objects.set("backups/2026/09/alt-notify-20260901-000000.sqlite.enc", { body: Buffer.from("old"), metadata: {} });
    const result = await runOffsiteBackup({ client, ...f, key: Buffer.alloc(32, 1), restore: async () => undefined });
    expect(result.cleanupWarnings).toContain("retention_cleanup_failed");
    expect(readOffsiteStatus(f.statusDirectory)?.state).toBe("ok");
  });

  it("retains the newest object and at most fourteen recent generations", () => {
    const now = Date.parse("2026-10-13T05:00:00Z");
    const keys = Array.from({ length: 16 }, (_, index) => `backups/2026/10/alt-notify-202610${String(13 - Math.floor(index / 4)).padStart(2, "0")}-${String(index).padStart(6, "0")}.sqlite.enc`);
    const result = retentionKeys(keys, now);
    expect(result.keep.size).toBeLessThanOrEqual(14);
    expect(result.keep.has(keys[0])).toBe(true);
    expect(result.remove.every((key) => key.includes("alt-notify-"))).toBe(true);
  });

  it("rejects incomplete R2 configuration without exposing secret values", () => {
    expect(() => r2ConfigFromEnv({ ALTN_R2_ENDPOINT: "https://example.invalid", ALTN_R2_BUCKET: "alt-notify-backups", ALTN_R2_ACCESS_KEY_ID: "" })).toThrow("R2 configuration unavailable");
  });

  it("uses a non-privileged HTTP client contract with no secret in errors", async () => {
    const client = new R2Client({ endpoint: "http://127.0.0.1", bucket: "bucket", accessKeyId: "access", secretAccessKey: "secret" });
    await expect(client.headObject("backup")).rejects.toThrow(/R2 head transport failed|R2 head failed/);
    try { await client.headObject("backup"); } catch (error) { expect(error.message).not.toContain("secret"); }
  });
});
