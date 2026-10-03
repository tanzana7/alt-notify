import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// HTTP is allowed only for an in-process loopback integration test. The CLI
// always requires HTTPS so a secret heartbeat URL cannot be sent in cleartext.
export async function probeHeartbeat(url, { timeoutMs = 5_000, allowHttp = false } = {}) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname))) return false;
    const response = await fetch(parsed, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    // Never expose URL, response body, or transport errors; the URL is a secret.
    return false;
  }
}

async function main() {
  if (process.argv.length !== 3) return false;
  try {
    const url = (await readFile(process.argv[2], 'utf8')).trim();
    return await probeHeartbeat(url);
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((accepted) => { process.exitCode = accepted ? 0 : 1; }, () => { process.exitCode = 1; });
}
