#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPrivacyState, validateOracleBackup, ORACLE_BACKUP_DIRECTORY, PRIVACY_STATE_DIRECTORY } from "./privacy-deletion-state.mjs";
import { runRestoreDrillFromBuffer } from "../dist/src/services/restore-drill.js";

async function main() {
  const name = process.argv[2];
  if (process.argv.length !== 3 || !/^discord-alt-notify-\d{8}-\d{6}\.sqlite$/.test(name ?? "")) {
    console.error("Usage: node deploy/verify-restore.mjs <Oracle-backup-name>");
    process.exitCode = 2;
    return;
  }
  try {
    const metadata = validateOracleBackup(PRIVACY_STATE_DIRECTORY, ORACLE_BACKUP_DIRECTORY, name);
    const state = readPrivacyState(PRIVACY_STATE_DIRECTORY);
    const file = path.join(ORACLE_BACKUP_DIRECTORY, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid backup");
    const bytes = fs.readFileSync(file);
    try {
      const result = await runRestoreDrillFromBuffer(bytes, "Oracle", metadata, state);
      process.stdout.write(`${JSON.stringify({ source: result.source, integrity: result.integrity, requiredTables: result.requiredTables, databaseOpen: result.databaseOpen, servicesInitialized: result.servicesInitialized, elapsedMs: result.elapsedMs })}\n`);
    } finally { bytes.fill(0); }
  } catch {
    console.error("Restore drill failed; source details omitted.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
