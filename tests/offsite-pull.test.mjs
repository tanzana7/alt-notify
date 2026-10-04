import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const run = (scenario) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-pull-mock-"));
  try {
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", path.resolve("tests/offsite-pull-mock.ps1"), scenario, directory], { encoding: "utf8" });
    if (!result.stdout.trim()) throw new Error(`mock harness produced no result: ${result.stderr.slice(0, 500)}`);
    return { status: result.status, output: JSON.parse(result.stdout.trim()) };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
};

describe.skipIf(process.platform !== "win32")("Windows offsite pull status markers", () => {
  it("marks success only after the verified copy is saved", () => {
    const result = run("success");
    expect(result).toMatchObject({ status: 0, output: { succeeded: true, successMarks: 1, failureMarks: [], verifierCalls: 1, earlySuccessMark: false, finalExists: true } });
  });

  it.each([
    ["transfer_failure", "transfer_failed"],
    ["hash_mismatch", "hash_mismatch"],
    ["sqlite_invalid", "sqlite_invalid"],
    ["failure_ssh_down", "transfer_failed"]
  ])("preserves %s failure without marking success", (scenario, code) => {
    const result = run(scenario);
    expect(result).toMatchObject({ status: 1, output: { succeeded: false, successMarks: 0, failureMarks: [code], finalExists: false } });
    expect(result.output.message).toBeTruthy();
  });
});
