import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { cleanupLegacyPlaintext, pruneEncrypted } from "../deploy/pull-offsite-backup.mjs";
import { encryptBuffer } from "../deploy/offsite-backup-format.mjs";

describe("encrypted Windows offsite backup flow", () => {
  const source = fs.readFileSync(path.resolve("deploy/pull-offsite-backup.mjs"), "utf8");

  it("verifies encrypted bytes with the production restore path before removing legacy plaintext", () => {
    const restore = source.indexOf("runRestoreDrillFromBuffer(decoded.database");
    const commitEncrypted = source.indexOf("fs.renameSync(partialPath, finalPath)");
    const removeLegacy = source.indexOf("const plainRemoved = cleanupLegacyPlaintext(directory)");
    const prune = source.indexOf("pruneEncrypted(directory, key, privacyGeneration)");
    const markSuccess = source.indexOf("mark-success ${remoteName}");
    expect(restore).toBeGreaterThan(-1);
    expect(commitEncrypted).toBeGreaterThan(restore);
    expect(removeLegacy).toBeGreaterThan(commitEncrypted);
    expect(prune).toBeGreaterThan(removeLegacy);
    expect(markSuccess).toBeGreaterThan(prune);
    expect(source).toContain("encryptReadableToFile(ssh.stdout, partialPath");
  });

  it("keeps plaintext out of final backup names and reports failures without secret details", () => {
    expect(source).toContain("${remoteName}.enc");
    expect(source).toContain("${remoteName}.enc.partial");
    expect(source).not.toMatch(/scp\s/);
    expect(source).toContain("VM外バックアップに失敗しました。詳細を含まない固定エラーです。");
    expect(source).toContain("mark-failure ${code}");
  });

  it("removes legacy plaintext only after a current encrypted backup is present and keeps that safe copy", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-migration-test-"));
    const key = crypto.randomBytes(32);
    try {
      const time = Date.now();
      const stamp = new Date(time).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
      const basename = `discord-alt-notify-${stamp}.sqlite`;
      const encryptedName = `${basename}.enc`;
      fs.writeFileSync(path.join(directory, basename), "legacy-plaintext-fixture");
      const encrypted = encryptBuffer(Buffer.from("verified sqlite fixture"), key, { createdAt: time, privacyGeneration: 9 });
      fs.writeFileSync(path.join(directory, encryptedName), encrypted.bytes);
      expect(cleanupLegacyPlaintext(directory)).toBe(1);
      expect(fs.readdirSync(directory)).toEqual([encryptedName]);
      expect(pruneEncrypted(directory, key, 9, time)).toBe(1);
      expect(fs.readdirSync(directory)).toEqual([encryptedName]);
    } finally {
      key.fill(0);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
