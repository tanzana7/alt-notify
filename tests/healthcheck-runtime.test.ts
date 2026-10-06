import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { SqliteDatabase } from "../src/db.js";
import { Logger } from "../src/logger.js";
import { HealthcheckService } from "../src/services/healthcheck.js";

type LocalServer = HttpServer | HttpsServer;
const servers: LocalServer[] = [];
let db: SqliteDatabase;
let dbDir: string;
let certDir: string;
let cert: string;
let key: string;
let originalCAs: string[];

function opensslBinary(): string {
  const candidates = [process.env.OPENSSL_BIN, "openssl"];
  if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (root) candidates.push(join(root, "Git", "usr", "bin", "openssl.exe"));
    }
  }
  for (const candidate of candidates) {
    if (candidate && spawnSync(candidate, ["version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  throw new Error("OpenSSL is required for the HTTPS heartbeat integration test");
}

async function listen(server: LocalServer, scheme: "http" | "https" = "http"): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  return `${scheme}://127.0.0.1:${address.port}/secret-heartbeat-fixture`;
}

function runtimeHeartbeat(url: string, maxPending = 200): HealthcheckService {
  // Omit the request argument so each assertion exercises the production fetch.
  return new HealthcheckService(db, new Logger("warn"), url, maxPending, 5);
}

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "altnoti-heartbeat-db-"));
  db = await SqliteDatabase.open(join(dbDir, "test.sqlite"));
  certDir = mkdtempSync(join(tmpdir(), "altnoti-heartbeat-tls-"));
  key = join(certDir, "key.pem");
  cert = join(certDir, "cert.pem");
  const generated = spawnSync(opensslBinary(), [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"
  ], { stdio: "ignore" });
  if (generated.status !== 0) throw new Error("could not generate a test TLS certificate");
  // This Vitest file runs in its own worker. Trust only this ephemeral local
  // certificate in addition to the normal CAs, then restore the process state.
  originalCAs = getCACertificates("default");
  setDefaultCACertificates([...originalCAs, readFileSync(cert, "utf8")]);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

afterAll(() => {
  if (originalCAs) setDefaultCACertificates(originalCAs);
  db?.close();
  if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

describe("runtime heartbeat default request", () => {
  it("accepts a direct 2xx from the configured endpoint", async () => {
    const url = await listen(createHttpServer((_request, response) => {
      response.writeHead(204);
      response.end();
    }));
    await expect(runtimeHeartbeat(url).check(true)).resolves.toMatchObject({ healthy: true, requestSent: true, reason: "ok" });
  });

  it("accepts a direct trusted HTTPS 2xx", async () => {
    const url = await listen(createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
      response.writeHead(204);
      response.end();
    }), "https");
    await expect(runtimeHeartbeat(url).check(true)).resolves.toMatchObject({ healthy: true, requestSent: true, reason: "ok" });
  });

  it("uses a TLS-verified IPv4 retry only after a transport failure", async () => {
    const url = await listen(createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
      response.writeHead(204); response.end();
    }), "https");
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async () => { throw new TypeError("simulated address timeout"); });
    try { await expect(runtimeHeartbeat(url).check(true)).resolves.toMatchObject({ healthy: true, requestSent: true }); }
    finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it.each([404, 503])("rejects a direct HTTP %i", async (status) => {
    const url = await listen(createHttpServer((_request, response) => {
      response.writeHead(status);
      response.end("private response body");
    }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(runtimeHeartbeat(url).check(true)).resolves.toMatchObject({ healthy: false, requestSent: true, reason: "healthcheck_request_failed" });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(url);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private response body");
    } finally { warning.mockRestore(); }
  });

  it.each([301, 302, 303, 307, 308])("rejects HTTP %i without contacting the redirect target", async (status) => {
    let targetHits = 0;
    const target = await listen(createHttpServer((_request, response) => {
      targetHits += 1;
      response.writeHead(204);
      response.end();
    }));
    const url = await listen(createHttpServer((_request, response) => {
      response.writeHead(status, { Location: target });
      response.end();
    }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(runtimeHeartbeat(url).check(true)).resolves.toMatchObject({ healthy: false, requestSent: true, reason: "healthcheck_request_failed" });
      expect(targetHits).toBe(0);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(url);
    } finally { warning.mockRestore(); }
  });

  it("does not follow an HTTPS-to-HTTP redirect or print the secret URL", async () => {
    let targetHits = 0;
    const target = await listen(createHttpServer((_request, response) => {
      targetHits += 1;
      response.writeHead(204);
      response.end();
    }));
    const url = await listen(createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
      response.writeHead(302, { Location: target });
      response.end("private response body");
    }), "https");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runtimeHeartbeat(url).check(true)).resolves.toMatchObject({ healthy: false, requestSent: true, reason: "healthcheck_request_failed" });
      expect(targetHits).toBe(0);
      for (const output of [warning.mock.calls, stdout.mock.calls, stderr.mock.calls]) {
        expect(JSON.stringify(output)).not.toContain(url);
        expect(JSON.stringify(output)).not.toContain("private response body");
      }
    } finally { warning.mockRestore(); stdout.mockRestore(); stderr.mockRestore(); }
  });

  it("does not follow an HTTPS-to-HTTPS redirect", async () => {
    let targetHits = 0;
    const target = await listen(createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
      targetHits += 1;
      response.writeHead(204);
      response.end();
    }), "https");
    const url = await listen(createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
      response.writeHead(302, { Location: target });
      response.end();
    }), "https");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(runtimeHeartbeat(url).check(true)).resolves.toMatchObject({ healthy: false, requestSent: true, reason: "healthcheck_request_failed" });
      expect(targetHits).toBe(0);
    } finally { warning.mockRestore(); }
  });

  it("also rejects redirects from the threshold /fail endpoint", async () => {
    db.raw.prepare("INSERT INTO main_accounts (user_id, username, created_at) VALUES (?, ?, ?)").run("fixture-main", "fixture", 1);
    db.raw.prepare("INSERT INTO notification_queue (main_user_id, message_id, guild_id, channel_id, kind, target_user_ids, target_labels, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("fixture-main", "fixture-message", "fixture-guild", "fixture-channel", "direct", "[]", "[]", 1, 1);
    let targetHits = 0;
    let failHits = 0;
    const target = await listen(createHttpServer((_request, response) => {
      targetHits += 1;
      response.writeHead(204);
      response.end();
    }));
    const url = await listen(createHttpServer((request, response) => {
      if (request.url === "/secret-heartbeat-fixture/fail") {
        failHits += 1;
        response.writeHead(302, { Location: target });
      } else response.writeHead(404);
      response.end();
    }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(runtimeHeartbeat(url, 1).check(true)).resolves.toMatchObject({ healthy: false, requestSent: true, reason: "healthcheck_request_failed" });
      expect(failHits).toBe(1);
      expect(targetHits).toBe(0);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(url);
    } finally { warning.mockRestore(); }
  });
});
