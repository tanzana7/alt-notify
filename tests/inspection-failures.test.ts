import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InspectionFailures } from "../src/services/inspection-failures.js";
import { SqliteDatabase } from "../src/db.js";
import { HealthcheckService } from "../src/services/healthcheck.js";
import { Logger } from "../src/logger.js";

const fixtures: Array<{ db: SqliteDatabase; directory: string }> = [];
afterEach(() => { for (const { db, directory } of fixtures.splice(0)) { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } });

describe("unexpected MessageCreate inspection failures", () => {
  it("persists only timestamps across restart and clears the unhealthy window after 15 minutes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-inspection-"));
    const db = await SqliteDatabase.open(path.join(directory, "db.sqlite")); fixtures.push({ db, directory });
    let now = 1_000_000;
    const file = path.join(directory, "inspection-failures.json");
    const initial = new InspectionFailures(file, () => now);
    const requests: string[] = [];
    const health = new HealthcheckService(db, new Logger("error"), "https://healthchecks.example/fixture", 200, 5,
      async (url) => { requests.push(url); return true; }, () => now,
      { inspectionFailures: initial, maxInspectionFailuresIn15m: 1 });
    expect((await health.check(true)).healthy).toBe(true);
    expect(initial.record()).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(`[${now}]`);
    const restarted = new InspectionFailures(file, () => now);
    expect(restarted.count()).toBe(1);
    expect(await health.check(true)).toMatchObject({ healthy: false, reason: "inspection_failure_threshold", snapshot: { inspectionFailuresIn15m: 1 } });
    expect(requests.at(-1)).toContain("/fail");
    now += 15 * 60_000 + 1;
    expect(restarted.count()).toBe(0);
    expect((await health.check(true)).healthy).toBe(true);
  });

  it("fails closed when the status file is corrupt", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "altnoti-inspection-"));
    const db = await SqliteDatabase.open(path.join(directory, "db.sqlite")); fixtures.push({ db, directory });
    const file = path.join(directory, "inspection-failures.json"); fs.writeFileSync(file, "not-json");
    const health = new HealthcheckService(db, new Logger("error"), "https://healthchecks.example/fixture", 200, 5, async () => true, () => 1_000_000,
      { inspectionFailures: new InspectionFailures(file, () => 1_000_000) });
    expect(await health.check(true)).toMatchObject({ healthy: false, reason: "inspection_failure_threshold" });
  });
});
