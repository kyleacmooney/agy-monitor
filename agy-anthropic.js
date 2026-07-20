"use strict";
/*
 * agy-anthropic — the Claude transport shared by the Opus review and the
 * fan-out planner/judge. Raw HTTP (this app ships no runtime deps).
 *
 * Providers (AGY_ANTHROPIC_PROVIDER):
 *   "bedrock"   (default) — Claude in Amazon Bedrock, Messages API at
 *                https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages,
 *                SigV4-signed (service "bedrock-mantle") with credentials from
 *                an AWS SSO profile (AGY_AWS_PROFILE, default "saml") resolved
 *                via `aws configure export-credentials`. Model IDs carry the
 *                "anthropic." prefix. Requires a prior `aws sso login`.
 *   "anthropic" — first-party API (api.anthropic.com) with ANTHROPIC_API_KEY
 *                or ANTHROPIC_AUTH_TOKEN.
 *
 * The request body shape is identical on both providers (Messages API with
 * structured outputs + adaptive thinking), so callers only ever see
 * callAnthropic(body) → { ok, response, ms }.
 */

const { execFile } = require("child_process");
const crypto = require("crypto");

const PROVIDER = process.env.AGY_ANTHROPIC_PROVIDER || "bedrock";
const AWS_PROFILE = process.env.AGY_AWS_PROFILE || "saml";
const SIGV4_SERVICE = "bedrock-mantle";
const DEFAULT_REGION = "us-east-1";

const MODEL = process.env.AGY_REVIEW_MODEL ||
  (PROVIDER === "bedrock" ? "anthropic.claude-opus-4-8" : "claude-opus-4-8");

// list-price USD per 1M tokens by model family (opus-4-8 tier)
const PRICE = { in: 5, out: 25 };

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || "").toString().slice(0, 400)));
      else resolve(stdout.toString());
    });
  });
}

// ---- AWS credentials (SSO profile → aws configure export-credentials) --------

let _creds = null;   // { AccessKeyId, SecretAccessKey, SessionToken, expiresMs }
let _region = null;

async function awsRegion() {
  if (process.env.AGY_AWS_REGION) return process.env.AGY_AWS_REGION;
  if (_region) return _region;
  try {
    const out = (await execFileP("aws", ["configure", "get", "region", "--profile", AWS_PROFILE])).trim();
    _region = out || process.env.AWS_REGION || DEFAULT_REGION;
  } catch {
    _region = process.env.AWS_REGION || DEFAULT_REGION;
  }
  return _region;
}

// Fallback when the aws CLI can't run: static keys straight from the profile's
// ~/.aws/credentials section (no SSO resolution — SSO profiles need the CLI).
function staticProfileCredentials() {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  let text;
  try { text = fs.readFileSync(path.join(os.homedir(), ".aws", "credentials"), "utf8"); } catch { return null; }
  const section = new RegExp("^\\[" + AWS_PROFILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\]([\\s\\S]*?)(?=^\\[|\\s*$(?![\\s\\S]))", "m").exec(text);
  if (!section) return null;
  const get = (k) => { const m = new RegExp("^\\s*" + k + "\\s*=\\s*(.+)$", "m").exec(section[1]); return m ? m[1].trim() : null; };
  const key = get("aws_access_key_id"), secret = get("aws_secret_access_key");
  if (!key || !secret) return null;
  return { AccessKeyId: key, SecretAccessKey: secret, SessionToken: get("aws_session_token"), expiresMs: Date.now() + 30 * 60 * 1000 };
}

async function awsCredentials() {
  if (_creds && Date.now() < _creds.expiresMs - 5 * 60 * 1000) return _creds;
  let raw = null, cliErr = null;
  try {
    raw = await execFileP("aws", ["configure", "export-credentials", "--profile", AWS_PROFILE, "--format", "process"]);
  } catch (e) {
    cliErr = e.message || String(e);
  }
  if (raw != null) {
    let j;
    try { j = JSON.parse(raw); } catch { throw new Error("could not parse aws export-credentials output"); }
    if (!j.AccessKeyId || !j.SecretAccessKey) throw new Error("aws export-credentials returned no keys");
    _creds = {
      AccessKeyId: j.AccessKeyId,
      SecretAccessKey: j.SecretAccessKey,
      SessionToken: j.SessionToken || null,
      expiresMs: j.Expiration ? Date.parse(j.Expiration) : Date.now() + 30 * 60 * 1000,
    };
    return _creds;
  }
  const fallback = staticProfileCredentials();
  if (fallback) { _creds = fallback; return _creds; }
  throw new Error("AWS credentials unavailable for profile '" + AWS_PROFILE + "' — run `aws sso login --profile " + AWS_PROFILE + "` (" + cliErr + ")");
}

// ---- SigV4 (stdlib crypto) ---------------------------------------------------

const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

// General AWS Signature V4 signer. `headers` are the headers to SIGN (lowercase
// keys, values already final); `query` is the pre-encoded canonical query
// string. Exported for the unit test, which runs it against AWS's published
// test vector.
function signV4({ method, pathName, query = "", headers, payloadHash, region, service, amzDate, creds }) {
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => h + ":" + String(headers[h]).trim() + "\n").join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [method, pathName, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = date + "/" + region + "/" + service + "/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac("AWS4" + creds.SecretAccessKey, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    signature,
    authorization: "AWS4-HMAC-SHA256 Credential=" + creds.AccessKeyId + "/" + scope +
      ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
  };
}

function sigv4Headers({ method, host, pathName, body, region, creds }) {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20260718T120000Z
  const payloadHash = sha256hex(body);
  const headers = {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  if (creds.SessionToken) headers["x-amz-security-token"] = creds.SessionToken;
  const { authorization } = signV4({ method, pathName, headers, payloadHash, region, service: SIGV4_SERVICE, amzDate, creds });
  const out = {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    authorization,
  };
  if (creds.SessionToken) out["x-amz-security-token"] = creds.SessionToken;
  return out;
}

// ---- transports --------------------------------------------------------------

async function postJson(url, headers, bodyStr) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: bodyStr });
  } catch (e) {
    return { ok: false, message: "API unreachable: " + (e && e.message ? e.message : e) };
  }
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok) {
    const msg = json && (json.message || (json.error && json.error.message)) || "HTTP " + res.status;
    return { ok: false, message: "API error: " + msg };
  }
  return { ok: true, response: json, ms: Date.now() - t0 };
}

async function callBedrock(body) {
  let creds, region;
  try {
    region = await awsRegion();
    creds = await awsCredentials();
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
  const host = "bedrock-mantle." + region + ".api.aws";
  const pathName = "/anthropic/v1/messages";
  const bodyStr = JSON.stringify(body);
  const sig = sigv4Headers({ method: "POST", host, pathName, body: bodyStr, region, creds });
  return postJson("https://" + host + pathName, Object.assign({
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  }, sig), bodyStr);
}

async function callFirstParty(body) {
  let headers;
  if (process.env.ANTHROPIC_API_KEY) {
    headers = { "x-api-key": process.env.ANTHROPIC_API_KEY };
  } else if (process.env.ANTHROPIC_AUTH_TOKEN) {
    headers = { authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN, "anthropic-beta": "oauth-2025-04-20" };
  } else {
    return { ok: false, message: "no API credentials — set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) for the agy-monitor daemon" };
  }
  const url = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages";
  return postJson(url, Object.assign({
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  }, headers), JSON.stringify(body));
}

// One Messages-API call. `body.model` defaults to the provider's Opus 4.8 id.
async function callAnthropic(body) {
  const withModel = Object.assign({ model: MODEL }, body);
  return PROVIDER === "anthropic" ? callFirstParty(withModel) : callBedrock(withModel);
}

function usageMeta(response, ms) {
  const u = (response && response.usage) || {};
  const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  return {
    model: response.model || MODEL,
    provider: PROVIDER,
    inTokens: inTok,
    outTokens: outTok,
    costUsd: (inTok * PRICE.in + outTok * PRICE.out) / 1e6,
    ms,
  };
}

// The concatenated text blocks of a response (structured outputs land here).
function responseText(response) {
  return ((response && response.content) || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

module.exports = { callAnthropic, usageMeta, responseText, signV4, MODEL, PROVIDER };
