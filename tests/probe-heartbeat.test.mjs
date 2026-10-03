import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { probeHeartbeat } from '../deploy/probe-heartbeat.mjs';

const servers = [];
const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(() => done()))));
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function listen(server, scheme = 'http') {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  return `${scheme}://127.0.0.1:${address.port}/secret-fixture`;
}

async function localServer(status, delayMs = 0) {
  return listen(createServer((_request, response) => {
    setTimeout(() => { response.writeHead(status); response.end('private response body'); }, delayMs);
  }));
}

function opensslBinary() {
  const candidates = [process.env.OPENSSL_BIN, 'openssl'];
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (root) candidates.push(join(root, 'Git', 'usr', 'bin', 'openssl.exe'));
    }
  }
  for (const candidate of candidates.filter(Boolean)) {
    if (spawnSync(candidate, ['version'], { stdio: 'ignore' }).status === 0) return candidate;
  }
  throw new Error('OpenSSL is required for the HTTPS probe integration tests');
}

function tlsCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'altnoti-tls-'));
  temporaryDirectories.push(dir);
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const result = spawnSync(opensslBinary(), [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ], { stdio: 'ignore' });
  if (result.status !== 0) throw new Error('could not generate a test TLS certificate');
  return { dir, key, cert };
}

async function runHttpsCli(url, cert, dir) {
  const file = join(dir, 'url');
  writeFileSync(file, url, { mode: 0o600 });
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: cert };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  // The TLS server runs in this process; a synchronous child would block it.
  const child = spawn(process.execPath, [resolve('deploy/probe-heartbeat.mjs'), file], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
  const timeout = setTimeout(() => child.kill(), 8_000);
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', done);
    });
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); }
}

describe('heartbeat probe', () => {
  it('accepts HTTP 2xx from an in-process loopback server', async () => {
    expect(await probeHeartbeat(await localServer(204), { allowHttp: true })).toBe(true);
  });
  it.each([400, 429, 500, 503])('rejects HTTP %i', async (status) => {
    expect(await probeHeartbeat(await localServer(status), { allowHttp: true })).toBe(false);
  });
  it.each([301, 302, 303, 307, 308])('rejects HTTP %i without contacting the redirect target', async (status) => {
    let targetHits = 0;
    const target = await listen(createServer((_request, response) => {
      targetHits += 1;
      response.writeHead(204);
      response.end();
    }));
    const source = await listen(createServer((_request, response) => {
      response.writeHead(status, { Location: target });
      response.end();
    }));
    expect(await probeHeartbeat(source, { allowHttp: true })).toBe(false);
    expect(targetHits).toBe(0);
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
  it('accepts a trusted local HTTPS 204 through the production CLI without printing the URL', async () => {
    const { dir, key, cert } = tlsCertificate();
    const url = await listen(createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
      response.writeHead(204);
      response.end();
    }), 'https');
    const result = await runHttpsCli(url, cert, dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
  it('rejects an HTTPS-to-HTTP redirect without contacting the target or printing the URL', async () => {
    const { dir, key, cert } = tlsCertificate();
    let targetHits = 0;
    const target = await listen(createServer((_request, response) => {
      targetHits += 1;
      response.writeHead(204);
      response.end();
    }));
    const url = await listen(createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
      response.writeHead(302, { Location: target });
      response.end();
    }), 'https');
    const result = await runHttpsCli(url, cert, dir);
    expect(result.code).toBe(1);
    expect(targetHits).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
