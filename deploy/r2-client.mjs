import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(bucket, key) {
  return `/${awsEncode(bucket)}/${String(key).split("/").map(awsEncode).join("/")}`;
}

function canonicalQuery(query = {}) {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .flatMap(([name, value]) => Array.isArray(value) ? value.map((entry) => [name, entry]) : [[name, value]])
    .map(([name, value]) => [awsEncode(name), awsEncode(value)])
    .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function normalizeHeaderValue(value) { return String(value).trim().replace(/\s+/g, " "); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function hmac(key, value) { return crypto.createHmac("sha256", key).update(value).digest(); }

function signingKey(secret, date, region, service) {
  const dateKey = hmac(Buffer.from(`AWS4${secret}`, "utf8"), date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

export class R2RequestError extends Error {
  constructor(status, operation) {
    super(`R2 ${operation} failed (${status})`);
    this.name = "R2RequestError";
    this.status = status;
    this.operation = operation;
  }
}

export class R2Client {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region = "auto", now = () => new Date() }) {
    const parsed = new URL(endpoint);
    if (!/^https?:$/.test(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("invalid R2 endpoint");
    if (!bucket || !accessKeyId || !secretAccessKey) throw new Error("R2 credentials unavailable");
    this.endpoint = parsed;
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region;
    this.now = now;
  }

  async request(method, key, { body = Buffer.alloc(0), query = {}, metadata = {}, operation = method } = {}) {
    const target = this.endpoint;
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const instant = this.now();
    const amzDate = instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const date = amzDate.slice(0, 8);
    const path = canonicalPath(this.bucket, key ?? "");
    const search = canonicalQuery(query);
    const headers = {
      host: target.host,
      "x-amz-content-sha256": sha256(payload),
      "x-amz-date": amzDate,
      ...Object.fromEntries(Object.entries(metadata).map(([name, value]) => [`x-amz-meta-${name.toLowerCase()}`, String(value)]))
    };
    if (payload.length > 0) headers["content-length"] = String(payload.length);
    const canonicalHeaders = Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)])
      .sort(([left], [right]) => left.localeCompare(right));
    const signedHeaders = canonicalHeaders.map(([name]) => name).join(";");
    const canonicalHeaderText = canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join("");
    const canonicalRequest = [method, path, search, canonicalHeaderText, signedHeaders, headers["x-amz-content-sha256"]].join("\n");
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    const signature = crypto.createHmac("sha256", signingKey(this.secretAccessKey, date, this.region, "s3")).update(stringToSign).digest("hex");
    const requestHeaders = {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    };
    const requestPath = `${path}${search ? `?${search}` : ""}`;
    return new Promise((resolve, reject) => {
      const transport = target.protocol === "https:" ? https : http;
      const request = transport.request({ hostname: target.hostname, port: target.port || undefined, method, path: requestPath, headers: requestHeaders, timeout: 30_000 }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const result = { status: response.statusCode ?? 0, headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(",") : String(value ?? "")])), body: Buffer.concat(chunks) };
          if (result.status < 200 || result.status >= 300) reject(new R2RequestError(result.status, operation));
          else resolve(result);
        });
      });
      request.on("timeout", () => request.destroy(new Error("R2 request timeout")));
      request.on("error", () => reject(new Error(`R2 ${operation} transport failed`)));
      if (payload.length > 0) request.write(payload);
      request.end();
    });
  }

  async putObject(key, bytes, metadata = {}) {
    return this.request("PUT", key, { body: bytes, metadata, operation: "put" });
  }

  async headObject(key) {
    return this.request("HEAD", key, { operation: "head" });
  }

  async getObject(key) {
    const result = await this.request("GET", key, { operation: "get" });
    return result;
  }

  async deleteObject(key) {
    return this.request("DELETE", key, { operation: "delete" });
  }

  async listObjects(prefix, continuationToken) {
    const result = await this.request("GET", "", { operation: "list", query: { "list-type": "2", prefix, "continuation-token": continuationToken } });
    const text = result.body.toString("utf8");
    const keys = [...text.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) => match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(text);
    const next = text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
    return { keys, truncated, continuationToken: next };
  }
}

export function r2ConfigFromEnv(env = process.env) {
  const endpoint = env.ALTN_R2_ENDPOINT;
  const bucket = env.ALTN_R2_BUCKET;
  const accessKeyId = env.ALTN_R2_ACCESS_KEY_ID;
  const secretAccessKey = env.ALTN_R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error("R2 configuration unavailable");
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: env.ALTN_R2_REGION || "auto" };
}
