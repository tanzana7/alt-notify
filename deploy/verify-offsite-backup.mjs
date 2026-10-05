#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decryptBuffer, loadOrCreateDpapiKey } from "./offsite-backup-format.mjs";
import { runRestoreDrillFromBuffer } from "../dist/src/services/restore-drill.js";

const HOST = "151.145.66.148";

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) throw new Error("restore validation failed");
  return String(result.stdout).trim();
}

async function main() {
  const name = process.argv[2];
  if (process.argv.length !== 3 || !/^discord-alt-notify-\d{8}-\d{6}\.sqlite\.enc$/.test(name ?? "")) {
    console.error("Usage: node deploy/verify-offsite-backup.mjs <encrypted-backup-name>"); process.exitCode = 2; return;
  }
  let key;
  let decoded;
  let encrypted;
  try {
    const directory = path.join(process.env.LOCALAPPDATA ?? "", "AltNotify", "offsite-backups");
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid encrypted backup");
    const protectedKeyPath = path.join(process.env.LOCALAPPDATA ?? "", "AltNotify", "keys", "offsite-backup-key.dpapi");
    if (!fs.existsSync(protectedKeyPath)) throw new Error("protected backup key missing");
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const keyPath = capture(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(path.dirname(fileURLToPath(import.meta.url)), "resolve-oracle-key.ps1")]);
    const stateText = capture("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-i", keyPath, `ubuntu@${HOST}`, "sudo -n /usr/local/sbin/altnoti-privacy status"]);
    const state = JSON.parse(stateText);
    key = loadOrCreateDpapiKey();
    encrypted = fs.readFileSync(file);
    decoded = decryptBuffer(encrypted, key);
    const stamp = Date.parse(`${name.slice(19, 23)}-${name.slice(23, 25)}-${name.slice(25, 27)}T${name.slice(28, 30)}:${name.slice(30, 32)}:${name.slice(32, 34)}Z`);
    if (decoded.metadata.createdAt < stamp || decoded.metadata.createdAt >= stamp + 5 * 60_000) throw new Error("backup timestamp invalid");
    const result = await runRestoreDrillFromBuffer(decoded.database, "Windows encrypted", decoded.metadata, state);
    process.stdout.write(`${JSON.stringify({ integrity: result.integrity, requiredTables: result.requiredTables, databaseOpen: result.databaseOpen, servicesInitialized: result.servicesInitialized })}\n`);
  } catch {
    console.error("Encrypted restore drill failed; source details omitted."); process.exitCode = 1;
  } finally {
    decoded?.database.fill(0); encrypted?.fill(0); key?.fill(0);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
