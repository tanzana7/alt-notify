import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { probeHeartbeat } from '../deploy/probe-heartbeat.mjs';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(() => done()))));
});

async function localServer(status, delayMs = 0) {
  const server = createServer((_request, response) => {
    setTimeout(() => { response.writeHead(status); response.end('private response body'); }, delayMs);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  return `http://127.0.0.1:${address.port}/secret-fixture`;
}

describe('heartbeat probe', () => {
  it('accepts HTTP 2xx from an in-process loopback server', async () => {
    expect(await probeHeartbeat(await localServer(204), { allowHttp: true })).toBe(true);
  });
  it.each([400, 429, 500, 503])('rejects HTTP %i', async (status) => {
    expect(await probeHeartbeat(await localServer(status), { allowHttp: true })).toBe(false);
  });
  it('does not print a secret URL or response body during a real failed fetch', async () => {
    const url = await localServer(500);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await probeHeartbeat(url, { allowHttp: true })).toBe(false);
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally { out.mockRestore(); err.mockRestore(); }
  });
  it('times out without disclosing the URL or response', async () => {
    expect(await probeHeartbeat(await localServer(200, 100), { allowHttp: true, timeoutMs: 10 })).toBe(false);
  });
  it('rejects connection failures', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const port = address.port;
    await new Promise((done) => server.close(() => done()));
    expect(await probeHeartbeat(`http://127.0.0.1:${port}/secret`, { allowHttp: true, timeoutMs: 100 })).toBe(false);
  });
  it('requires HTTPS in the CLI and keeps secrets out of stdout and stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'altnoti-probe-'));
    const secretUrl = 'http://127.0.0.1:1/secret-heartbeat-fixture';
    const file = join(dir, 'url');
    try {
      writeFileSync(file, secretUrl, { mode: 0o600 });
      const result = spawnSync(process.execPath, [resolve('deploy/probe-heartbeat.mjs'), file], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      writeFileSync(file, 'https://127.0.0.1:1/secret-heartbeat-fixture');
      const fetchFailure = spawnSync(process.execPath, [resolve('deploy/probe-heartbeat.mjs'), file], { encoding: 'utf8' });
      expect(fetchFailure.status).toBe(1);
      expect(fetchFailure.stdout).toBe('');
      expect(fetchFailure.stderr).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
