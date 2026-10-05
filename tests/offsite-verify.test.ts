import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

describe("offsite restore-candidate verification", () => {
  it("keeps scheduled PowerShell entrypoints readable in Windows PowerShell 5.1 and runnable on battery", () => {
    for (const script of ["resolve-oracle-key.ps1", "install-offsite-task.ps1"]) {
      const bytes = fs.readFileSync(path.resolve("deploy", script));
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    }
    expect(fs.readFileSync(path.resolve("deploy/install-offsite-task.ps1"), "utf8")).toContain("-AllowStartIfOnBatteries");
  });

  it.skipIf(process.platform !== "win32")("prefers the OneDrive-independent SSH key path", () => {
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", path.resolve("tests/ssh-resolver.ps1")], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS SSH key resolver priority");
  });

  it("routes scheduled backup work through the encrypted Node implementation", () => {
    const wrapper = fs.readFileSync(path.resolve("deploy/pull-offsite-backup.ps1"), "utf8");
    expect(wrapper).toContain("pull-offsite-backup.mjs");
    expect(wrapper).not.toContain("scp ");
    expect(fs.readFileSync(path.resolve("deploy/verify-offsite-backup.mjs"), "utf8")).toContain("decryptBuffer");
    expect(fs.readFileSync(path.resolve("deploy/verify-offsite-backup.mjs"), "utf8")).toContain("runRestoreDrillFromBuffer");
  });
});
