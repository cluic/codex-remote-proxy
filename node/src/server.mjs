import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { URL } from "node:url";
import zlib from "node:zlib";
import { decompress as zstdDecompress } from "fzstd";

import {
  createCaptureManager,
  createNoopCaptureHandle,
  DEFAULT_CAPTURE_DB_PATH,
  headersToObject,
  normalizeCaptureConfig
} from "./capture-store.mjs";

const CONFIG_ENV_VAR = "CODEX_PROXY_CONFIG";
const DEFAULT_CONFIG_PATH = resolve(import.meta.dirname, "..", "proxy-config.json");
const HEALTH_PATH = "/_proxy/health";
const METRIC_MODEL_MAX_BYTES = 64 * 1024;
const METRIC_USAGE_MAX_BYTES = 1024 * 1024;
const METRIC_MAX_MODEL_CODE_POINTS = 256;
const METRIC_MAX_OBSERVATION_TOKENS = 100_000_000;
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
      requestIdHeader: typeof proxy.requestIdHeader === "string" && proxy.requestIdHeader ? proxy.requestIdHeader : "x-client-request-id"
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

function safeBodyPreview(buffer, maxLen = 4096) {
  if (!buffer || !buffer.length) return "(empty)";
  try {
    const text = buffer.toString("utf-8");
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
const DEBUG_SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key"
]);
const DEBUG_SENSITIVE_HEADER_PARTS = ["token", "secret", "api-key"];

function decompressBody(buffer, encoding) {
  const enc = encoding.toLowerCase().trim();
  if (enc === "gzip") return zlib.gunzipSync(buffer);
  if (enc === "deflate") return zlib.inflateSync(buffer);
  if (enc === "br") return zlib.brotliDecompressSync(buffer);
  if (enc === "zstd") return Buffer.from(zstdDecompress(buffer));
  return buffer;
}

function autoDecompress(buffer) {
  if (buffer.length < 2) return null;
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try { return zlib.gunzipSync(buffer); } catch { return null; }
  }
  if (buffer[0] === 0x78 && (buffer[1] === 0x01 || buffer[1] === 0x5e || buffer[1] === 0x9c || buffer[1] === 0xda)) {
    try { return zlib.inflateSync(buffer); } catch { return null; }
  }
  if (buffer.length >= 4 && buffer[0] === 0x28 && buffer[1] === 0xb5 && buffer[2] === 0x2f && buffer[3] === 0xfd) {
    try { return Buffer.from(zstdDecompress(buffer)); } catch { return null; }
  }
  try { return zlib.brotliDecompressSync(buffer); } catch { return null; }
}

function sanitizeHeadersForDebug(headersObject, authHeader = "authorization") {
  const result = {};
  const activeAuthHeader = authHeader.toLowerCase();
  for (const [key, value] of Object.entries(headersObject)) {
    const loweredKey = key.toLowerCase();
    const sensitive = loweredKey === activeAuthHeader
      || DEBUG_SENSITIVE_HEADER_NAMES.has(loweredKey)
      || DEBUG_SENSITIVE_HEADER_PARTS.some((part) => loweredKey.includes(part));
    result[key] = sensitive ? maskSecret(String(value)) : value;
  }
  return result;
}

function sanitizeHeadersForCapture(headersInput, authHeader) {
  const result = headersToObject(headersInput);
  const activeAuthHeader = authHeader.toLowerCase();
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === activeAuthHeader) {
      result[key] = "[REDACTED]";
    }
  }
  return result;
}

export function buildUpstreamHeaders(req, settings, targetUrl, { stripContentHeaders }) {
  const headers = [];
  const authHeader = settings.upstream.authHeader.toLowerCase();

  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const key = req.rawHeaders[index];
    const value = req.rawHeaders[index + 1];
    const loweredKey = key.toLowerCase();
    if (
      loweredKey === "host" ||
      HOP_BY_HOP_HEADERS.has(loweredKey) ||
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

  if (settings.proxy.overrideAuthorization) {
    upsertHeader(headers, settings.upstream.authHeader, formatAuthorization(settings.upstream));
  }

  for (const [key, value] of Object.entries(settings.upstream.extraHeaders)) {
    upsertHeader(headers, key, value);
  }

  return headers;
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

function writeHeadersToResponse(res, rawHeaders) {
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
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

function safeMetricModel(value, settings) {
  if (typeof value !== "string" || value.length === 0
    || value.length > METRIC_MAX_MODEL_CODE_POINTS * 2
    || [...value].length > METRIC_MAX_MODEL_CODE_POINTS
    || value.trim() !== value
    || METRIC_TEXT_CONTROL_PATTERN.test(value)) {
    return null;
  }
  const protectedValues = [
    settings.upstream.apiKey,
    ...Object.values(settings.upstream.extraHeaders)
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  return protectedValues.some((secret) => value.includes(secret)) ? null : value;
}

function extractMetricModel(body, settings) {
  const parsed = parseBoundedJson(body, METRIC_MODEL_MAX_BYTES);
  return parsed ? safeMetricModel(parsed.model, settings) : null;
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

function extractMetricUsage(body, stream) {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > METRIC_USAGE_MAX_BYTES) return null;
  if (!stream) {
    const parsed = parseBoundedJson(body, METRIC_USAGE_MAX_BYTES);
    return normalizeMetricUsage(parsed?.usage);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  let observed = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (data.length === 0 || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      const usage = normalizeMetricUsage(event?.response?.usage);
      if (usage) observed = usage;
    } catch {
      // Ignore non-JSON or partial SSE data without retaining it.
    }
  }
  return observed;
}

function metricResultForStatus(statusCode) {
  if (statusCode >= 200 && statusCode <= 299) return "success";
  if (statusCode >= 400 && statusCode <= 499) return "upstreamRejected";
  return "upstreamError";
}

function buildHealthPayload(settings, captureManager, settingsSource) {
  if (settingsSource) {
    return {
      ok: true,
      ...settingsSource.publicState(),
      ...captureManager.getPublicState()
    };
  }
  return {
    ok: true,
    configPath: settings.configPath,
    listenHost: settings.server.host,
    listenPort: settings.server.port,
    upstreamBaseUrl: settings.upstream.baseUrl,
    overrideAuthorization: settings.proxy.overrideAuthorization,
    authHeader: settings.upstream.authHeader,
    authScheme: settings.upstream.authScheme,
    extraHeaderCount: Object.keys(settings.upstream.extraHeaders).length,
    ...captureManager.getPublicState()
  };
}

function buildRequestContext({ req, settings, targetUrl, requestId, requestHeaders, requestBody, startedAt, captureHandle }) {
  const turnMetadataHeader = req.headers["x-codex-turn-metadata"];
  let turnMetadata = null;
  if (typeof turnMetadataHeader === "string") {
    try {
      turnMetadata = JSON.parse(turnMetadataHeader);
    } catch {
      turnMetadata = null;
    }
  }

  const captureHeaders = sanitizeHeadersForCapture(requestHeaders, settings.upstream.authHeader);

  return {
    requestId,
    sessionId: typeof req.headers["session-id"] === "string"
      ? req.headers["session-id"]
      : (typeof req.headers["session_id"] === "string" ? req.headers["session_id"] : (turnMetadata?.session_id || null)),
    threadId: typeof req.headers["thread-id"] === "string"
      ? req.headers["thread-id"]
      : (typeof req.headers["thread_id"] === "string" ? req.headers["thread_id"] : (turnMetadata?.thread_id || null)),
    method: req.method || "GET",
    incomingUrl: new URL(req.url, `http://${settings.server.host}:${settings.server.port}`).href,
    targetUrl: targetUrl.href,
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
    responseStatus: fields.responseStatus,
    responseHeaders: fields.responseHeaders ?? {},
    responseBody: fields.responseBody ?? Buffer.alloc(0),
    isStream: fields.isStream ?? false,
    upstreamRequestId: fields.upstreamRequestId ?? null,
    errorType: fields.errorType ?? null,
    errorMessage: fields.errorMessage ?? null
  });
}

export function createServer(settings, {
  captureManager = createCaptureManager({ configPath: settings.configPath, capture: settings.capture, log }).start(),
  logFn = log,
  settingsSource,
  recordMetric = () => {},
  metricNow = Date.now
} = {}) {
  return http.createServer((req, res) => {
    if (!req.url) {
      writeJson(res, 400, { error: { message: "Missing request URL", type: "proxy_bad_request" } });
      return;
    }

    if (req.url === HEALTH_PATH) {
      writeJson(res, 200, buildHealthPayload(settings, captureManager, settingsSource));
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
    const requestDebugEnabled = requestSettings.server.logLevel.toLowerCase() === "debug";
    const requestId = req.headers[requestSettings.proxy.requestIdHeader] || req.headers["x-request-id"] || "-";
    const targetUrl = buildTargetUrl(requestSettings.upstream.baseUrl, req.url);
    const transport = targetUrl.protocol === "https:" ? https : http;
    const startedAt = Date.now();
    const metricStartedAt = metricNow();

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      const contentEncoding = req.headers["content-encoding"];
      let bodyTransformed = false;
      if (contentEncoding && body.length) {
        try {
          body = decompressBody(body, contentEncoding);
          bodyTransformed = true;
        } catch (error) {
          logFn("warn", "Failed to decompress request body", {
            encoding: contentEncoding,
            error: error.message
          });
        }
      } else if (body.length >= 2 && contentEncoding === undefined) {
        const decompressed = autoDecompress(body);
        if (decompressed) {
          debugLog("AUTODECOMP", {
            originalSize: body.length,
            decompressedSize: decompressed.length,
            magicBytes: `0x${body[0].toString(16).padStart(2, "0")} 0x${body[1].toString(16).padStart(2, "0")}`
          }, requestDebugEnabled);
          body = decompressed;
          bodyTransformed = true;
        }
      }

      const headers = buildUpstreamHeaders(req, requestSettings, targetUrl, {
        stripContentHeaders: bodyTransformed
      });
      if (bodyTransformed && body.length) {
        upsertHeader(headers, "content-length", String(Buffer.byteLength(body)));
      }

      const captureHandle = captureManager.beginRecord() ?? createNoopCaptureHandle();
      const captureContext = buildRequestContext({
        req,
        settings: requestSettings,
        targetUrl,
        requestId,
        requestHeaders: headers,
        requestBody: body,
        startedAt,
        captureHandle
      });
      let captureSaved = false;
      let metricSaved = false;
      let responseCompleted = false;
      let responseStartBin = null;
      const metricModel = extractMetricModel(body, requestSettings);

      function finalizeCapture(fields) {
        if (captureSaved) {
          return;
        }
        captureSaved = true;
        saveCaptureRecord(captureContext, fields);
      }

      function finalizeMetric(result, { responseBody = null, stream = false } = {}) {
        if (metricSaved) return;
        metricSaved = true;
        if (!Number.isSafeInteger(active.generation) || active.generation <= 0) return;
        const usage = result === "success" && responseBody !== null
          ? extractMetricUsage(responseBody, stream)
          : null;
        const observation = {
          generation: active.generation,
          result,
          model: metricModel,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
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

      debugLog("REQUEST", {
        method: req.method,
        path: req.url,
        targetUrl: targetUrl.href,
        incomingHeaders: sanitizeHeadersForDebug(
          Object.fromEntries(Object.entries(req.headers)),
          requestSettings.upstream.authHeader
        ),
        upstreamHeaders: sanitizeHeadersForDebug(
          Object.fromEntries(headers),
          requestSettings.upstream.authHeader
        ),
        body: safeBodyPreview(body)
      }, requestDebugEnabled);

      const upstreamRequest = transport.request(
        {
          method: req.method,
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || undefined,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers,
          rejectUnauthorized: requestSettings.upstream.verifySsl
        },
        (upstreamResponse) => {
          const stream = isEventStream(upstreamResponse.headers["content-type"]);
          debugLog("RESPONSE HEADERS", {
            status: upstreamResponse.statusCode,
            headers: sanitizeHeadersForDebug(
              upstreamResponse.headers,
              requestSettings.upstream.authHeader
            )
          }, requestDebugEnabled);

          const responseHeaders = sanitizeHeadersForCapture(
            upstreamResponse.headers,
            requestSettings.upstream.authHeader
          );
          const respChunks = [];
          upstreamResponse.on("data", (chunk) => {
            if (responseStartBin === null && chunk.length > 0) {
              responseStartBin = metricLatencyBin(metricNow() - metricStartedAt);
            }
            respChunks.push(chunk);
          });

          res.statusCode = upstreamResponse.statusCode || 502;
          writeHeadersToResponse(res, upstreamResponse.rawHeaders);
          upstreamResponse.pipe(res);
          upstreamResponse.on("end", () => {
            responseCompleted = true;
            const responseBody = Buffer.concat(respChunks);
            if (responseBody.length) {
              debugLog("RESPONSE BODY", {
                status: upstreamResponse.statusCode,
                body: safeBodyPreview(responseBody)
              }, requestDebugEnabled);
            }
            finalizeCapture({
              responseStatus: upstreamResponse.statusCode || 502,
              responseHeaders,
              responseBody,
              isStream: stream,
              upstreamRequestId: typeof upstreamResponse.headers["x-request-id"] === "string" ? upstreamResponse.headers["x-request-id"] : null
            });
            finalizeMetric(metricResultForStatus(upstreamResponse.statusCode || 502), {
              responseBody,
              stream
            });
            logFn("info", "Proxied request", {
              request_id: requestId,
              method: req.method || "GET",
              path: req.url,
              status: upstreamResponse.statusCode || 502,
              stream,
              duration_ms: Date.now() - startedAt
            });
          });
          upstreamResponse.once("aborted", () => finalizeMetric("networkError"));
          upstreamResponse.once("error", () => finalizeMetric("networkError"));
        }
      );

      upstreamRequest.setTimeout(requestSettings.upstream.timeoutMs, () => {
        upstreamRequest.destroy(new Error("upstream timeout"));
      });

      upstreamRequest.on("error", (error) => {
        const statusCode = error.message === "upstream timeout" ? 504 : 502;
        const errorType = statusCode === 504 ? "proxy_timeout" : "proxy_upstream_error";
        const payload = {
          error: {
            message: statusCode === 504 ? "Upstream request timed out" : "Failed to reach upstream service",
            type: errorType,
            request_id: requestId
          }
        };
        const responseBody = Buffer.from(JSON.stringify(payload));
        const responseHeaders = {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(responseBody.length)
        };

        debugLog("UPSTREAM ERROR", {
          error: error.message,
          code: error.code || "(none)",
          stack: error.stack
        }, requestDebugEnabled);
        if (!res.headersSent) {
          writeJson(res, statusCode, payload);
        } else {
          res.destroy(error);
        }
        finalizeCapture({
          responseStatus: statusCode,
          responseHeaders,
          responseBody,
          errorType,
          errorMessage: error.message,
          upstreamRequestId: null
        });
        finalizeMetric(statusCode === 504 ? "timeout" : "networkError");
        logFn("warn", "Proxy request failed", {
          request_id: requestId,
          method: req.method || "GET",
          path: req.url,
          status: statusCode,
          duration_ms: Date.now() - startedAt,
          error: JSON.stringify(error.message)
        });
      });

      res.on("close", () => {
        if (responseCompleted || res.writableFinished) {
          return;
        }
        finalizeCapture({
          responseStatus: res.statusCode || null,
          responseHeaders: {},
          responseBody: Buffer.alloc(0),
          isStream: false,
          upstreamRequestId: null,
          errorType: "proxy_client_abort",
          errorMessage: "Client closed connection"
        });
        finalizeMetric("clientAbort");
      });

      upstreamRequest.end(body);
    });
  });
}

export function createApp(settings = loadConfig(), { settingsSource, recordMetric } = {}) {
  const captureManager = createCaptureManager({
    configPath: settings.configPath,
    capture: settings.capture,
    log
  }).start();

  log("info", "Loaded proxy config", {
    config_path: settings.configPath,
    upstream: settings.upstream.baseUrl,
    auth_override: settings.proxy.overrideAuthorization,
    auth_header: settings.upstream.authHeader,
    api_key: maskSecret(settings.upstream.apiKey),
    capture_enabled: settings.capture.enabled,
    capture_db_path: settings.capture.dbPath
  });

  const server = createServer(settings, {
    captureManager,
    logFn: log,
    settingsSource,
    recordMetric
  });
  server.on("close", () => {
    captureManager.close();
  });

  return { server, settings, captureManager };
}

export function startServer(settings = loadConfig()) {
  const app = createApp(settings);
  app.server.on("error", (error) => {
    log("error", "Node proxy failed to listen", {
      host: settings.server.host,
      port: settings.server.port,
      error: JSON.stringify(error.message)
    });
    process.exit(1);
  });

  app.server.listen(settings.server.port, settings.server.host, () => {
    log("info", "Node proxy listening", {
      host: settings.server.host,
      port: settings.server.port
    });
  });

  return app;
}

function isWindowsStylePath(filePath) {
  return /^[A-Za-z]:[\\/]/.test(filePath);
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
  return fileURLToPath(metaUrl);
}

function normalizeExecutionPath(filePath) {
  if (!filePath) {
    return "";
  }
  if (isWindowsStylePath(filePath)) {
    return path.win32.normalize(filePath).toLowerCase();
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
