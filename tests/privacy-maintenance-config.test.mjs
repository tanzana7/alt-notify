import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("systemd privacy maintenance integration", () => {
  it("permits only the fixed root helper commands needed by the Bot", () => {
    const dropIn = fs.readFileSync("deploy/alt-notify-privacy-sudo.conf", "utf8");
    const sudoers = fs.readFileSync("deploy/altnoti-privacy.sudoers", "utf8");
    const entry = fs.readFileSync("src/index.ts", "utf8");
    expect(dropIn).toMatch(/^NoNewPrivileges=no$/m);
    for (const command of ["begin", "database-deleted", "finish", "status"]) {
      expect(sudoers).toContain(`/usr/local/sbin/altnoti-privacy ${command}`);
      expect(entry).toContain(`"/usr/local/sbin/altnoti-privacy", "${command}"`);
    }
    expect(sudoers).not.toContain("*");
    expect(sudoers).not.toContain("/bin/sh");
  });
});
