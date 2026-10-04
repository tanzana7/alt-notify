import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scripts = ["recovery-scripts.sh", "backup-retention.sh"].map((name) => join(root, "tests", name));
const candidates = process.platform === "win32"
  ? [
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe")
    ]
  : ["bash"];
const bash = candidates.find((candidate) => candidate === "bash" || existsSync(candidate));
if (!bash) {
  console.error("recovery tests require Git Bash on Windows");
  process.exit(1);
}
for (const script of scripts) {
  const result = spawnSync(bash, [script], { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error("could not run operational tests");
    process.exit(result.status ?? 1);
  }
}
