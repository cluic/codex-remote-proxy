import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  CaptureManager,
  DEFAULT_CAPTURE_DB_PATH,
  encodeBody,
  loadRuntimeCaptureConfig,
  normalizeCaptureConfig,
  redactHeaders
} from "../src/capture-store.mjs";

function makeTempDir(prefix) {
  return join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

test("capture manager persists truncated prefixes with total observed byte counts", (t) => {
  const dir = makeTempDir("crp-capture-truncated");
  mkdirSync(dir, { recursive: true });
  const runtimeConfigPath = join(dir, "proxy-config.json");
  const dbPath = join(dir, "traffic.sqlite3");
  writeFileSync(runtimeConfigPath, JSON.stringify({ capture: { enabled: true, dbPath } }));
  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: { enabled: true, dbPath },
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
      dbPath
    }
  }, null, 2)}\n`, "utf8");

  const manager = new CaptureManager({
    configPath: runtimeConfigPath,
    capture: {
      enabled: true,
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
    requestedModel: "model-a",
    forwardedModel: "vendor/model-a",
    requestHeaders: {
      Authorization: "Bearer super-secret",
      Accept: "application/json"
    },
    requestBody: Buffer.from("{\"hello\":\"world\"}", "utf8"),
    responseStatus: 200,
    responseHeaders: {
      "Content-Type": "text/event-stream",
      "X-Request-Id": "upstream-1"
    },
    responseBody: Buffer.from("event: ok\ndata: {}\n\n", "utf8"),
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
  assert.equal(rows[0].requested_model, "model-a");
  assert.equal(rows[0].forwarded_model, "vendor/model-a");
  assert.equal(rows[0].input_tokens, 23);
  assert.equal(rows[0].output_tokens, 7);
  assert.equal(rows[0].usage_observation_status, "observed");
  assert.match(rows[0].request_headers_json, /REDACTED/);
  assert.match(rows[0].response_body, /event: ok/);

  rmSync(dir, { recursive: true, force: true });
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
    capture: { enabled: true, dbPath },
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
    SELECT provider_id, provider_name, route, requested_model, forwarded_model
    FROM http_transactions
  `).get();
  upgraded.close();
  assert.equal(version, 5);
  assert.ok(columns.includes("provider_id"));
  assert.ok(columns.includes("input_tokens"));
  assert.ok(columns.includes("output_tokens"));
  assert.ok(columns.includes("usage_observation_status"));
  assert.ok(columns.includes("requested_model"));
  assert.ok(columns.includes("forwarded_model"));
  assert.equal(row.provider_id, "provider-stable");
  assert.equal(row.provider_name, "Stable provider");
  assert.equal(row.route, "custom");
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
