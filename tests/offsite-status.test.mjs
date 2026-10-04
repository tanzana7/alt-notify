import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OFFSITE_STATUS_FILENAME, readOffsiteStatus, writeOffsiteStatus } from "../deploy/offsite-status.mjs";

const directories = [];
function directory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-offsite-status-"));
  directories.push(value);
  return value;
}
afterEach(() => { for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

describe("offsite status atomic state", () => {
  it("writes a regular status file atomically and preserves the last success on failure", () => {
    const dir = directory();
    writeOffsiteStatus(dir, "ok", undefined, 1000);
    expect(readOffsiteStatus(dir)).toEqual({ state: "ok", lastAttemptAt: 1000, lastSuccessAt: 1000 });
    writeOffsiteStatus(dir, "failed", "transfer_failed", 2000);
    expect(readOffsiteStatus(dir)).toEqual({ state: "failed", lastAttemptAt: 2000, lastSuccessAt: 1000, failureCode: "transfer_failed" });
    expect(fs.readdirSync(dir)).toEqual([OFFSITE_STATUS_FILENAME]);
    expect(fs.lstatSync(path.join(dir, OFFSITE_STATUS_FILENAME)).isFile()).toBe(true);
  });

  it("clears an earlier failure on the next success", () => {
    const dir = directory();
    writeOffsiteStatus(dir, "failed", "prepare_failed", 1000);
    expect(readOffsiteStatus(dir)?.lastSuccessAt).toBeNull();
    writeOffsiteStatus(dir, "ok", undefined, 2000);
    expect(readOffsiteStatus(dir)).toEqual({ state: "ok", lastAttemptAt: 2000, lastSuccessAt: 2000 });
  });

  it("rejects arbitrary failure codes without changing prior state", () => {
    const dir = directory(); writeOffsiteStatus(dir, "ok", undefined, 1000);
    expect(() => writeOffsiteStatus(dir, "failed", "C:\\secret\\key", 2000)).toThrow("invalid failure code");
    expect(readOffsiteStatus(dir)?.state).toBe("ok");
  });

  it.skipIf(process.platform === "win32")("rejects a symlink status target", () => {
    const dir = directory();
    const target = path.join(dir, "target.json"); fs.writeFileSync(target, "private");
    fs.symlinkSync(target, path.join(dir, OFFSITE_STATUS_FILENAME));
    expect(() => writeOffsiteStatus(dir, "ok", undefined, 1000)).toThrow("status file must be regular");
    expect(fs.readFileSync(target, "utf8")).toBe("private");
  });

  it.skipIf(process.platform === "win32")("rejects a symlink parent directory", () => {
    const dir = directory(); const real = path.join(dir, "real"); fs.mkdirSync(real);
    const alias = path.join(dir, "alias"); fs.symlinkSync(real, alias, "dir");
    expect(() => writeOffsiteStatus(alias, "ok", undefined, 1000)).toThrow("status directory must be regular");
    expect(fs.readdirSync(real)).toEqual([]);
  });
});
