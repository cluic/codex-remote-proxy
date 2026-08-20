import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { URL } from "node:url";
import zlib from "node:zlib";
import { Decompress as ZstdDecompress } from "fzstd";

import {
  createCaptureManager,
  DEFAULT_CAPTURE_DB_PATH,
  headersToObject,
  normalizeCaptureConfig
} from "./capture-store.mjs";
import {
  ACCOUNT_REQUEST_REPLAY_MAX_BYTES,
  account429Cooldown,
  decideUpstreamRoute,
  parseCodexQuotaHeaders
} from "./routing/account-routing.mjs";

const CONFIG_ENV_VAR = "CODEX_PROXY_CONFIG";
const DEFAULT_CONFIG_PATH = resolve(import.meta.dirname, "..", "proxy-config.json");
const HEALTH_PATH = "/_proxy/health";
const METRIC_USAGE_MAX_BYTES = 1024 * 1024;
const METRIC_BODY_INSPECTION_MAX_BYTES = 8 * 1024 * 1024;
const CAPTURE_BODY_MAX_BYTES = 1024 * 1024;
const MODEL_OVERRIDE_MAX_BYTES = 8 * 1024 * 1024;
const SSE_EVENT_MAX_BYTES = METRIC_USAGE_MAX_BYTES;
const SSE_EVENT_MAX_DATA_LINES = 16 * 1024;
const METRIC_MAX_MODEL_CODE_POINTS = 256;
const METRIC_MAX_OBSERVATION_TOKENS = 100_000_000;
const CONFIG_TEXT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const METRIC_TEXT_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const METRIC_LATENCY_BOUNDS_MS = [
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  30_000,
  60_000,
  120_000,
  300_000
];

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade"
]);

export function resolveConfigPath() {
  return process.env[CONFIG_ENV_VAR] ? resolve(process.env[CONFIG_ENV_VAR]) : DEFAULT_CONFIG_PATH;
}

function isStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(([key, item]) => typeof key === "string" && typeof item === "string");
}

export function loadConfig(configPath = resolveConfigPath()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read proxy config at ${configPath}: ${error.message}`);
  }

  const server = parsed.server ?? {};
  const upstream = parsed.upstream ?? {};
  const proxy = parsed.proxy ?? {};
  const capture = parsed.capture ?? {};

  const modelMode = proxy.modelMode ?? "passthrough";
  if (modelMode !== "passthrough" && modelMode !== "override") {
    throw new Error("proxy.modelMode must be passthrough or override");
  }
  const modelOverride = proxy.modelOverride ?? null;
  if (modelOverride !== null && (typeof modelOverride !== "string"
    || modelOverride.trim().length === 0
    || CONFIG_TEXT_CONTROL_PATTERN.test(modelOverride))) {
    throw new Error("proxy.modelOverride must be a non-empty string or null");
  }
  if (modelMode === "override" && modelOverride === null) {
    throw new Error("proxy.modelOverride is required when proxy.modelMode is override");
  }

  if (!upstream.baseUrl || typeof upstream.baseUrl !== "string") {
    throw new Error("upstream.baseUrl is required");
  }
  if ((proxy.overrideAuthorization ?? true) && !upstream.apiKey) {
    throw new Error("upstream.apiKey is required when proxy.overrideAuthorization is true");
  }

  return {
    configPath,
    server: {
      host: typeof server.host === "string" && server.host ? server.host : "127.0.0.1",
      port: Number.isInteger(server.port) ? server.port : 15100,
      logLevel: typeof server.logLevel === "string" && server.logLevel ? server.logLevel : "info"
    },
    upstream: {
      baseUrl: String(upstream.baseUrl).replace(/\/$/, ""),
      apiKey: typeof upstream.apiKey === "string" ? upstream.apiKey : "",
      timeoutMs: Number.isFinite(upstream.timeoutMs) ? Number(upstream.timeoutMs) : 300000,
      verifySsl: typeof upstream.verifySsl === "boolean" ? upstream.verifySsl : true,
      authHeader: typeof upstream.authHeader === "string" && upstream.authHeader ? upstream.authHeader : "authorization",
      authScheme: typeof upstream.authScheme === "string" ? upstream.authScheme : "Bearer",
      extraHeaders: isStringMap(upstream.extraHeaders) ? upstream.extraHeaders : {}
    },
    proxy: {
      overrideAuthorization: typeof proxy.overrideAuthorization === "boolean" ? proxy.overrideAuthorization : true,
      requestIdHeader: typeof proxy.requestIdHeader === "string" && proxy.requestIdHeader ? proxy.requestIdHeader : "x-client-request-id",
      modelMode,
      modelOverride: typeof modelOverride === "string" ? modelOverride.trim() : null
    },
    capture: normalizeCaptureConfig(capture, {
      baseDir: dirname(configPath),
      defaultDbPath: DEFAULT_CAPTURE_DB_PATH,
      strict: true
    })
  };
}

function maskSecret(value) {
  if (!value) {
    return "(empty)";
  }
  if (value.length <= 8) {
    return "[REDACTED]";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function log(level, message, fields = {}) {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  const suffix = parts.length ? ` ${parts.join(" ")}` : "";
  console.log(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`);
}

function debugLog(label, data, enabled) {
  if (!enabled) return;
  const timestamp = new Date().toISOString();
  const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  for (const line of json.split("\n")) {
    console.log(`${timestamp} DEBUG [${label}] ${line}`);
  }
}

function normalizeProtectedValues(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

function redactProtectedText(value, protectedValues) {
  let result = String(value);
  for (const secret of normalizeProtectedValues(protectedValues)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function decodeRecoverableText(value) {
  return value
    .replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
      const bytes = encoded.split("%").filter(Boolean).map((item) => Number.parseInt(item, 16));
      return Buffer.from(bytes).toString("utf8");
    })
    .replace(/\\u([0-9a-f]{4})/giu, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\(["\\/bfnrt])/gu, (_match, escaped) => ({
      "\"": "\"",
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t"
    })[escaped]);
}

function containsRecoverableProtectedValue(value, protectedValues, { includeLiteral = true } = {}) {
  const normalizedValues = normalizeProtectedValues(protectedValues);
  const encodedRepresentations = normalizedValues.flatMap((secret) => {
    const bytes = Buffer.from(secret);
    const base64 = bytes.toString("base64");
    const paddedBase64Url = base64.replace(/\+/gu, "-").replace(/\//gu, "_");
    return [
      base64,
      base64.replace(/=+$/u, ""),
      paddedBase64Url,
      bytes.toString("base64url")
    ];
  });
  const hexRepresentations = normalizedValues.map((secret) => Buffer.from(secret).toString("hex"));
  const matches = (candidate, matchLiteral) => (matchLiteral && normalizedValues.some(
    (secret) => secret.length > 0 && candidate.includes(secret)
  )) || encodedRepresentations.some(
    (secret) => secret.length > 0 && candidate.includes(secret)
  ) || hexRepresentations.some(
    (secret) => secret.length > 0 && candidate.toLowerCase().includes(secret)
  );
  let candidate = String(value);
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const formDecoded = candidate.replace(/\+/g, " ");
    const compactBase64 = candidate.replace(/[\t\n\v\f\r ]/gu, "");
    const compactFormBase64 = formDecoded.replace(/[\t\n\v\f\r ]/gu, "");
    if (matches(candidate, includeLiteral || attempt > 0)) return true;
    if (formDecoded !== candidate && matches(formDecoded, true)) return true;
    if (compactBase64 !== candidate && matches(compactBase64, false)) return true;
    if (compactFormBase64 !== formDecoded && matches(compactFormBase64, false)) return true;
    if (attempt === 3) break;
    const decoded = decodeRecoverableText(candidate);
    if (decoded === candidate) break;
    candidate = decoded;
  }
  return false;
}

function redactRecoverableProtectedText(value, protectedValues) {
  const source = String(value);
  const encoded = containsRecoverableProtectedValue(source, protectedValues, {
    includeLiteral: false
  });
  const literal = redactProtectedText(source, protectedValues);
  return encoded ? "[REDACTED]" : literal;
}

function redactProtectedUrl(value, protectedValues) {
  return redactRecoverableProtectedText(value, protectedValues);
}

function redactProtectedBuffer(buffer, protectedValues) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return buffer ?? Buffer.alloc(0);
  const redacted = Buffer.from(buffer);
  for (const secret of normalizeProtectedValues(protectedValues)) {
    const needle = Buffer.from(secret);
    let offset = 0;
    while (offset <= redacted.length - needle.length) {
      const index = redacted.indexOf(needle, offset);
      if (index === -1) break;
      redacted.fill(0x2a, index, index + needle.length);
      offset = index + needle.length;
    }
  }
  return redacted;
}

function redactProtectedFields(fields, protectedValues) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key,
    typeof value === "string" ? redactRecoverableProtectedText(value, protectedValues) : value
  ]));
}

function safeBodyPreview(buffer, maxLen = 4096, protectedValues = [], {
  contentEncoding,
  truncated = false
} = {}) {
  if (!buffer || !buffer.length) return "(empty)";
  try {
    const normalizedEncoding = singleContentEncoding(contentEncoding);
    const opaqueEncoding = normalizedEncoding === null
      || (normalizedEncoding !== "" && normalizedEncoding !== "identity");
    const text = buffer.toString("utf-8");
    if (protectedValues.length > 0
      && (truncated
        || opaqueEncoding
        || containsRecoverableProtectedValue(text, protectedValues)
        || isRecoverablyCompressedBody(buffer))) {
      return "[REDACTED]";
    }
    return text.length > maxLen ? `${text.slice(0, maxLen)}... (${buffer.length} bytes total)` : text;
  } catch {
    return `(${buffer.length} bytes, binary)`;
  }
}

export function buildTargetUrl(baseUrl, requestUrl) {
  const target = new URL(baseUrl);
  const incoming = new URL(requestUrl, "http://127.0.0.1");
  const baseSearch = target.search;
  if (incoming.pathname !== "/") {
    const basePath = target.pathname.replace(/\/+$/, "");
    target.pathname = `${basePath}${incoming.pathname}`;
  }
  target.search = baseSearch && incoming.search
    ? `${baseSearch}&${incoming.search.slice(1)}`
    : baseSearch || incoming.search;
  target.hash = "";
  return target;
}

function formatAuthorization(upstream) {
  const scheme = upstream.authScheme.trim();
  return scheme ? `${scheme} ${upstream.apiKey}` : upstream.apiKey;
}

const CONTENT_HEADERS = new Set(["content-encoding", "content-length"]);
const BODY_INTEGRITY_HEADERS = new Set([
  "content-md5",
  "digest",
  "content-digest",
  "repr-digest",
  "signature",
  "signature-input"
]);
const DEBUG_SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key"
]);
const DEBUG_SENSITIVE_HEADER_PARTS = ["token", "secret", "api-key"];

function declaredZstdContentSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6 || buffer.readUInt32LE(0) !== 0xfd2fb528) {
    return null;
  }
  const descriptor = buffer[4];
  if ((descriptor & 0x08) !== 0) return null;
  const singleSegment = (descriptor & 0x20) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentFlag = descriptor >> 6;
  const contentBytes = contentFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentFlag);
  if (contentBytes === 0) return null;
  const offset = (singleSegment ? 5 : 6) + dictionaryBytes;
  if (offset + contentBytes > buffer.length) return null;
  let size = 0n;
  for (let index = 0; index < contentBytes; index += 1) {
    size |= BigInt(buffer[offset + index]) << BigInt(index * 8);
  }
  if (contentFlag === 1) size += 256n;
  return size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : null;
}

function declaredZstdWindowSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6 || buffer.readUInt32LE(0) !== 0xfd2fb528) {
    return null;
  }
  const descriptor = buffer[4];
  const singleSegment = (descriptor & 0x20) !== 0;
  if (singleSegment) return declaredZstdContentSize(buffer);
  const windowDescriptor = buffer[5];
  const base = 2 ** (10 + (windowDescriptor >> 3));
  return base + ((base / 8) * (windowDescriptor & 0x07));
}

function zstdFrameEnd(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6 || buffer.readUInt32LE(0) !== 0xfd2fb528) {
    return null;
  }
  const descriptor = buffer[4];
  const singleSegment = (descriptor & 0x20) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentFlag = descriptor >> 6;
  const contentBytes = contentFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentFlag);
  let offset = 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentBytes;
  while (offset + 3 <= buffer.length) {
    const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
    const lastBlock = (header & 1) !== 0;
    const blockType = (header >> 1) & 0x03;
    const blockSize = header >>> 3;
    if (blockType === 3) return null;
    offset += 3 + (blockType === 1 ? 1 : blockSize);
    if (offset > buffer.length) return null;
    if (lastBlock) {
      if ((descriptor & 0x04) !== 0) offset += 4;
      return offset <= buffer.length ? offset : null;
    }
  }
  return null;
}

function decompressBody(buffer, encoding, maximumBytes) {
  const enc = encoding.toLowerCase().trim();
  const options = Number.isFinite(maximumBytes) ? { maxOutputLength: maximumBytes } : undefined;
  if (enc === "" || enc === "identity") return buffer;
  if (enc === "gzip") return zlib.gunzipSync(buffer, options);
  if (enc === "deflate") return zlib.inflateSync(buffer, options);
  if (enc === "br") return zlib.brotliDecompressSync(buffer, options);
  if (enc === "zstd" && typeof zlib.zstdDecompressSync === "function") {
    return zlib.zstdDecompressSync(buffer, options);
  }
  if (enc === "zstd") {
    const declaredSize = declaredZstdContentSize(buffer);
    const frameEnd = zstdFrameEnd(buffer);
    if (frameEnd === null) throw new Error("Invalid zstd frame");
    if (frameEnd !== buffer.length) throw new Error("Multi-frame zstd inspection is not supported");
    if ((buffer[4] & 0x04) !== 0) throw new Error("Checksummed zstd fallback inspection is not supported");
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maximumBytes) {
      throw new Error("Decompressed body exceeds the inspection limit");
    }
    const windowSize = declaredZstdWindowSize(buffer);
    if (!Number.isSafeInteger(windowSize) || windowSize < 0 || windowSize > maximumBytes) {
      throw new Error("Zstd window exceeds the inspection limit");
    }
    const collector = createBoundedCollector(maximumBytes);
    const decompressor = new ZstdDecompress((chunk) => {
      collector.append(Buffer.from(chunk));
      if (collector.truncated) throw new Error("Decompressed body exceeds the inspection limit");
    });
    decompressor.push(buffer, true);
    if (collector.truncated || collector.totalBytes !== declaredSize) throw new Error("Invalid zstd body size");
    return collector.buffer();
  }
  throw new Error(`Unsupported content encoding: ${encoding}`);
}

function compressBody(buffer, encoding) {
  const enc = encoding.toLowerCase().trim();
  if (enc === "" || enc === "identity") return buffer;
  if (enc === "gzip") return zlib.gzipSync(buffer);
  if (enc === "deflate") return zlib.deflateSync(buffer);
  if (enc === "br") return zlib.brotliCompressSync(buffer);
  if (enc === "zstd" && typeof zlib.zstdCompressSync === "function") {
    return zlib.zstdCompressSync(buffer);
  }
  throw new Error(`Unsupported content encoding: ${encoding}`);
}

function singleContentEncoding(value) {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;
  const values = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return values.length === 1 ? values[0] : null;
}

function hasSupportedCompressionEnvelope(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return true;
  if (buffer.length >= 4
    && buffer[0] === 0x28
    && buffer[1] === 0xb5
    && buffer[2] === 0x2f
    && buffer[3] === 0xfd) return true;
  if (buffer.length >= 4
    && buffer[0] >= 0x50
    && buffer[0] <= 0x5f
    && buffer[1] === 0x2a
    && buffer[2] === 0x4d
    && buffer[3] === 0x18) return true;
  if (buffer.length < 2) return false;
  const compressionMethod = buffer[0] & 0x0f;
  const windowSize = buffer[0] >> 4;
  return compressionMethod === 8
    && windowSize <= 7
    && (((buffer[0] << 8) | buffer[1]) % 31) === 0;
}

function isRecoverablyCompressedBody(buffer) {
  if (buffer.length === 0) return false;
  if (hasSupportedCompressionEnvelope(buffer)) return true;
  try {
    zlib.brotliDecompressSync(buffer, { maxOutputLength: METRIC_BODY_INSPECTION_MAX_BYTES });
    return true;
  } catch (error) {
    return error?.code === "ERR_BUFFER_TOO_LARGE";
  }
}

function captureBodySnapshot(collector, contentEncoding, protectedValues) {
  const body = collector?.buffer() ?? Buffer.alloc(0);
  const totalBytes = collector?.totalBytes ?? 0;
  const normalizedEncoding = singleContentEncoding(contentEncoding);
  const opaqueEncoding = protectedValues.length > 0
    && (normalizedEncoding === null
      || (normalizedEncoding !== "" && normalizedEncoding !== "identity"));
  const unscreenedPrefix = protectedValues.length > 0 && collector?.truncated === true;
  if ((opaqueEncoding || unscreenedPrefix) && totalBytes > 0) {
    return { body: Buffer.alloc(0), totalBytes, truncated: true };
  }
  const recoverableSecret = protectedValues.length > 0
    && containsRecoverableProtectedValue(body.toString("utf8"), protectedValues);
  const undeclaredCompression = protectedValues.length > 0
    && (normalizedEncoding === "" || normalizedEncoding === "identity")
    && isRecoverablyCompressedBody(body);
  if ((recoverableSecret || undeclaredCompression) && totalBytes > 0) {
    return { body: Buffer.alloc(0), totalBytes, truncated: true };
  }
  return {
    body: redactProtectedBuffer(body, protectedValues),
    totalBytes,
    truncated: collector?.truncated ?? false
  };
}

function decodeBoundedBody(buffer, encoding, maximumBytes) {
  const normalized = singleContentEncoding(encoding);
  if (normalized === null) return null;
  try {
    return decompressBody(buffer, normalized, maximumBytes);
  } catch {
    return null;
  }
}

function encodeBodyWithOriginalEncoding(buffer, encoding) {
  const normalized = singleContentEncoding(encoding);
  if (normalized === null) {
    throw new Error("Multiple content encodings are not supported for model override");
  }
  return compressBody(buffer, normalized);
}

function createBoundedCollector(maximumBytes) {
  let storage = null;
  let length = 0;
  let totalBytes = 0;
  let truncated = false;

  return {
    append(chunk) {
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      totalBytes += chunk.length;
      const remaining = maximumBytes - length;
      if (remaining <= 0) {
        if (chunk.length > 0) truncated = true;
        return;
      }
      const copied = Math.min(remaining, chunk.length);
      if (copied < chunk.length) truncated = true;
      if (copied === 0) return;
      const required = length + copied;
      if (!storage || storage.length < required) {
        const capacity = Math.min(maximumBytes, Math.max(required, storage ? storage.length * 2 : 4096));
        const replacement = Buffer.allocUnsafe(capacity);
        if (storage && length > 0) storage.copy(replacement, 0, 0, length);
        storage = replacement;
      }
      chunk.copy(storage, length, 0, copied);
      length = required;
    },
    buffer() {
      return length === 0 ? Buffer.alloc(0) : Buffer.from(storage.subarray(0, length));
    },
    get length() {
      return length;
    },
    get totalBytes() {
      return totalBytes;
    },
    get truncated() {
      return truncated;
    }
  };
}

function decodeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return null;
  }
}

function createTopLevelJsonInspector({ stringKeys = [], tokenKeys = [] } = {}) {
  const wantedStrings = new Set(stringKeys);
  const wantedTokens = new Set(tokenKeys);
  const strings = Object.create(null);
  const tokens = Object.create(null);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let rootStarted = false;
  let complete = false;
  let invalid = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringRole = null;
  let stringRaw = "";
  let stringOverflow = false;
  let expectingKey = false;
  let pendingKey = null;
  let valueKey = null;

  function startString(role) {
    inString = true;
    escaped = false;
    stringRole = role;
    stringRaw = "";
    stringOverflow = false;
  }

  function appendString(character) {
    if (stringOverflow) return;
    stringRaw += character;
    if (stringRaw.length > 4096) {
      stringRaw = "";
      stringOverflow = true;
    }
  }

  function finishString() {
    const decoded = stringOverflow ? null : decodeJsonString(stringRaw);
    if (stringRole === "key") {
      pendingKey = typeof decoded === "string" ? decoded : null;
      expectingKey = false;
    } else if (stringRole === "value" && valueKey && typeof decoded === "string") {
      strings[valueKey] = decoded;
    }
    stringRole = null;
    valueKey = null;
  }

  function inspectText(text) {
    for (const character of text) {
      if (invalid) break;
      if (complete) {
        if (!/\s/u.test(character)) invalid = true;
        continue;
      }
      if (inString) {
        if (escaped) {
          appendString(character);
          escaped = false;
        } else if (character === "\\") {
          appendString(character);
          escaped = true;
        } else if (character === "\"") {
          inString = false;
          finishString();
        } else {
          appendString(character);
        }
        continue;
      }

      if (!rootStarted) {
        if (/\s/u.test(character)) continue;
        if (character !== "{") {
          invalid = true;
          continue;
        }
        rootStarted = true;
        depth = 1;
        expectingKey = true;
        continue;
      }

      if (depth === 1) {
        if (expectingKey && character === "\"") {
          startString("key");
          continue;
        }
        if (pendingKey !== null) {
          if (/\s/u.test(character)) continue;
          if (character === ":") {
            valueKey = pendingKey;
            pendingKey = null;
            continue;
          }
          invalid = true;
          continue;
        }
        if (valueKey !== null) {
          if (/\s/u.test(character)) continue;
          const key = valueKey;
          if (character === "\"") {
            if (wantedStrings.has(key)) delete strings[key];
            startString(wantedStrings.has(key) ? "value" : null);
          } else {
            if (wantedStrings.has(key)) delete strings[key];
            if (wantedTokens.has(key)) tokens[key] = character;
            valueKey = null;
            if (character === "{" || character === "[") depth += 1;
          }
          continue;
        }
        if (character === ",") {
          expectingKey = true;
          continue;
        }
        if (character === "}") {
          depth = 0;
          complete = true;
          continue;
        }
      }

      if (character === "\"") {
        startString(null);
      } else if (character === "{" || character === "[") {
        depth += 1;
      } else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth < 0) invalid = true;
      }
    }
  }

  return {
    write(chunk) {
      if (invalid) return;
      try {
        inspectText(decoder.decode(chunk, { stream: true }));
      } catch {
        invalid = true;
      }
    },
    end() {
      if (!invalid) {
        try {
          inspectText(decoder.decode());
        } catch {
          invalid = true;
        }
      }
      return { strings, tokens, complete, invalid };
    },
    snapshot() {
      return { strings, tokens, complete, invalid };
    }
  };
}

function createSseInspector() {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let previousWasCarriageReturn = false;
  let eventName = "";
  let dataLines = [];
  let eventBytes = 0;
  let eventOverflow = false;
  let terminal = null;
  let usage = null;

  function resetEvent() {
    eventName = "";
    dataLines = [];
    eventBytes = 0;
    eventOverflow = false;
  }

  function dispatch() {
    if (eventOverflow || dataLines.length === 0) {
      resetEvent();
      return;
    }
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      resetEvent();
      return;
    }
    try {
      const payload = JSON.parse(data);
      const type = typeof payload?.type === "string" ? payload.type : eventName;
      if (type === "response.completed") {
        if (terminal !== "failure") {
          terminal = payload?.response?.error == null ? "success" : "failure";
        }
        usage = normalizeMetricUsage(payload?.response?.usage) ?? usage;
      } else if (type === "response.failed" || type === "response.incomplete" || type === "error") {
        terminal = "failure";
      }
    } catch {
      // Malformed or non-JSON events are not terminal protocol evidence.
    }
    resetEvent();
  }

  function line(value) {
    if (value.endsWith("\r")) value = value.slice(0, -1);
    eventBytes += Buffer.byteLength(value) + 1;
    if (eventBytes > SSE_EVENT_MAX_BYTES) {
      eventOverflow = true;
      dataLines = [];
    }
    if (value === "") {
      dispatch();
      return;
    }
    if (value.startsWith(":")) return;
    const separator = value.indexOf(":");
    const field = separator === -1 ? value : value.slice(0, separator);
    let fieldValue = separator === -1 ? "" : value.slice(separator + 1);
    if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
    if (field === "event") {
      eventName = fieldValue;
    } else if (field === "data" && !eventOverflow) {
      if (dataLines.length >= SSE_EVENT_MAX_DATA_LINES) {
        eventOverflow = true;
        dataLines = [];
      } else {
        dataLines.push(fieldValue);
      }
    }
  }

  function inspectText(text) {
    for (const character of text) {
      if (character === "\r") {
        line(pending);
        pending = "";
        previousWasCarriageReturn = true;
      } else if (character === "\n") {
        if (!previousWasCarriageReturn) line(pending);
        pending = "";
        previousWasCarriageReturn = false;
      } else {
        previousWasCarriageReturn = false;
        pending += character;
      }
    }
    if (Buffer.byteLength(pending) > SSE_EVENT_MAX_BYTES) {
      pending = "";
      eventOverflow = true;
    }
  }

  return {
    write(chunk) {
      if (terminal === "invalid") return;
      try {
        inspectText(decoder.decode(chunk, { stream: true }));
      } catch {
        terminal = "invalid";
        resetEvent();
      }
    },
    end() {
      if (terminal === "invalid") return { terminal: null, usage: null };
      try {
        inspectText(decoder.decode());
      } catch {
        return { terminal: null, usage: null };
      }
      if (pending.length > 0) line(pending);
      dispatch();
      return { terminal, usage };
    }
  };
}

function protectedHeaderValues(settings) {
  return normalizeProtectedValues([
    settings.upstream.apiKey,
    ...Object.values(settings.upstream.extraHeaders)
  ]);
}

function protectedRequestValues(req, settings) {
  const values = [
    settings.upstream.apiKey,
    ...Object.values(settings.upstream.extraHeaders)
  ];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase();
    if (name === "authorization" || name === "chatgpt-account-id") {
      values.push(req.rawHeaders[index + 1]);
    }
  }
  return normalizeProtectedValues(values);
}

function headerContainsProtectedValue(value, protectedValues) {
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => containsRecoverableProtectedValue(String(item), protectedValues));
}

function sanitizeHeadersForDebug(headersObject, authHeader = "authorization", protectedValues = []) {
  const result = {};
  const activeAuthHeader = authHeader.toLowerCase();
  for (const [key, value] of Object.entries(headersObject)) {
    const loweredKey = key.toLowerCase();
    const protectedName = containsRecoverableProtectedValue(key, protectedValues);
    const protectedValue = headerContainsProtectedValue(value, protectedValues);
    const sensitive = loweredKey === activeAuthHeader
      || DEBUG_SENSITIVE_HEADER_NAMES.has(loweredKey)
      || DEBUG_SENSITIVE_HEADER_PARTS.some((part) => loweredKey.includes(part));
    const safeKey = protectedName ? "[REDACTED]" : key;
    result[safeKey] = (protectedName || protectedValue)
      ? "[REDACTED]"
      : (sensitive ? maskSecret(String(value)) : value);
  }
  return result;
}

function sanitizeHeadersForCapture(headersInput, authHeader, protectedValues = []) {
  const result = headersToObject(headersInput);
  const activeAuthHeader = authHeader.toLowerCase();
  for (const key of Object.keys(result)) {
    const protectedName = containsRecoverableProtectedValue(key, protectedValues);
    const protectedValue = headerContainsProtectedValue(result[key], protectedValues);
    const sensitive = key.toLowerCase() === activeAuthHeader || protectedName || protectedValue;
    if (!sensitive) continue;
    delete result[key];
    result[protectedName ? "[REDACTED]" : key] = "[REDACTED]";
  }
  return result;
}

export function buildUpstreamHeaders(req, settings, targetUrl, {
  stripContentHeaders,
  stripAccountHeaders = false
}) {
  const headers = [];
  const authHeader = settings.upstream.authHeader.toLowerCase();
  const connectionHeaders = connectionHeaderTokens(req.rawHeaders);

  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const key = req.rawHeaders[index];
    const value = req.rawHeaders[index + 1];
    const loweredKey = key.toLowerCase();
    if (
      loweredKey === "host" ||
      HOP_BY_HOP_HEADERS.has(loweredKey) ||
      connectionHeaders.has(loweredKey) ||
      (stripAccountHeaders && loweredKey === "chatgpt-account-id") ||
      (stripAccountHeaders && authHeader !== "authorization" && loweredKey === "authorization") ||
      (stripContentHeaders && CONTENT_HEADERS.has(loweredKey))
    ) {
      continue;
    }
    if (settings.proxy.overrideAuthorization && loweredKey === authHeader) {
      continue;
    }
    headers.push([key, value]);
  }

  upsertHeader(headers, "Host", targetUrl.host);

  const generatedHeaderAllowed = (name) => {
    const lowered = name.toLowerCase();
    return lowered !== "host"
      && !HOP_BY_HOP_HEADERS.has(lowered)
      && !connectionHeaders.has(lowered);
  };

  if (settings.proxy.overrideAuthorization && generatedHeaderAllowed(settings.upstream.authHeader)) {
    upsertHeader(headers, settings.upstream.authHeader, formatAuthorization(settings.upstream));
  }

  for (const [key, value] of Object.entries(settings.upstream.extraHeaders)) {
    if (generatedHeaderAllowed(key)) upsertHeader(headers, key, value);
  }

  return headers;
}

export function buildAccountUpstreamHeaders(
  req,
  settings,
  targetUrl,
  { stripContentHeaders = false } = {}
) {
  const headers = [];
  const connectionHeaders = connectionHeaderTokens(req.rawHeaders);
  const customAuthHeader = settings.upstream.authHeader.toLowerCase();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const key = req.rawHeaders[index];
    const value = req.rawHeaders[index + 1];
    const loweredKey = key.toLowerCase();
    if (loweredKey === "host"
      || HOP_BY_HOP_HEADERS.has(loweredKey)
      || connectionHeaders.has(loweredKey)
      || (customAuthHeader !== "authorization" && loweredKey === customAuthHeader)
      || (stripContentHeaders && CONTENT_HEADERS.has(loweredKey))) {
      continue;
    }
    headers.push([key, value]);
  }
  upsertHeader(headers, "Host", targetUrl.host);
  return headers;
}

function connectionHeaderTokens(rawHeaders) {
  const tokens = new Set();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() !== "connection") continue;
    for (const token of rawHeaders[index + 1].split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) tokens.add(normalized);
    }
  }
  return tokens;
}

function upsertHeader(headers, key, value) {
  const lowered = key.toLowerCase();
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    if (headers[index][0].toLowerCase() === lowered) {
      headers.splice(index, 1);
    }
  }
  headers.push([key, value]);
}

function removeHeader(headers, key) {
  const lowered = key.toLowerCase();
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    if (headers[index][0].toLowerCase() === lowered) headers.splice(index, 1);
  }
}

function stripBodyIntegrityHeaders(headers) {
  for (const header of BODY_INTEGRITY_HEADERS) removeHeader(headers, header);
}

function writeHeadersToResponse(res, rawHeaders) {
  const connectionHeaders = connectionHeaderTokens(rawHeaders);
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || connectionHeaders.has(key.toLowerCase())) {
      continue;
    }
    res.appendHeader(key, value);
  }
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function isEventStream(contentType = "") {
  return contentType.split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
}

function metricLatencyBin(value) {
  const duration = Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
  const index = METRIC_LATENCY_BOUNDS_MS.findIndex((boundary) => duration <= boundary);
  return index === -1 ? METRIC_LATENCY_BOUNDS_MS.length : index;
}

function parseBoundedJson(buffer, maximumBytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > maximumBytes) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function skipJsonWhitespace(source, offset) {
  while (offset < source.length && /\s/u.test(source[offset])) offset += 1;
  return offset;
}

function jsonStringEnd(source, start) {
  let escaped = false;
  for (let offset = start + 1; offset < source.length; offset += 1) {
    const character = source[offset];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "\"") {
      return offset + 1;
    }
  }
  return -1;
}

function jsonValueEnd(source, start) {
  if (source[start] === "\"") return jsonStringEnd(source, start);
  if (source[start] !== "{" && source[start] !== "[") {
    let offset = start;
    while (offset < source.length && !/[\s,}]/u.test(source[offset])) offset += 1;
    return offset;
  }
  let depth = 0;
  for (let offset = start; offset < source.length; offset += 1) {
    const character = source[offset];
    if (character === "\"") {
      offset = jsonStringEnd(source, offset) - 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return offset + 1;
    }
  }
  return -1;
}

function rewriteTopLevelModel(buffer, modelOverride) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MODEL_OVERRIDE_MAX_BYTES) return null;
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }

  let offset = skipJsonWhitespace(source, 0);
  offset += 1;
  let hasProperties = false;
  const replacements = [];
  let closingBrace = -1;
  while (offset < source.length) {
    offset = skipJsonWhitespace(source, offset);
    if (source[offset] === "}") {
      closingBrace = offset;
      break;
    }
    hasProperties = true;
    const keyStart = offset;
    const keyEnd = jsonStringEnd(source, keyStart);
    const key = JSON.parse(source.slice(keyStart, keyEnd));
    offset = skipJsonWhitespace(source, keyEnd) + 1;
    offset = skipJsonWhitespace(source, offset);
    const valueStart = offset;
    const valueEnd = jsonValueEnd(source, valueStart);
    if (key === "model") replacements.push({ start: valueStart, end: valueEnd });
    offset = skipJsonWhitespace(source, valueEnd);
    if (source[offset] === ",") offset += 1;
  }
  if (closingBrace === -1) return null;

  const replacement = JSON.stringify(modelOverride);
  if (replacements.length === 0) {
    const insertion = `${hasProperties ? "," : ""}"model":${replacement}`;
    const rewritten = Buffer.from(`${source.slice(0, closingBrace)}${insertion}${source.slice(closingBrace)}`);
    return rewritten.length <= MODEL_OVERRIDE_MAX_BYTES
      ? { body: rewritten, changed: true }
      : { tooLarge: true };
  }
  if (replacements.every(({ start, end }) => source.slice(start, end) === replacement)) {
    return { body: buffer, changed: false };
  }
  const chunks = [];
  let cursor = 0;
  for (const range of replacements) {
    chunks.push(source.slice(cursor, range.start), replacement);
    cursor = range.end;
  }
  chunks.push(source.slice(cursor));
  const rewritten = Buffer.from(chunks.join(""));
  return rewritten.length <= MODEL_OVERRIDE_MAX_BYTES
    ? { body: rewritten, changed: true }
    : { tooLarge: true };
}

function safeMetricModel(value, settings, protectedValues = protectedHeaderValues(settings)) {
  if (typeof value !== "string" || value.length === 0
    || value.length > METRIC_MAX_MODEL_CODE_POINTS * 2
    || [...value].length > METRIC_MAX_MODEL_CODE_POINTS
    || value.trim() !== value
    || METRIC_TEXT_CONTROL_PATTERN.test(value)) {
    return null;
  }
  return containsRecoverableProtectedValue(value, protectedValues) ? null : value;
}

function normalizeMetricUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0
    || inputTokens > METRIC_MAX_OBSERVATION_TOKENS
    || !Number.isSafeInteger(outputTokens) || outputTokens < 0
    || outputTokens > METRIC_MAX_OBSERVATION_TOKENS) {
    return null;
  }
  return { inputTokens, outputTokens };
}

function metricResultForStatus(statusCode) {
  if (statusCode >= 200 && statusCode <= 299) return "success";
  if (statusCode >= 400 && statusCode <= 499) return "upstreamRejected";
  return "upstreamError";
}

function isResponsesRequest(requestUrl) {
  try {
    const pathname = new URL(requestUrl, "http://127.0.0.1").pathname.replace(/\/+$/, "");
    return pathname.endsWith("/responses");
  } catch {
    return false;
  }
}

function semanticResultForJson(body, fallbackInspection) {
  const parsed = parseBoundedJson(body, METRIC_BODY_INSPECTION_MAX_BYTES);
  if (parsed) {
    const failed = parsed.error != null
      || parsed.status === "failed"
      || parsed.status === "incomplete"
      || parsed.status === "cancelled";
    const completed = parsed.object === "response"
      && parsed.status === "completed"
      && Array.isArray(parsed.output);
    return {
      terminal: failed ? "failure" : (completed ? "success" : null),
      usage: normalizeMetricUsage(parsed.usage)
    };
  }
  if (Buffer.isBuffer(body) && body.length > 0) {
    return { terminal: null, usage: null };
  }

  const inspection = fallbackInspection?.snapshot?.() ?? fallbackInspection ?? {};
  if (inspection.invalid || inspection.complete !== true) {
    return { terminal: null, usage: null };
  }
  const status = inspection.strings?.status;
  const explicitFailure = status === "failed"
    || status === "incomplete"
    || status === "cancelled"
    || (inspection.tokens?.error && inspection.tokens.error !== "n");
  return {
    // The lightweight scanner cannot validate an arbitrarily large JSON document.
    terminal: explicitFailure ? "failure" : null,
    usage: null
  };
}

function inspectCompletedResponse({
  statusCode,
  stream,
  responsesRequest,
  contentEncoding,
  metricCollector,
  jsonInspector,
  sseInspector
}) {
  const statusResult = metricResultForStatus(statusCode);
  let semantic = null;
  let usage = null;
  const encodedBody = metricCollector?.truncated ? null : metricCollector?.buffer();
  const decodedBody = encodedBody === null
    ? null
    : decodeBoundedBody(encodedBody, contentEncoding, METRIC_BODY_INSPECTION_MAX_BYTES);

  if (stream) {
    const inspection = sseInspector
      ? sseInspector.end()
      : (decodedBody ? (() => {
          const boundedSse = createSseInspector();
          boundedSse.write(decodedBody);
          return boundedSse.end();
        })() : { terminal: null, usage: null });
    semantic = inspection.terminal;
    usage = inspection.usage;
  } else if (decodedBody) {
    const inspection = semanticResultForJson(decodedBody, jsonInspector);
    semantic = inspection.terminal;
    usage = inspection.usage;
  } else if (jsonInspector) {
    semantic = semanticResultForJson(Buffer.alloc(0), jsonInspector).terminal;
  }

  return {
    result: statusResult === "success" && responsesRequest && semantic !== "success"
      ? "upstreamError"
      : statusResult,
    usage
  };
}

function buildHealthPayload(settings, captureManager, settingsSource) {
  const protectedValues = protectedHeaderValues(settings);
  const captureState = redactProtectedFields(captureManager.getPublicState(), protectedValues);
  if (settingsSource) {
    return redactProtectedFields({
      ok: true,
      ...settingsSource.publicState(),
      ...captureState
    }, protectedValues);
  }
  return redactProtectedFields({
    ok: true,
    configPath: redactProtectedUrl(settings.configPath, protectedValues),
    listenHost: settings.server.host,
    listenPort: settings.server.port,
    upstreamBaseUrl: redactProtectedUrl(settings.upstream.baseUrl, protectedValues),
    overrideAuthorization: settings.proxy.overrideAuthorization,
    authHeader: settings.upstream.authHeader,
    authScheme: settings.upstream.authScheme,
    extraHeaderCount: Object.keys(settings.upstream.extraHeaders).length,
    ...captureState
  }, protectedValues);
}

function buildRequestContext({
  req,
  settings,
  targetUrl,
  requestId,
  requestHeaders,
  requestBody,
  startedAt,
  captureHandle,
  protectedValues
}) {
  const turnMetadataHeader = req.headers["x-codex-turn-metadata"];
  let turnMetadata = null;
  if (typeof turnMetadataHeader === "string") {
    try {
      turnMetadata = JSON.parse(turnMetadataHeader);
    } catch {
      turnMetadata = null;
    }
  }

  const captureHeaders = sanitizeHeadersForCapture(
    requestHeaders,
    settings.upstream.authHeader,
    protectedHeaderValues(settings)
  );

  return {
    requestId,
    sessionId: redactRecoverableProtectedText(typeof req.headers["session-id"] === "string"
      ? req.headers["session-id"]
      : (typeof req.headers["session_id"] === "string" ? req.headers["session_id"] : (turnMetadata?.session_id || "")), protectedValues) || null,
    threadId: redactRecoverableProtectedText(typeof req.headers["thread-id"] === "string"
      ? req.headers["thread-id"]
      : (typeof req.headers["thread_id"] === "string" ? req.headers["thread_id"] : (turnMetadata?.thread_id || "")), protectedValues) || null,
    method: redactRecoverableProtectedText(req.method || "GET", protectedValues),
    incomingUrl: redactProtectedUrl(
      new URL(req.url, `http://${settings.server.host}:${settings.server.port}`).href,
      protectedValues
    ),
    targetUrl: redactProtectedUrl(targetUrl.href, protectedValues),
    requestHeaders: captureHeaders,
    requestBody,
    startedAt: new Date(startedAt).toISOString(),
    captureHandle
  };
}

function saveCaptureRecord(captureContext, fields) {
  if (!captureContext?.captureHandle) {
    return;
  }
  captureContext.captureHandle.save({
    startedAt: captureContext.startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(captureContext.startedAt),
    requestId: captureContext.requestId,
    sessionId: captureContext.sessionId,
    threadId: captureContext.threadId,
    method: captureContext.method,
    incomingUrl: captureContext.incomingUrl,
    targetUrl: captureContext.targetUrl,
    requestHeaders: captureContext.requestHeaders,
    requestBody: captureContext.requestBody,
    requestBodyBytes: captureContext.requestBodyBytes,
    requestBodyTruncated: captureContext.requestBodyTruncated,
    responseStatus: fields.responseStatus,
    responseHeaders: fields.responseHeaders ?? {},
    responseBody: fields.responseBody ?? Buffer.alloc(0),
    responseBodyBytes: fields.responseBodyBytes,
    responseBodyTruncated: fields.responseBodyTruncated,
    isStream: fields.isStream ?? false,
    upstreamRequestId: fields.upstreamRequestId ?? null,
    errorType: fields.errorType ?? null,
    errorMessage: fields.errorMessage ?? null
  });
}

export function createServer(settings, {
  captureManager = createCaptureManager({
    configPath: settings.configPath,
    capture: settings.capture,
    log: (level, message, fields = {}) => log(
      level,
      message,
      redactProtectedFields(fields, protectedHeaderValues(settings))
    )
  }).start(),
  logFn = log,
  settingsSource,
  accountStateSource,
  recordMetric = () => {},
  metricNow = Date.now,
  routingNow = Date.now,
  resolveAccountTarget = (target) => target
} = {}) {
  let accountBlockedUntilMs = null;
  return http.createServer((req, res) => {
    if (!req.url) {
      writeJson(res, 400, { error: { message: "Missing request URL", type: "proxy_bad_request" } });
      return;
    }

    if (req.url === HEALTH_PATH) {
      let healthSettings = settings;
      try {
        healthSettings = settingsSource?.current().settings ?? settings;
      } catch {
        // An unconfigured source still exposes its existing public health contract.
      }
      writeJson(res, 200, buildHealthPayload(healthSettings, captureManager, settingsSource));
      return;
    }

    let active;
    try {
      active = settingsSource ? settingsSource.current() : { generation: 0, settings };
    } catch (error) {
      const unavailable = error?.code === "RUNTIME_SETTINGS_UNAVAILABLE";
      writeJson(res, unavailable ? 503 : 500, {
        error: {
          code: unavailable ? "RUNTIME_SETTINGS_UNAVAILABLE" : "RUNTIME_SETTINGS_ERROR",
          message: unavailable ? "Proxy settings are not configured." : "Proxy settings could not be loaded."
        }
      });
      return;
    }
    const requestSettings = active.settings;
    const requestProtectedValues = protectedRequestValues(req, requestSettings);
    const requestDebugEnabled = requestSettings.server.logLevel.toLowerCase() === "debug";
    const rawRequestId = req.headers[requestSettings.proxy.requestIdHeader] || req.headers["x-request-id"] || "-";
    const requestId = redactRecoverableProtectedText(String(rawRequestId), requestProtectedValues);
    const customTargetUrl = buildTargetUrl(requestSettings.upstream.baseUrl, req.url);
    let accountState = requestSettings.routing?.account ?? null;
    try {
      accountState = accountStateSource?.current().state ?? accountState;
    } catch {
      // A missing live state falls back to the validated Worker configuration snapshot.
    }
    const routeDecision = decideUpstreamRoute({
      mode: requestSettings.routing?.mode ?? "custom_only",
      method: req.method,
      requestUrl: req.url,
      rawHeaders: req.rawHeaders,
      accountState,
      localBlockedUntilMs: accountBlockedUntilMs,
      nowMs: routingNow()
    });
    let metricRoute = routeDecision.route;
    let targetUrl = routeDecision.target
      ? resolveAccountTarget(new URL(routeDecision.target.href))
      : customTargetUrl;
    const safeRequestPath = redactProtectedUrl(req.url, requestProtectedValues);
    let safeTargetUrl = redactProtectedUrl(targetUrl.href, requestProtectedValues);
    const safeMethod = redactRecoverableProtectedText(req.method || "GET", requestProtectedValues);
    let transport = targetUrl.protocol === "https:" ? https : http;
    const startedAt = Date.now();
    const metricStartedAt = metricNow();
    const responsesRequest = isResponsesRequest(req.url);
    const overrideModel = requestSettings.proxy.modelMode === "override"
      && typeof requestSettings.proxy.modelOverride === "string"
      ? requestSettings.proxy.modelOverride
      : null;
    const requestEncoding = req.headers["content-encoding"];
    const normalizedRequestEncoding = singleContentEncoding(requestEncoding);
    const directRequestInspection = normalizedRequestEncoding === "" || normalizedRequestEncoding === "identity";
    const captureHandle = captureManager.beginRecord();
    let requestCapture = captureHandle ? createBoundedCollector(CAPTURE_BODY_MAX_BYTES) : null;
    const requestPreview = requestDebugEnabled ? createBoundedCollector(4096) : null;
    const initialAccountRoute = metricRoute === "account";
    const requestModelInspector = (!overrideModel || initialAccountRoute) && directRequestInspection
      ? createTopLevelJsonInspector({ stringKeys: ["model"] })
      : null;
    const encodedRequestMetric = (!overrideModel || initialAccountRoute) && !directRequestInspection
      ? createBoundedCollector(METRIC_BODY_INSPECTION_MAX_BYTES)
      : null;
    const overrideCollector = overrideModel && !initialAccountRoute
      ? createBoundedCollector(MODEL_OVERRIDE_MAX_BYTES)
      : null;
    let forwardedHeaders = initialAccountRoute
      ? buildAccountUpstreamHeaders(req, requestSettings, targetUrl)
      : buildUpstreamHeaders(req, requestSettings, targetUrl, {
          stripContentHeaders: false,
          stripAccountHeaders: true
        });
    let captureContext = null;
    let captureSaved = false;
    let metricSaved = false;
    let terminal = false;
    let requestEnded = false;
    let requestModel = overrideModel && !initialAccountRoute
      ? safeMetricModel(overrideModel, requestSettings, requestProtectedValues)
      : null;
    let requestInspectionFinished = Boolean(overrideModel && !initialAccountRoute);
    let upstreamRequest = null;
    let upstreamResponse = null;
    let responseState = null;
    let responseStartBin = null;
    let timedOut = false;
    let replayBody = null;

    function requestCaptureSnapshot() {
      const snapshot = captureBodySnapshot(requestCapture, requestEncoding, requestProtectedValues);
      return {
        requestBody: snapshot.body,
        requestBodyBytes: snapshot.totalBytes,
        requestBodyTruncated: snapshot.truncated
      };
    }

    function ensureCaptureContext() {
      if (!captureHandle || captureContext) return captureContext;
      captureContext = buildRequestContext({
        req,
        settings: requestSettings,
        targetUrl,
        requestId,
        requestHeaders: forwardedHeaders,
        requestBody: Buffer.alloc(0),
        startedAt,
        captureHandle,
        protectedValues: requestProtectedValues
      });
      return captureContext;
    }

    function finalizeCapture(fields) {
      if (captureSaved || !captureHandle) return;
      captureSaved = true;
      const context = ensureCaptureContext();
      Object.assign(context, requestCaptureSnapshot());
      saveCaptureRecord(context, fields);
    }

    function finishRequestInspection() {
      if (requestInspectionFinished) return requestModel;
      requestInspectionFinished = true;
      if (requestModelInspector) {
        const inspection = requestModelInspector.end();
        requestModel = inspection.complete && !inspection.invalid
          ? safeMetricModel(inspection.strings.model, requestSettings, requestProtectedValues)
          : null;
      } else if (encodedRequestMetric && !encodedRequestMetric.truncated) {
        const decoded = decodeBoundedBody(
          encodedRequestMetric.buffer(),
          requestEncoding,
          METRIC_BODY_INSPECTION_MAX_BYTES
        );
        if (decoded) {
          const inspector = createTopLevelJsonInspector({ stringKeys: ["model"] });
          inspector.write(decoded);
          const inspection = inspector.end();
          requestModel = inspection.complete && !inspection.invalid
            ? safeMetricModel(inspection.strings.model, requestSettings, requestProtectedValues)
            : null;
        }
      }
      return requestModel;
    }

    function finalizeMetric(result, usage = null) {
      if (metricSaved) return;
      metricSaved = true;
      if (!Number.isSafeInteger(active.generation) || active.generation <= 0) return;
      const observation = {
        generation: active.generation,
        route: metricRoute,
        result,
        model: requestEnded ? finishRequestInspection() : requestModel,
        inputTokens: result === "success" ? (usage?.inputTokens ?? null) : null,
        outputTokens: result === "success" ? (usage?.outputTokens ?? null) : null,
        durationBin: metricLatencyBin(metricNow() - metricStartedAt),
        responseStartBin
      };
      try {
        const pending = recordMetric(observation);
        if (pending && typeof pending.then === "function") void pending.catch(() => {});
      } catch {
        // Operational metrics must never affect proxy forwarding.
      }
    }

    function clearResponseHeaders() {
      if (res.headersSent) return;
      for (const name of res.getHeaderNames()) res.removeHeader(name);
    }

    function switchToCustomRoute() {
      metricRoute = "custom";
      targetUrl = customTargetUrl;
      safeTargetUrl = redactProtectedUrl(targetUrl.href, requestProtectedValues);
      transport = targetUrl.protocol === "https:" ? https : http;
      forwardedHeaders = buildUpstreamHeaders(req, requestSettings, targetUrl, {
        stripContentHeaders: false,
        stripAccountHeaders: true
      });
      upstreamResponse = null;
      responseState = null;
      responseStartBin = null;
      timedOut = false;
      if (captureContext) {
        captureContext.targetUrl = safeTargetUrl;
        captureContext.requestHeaders = sanitizeHeadersForCapture(
          forwardedHeaders,
          requestSettings.upstream.authHeader,
          requestProtectedValues
        );
      }
    }

    function prepareCustomOverrideBody(encodedBody) {
      const normalizedEncoding = singleContentEncoding(requestEncoding);
      const supportedEncoding = normalizedEncoding === ""
        || normalizedEncoding === "identity"
        || normalizedEncoding === "gzip"
        || normalizedEncoding === "deflate"
        || normalizedEncoding === "br"
        || normalizedEncoding === "zstd";
      if (!supportedEncoding) {
        logRequestBody();
        finishProxyFailure({
          statusCode: 415,
          errorType: "proxy_unsupported_content_encoding",
          result: "upstreamError",
          error: new Error("model override content encoding is unsupported")
        });
        return null;
      }
      let decodedBody;
      try {
        decodedBody = decompressBody(encodedBody, normalizedEncoding, MODEL_OVERRIDE_MAX_BYTES);
      } catch (error) {
        const tooLarge = error?.code === "ERR_BUFFER_TOO_LARGE"
          || String(error?.message).includes("exceeds the inspection limit");
        finishProxyFailure({
          statusCode: tooLarge ? 413 : 400,
          errorType: tooLarge ? "proxy_request_too_large" : "proxy_bad_request",
          result: "upstreamError",
          error
        });
        return null;
      }
      const rewrite = rewriteTopLevelModel(decodedBody, overrideModel);
      if (!rewrite) {
        logRequestBody();
        finishProxyFailure({
          statusCode: 400,
          errorType: "proxy_bad_request",
          result: "upstreamError",
          error: new Error("model override request is not a valid JSON object")
        });
        return null;
      }
      if (rewrite.tooLarge) {
        finishProxyFailure({
          statusCode: 413,
          errorType: "proxy_request_too_large",
          result: "upstreamError",
          error: new Error("rewritten model override request exceeds the bounded transformation limit")
        });
        return null;
      }
      let forwardedBody = encodedBody;
      if (rewrite.changed) {
        try {
          if (normalizedEncoding === "zstd" && typeof zlib.zstdCompressSync !== "function") {
            forwardedBody = rewrite.body;
            removeHeader(forwardedHeaders, "content-encoding");
          } else {
            forwardedBody = encodeBodyWithOriginalEncoding(rewrite.body, requestEncoding);
          }
        } catch (error) {
          finishProxyFailure({
            statusCode: 415,
            errorType: "proxy_unsupported_content_encoding",
            result: "upstreamError",
            error
          });
          return null;
        }
        stripBodyIntegrityHeaders(forwardedHeaders);
        upsertHeader(forwardedHeaders, "content-length", String(forwardedBody.length));
      }
      if (requestCapture) {
        requestCapture = createBoundedCollector(CAPTURE_BODY_MAX_BYTES);
        requestCapture.append(forwardedBody);
      }
      requestModel = safeMetricModel(overrideModel, requestSettings, requestProtectedValues);
      requestInspectionFinished = true;
      return forwardedBody;
    }

    function startCustomFallback() {
      if (terminal || !Buffer.isBuffer(replayBody)) return;
      switchToCustomRoute();
      const forwardedBody = overrideModel
        ? prepareCustomOverrideBody(replayBody)
        : replayBody;
      if (!forwardedBody || terminal) return;
      logRequestBody(forwardedBody.subarray(0, 4096));
      const outgoing = createUpstreamRequest();
      outgoing?.end(forwardedBody);
    }

    function logRequestBody(body = null) {
      if (!requestDebugEnabled) return;
      const preview = body ?? requestPreview?.buffer() ?? Buffer.alloc(0);
      debugLog("REQUEST", {
        method: safeMethod,
        path: safeRequestPath,
        targetUrl: safeTargetUrl,
        incomingHeaders: sanitizeHeadersForDebug(
          Object.fromEntries(Object.entries(req.headers)),
          requestSettings.upstream.authHeader,
          requestProtectedValues
        ),
        upstreamHeaders: sanitizeHeadersForDebug(
          Object.fromEntries(forwardedHeaders),
          requestSettings.upstream.authHeader,
          requestProtectedValues
        ),
        body: safeBodyPreview(preview, 4096, requestProtectedValues, {
          contentEncoding: requestEncoding,
          truncated: requestPreview?.truncated === true
        }),
        bodyTruncated: body === null && requestPreview?.truncated === true
      }, true);
    }

    function proxyErrorPayload(statusCode, errorType) {
      return {
        error: {
          message: statusCode === 504
            ? "Upstream request timed out"
            : (statusCode === 413
                ? "Request body is too large for model override"
                : (statusCode === 400
                    ? "Request body must be a valid JSON object for model override"
                    : (statusCode === 415
                        ? "Request content encoding is not supported for model override"
                        : "Failed to reach upstream service"))),
          type: errorType,
          request_id: requestId
        }
      };
    }

    function responseCaptureSnapshot() {
      const snapshot = captureBodySnapshot(
        responseState?.capture,
        responseState?.contentEncoding,
        requestProtectedValues
      );
      return {
        responseBody: snapshot.body,
        responseBodyBytes: snapshot.totalBytes,
        responseBodyTruncated: snapshot.truncated
      };
    }

    function finishProxyFailure({ statusCode, errorType, result, error, responseStarted = false }) {
      if (terminal) return;
      terminal = true;
      const message = redactRecoverableProtectedText(
        error instanceof Error ? error.message : String(error ?? errorType),
        requestProtectedValues
      );
      upstreamResponse?.destroy();
      upstreamRequest?.destroy();
      req.resume?.();
      const payload = proxyErrorPayload(statusCode, errorType);
      const proxyBody = Buffer.from(JSON.stringify(payload));
      const proxyHeaders = {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(proxyBody.length)
      };

      debugLog("UPSTREAM ERROR", {
        error: message,
        code: redactRecoverableProtectedText(error?.code || "(none)", requestProtectedValues),
        stack: error?.stack
          ? redactRecoverableProtectedText(error.stack, requestProtectedValues)
          : undefined
      }, requestDebugEnabled);
      if (!res.headersSent && !res.destroyed) {
        clearResponseHeaders();
        writeJson(res, statusCode, payload);
      } else if (!res.destroyed) {
        res.destroy();
      }
      finalizeCapture({
        responseStatus: responseStarted ? (responseState?.statusCode ?? statusCode) : statusCode,
        responseHeaders: responseStarted ? (responseState?.captureHeaders ?? {}) : proxyHeaders,
        ...(responseStarted
          ? responseCaptureSnapshot()
          : {
              responseBody: proxyBody,
              responseBodyBytes: proxyBody.length,
              responseBodyTruncated: false
            }),
        isStream: responseState?.stream ?? false,
        upstreamRequestId: responseStarted ? (responseState?.upstreamRequestId ?? null) : null,
        errorType,
        errorMessage: message
      });
      finalizeMetric(result);
      logFn("warn", "Proxy request failed", {
        request_id: requestId,
        method: safeMethod,
        path: safeRequestPath,
        status: responseStarted ? (responseState?.statusCode ?? statusCode) : statusCode,
        duration_ms: Date.now() - startedAt,
        error: JSON.stringify(message)
      });
    }

    function handleClientAbort() {
      if (terminal || res.writableFinished) return;
      terminal = true;
      upstreamResponse?.destroy();
      upstreamRequest?.destroy();
      finalizeCapture({
        responseStatus: responseState?.statusCode ?? (res.headersSent ? res.statusCode : null),
        responseHeaders: responseState?.captureHeaders ?? {},
        ...responseCaptureSnapshot(),
        isStream: responseState?.stream ?? false,
        upstreamRequestId: responseState?.upstreamRequestId ?? null,
        errorType: "proxy_client_abort",
        errorMessage: "Client closed connection"
      });
      finalizeMetric("clientAbort");
    }

    function maybeCompleteResponse() {
      if (terminal || !responseState?.upstreamEnded || !responseState.downstreamFinished) return;
      terminal = true;
      if (!requestEnded) {
        upstreamRequest?.destroy();
        req.resume?.();
      }
      const inspected = inspectCompletedResponse({
        statusCode: responseState.statusCode,
        stream: responseState.stream,
        responsesRequest,
        contentEncoding: responseState.contentEncoding,
        metricCollector: responseState.metricCollector,
        jsonInspector: responseState.jsonInspector,
        sseInspector: responseState.sseInspector
      });
      const captureSnapshot = responseCaptureSnapshot();
      const responseBody = captureSnapshot.responseBody;
      const responsePreview = responseState.preview?.buffer() ?? responseBody;
      if (responsePreview.length) {
        debugLog("RESPONSE BODY", {
          status: responseState.statusCode,
          body: safeBodyPreview(responsePreview, 4096, requestProtectedValues, {
            contentEncoding: responseState.contentEncoding,
            truncated: responseState.preview?.truncated === true
          }),
          bodyTruncated: responseState.preview?.truncated === true
        }, requestDebugEnabled);
      }
      finalizeCapture({
        responseStatus: responseState.statusCode,
        responseHeaders: responseState.captureHeaders,
        ...captureSnapshot,
        isStream: responseState.stream,
        upstreamRequestId: responseState.upstreamRequestId
      });
      finalizeMetric(inspected.result, inspected.usage);
      logFn("info", "Proxied request", {
        request_id: requestId,
        method: safeMethod,
        path: safeRequestPath,
        status: responseState.statusCode,
        stream: responseState.stream,
        duration_ms: Date.now() - startedAt
      });
    }

    function onUpstreamResponse(incoming) {
      if (terminal) {
        incoming.destroy();
        return;
      }
      if (metricRoute === "account") {
        const observedQuota = parseCodexQuotaHeaders(incoming.headers, routingNow());
        if (observedQuota?.blockedUntilMs !== null
          && observedQuota?.blockedUntilMs !== undefined) {
          accountBlockedUntilMs = observedQuota.blockedUntilMs;
        } else if (incoming.statusCode >= 200
          && incoming.statusCode <= 299
          && observedQuota?.status === "available") {
          accountBlockedUntilMs = null;
        }
        if (incoming.statusCode === 429 && Buffer.isBuffer(replayBody)) {
          accountBlockedUntilMs = account429Cooldown(incoming.headers, routingNow()).untilMs;
          incoming.destroy();
          startCustomFallback();
          return;
        }
      }
      upstreamResponse = incoming;
      const stream = isEventStream(incoming.headers["content-type"]);
      const contentEncoding = incoming.headers["content-encoding"];
      const normalizedEncoding = singleContentEncoding(contentEncoding);
      const directInspection = normalizedEncoding === "" || normalizedEncoding === "identity";
      responseState = {
        statusCode: incoming.statusCode || 502,
        stream,
        contentEncoding,
        captureHeaders: sanitizeHeadersForCapture(
          incoming.headers,
          requestSettings.upstream.authHeader,
          requestProtectedValues
        ),
        upstreamRequestId: typeof incoming.headers["x-request-id"] === "string"
          ? redactRecoverableProtectedText(incoming.headers["x-request-id"], requestProtectedValues)
          : null,
        capture: captureHandle ? createBoundedCollector(CAPTURE_BODY_MAX_BYTES) : null,
        preview: requestDebugEnabled ? createBoundedCollector(4096) : null,
        metricCollector: (!directInspection || !stream)
          ? createBoundedCollector(METRIC_BODY_INSPECTION_MAX_BYTES)
          : null,
        jsonInspector: directInspection && !stream
          ? createTopLevelJsonInspector({
              stringKeys: ["status"],
              tokenKeys: ["error"]
            })
          : null,
        sseInspector: directInspection && stream ? createSseInspector() : null,
        upstreamEnded: false,
        downstreamFinished: false
      };

      debugLog("RESPONSE HEADERS", {
        status: incoming.statusCode,
        headers: sanitizeHeadersForDebug(
          incoming.headers,
          requestSettings.upstream.authHeader,
          requestProtectedValues
        )
      }, requestDebugEnabled);

      incoming.on("data", (chunk) => {
        if (terminal) return;
        if (responseStartBin === null && chunk.length > 0) {
          responseStartBin = metricLatencyBin(metricNow() - metricStartedAt);
        }
        responseState.capture?.append(chunk);
        responseState.preview?.append(chunk);
        responseState.metricCollector?.append(chunk);
        responseState.jsonInspector?.write(chunk);
        responseState.sseInspector?.write(chunk);
      });
      incoming.once("end", () => {
        if (terminal) return;
        responseState.jsonInspector?.end();
        responseState.upstreamEnded = true;
        maybeCompleteResponse();
      });
      const responseFailure = (error) => finishProxyFailure({
        statusCode: timedOut ? 504 : 502,
        errorType: timedOut ? "proxy_timeout" : "proxy_upstream_response_error",
        result: timedOut ? "timeout" : "networkError",
        error: error ?? new Error("Upstream response ended unexpectedly"),
        responseStarted: res.headersSent
      });
      incoming.once("aborted", responseFailure);
      incoming.once("error", responseFailure);
      incoming.once("close", () => {
        if (!incoming.complete && !responseState?.upstreamEnded) responseFailure(new Error("Upstream response closed early"));
      });

      res.statusCode = responseState.statusCode;
      writeHeadersToResponse(res, incoming.rawHeaders);
      incoming.pipe(res);
    }

    function createUpstreamRequest() {
      if (terminal) return null;
      let createdRequest;
      try {
        createdRequest = transport.request(
          {
            method: req.method,
            protocol: targetUrl.protocol,
            hostname: targetUrl.hostname,
            port: targetUrl.port || undefined,
            path: `${targetUrl.pathname}${targetUrl.search}`,
            headers: forwardedHeaders,
            rejectUnauthorized: metricRoute === "account"
              ? true
              : requestSettings.upstream.verifySsl
          },
          onUpstreamResponse
        );
        upstreamRequest = createdRequest;
      } catch (error) {
        finishProxyFailure({
          statusCode: 502,
          errorType: "proxy_upstream_error",
          result: "networkError",
          error
        });
        return null;
      }
      ensureCaptureContext();
      createdRequest.setTimeout(requestSettings.upstream.timeoutMs, () => {
        if (createdRequest !== upstreamRequest) return;
        timedOut = true;
        createdRequest.destroy(new Error("upstream timeout"));
      });
      createdRequest.on("error", (error) => {
        if (terminal || createdRequest !== upstreamRequest) return;
        finishProxyFailure({
          statusCode: timedOut ? 504 : 502,
          errorType: timedOut ? "proxy_timeout" : "proxy_upstream_error",
          result: timedOut ? "timeout" : "networkError",
          error,
          responseStarted: Boolean(upstreamResponse && res.headersSent)
        });
      });
      createdRequest.on("drain", () => {
        if (!terminal && createdRequest === upstreamRequest) req.resume?.();
      });
      return createdRequest;
    }

    res.on("finish", () => {
      if (!responseState) return;
      responseState.downstreamFinished = true;
      maybeCompleteResponse();
    });
    res.on("close", handleClientAbort);
    req.on("aborted", handleClientAbort);
    req.on("error", handleClientAbort);

    if (initialAccountRoute) {
      const accountChunks = [];
      let accountBytes = 0;
      let outgoing = null;
      let streamingCustom = false;
      req.on("data", (chunk) => {
        if (terminal) return;
        requestCapture?.append(chunk);
        requestPreview?.append(chunk);
        requestModelInspector?.write(chunk);
        encodedRequestMetric?.append(chunk);
        if (streamingCustom) {
          if (outgoing && !outgoing.write(chunk)) req.pause?.();
          return;
        }
        if (accountBytes + chunk.length <= ACCOUNT_REQUEST_REPLAY_MAX_BYTES) {
          accountChunks.push(Buffer.from(chunk));
          accountBytes += chunk.length;
          return;
        }
        if (overrideModel) {
          logRequestBody();
          finishProxyFailure({
            statusCode: 413,
            errorType: "proxy_request_too_large",
            result: "upstreamError",
            error: new Error("model override request exceeds the bounded transformation limit")
          });
          return;
        }
        streamingCustom = true;
        replayBody = null;
        switchToCustomRoute();
        outgoing = createUpstreamRequest();
        let backpressured = false;
        for (const buffered of accountChunks) {
          if (outgoing && !outgoing.write(buffered)) backpressured = true;
        }
        accountChunks.length = 0;
        if (outgoing && !outgoing.write(chunk)) backpressured = true;
        if (backpressured) req.pause?.();
      });
      req.on("end", () => {
        requestEnded = true;
        finishRequestInspection();
        if (terminal) return;
        if (streamingCustom) {
          logRequestBody();
          outgoing ??= createUpstreamRequest();
          outgoing?.end();
          return;
        }
        replayBody = Buffer.concat(accountChunks, accountBytes);
        logRequestBody(replayBody.subarray(0, 4096));
        outgoing = createUpstreamRequest();
        outgoing?.end(replayBody);
      });
      return;
    }

    if (overrideModel) {
      req.on("data", (chunk) => {
        if (terminal) return;
        requestCapture?.append(chunk);
        requestPreview?.append(chunk);
        overrideCollector.append(chunk);
        if (overrideCollector.truncated) {
          logRequestBody();
          finishProxyFailure({
            statusCode: 413,
            errorType: "proxy_request_too_large",
            result: "upstreamError",
            error: new Error("model override request exceeds the bounded transformation limit")
          });
        }
      });
      req.on("end", () => {
        requestEnded = true;
        if (terminal) return;
        const encodedBody = overrideCollector.buffer();
        const forwardedBody = prepareCustomOverrideBody(encodedBody);
        if (!forwardedBody || terminal) return;
        logRequestBody(forwardedBody.subarray(0, 4096));
        const outgoing = createUpstreamRequest();
        outgoing?.end(forwardedBody);
      });
      return;
    }

    let outgoing = null;
    req.on("data", (chunk) => {
      if (terminal) return;
      outgoing ??= createUpstreamRequest();
      requestCapture?.append(chunk);
      requestPreview?.append(chunk);
      requestModelInspector?.write(chunk);
      encodedRequestMetric?.append(chunk);
      if (outgoing && !outgoing.write(chunk)) req.pause?.();
    });
    req.on("end", () => {
      requestEnded = true;
      finishRequestInspection();
      logRequestBody();
      if (!terminal) {
        outgoing ??= createUpstreamRequest();
        outgoing?.end();
      }
    });
  });
}

export function createApp(settings = loadConfig(), {
  settingsSource,
  accountStateSource,
  recordMetric
} = {}) {
  const protectedValues = protectedHeaderValues(settings);
  const captureManager = createCaptureManager({
    configPath: settings.configPath,
    capture: settings.capture,
    log: (level, message, fields = {}) => log(
      level,
      message,
      redactProtectedFields(fields, protectedValues)
    )
  }).start();

  log("info", "Loaded proxy config", redactProtectedFields({
    config_path: redactProtectedUrl(settings.configPath, protectedValues),
    upstream: redactProtectedUrl(settings.upstream.baseUrl, protectedValues),
    auth_override: settings.proxy.overrideAuthorization,
    auth_header: settings.upstream.authHeader,
    api_key: maskSecret(settings.upstream.apiKey),
    capture_enabled: settings.capture.enabled,
    capture_db_path: redactProtectedUrl(settings.capture.dbPath, protectedValues)
  }, protectedValues));

  const server = createServer(settings, {
    captureManager,
    logFn: log,
    settingsSource,
    accountStateSource,
    recordMetric
  });
  server.on("close", () => {
    captureManager.close();
  });

  return { server, settings, captureManager };
}

export function startServer(settings = loadConfig()) {
  const app = createApp(settings);
  const protectedValues = protectedHeaderValues(settings);
  app.server.on("error", (error) => {
    log("error", "Node proxy failed to listen", redactProtectedFields({
      host: settings.server.host,
      port: settings.server.port,
      error: JSON.stringify(redactRecoverableProtectedText(error.message, protectedValues))
    }, protectedValues));
    process.exit(1);
  });

  app.server.listen(settings.server.port, settings.server.host, () => {
    log("info", "Node proxy listening", redactProtectedFields({
      host: settings.server.host,
      port: settings.server.port
    }, protectedValues));
  });

  return app;
}

function isWindowsStylePath(filePath) {
  return /^[A-Za-z]:[\\/]/.test(filePath);
}

function isPosixStylePath(filePath) {
  return filePath.startsWith("/") && !/^\/[A-Za-z]:\//.test(filePath);
}

function modulePathFromMetaUrl(metaUrl) {
  const url = new URL(metaUrl);
  if (url.protocol !== "file:") {
    return null;
  }
  const pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:\//.test(pathname)) {
    return path.win32.normalize(pathname.slice(1));
  }
  if (pathname.startsWith("/")) {
    return path.posix.normalize(pathname);
  }
  return fileURLToPath(metaUrl);
}

function normalizeExecutionPath(filePath) {
  if (!filePath) {
    return "";
  }
  if (isWindowsStylePath(filePath)) {
    return path.win32.normalize(filePath).toLowerCase();
  }
  if (isPosixStylePath(filePath)) {
    return path.posix.normalize(filePath);
  }
  return resolve(filePath);
}

export function isDirectExecution(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) {
    return false;
  }
  const modulePath = modulePathFromMetaUrl(metaUrl);
  if (!modulePath) {
    return false;
  }
  return normalizeExecutionPath(modulePath) === normalizeExecutionPath(argv1);
}

if (isDirectExecution()) {
  startServer();
}
