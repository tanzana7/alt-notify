#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runRestoreDrill } from "../dist/src/services/restore-drill.js";

async function main() {
  if (process.argv.length !== 4 || !["oracle", "windows"].includes(process.argv[3])) {
    console.error("Usage: node deploy/verify-restore.mjs <backup-path> <oracle|windows>");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runRestoreDrill(process.argv[2], process.argv[3]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    console.error("Restore drill failed; source details omitted.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
