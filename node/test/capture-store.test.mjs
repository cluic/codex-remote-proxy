import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  CaptureManager,
  DEFAULT_CAPTURE_DB_PATH,
  FORWARDING_METADATA_COLUMNS,
  FORWARDING_METADATA_INDEX,
  encodeBody,
  loadRuntimeCaptureConfig,
  normalizeCaptureConfig,
  redactHeaders
} from "../src/capture-store.mjs";

function makeTempDir(prefix) {
  return join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function createNonemptyDatabaseWithoutMetadataIndex(dir) {
  mkdirSync(dir, { recursive: true });
  const runtimeConfigPath = join(dir, "proxy-config.json");
  const dbPath = join(dir, "traffic.sqlite3");
  writeFileSync(runtimeConfigPath, JSON.stringify({ capture: { enabled: true, dbPath } }));
  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: { enabled: true, dbPath },
    watchRuntimeConfig: false
  }).start();
  manager.close();
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`
      INSERT INTO http_transactions (
        started_at, request_headers_json, request_body, request_body_encoding,
        request_body_bytes, response_headers_json, response_body,
        response_body_encoding, response_body_bytes, is_stream
      ) VALUES (
        '2026-09-05T00:00:00.000Z', '{}', '', 'empty', 0, '{}', '', 'empty', 0, 0
      );
      DROP INDEX ${FORWARDING_METADATA_INDEX};
    `);
  } finally {
    database.close();
  }
  return { runtimeConfigPath, dbPath };
}

class ControlledIndexWorker extends EventEmitter {
  constructor({ termination = Promise.resolve(0) } = {}) {
    super();
    this.termination = termination;
    this.terminated = false;
    this.unreferenced = false;
  }

  unref() {
    this.unreferenced = true;
  }

  terminate() {
    this.terminated = true;
    return this.termination;
  }

  finish(type = "complete", code = type === "complete" ? 0 : 1) {
    this.emit("message", { type });
    this.emit("exit", code);
  }
}

async function waitFor(condition, description, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

test("normalizeCaptureConfig applies defaults", () => {
  const normalized = normalizeCaptureConfig({}, {
    baseDir: "/tmp/example",
    defaultDbPath: DEFAULT_CAPTURE_DB_PATH,
    strict: true
  });
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.detailsEnabled, false);
  assert.equal(normalized.dbPath, DEFAULT_CAPTURE_DB_PATH);
});

test("redactHeaders redacts sensitive header names", () => {
  const headers = redactHeaders({
    Authorization: "Bearer secret",
    Cookie: "abc=123",
    "X-Api-Key": "key",
    Accept: "application/json"
  });
  assert.equal(headers.Authorization, "[REDACTED]");
  assert.equal(headers.Cookie, "[REDACTED]");
  assert.equal(headers["X-Api-Key"], "[REDACTED]");
  assert.equal(headers.Accept, "application/json");
});

test("encodeBody preserves utf8 and base64 encodes binary", () => {
  const text = encodeBody(Buffer.from("hello", "utf8"));
  assert.deepEqual(text, { body: "hello", encoding: "utf8", bytes: 5 });

  const binary = encodeBody(Buffer.from([0xff, 0x00, 0x10]));
  assert.equal(binary.encoding, "base64");
  assert.equal(binary.bytes, 3);

  const truncated = encodeBody(Buffer.from("prefix", "utf8"), {
    totalBytes: 4096,
    truncated: true
  });
  assert.deepEqual(truncated, {
    body: "prefix",
    encoding: "utf8-truncated",
    bytes: 4096
  });
  assert.throws(
    () => encodeBody(Buffer.from("too-long"), { totalBytes: 2, truncated: true }),
    /byte count is invalid/
  );
  assert.throws(
    () => encodeBody(Buffer.from("prefix"), { totalBytes: 4096, truncated: false }),
    /truncation marker is inconsistent/
  );
});

test("nonempty databases prepare the forwarding index without blocking capture startup", async (t) => {
  const dir = makeTempDir("crp-capture-index-background");
  const { runtimeConfigPath, dbPath } = createNonemptyDatabaseWithoutMetadataIndex(dir);
  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: { enabled: true, dbPath },
    watchRuntimeConfig: false
  }).start();
  t.after(async () => {
    manager.close();
    await manager.waitForBackgroundTasks();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.deepEqual(manager.getPublicState(), {
    captureConfigured: true,
    captureDetailsConfigured: false,
    captureActive: false,
    captureDbPath: dbPath,
    captureRuntimeDbPath: null,
    captureState: "enabling",
    captureRestartRequired: false,
    failedWriteCount: 0,
    lastWriteErrorAt: null,
    lastWriteErrorMessage: null,
    captureLastErrorAt: null,
    captureLastErrorMessage: null
  });
  assert.equal(manager.beginRecord(), null);

  await manager.waitForBackgroundTasks();
  assert.equal(manager.getPublicState().captureActive, true);
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.deepEqual(
      database.prepare(`PRAGMA index_info(${FORWARDING_METADATA_INDEX})`).all()
        .map(({ name }) => name),
      FORWARDING_METADATA_COLUMNS
    );
  } finally {
    database.close();
  }
});

test("index preparation failures expose only a stable capture error", async (t) => {
  const dir = makeTempDir("crp-capture-index-failure");
  const { runtimeConfigPath, dbPath } = createNonemptyDatabaseWithoutMetadataIndex(dir);
  const controlledWorker = new ControlledIndexWorker();
  const logs = [];
  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: { enabled: true, dbPath },
    watchRuntimeConfig: false,
    indexWorkerFactory: () => controlledWorker,
    log: (level, message, fields) => logs.push({ level, message, fields })
  }).start();
  t.after(async () => {
    manager.close();
    await manager.waitForBackgroundTasks();
    rmSync(dir, { recursive: true, force: true });
  });

  controlledWorker.emit("error", new Error("raw SQLite failure at /private/example"));
  controlledWorker.emit("exit", 1);
  await manager.waitForBackgroundTasks();

  const state = manager.getPublicState();
  assert.equal(state.captureActive, false);
  assert.equal(state.captureState, "error");
  assert.equal(state.captureLastErrorMessage, "Capture forwarding index preparation failed");
  assert.deepEqual(logs, [{
    level: "warn",
    message: "Capture forwarding index preparation failed",
    fields: { code: "CAPTURE_INDEX_PREPARATION_FAILED" }
  }]);
  assert.doesNotMatch(JSON.stringify({ state, logs }), /raw SQLite|\/private\/example/);
});

test("closing during index preparation waits for termination and ignores stale completion", async (t) => {
  const dir = makeTempDir("crp-capture-index-close");
  const { runtimeConfigPath, dbPath } = createNonemptyDatabaseWithoutMetadataIndex(dir);
  let releaseTermination;
  const termination = new Promise((resolvePromise) => {
    releaseTermination = resolvePromise;
  });
  const controlledWorker = new ControlledIndexWorker({ termination });
  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: { enabled: true, dbPath },
    watchRuntimeConfig: false,
    indexWorkerFactory: () => controlledWorker
  }).start();
  t.after(async () => {
    releaseTermination(0);
    manager.close();
    await manager.waitForBackgroundTasks();
    rmSync(dir, { recursive: true, force: true });
  });

  manager.close();
  controlledWorker.finish();
  let settled = false;
  manager.waitForBackgroundTasks().then(() => {
    settled = true;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(controlledWorker.terminated, true);
  assert.equal(settled, false);
  assert.equal(manager.getPublicState().captureActive, false);

  releaseTermination(0);
  await manager.waitForBackgroundTasks();
  assert.equal(manager.getPublicState().captureActive, false);
});

test("a rejected termination remains blocked until the index worker exits", async (t) => {
  const dir = makeTempDir("crp-capture-index-rejected-termination");
  const { runtimeConfigPath, dbPath } = createNonemptyDatabaseWithoutMetadataIndex(dir);
  const controlledWorker = new ControlledIndexWorker({
    termination: Promise.reject(new Error("termination failed"))
  });
  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: { enabled: true, dbPath },
    watchRuntimeConfig: false,
    indexWorkerFactory: () => controlledWorker
  }).start();
  t.after(async () => {
    controlledWorker.emit("exit", 1);
    manager.close();
    await manager.waitForBackgroundTasks();
    rmSync(dir, { recursive: true, force: true });
  });

  manager.close();
  let settled = false;
  const waiting = manager.waitForBackgroundTasks().then(() => {
    settled = true;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(settled, false);

  controlledWorker.emit("exit", 1);
  await waiting;
  assert.equal(settled, true);
});

test("switching paths cancels index preparation without reopening the stale database", async (t) => {
  const dir = makeTempDir("crp-capture-index-path-switch");
  const { runtimeConfigPath, dbPath } = createNonemptyDatabaseWithoutMetadataIndex(dir);
  const nextDbPath = join(dir, "traffic-next.sqlite3");
  const controlledWorker = new ControlledIndexWorker();
  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: { enabled: true, dbPath },
    watchRuntimeConfig: false,
    indexWorkerFactory: () => controlledWorker
  }).start();
  t.after(async () => {
    manager.close();
    await manager.waitForBackgroundTasks();
    rmSync(dir, { recursive: true, force: true });
  });

  manager.applyRuntimeConfig({ enabled: true, detailsEnabled: false, dbPath: nextDbPath });
  controlledWorker.finish();
  await manager.waitForBackgroundTasks();

  const state = manager.getPublicState();
  assert.equal(controlledWorker.terminated, true);
  assert.equal(state.captureActive, true);
  assert.equal(state.captureState, "enabled");
  assert.equal(resolve(state.captureRuntimeDbPath), resolve(nextDbPath));
});

test("rapid re-enable waits for cancelled index maintenance before starting another worker", async (t) => {
  const dir = makeTempDir("crp-capture-index-reenable");
  const { runtimeConfigPath, dbPath } = createNonemptyDatabaseWithoutMetadataIndex(dir);
  let releaseFirstTermination;
  const firstTermination = new Promise((resolvePromise) => {
    releaseFirstTermination = resolvePromise;
  });
  const workers = [
    new ControlledIndexWorker({ termination: firstTermination }),
    new ControlledIndexWorker()
  ];
  let workerCount = 0;
  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: { enabled: true, dbPath },
    watchRuntimeConfig: false,
    indexWorkerFactory: () => workers[workerCount++]
  }).start();
  t.after(async () => {
    releaseFirstTermination(0);
    manager.close();
    await manager.waitForBackgroundTasks();
    rmSync(dir, { recursive: true, force: true });
  });

  manager.applyRuntimeConfig({ enabled: false, detailsEnabled: false, dbPath });
  manager.applyRuntimeConfig({ enabled: true, detailsEnabled: false, dbPath });
  assert.equal(workerCount, 1);
  assert.equal(manager.getPublicState().captureState, "enabling");

  releaseFirstTermination(0);
  await waitFor(() => workerCount === 2, "replacement index worker to start");
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`CREATE INDEX ${FORWARDING_METADATA_INDEX}
      ON http_transactions (${FORWARDING_METADATA_COLUMNS.join(", ")})`);
  } finally {
    database.close();
  }
  workers[1].finish();
  await manager.waitForBackgroundTasks();

  assert.equal(manager.getPublicState().captureActive, true);
  assert.equal(workerCount, 2);
});

test("capture manager persists truncated prefixes with total observed byte counts", (t) => {
  const dir = makeTempDir("crp-capture-truncated");
  mkdirSync(dir, { recursive: true });
  const runtimeConfigPath = join(dir, "proxy-config.json");
  const dbPath = join(dir, "traffic.sqlite3");
  writeFileSync(runtimeConfigPath, JSON.stringify({ capture: { enabled: true, detailsEnabled: true, dbPath } }));
  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: { enabled: true, detailsEnabled: true, dbPath },
    watchRuntimeConfig: false
  }).start();
  t.after(() => {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  });
  manager.beginRecord().save({
    startedAt: "2026-05-19T00:00:00.000Z",
    completedAt: "2026-05-19T00:00:01.000Z",
    durationMs: 1000,
    requestId: "req-truncated",
    sessionId: null,
    threadId: null,
    method: "POST",
    incomingUrl: "http://127.0.0.1:15100/responses",
    targetUrl: "https://example.test/responses",
    requestHeaders: {},
    requestBody: Buffer.from("request-prefix"),
    requestBodyBytes: 2_000_000,
    requestBodyTruncated: true,
    responseStatus: 200,
    responseHeaders: {},
    responseBody: Buffer.from([0xff, 0x00]),
    responseBodyBytes: 3_000_000,
    responseBodyTruncated: true,
    isStream: false,
    upstreamRequestId: null
  });

  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT * FROM http_transactions WHERE request_id = ?").get("req-truncated");
  db.close();
  assert.equal(row.request_body, "request-prefix");
  assert.equal(row.request_body_encoding, "utf8-truncated");
  assert.equal(row.request_body_bytes, 2_000_000);
  assert.equal(row.response_body, Buffer.from([0xff, 0x00]).toString("base64"));
  assert.equal(row.response_body_encoding, "base64-truncated");
  assert.equal(row.response_body_bytes, 3_000_000);
});

test("capture manager writes a complete request/response record", async () => {
  const dir = makeTempDir("crp-capture");
  mkdirSync(dir, { recursive: true });
  const runtimeConfigPath = join(dir, "proxy-config.json");
  const dbPath = join(dir, "traffic.sqlite3");
  writeFileSync(runtimeConfigPath, `${JSON.stringify({
    capture: {
      enabled: true,
      detailsEnabled: true,
      dbPath
    }
  }, null, 2)}\n`, "utf8");

  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: {
      enabled: true,
      detailsEnabled: true,
      dbPath
    },
    watchRuntimeConfig: false
  }).start();

  const handle = manager.beginRecord();
  assert.ok(handle);
  handle.save({
    startedAt: new Date("2026-05-19T00:00:00.000Z").toISOString(),
    completedAt: new Date("2026-05-19T00:00:01.000Z").toISOString(),
    durationMs: 1000,
    requestId: "req-1",
    sessionId: "sess-1",
    threadId: "thread-1",
    method: "POST",
    incomingUrl: "http://127.0.0.1:15100/responses",
    targetUrl: "https://example.com/responses",
    providerId: "provider-original",
    providerName: "Original provider",
    route: "custom",
    routeReason: "unsupported_operation",
    providerSelectionReason: "model_priority",
    requestedModel: "model-a",
    forwardedModel: "vendor/model-a",
    requestHeaders: {
      Authorization: "Bearer super-secret",
      Accept: "application/json"
    },
      requestBody: Buffer.from("{\"hello\":\"world\"}", "utf8"),
      requestBodyBytes: 17,
      requestBodyTruncated: false,
    responseStatus: 200,
    responseHeaders: {
      "Content-Type": "text/event-stream",
      "X-Request-Id": "upstream-1"
    },
      responseBody: Buffer.from("event: ok\ndata: {}\n\n", "utf8"),
      responseBodyBytes: 20,
      responseBodyTruncated: false,
    isStream: true,
    upstreamRequestId: "upstream-1",
    inputTokens: 23,
    outputTokens: 7
  });

  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT * FROM http_transactions").all();
  db.close();
  manager.close();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_id, "req-1");
  assert.equal(rows[0].thread_id, "thread-1");
  assert.equal(rows[0].is_stream, 1);
  assert.equal(rows[0].response_status, 200);
  assert.equal(rows[0].provider_id, "provider-original");
  assert.equal(rows[0].provider_name, "Original provider");
  assert.equal(rows[0].route, "custom");
  assert.equal(rows[0].route_reason, "unsupported_operation");
  assert.equal(rows[0].provider_selection_reason, "model_priority");
  assert.equal(rows[0].requested_model, "model-a");
  assert.equal(rows[0].forwarded_model, "vendor/model-a");
  assert.equal(rows[0].input_tokens, 23);
  assert.equal(rows[0].output_tokens, 7);
  assert.equal(rows[0].usage_observation_status, "observed");
  assert.match(rows[0].request_headers_json, /REDACTED/);
  assert.match(rows[0].response_body, /event: ok/);

  rmSync(dir, { recursive: true, force: true });
});

test("capture details fail closed, preserve byte metadata, and honor in-flight mode snapshots", (t) => {
  const dir = makeTempDir("crp-capture-details-snapshot");
  mkdirSync(dir, { recursive: true });
  const runtimeConfigPath = join(dir, "proxy-config.json");
  const dbPath = join(dir, "traffic.sqlite3");
  writeFileSync(runtimeConfigPath, JSON.stringify({
    capture: { enabled: true, detailsEnabled: false, dbPath }
  }));
  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: { enabled: true, detailsEnabled: false, dbPath },
    watchRuntimeConfig: false
  }).start();
  t.after(() => {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const save = (handle, requestId, detailsCaptured) => handle.save({
    startedAt: "2026-05-19T00:00:00.000Z",
    completedAt: "2026-05-19T00:00:01.000Z",
    durationMs: 1,
    requestId,
    method: "POST",
    incomingUrl: "/v1/responses",
    targetUrl: "https://example.test/v1/responses",
    requestHeaders: { Authorization: "sentinel" },
    requestBody: Buffer.from("sentinel-request"),
    requestBodyBytes: 1024,
    requestBodyTruncated: true,
    responseHeaders: { "X-Secret": "sentinel" },
    responseBody: Buffer.from("sentinel-response"),
    responseBodyBytes: 2048,
    responseBodyTruncated: true,
    responseStatus: 200,
    detailsCaptured
  });
  const offHandle = manager.beginRecord();
  assert.ok(offHandle);
  save(offHandle, "details-off", true);
  manager.applyRuntimeConfig({ enabled: true, detailsEnabled: true, dbPath });
  const inFlight = manager.beginRecord();
  assert.ok(inFlight);
  manager.applyRuntimeConfig({ enabled: true, detailsEnabled: false, dbPath });
  save(inFlight, "details-snapshotted", false);
  manager.close();
  const database = new DatabaseSync(dbPath);
  const rows = database.prepare(`SELECT request_id, request_headers_json, request_body,
    request_body_bytes, response_body, response_body_bytes, details_captured
    FROM http_transactions ORDER BY id`).all();
  database.close();
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0] }, {
    request_id: "details-off",
    request_headers_json: "{}",
    request_body: "",
    request_body_bytes: 1024,
    response_body: "",
    response_body_bytes: 2048,
    details_captured: 0
  });
  assert.equal(rows[1].details_captured, 1);
  assert.match(rows[1].request_body, /sentinel-request/);
  assert.doesNotMatch(JSON.stringify(rows[0]), /sentinel/);
});

test("capture manager upgrades schema 1 and persists model, provider, and usage metadata", (t) => {
  const dir = makeTempDir("crp-capture-schema-1");
  mkdirSync(dir, { recursive: true });
  const runtimeConfigPath = join(dir, "proxy-config.json");
  const dbPath = join(dir, "traffic.sqlite3");
  writeFileSync(runtimeConfigPath, JSON.stringify({ capture: { enabled: true, dbPath } }));
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE http_transactions (
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
      error_type TEXT,
      error_message TEXT
    );
  `);
  legacy.close();
  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: { enabled: true, detailsEnabled: true, dbPath },
    watchRuntimeConfig: false
  }).start();
  t.after(() => {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  });
  manager.beginRecord().save({
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt: "2026-08-21T00:00:01.000Z",
    durationMs: 1_000,
    requestId: "schema-2-record",
    sessionId: null,
    threadId: null,
    method: "POST",
    incomingUrl: "http://127.0.0.1:15100/v1/responses",
    targetUrl: "https://provider.example/v1/responses",
    providerId: "provider-stable",
    providerName: "Stable provider",
    route: "custom",
    routeReason: "custom_only",
    providerSelectionReason: "sole_eligible",
    requestedModel: "model-a",
    forwardedModel: "vendor/model-a",
    requestHeaders: {},
    requestBody: Buffer.from("{}"),
    responseStatus: 200,
    responseHeaders: {},
    responseBody: Buffer.from("{}"),
    isStream: false
  });
  manager.close();

  const upgraded = new DatabaseSync(dbPath, { readOnly: true });
  const columns = upgraded.prepare("PRAGMA table_info(http_transactions)").all()
    .map(({ name }) => name);
  const version = upgraded.prepare("PRAGMA user_version").get().user_version;
  const row = upgraded.prepare(`
    SELECT provider_id, provider_name, route, route_reason,
      provider_selection_reason, requested_model, forwarded_model
    FROM http_transactions
  `).get();
  const indexColumns = upgraded.prepare(`PRAGMA index_info(${FORWARDING_METADATA_INDEX})`).all()
    .map(({ name }) => name);
  upgraded.close();
  assert.deepEqual(indexColumns, [
    "id", "started_at", "completed_at", "duration_ms",
    "request_id", "session_id", "thread_id", "method", "incoming_url", "target_url",
    "provider_id", "provider_name", "route", "route_reason", "provider_selection_reason",
    "requested_model", "forwarded_model", "request_body_bytes", "response_status",
    "response_body_bytes", "is_stream", "upstream_request_id", "input_tokens",
    "output_tokens", "cached_input_tokens", "details_captured", "usage_observation_status",
    "error_type", "error_message"
  ]);
  assert.equal(version, 6);
  assert.ok(columns.includes("provider_id"));
  assert.ok(columns.includes("input_tokens"));
  assert.ok(columns.includes("output_tokens"));
  assert.ok(columns.includes("usage_observation_status"));
  assert.ok(columns.includes("requested_model"));
  assert.ok(columns.includes("forwarded_model"));
  assert.ok(columns.includes("route_reason"));
  assert.ok(columns.includes("provider_selection_reason"));
  assert.equal(row.provider_id, "provider-stable");
  assert.equal(row.provider_name, "Stable provider");
  assert.equal(row.route, "custom");
  assert.equal(row.route_reason, "custom_only");
  assert.equal(row.provider_selection_reason, "sole_eligible");
  assert.equal(row.requested_model, "model-a");
  assert.equal(row.forwarded_model, "vendor/model-a");
});

test("capture manager hot-disables when runtime config changes", async (t) => {
  const dir = makeTempDir("crp-hot-disable");
  mkdirSync(dir, { recursive: true });
  let manager;
  t.after(() => {
    try {
      manager?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const runtimeConfigPath = join(dir, "proxy-config.json");
  const dbPath = join(dir, "traffic.sqlite3");
  writeFileSync(runtimeConfigPath, `${JSON.stringify({
    capture: {
      enabled: true,
      dbPath
    }
  }, null, 2)}\n`, "utf8");

  manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: {
      enabled: true,
      dbPath
    }
  });
  manager.start();

  assert.equal(manager.getPublicState().captureActive, true);
  writeFileSync(runtimeConfigPath, `${JSON.stringify({
    capture: {
      enabled: false,
      dbPath
    }
  }, null, 2)}\n`, "utf8");
  await waitFor(
    () => manager.getPublicState().captureActive === false,
    "capture recording to become inactive"
  );

  assert.equal(manager.getPublicState().captureActive, false);
  assert.equal(manager.getPublicState().captureState, "disabled");
});

test("capture manager marks restart required when db path changes", async (t) => {
  const dir = makeTempDir("crp-db-change");
  mkdirSync(dir, { recursive: true });
  let manager;
  t.after(() => {
    try {
      manager?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const runtimeConfigPath = join(dir, "proxy-config.json");
  const dbPath = join(dir, "traffic.sqlite3");
  const nextDbPath = join(dir, "traffic-next.sqlite3");
  writeFileSync(runtimeConfigPath, `${JSON.stringify({
    capture: {
      enabled: true,
      dbPath
    }
  }, null, 2)}\n`, "utf8");

  manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: {
      enabled: true,
      dbPath
    }
  });
  manager.start();

  writeFileSync(runtimeConfigPath, `${JSON.stringify({
    capture: {
      enabled: true,
      dbPath: nextDbPath
    }
  }, null, 2)}\n`, "utf8");
  await waitFor(
    () => manager.getPublicState().captureRestartRequired === true,
    "capture restart to become required"
  );

  const state = manager.getPublicState();
  assert.equal(state.captureRestartRequired, true);
  assert.equal(resolve(state.captureRuntimeDbPath), resolve(dbPath));
  assert.equal(resolve(state.captureDbPath), resolve(nextDbPath));
});

test("capture manager reconciles a config change during startup", (t) => {
  const dir = makeTempDir("crp-startup-change");
  mkdirSync(dir, { recursive: true });
  let manager;
  t.after(() => {
    try {
      manager?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const runtimeConfigPath = join(dir, "proxy-config.json");
  const dbPath = join(dir, "traffic.sqlite3");
  const nextDbPath = join(dir, "traffic-next.sqlite3");
  writeFileSync(runtimeConfigPath, `${JSON.stringify({
    capture: {
      enabled: true,
      dbPath
    }
  }, null, 2)}\n`, "utf8");

  manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: {
      enabled: true,
      dbPath
    }
  });
  const enableFromConfig = manager.enableFromConfig.bind(manager);
  manager.enableFromConfig = (...args) => {
    enableFromConfig(...args);
    writeFileSync(runtimeConfigPath, `${JSON.stringify({
      capture: {
        enabled: true,
        dbPath: nextDbPath
      }
    }, null, 2)}\n`, "utf8");
  };
  manager.start();

  const state = manager.getPublicState();
  assert.equal(state.captureRestartRequired, true);
  assert.equal(resolve(state.captureRuntimeDbPath), resolve(dbPath));
  assert.equal(resolve(state.captureDbPath), resolve(nextDbPath));
  assert.equal(manager.start(), manager);
});

test("loadRuntimeCaptureConfig validates malformed config", () => {
  const dir = makeTempDir("crp-bad-config");
  mkdirSync(dir, { recursive: true });
  const runtimeConfigPath = join(dir, "proxy-config.json");
  writeFileSync(runtimeConfigPath, `${JSON.stringify({
    capture: {
      enabled: "yes"
    }
  }, null, 2)}\n`, "utf8");

  assert.throws(() => loadRuntimeCaptureConfig(runtimeConfigPath), /capture\.enabled must be a boolean/);

  rmSync(dir, { recursive: true, force: true });
});
