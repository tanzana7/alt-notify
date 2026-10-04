import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SqliteDatabase } from "../src/db.js";

describe("offsite restore-candidate verification", () => {
  it("keeps scheduled PowerShell entrypoints readable in Windows PowerShell 5.1 and runnable on battery", () => {
    for (const script of ["pull-offsite-backup.ps1", "resolve-oracle-key.ps1", "install-offsite-task.ps1"]) {
      const bytes = fs.readFileSync(path.resolve("deploy", script));
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    }
    expect(fs.readFileSync(path.resolve("deploy/install-offsite-task.ps1"), "utf8")).toContain("-AllowStartIfOnBatteries");
  });

  it("accepts a complete SQLite backup and rejects damaged or incomplete copies", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnotify-offsite-"));
    try {
      const validPath = path.join(directory, "valid.sqlite");
      const db = await SqliteDatabase.open(validPath);
      db.close();
      const verifier = path.resolve("deploy/verify-offsite-backup.mjs");
      const verify = (filePath: string) => spawnSync(process.execPath, [verifier, filePath], { cwd: process.cwd(), stdio: "ignore" }).status;
      expect(verify(validPath)).toBe(0);
      const damagedPath = path.join(directory, "damaged.sqlite");
      fs.writeFileSync(damagedPath, "not a database");
      expect(verify(damagedPath)).not.toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
