import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "tests", "recovery-scripts.sh");
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
const result = spawnSync(bash, [script], { cwd: root, stdio: "inherit" });
if (result.error) {
  console.error("could not run recovery tests");
  process.exit(1);
}
process.exit(result.status ?? 1);
