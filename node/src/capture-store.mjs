import { createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_CAPTURE_DB_PATH } from "./capture-config.mjs";

export { DEFAULT_CAPTURE_DB_PATH };

// A covering projection keeps list and facet queries away from captured body
// overflow pages. It contains only fields already exposed by the metadata list.
export const FORWARDING_METADATA_INDEX = "idx_http_transactions_forwarding_metadata";
export const FORWARDING_METADATA_COLUMNS = Object.freeze([
  "id", "started_at", "completed_at", "duration_ms",
  "request_id", "session_id", "thread_id", "method", "incoming_url", "target_url",
  "provider_id", "provider_name", "route", "route_reason", "provider_selection_reason",
  "requested_model", "forwarded_model", "request_body_bytes", "response_status",
  "response_body_bytes", "is_stream", "upstream_request_id", "input_tokens",
  "output_tokens", "cached_input_tokens", "details_captured", "usage_observation_status",
  "error_type", "error_message"
]);

const WATCH_INTERVAL_MS = 500;
const WATCH_DEBOUNCE_MS = 100;
const REDACTED_VALUE = "[REDACTED]";
const MAX_CAPTURE_TOKENS = 100_000_000;
const MAX_CAPTURE_MODEL_CODE_POINTS = 256;
const MODEL_TEXT_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const ROUTE_REASONS = new Set([
  "account_eligible",
  "account_cooldown",
  "account_quota_exhausted",
  "account_headers_missing",
  "account_body_too_large",
  "not_chatgpt_auth",
  "unsupported_method",
  "unsupported_path",
  "unsupported_operation",
  "unsupported_account_model",
  "unsupported_request_format",
  "model_not_detected",
  "invalid_multipart",
  "custom_only"
]);
const PROVIDER_SELECTION_REASONS = new Set([
  "sole_eligible",
  "model_priority",
  "weight",
  "runtime_order",
  "cooldown_fallback",
  "retry_after_provider_failure"
]);
const USAGE_OBSERVATION_STATUSES = new Set([
  "observed",
  "upstream_unreported",
  "protocol_unrecognized",
  "not_applicable"
]);
const HEADER_REDACTION_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie"
]);
const HEADER_REDACTION_SUBSTRINGS = ["token", "secret", "api-key"];

function defaultLogger() {}

function fingerprintRuntimeConfig(configPath) {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(configPath)).digest("hex")}`;
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
    return `error:${code}`;
  }
}

function resolvePathValue(value, baseDir) {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function validateCaptureEnabled(value) {
  return value === undefined || typeof value === "boolean";
}

function validateCaptureDetailsEnabled(value) {
  return value === undefined || typeof value === "boolean";
}

function validateCaptureDbPath(value) {
  return value === undefined || (typeof value === "string" && value.trim().length > 0);
}

export function normalizeCaptureConfig(rawCapture = {}, { baseDir = process.cwd(), defaultDbPath = DEFAULT_CAPTURE_DB_PATH, strict = false } = {}) {
  const capture = rawCapture && typeof rawCapture === "object" && !Array.isArray(rawCapture) ? rawCapture : {};

  if (!validateCaptureEnabled(capture.enabled)) {
    throw new Error("capture.enabled must be a boolean when provided");
  }
  if (!validateCaptureDetailsEnabled(capture.detailsEnabled)) {
    throw new Error("capture.detailsEnabled must be a boolean when provided");
  }
  if (!validateCaptureDbPath(capture.dbPath)) {
    throw new Error("capture.dbPath must be a non-empty string when provided");
  }
  if (strict && capture.enabled === undefined && capture.detailsEnabled === undefined && capture.dbPath === undefined) {
    return {
      enabled: false,
      detailsEnabled: false,
      dbPath: defaultDbPath
    };
  }

  const dbPathRaw = typeof capture.dbPath === "string" && capture.dbPath.trim() ? capture.dbPath.trim() : defaultDbPath;
  const enabled = typeof capture.enabled === "boolean" ? capture.enabled : false;
  return {
    enabled,
    // Detail capture is subordinate to metadata capture. Re-enabling metadata
    // must never resurrect a stale body-capture setting.
    detailsEnabled: !enabled
      ? false
      : (typeof capture.detailsEnabled === "boolean" ? capture.detailsEnabled : false),
    dbPath: resolvePathValue(dbPathRaw, baseDir)
  };
}

export function loadRuntimeCaptureConfig(configPath, { defaultDbPath = DEFAULT_CAPTURE_DB_PATH } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read runtime config at ${configPath}: ${error.message}`);
  }

  return normalizeCaptureConfig(parsed.capture ?? {}, {
    baseDir: dirname(configPath),
    defaultDbPath,
    strict: true
  });
}

function upsertHeaderValue(headers, key, value) {
  if (!(key in headers)) {
    headers[key] = value;
    return;
  }
  if (Array.isArray(headers[key])) {
    headers[key].push(value);
    return;
  }
  headers[key] = [headers[key], value];
}

export function headersToObject(headersInput) {
  if (!headersInput) {
    return {};
  }

  if (Array.isArray(headersInput)) {
    const result = {};
    for (const entry of headersInput) {
      if (!Array.isArray(entry) || entry.length < 2) {
        continue;
      }
      upsertHeaderValue(result, String(entry[0]), String(entry[1]));
    }
    return result;
  }

  if (typeof headersInput === "object") {
    const result = {};
    for (const [key, value] of Object.entries(headersInput)) {
      if (Array.isArray(value)) {
        result[key] = value.map((item) => String(item));
      } else if (value != null) {
        result[key] = String(value);
      }
    }
    return result;
  }

  return {};
}

function shouldRedactHeader(key) {
  const lowered = key.toLowerCase();
  if (HEADER_REDACTION_NAMES.has(lowered)) {
    return true;
  }
  return HEADER_REDACTION_SUBSTRINGS.some((part) => lowered.includes(part));
}

export function redactHeaders(headersInput) {
  const headers = headersToObject(headersInput);
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = shouldRedactHeader(key) ? REDACTED_VALUE : value;
  }
  return result;
}

export function encodeBody(buffer, {
  totalBytes = buffer?.length ?? 0,
  truncated = false
} = {}) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes < (buffer?.length ?? 0)) {
    throw new Error("Captured body byte count is invalid");
  }
  if (truncated !== (totalBytes > (buffer?.length ?? 0))) {
    throw new Error("Captured body truncation marker is inconsistent");
  }
  const suffix = truncated ? "-truncated" : "";
  if (!buffer || buffer.length === 0) {
    return {
      body: "",
      encoding: `empty${suffix}`,
      bytes: totalBytes
    };
  }

  const text = buffer.toString("utf8");
  if (Buffer.compare(Buffer.from(text, "utf8"), buffer) === 0) {
    return {
      body: text,
      encoding: `utf8${suffix}`,
      bytes: totalBytes
    };
  }

  return {
    body: buffer.toString("base64"),
    encoding: `base64${suffix}`,
    bytes: totalBytes
  };
}

function normalizeCapturedModel(value) {
  if (typeof value !== "string" || value.length === 0
    || value.length > MAX_CAPTURE_MODEL_CODE_POINTS * 2
    || [...value].length > MAX_CAPTURE_MODEL_CODE_POINTS
    || value.trim() !== value
    || MODEL_TEXT_CONTROL_PATTERN.test(value)) {
    return null;
  }
  return value;
}

function createInsertStatement(db) {
  return db.prepare(`
    INSERT INTO http_transactions (
      started_at,
      completed_at,
      duration_ms,
      request_id,
      session_id,
      thread_id,
      method,
      incoming_url,
      target_url,
      provider_id,
      provider_name,
      route,
      route_reason,
      provider_selection_reason,
      requested_model,
      forwarded_model,
      request_headers_json,
      request_body,
      request_body_encoding,
      request_body_bytes,
      response_status,
      response_headers_json,
      response_body,
      response_body_encoding,
      response_body_bytes,
      is_stream,
      upstream_request_id,
      input_tokens,
      output_tokens,
      cached_input_tokens,
      usage_observation_status,
      details_captured,
      error_type,
      error_message
    ) VALUES (
      @started_at,
      @completed_at,
      @duration_ms,
      @request_id,
      @session_id,
      @thread_id,
      @method,
      @incoming_url,
      @target_url,
      @provider_id,
      @provider_name,
      @route,
      @route_reason,
      @provider_selection_reason,
      @requested_model,
      @forwarded_model,
      @request_headers_json,
      @request_body,
      @request_body_encoding,
      @request_body_bytes,
      @response_status,
      @response_headers_json,
      @response_body,
      @response_body_encoding,
      @response_body_bytes,
      @is_stream,
      @upstream_request_id,
      @input_tokens,
      @output_tokens,
      @cached_input_tokens,
      @usage_observation_status,
      @details_captured,
      @error_type,
      @error_message
    )
  `);
}

function initializeDatabase(db) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS http_transactions (
      id INTEGER PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER,
      request_id TEXT,
      session_id TEXT,
      thread_id TEXT,
      method TEXT,
      incoming_url TEXT,
      target_url TEXT,
      provider_id TEXT,
      provider_name TEXT,
      route TEXT,
      route_reason TEXT,
      provider_selection_reason TEXT,
      requested_model TEXT,
      forwarded_model TEXT,
      request_headers_json TEXT NOT NULL,
      request_body TEXT NOT NULL,
      request_body_encoding TEXT NOT NULL,
      request_body_bytes INTEGER NOT NULL,
      response_status INTEGER,
      response_headers_json TEXT NOT NULL,
      response_body TEXT NOT NULL,
      response_body_encoding TEXT NOT NULL,
      response_body_bytes INTEGER NOT NULL,
      is_stream INTEGER NOT NULL,
      upstream_request_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_input_tokens INTEGER,
      usage_observation_status TEXT,
      details_captured INTEGER NOT NULL DEFAULT 0,
      error_type TEXT,
      error_message TEXT
    );
  `);
  const columns = new Set(
    db.prepare("PRAGMA table_info(http_transactions)").all().map((column) => column.name)
  );
  for (const [name, type] of [
    ["provider_id", "TEXT"],
    ["provider_name", "TEXT"],
    ["route", "TEXT"],
    ["route_reason", "TEXT"],
    ["provider_selection_reason", "TEXT"],
    ["requested_model", "TEXT"],
    ["forwarded_model", "TEXT"],
    ["input_tokens", "INTEGER"],
    ["output_tokens", "INTEGER"],
    ["cached_input_tokens", "INTEGER"],
    ["details_captured", "INTEGER NOT NULL DEFAULT 0"],
    ["usage_observation_status", "TEXT"]
  ]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE http_transactions ADD COLUMN ${name} ${type}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_http_transactions_started_at
      ON http_transactions (started_at);
    CREATE INDEX IF NOT EXISTS idx_http_transactions_request_id
      ON http_transactions (request_id);
    CREATE INDEX IF NOT EXISTS idx_http_transactions_thread_id
      ON http_transactions (thread_id);
    CREATE INDEX IF NOT EXISTS idx_http_transactions_response_status
      ON http_transactions (response_status);
    CREATE INDEX IF NOT EXISTS ${FORWARDING_METADATA_INDEX}
      ON http_transactions (${FORWARDING_METADATA_COLUMNS.join(", ")});
    PRAGMA user_version = 6;
  `);
}

function noopHandle() {
  return {
    save() {}
  };
}

export class CaptureManager {
  constructor({
    configPath,
    capture,
    log = defaultLogger,
    defaultDbPath = DEFAULT_CAPTURE_DB_PATH,
    watchRuntimeConfig = true
  }) {
    this.configPath = configPath;
    this.log = log;
    this.defaultDbPath = defaultDbPath;
    this.watchRuntimeConfig = watchRuntimeConfig;
    this.desiredConfig = normalizeCaptureConfig(capture, {
      baseDir: dirname(configPath),
      defaultDbPath,
      strict: true
    });
    this.activeDbPath = null;
    this.db = null;
    this.insertStatement = null;
    this.acceptingRecords = false;
    this.state = "disabled";
    this.restartRequired = false;
    this.pendingRecords = 0;
    this.failedWriteCount = 0;
    this.lastWriteErrorAt = null;
    this.lastWriteErrorMessage = null;
    this.lastErrorAt = null;
    this.lastErrorMessage = null;
    this.started = false;
    this.closed = false;
    this.watchTimer = null;
    this.watchInterval = null;
    this.runtimeConfigFingerprint = null;
    this.handleRuntimeConfigChange = this.handleRuntimeConfigChange.bind(this);
    this.pollRuntimeConfig = this.pollRuntimeConfig.bind(this);
  }

  start() {
    if (this.started || this.closed) return this;
    this.started = true;
    try {
      if (this.desiredConfig.enabled) {
        this.enableFromConfig(this.desiredConfig, { source: "startup" });
      }
      if (this.watchRuntimeConfig) {
        this.runtimeConfigFingerprint = fingerprintRuntimeConfig(this.configPath);
        this.reloadRuntimeConfig();
        this.watchInterval = setInterval(this.pollRuntimeConfig, WATCH_INTERVAL_MS);
        this.watchInterval.unref?.();
      }
    } catch (error) {
      this.started = false;
      throw error;
    }
    return this;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
    this.runtimeConfigFingerprint = null;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    this.closeDatabase();
  }

  pollRuntimeConfig() {
    if (this.closed) return;
    const nextFingerprint = fingerprintRuntimeConfig(this.configPath);
    if (nextFingerprint === this.runtimeConfigFingerprint) return;
    this.runtimeConfigFingerprint = nextFingerprint;
    this.handleRuntimeConfigChange();
  }

  handleRuntimeConfigChange() {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.reloadRuntimeConfig();
    }, WATCH_DEBOUNCE_MS);
  }

  reloadRuntimeConfig() {
    try {
      const nextConfig = loadRuntimeCaptureConfig(this.configPath, {
        defaultDbPath: this.defaultDbPath
      });
      this.clearLastError();
      this.applyRuntimeConfig(nextConfig);
    } catch (error) {
      this.setLastError(error.message);
      this.log("warn", "Failed to hot-apply capture config", {
        config_path: this.configPath,
        error: JSON.stringify(error.message)
      });
    }
  }

  applyRuntimeConfig(nextConfig) {
    const previousDesired = this.desiredConfig;
    const previousActiveDbPath = this.activeDbPath;
    this.desiredConfig = nextConfig;
    if (previousActiveDbPath && previousActiveDbPath !== nextConfig.dbPath) {
      this.restartRequired = true;
    } else if (!previousActiveDbPath) {
      this.restartRequired = false;
    }

    if (nextConfig.enabled) {
      if (this.acceptingRecords) {
        return;
      }
      if (this.state === "disabling" && previousActiveDbPath === this.activeDbPath) {
        this.acceptingRecords = true;
        this.state = "enabled";
        return;
      }
      this.enableFromConfig(nextConfig, { source: "runtime" });
      return;
    }

    if (this.acceptingRecords || this.state === "enabled" || this.state === "error") {
      this.disableRecording();
      return;
    }

    this.state = "disabled";
    this.restartRequired = false;
    if (previousDesired.dbPath !== nextConfig.dbPath && !this.activeDbPath) {
      this.restartRequired = false;
    }
  }

  enableFromConfig(config, { source }) {
    this.state = "enabling";
    try {
      this.openDatabase(config.dbPath);
      this.activeDbPath = config.dbPath;
      this.acceptingRecords = true;
      this.state = "enabled";
      this.restartRequired = false;
      this.clearLastError();
      this.log("info", "Capture recording enabled", {
        source,
        db_path: this.activeDbPath
      });
    } catch (error) {
      this.acceptingRecords = false;
      this.closeDatabase();
      this.activeDbPath = null;
      this.state = "error";
      this.setLastError(error.message);
      if (source === "startup") {
        throw error;
      }
      this.log("warn", "Failed to enable capture recording", {
        source,
        db_path: config.dbPath,
        error: JSON.stringify(error.message)
      });
    }
  }

  disableRecording() {
    this.acceptingRecords = false;
    if (!this.db) {
      this.state = "disabled";
      this.activeDbPath = null;
      return;
    }
    if (this.pendingRecords > 0) {
      this.state = "disabling";
      return;
    }
    this.closeDatabase();
    this.activeDbPath = null;
    this.state = "disabled";
    this.log("info", "Capture recording disabled", {});
  }

  openDatabase(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    initializeDatabase(db);
    this.db = db;
    this.insertStatement = createInsertStatement(db);
  }

  closeDatabase() {
    if (this.db) {
      this.db.close();
    }
    this.db = null;
    this.insertStatement = null;
  }

  beginRecord() {
    if (!this.acceptingRecords || !this.db || !this.insertStatement) {
      return null;
    }

    this.pendingRecords += 1;
    let finished = false;
    const detailsEnabled = this.desiredConfig.detailsEnabled === true;

    return {
      detailsEnabled,
      save: (record) => {
        if (finished) {
          return;
        }
        finished = true;
        try {
          this.writeRecord({
            ...record,
            // The capture mode is snapshotted at beginRecord time and cannot be
            // forged by callers or changed by a later runtime reload.
            detailsCaptured: detailsEnabled
          });
        } finally {
          this.pendingRecords -= 1;
          if (!this.acceptingRecords && this.pendingRecords === 0 && this.state === "disabling") {
            this.closeDatabase();
            this.activeDbPath = null;
            this.state = "disabled";
          }
        }
      }
    };
  }

  writeRecord(record) {
    if (!this.insertStatement) {
      this.recordWriteFailure(new Error("Capture database is not available"));
      return;
    }

    try {
      const detailsCaptured = record.detailsCaptured === true ? 1 : 0;
      const metadataBytes = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
      const requestBody = detailsCaptured === 1
        ? encodeBody(record.requestBody, {
            totalBytes: record.requestBodyBytes,
            truncated: record.requestBodyTruncated === true
          })
        : { body: "", encoding: "empty", bytes: metadataBytes(record.requestBodyBytes) };
      const responseBody = detailsCaptured === 1
        ? encodeBody(record.responseBody, {
            totalBytes: record.responseBodyBytes,
            truncated: record.responseBodyTruncated === true
          })
        : { body: "", encoding: "empty", bytes: metadataBytes(record.responseBodyBytes) };
      const inputTokens = Number.isSafeInteger(record.inputTokens)
        && record.inputTokens >= 0
        && record.inputTokens <= MAX_CAPTURE_TOKENS
        ? record.inputTokens
        : null;
      const outputTokens = Number.isSafeInteger(record.outputTokens)
        && record.outputTokens >= 0
        && record.outputTokens <= MAX_CAPTURE_TOKENS
        ? record.outputTokens
        : null;
      const cachedInputTokens = Number.isSafeInteger(record.cachedInputTokens)
        && record.cachedInputTokens >= 0
        && record.cachedInputTokens <= MAX_CAPTURE_TOKENS
        ? record.cachedInputTokens
        : null;
      const requestHeaders = detailsCaptured === 1 ? record.requestHeaders : {};
      const responseHeaders = detailsCaptured === 1 ? record.responseHeaders : {};
      const usageObservationStatus = inputTokens !== null && outputTokens !== null
        ? "observed"
        : USAGE_OBSERVATION_STATUSES.has(record.usageObservationStatus)
          ? record.usageObservationStatus
          : "not_applicable";
      this.insertStatement.run({
        started_at: record.startedAt,
        completed_at: record.completedAt,
        duration_ms: record.durationMs,
        request_id: record.requestId,
        session_id: record.sessionId ?? null,
        thread_id: record.threadId ?? null,
        method: record.method,
        incoming_url: record.incomingUrl,
        target_url: record.targetUrl,
        provider_id: record.providerId ?? null,
        provider_name: record.providerName ?? null,
        route: record.route ?? null,
        route_reason: ROUTE_REASONS.has(record.routeReason) ? record.routeReason : null,
        provider_selection_reason: PROVIDER_SELECTION_REASONS.has(record.providerSelectionReason)
          ? record.providerSelectionReason
          : null,
        requested_model: normalizeCapturedModel(record.requestedModel),
        forwarded_model: normalizeCapturedModel(record.forwardedModel),
        request_headers_json: JSON.stringify(redactHeaders(requestHeaders)),
        request_body: detailsCaptured === 1 ? requestBody.body : "",
        request_body_encoding: detailsCaptured === 1 ? requestBody.encoding : "empty",
        request_body_bytes: requestBody.bytes,
        response_status: record.responseStatus ?? null,
        response_headers_json: JSON.stringify(redactHeaders(responseHeaders)),
        response_body: detailsCaptured === 1 ? responseBody.body : "",
        response_body_encoding: detailsCaptured === 1 ? responseBody.encoding : "empty",
        response_body_bytes: responseBody.bytes,
        is_stream: record.isStream ? 1 : 0,
        upstream_request_id: record.upstreamRequestId ?? null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_input_tokens: cachedInputTokens,
        usage_observation_status: usageObservationStatus,
        details_captured: detailsCaptured,
        error_type: record.errorType ?? null,
        error_message: record.errorMessage ?? null
      });
    } catch (error) {
      this.recordWriteFailure(error);
    }
  }

  recordWriteFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    this.failedWriteCount += 1;
    this.lastWriteErrorAt = new Date().toISOString();
    this.lastWriteErrorMessage = message;
    this.log("warn", "Failed to write capture record", {
      db_path: this.activeDbPath || this.desiredConfig.dbPath,
      error: JSON.stringify(message)
    });
  }

  setLastError(message) {
    this.lastErrorAt = new Date().toISOString();
    this.lastErrorMessage = message;
  }

  clearLastError() {
    this.lastErrorAt = null;
    this.lastErrorMessage = null;
  }

  getPublicState() {
    return {
      captureConfigured: this.desiredConfig.enabled,
      captureDetailsConfigured: this.desiredConfig.detailsEnabled,
      captureActive: this.acceptingRecords,
      captureDbPath: this.desiredConfig.dbPath,
      captureRuntimeDbPath: this.activeDbPath,
      captureState: this.state,
      captureRestartRequired: this.restartRequired,
      failedWriteCount: this.failedWriteCount,
      lastWriteErrorAt: this.lastWriteErrorAt,
      lastWriteErrorMessage: this.lastWriteErrorMessage,
      captureLastErrorAt: this.lastErrorAt,
      captureLastErrorMessage: this.lastErrorMessage
    };
  }
}

export function createCaptureManager(options) {
  return new CaptureManager(options);
}

export function createNoopCaptureHandle() {
  return noopHandle();
}
