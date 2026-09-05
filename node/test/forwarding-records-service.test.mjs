import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CaptureManager, FORWARDING_METADATA_INDEX } from "../src/capture-store.mjs";

import {
  FORWARDING_DETAIL_LIMITS,
  ForwardingRecordsService
} from "../src/supervisor/forwarding-records-service.mjs";

function makeTempDir(t) {
  const directory = mkdtempSync(join(os.tmpdir(), "crp-forwarding-records-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec(`
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
    )
  `);
  const insert = database.prepare(`
    INSERT INTO http_transactions (
      id, started_at, completed_at, duration_ms, request_id, session_id, thread_id,
      method, incoming_url, target_url, request_headers_json, request_body,
      request_body_encoding, request_body_bytes, response_status,
      response_headers_json, response_body, response_body_encoding,
      response_body_bytes, is_stream, upstream_request_id, error_type, error_message
    ) VALUES (
      @id, @startedAt, @completedAt, @durationMs, @requestId, @sessionId, @threadId,
      'POST', @incomingUrl, @targetUrl, '{"authorization":"[REDACTED]"}', @requestBody,
      'utf8', @requestBytes, @responseStatus,
      '{}', @responseBody, 'utf8', @responseBytes, @stream,
      @upstreamRequestId, @errorType, @errorMessage
    )
  `);
  const rows = [
    {
      id: 1,
      startedAt: "2026-08-21T00:00:00.000Z",
      completedAt: "2026-08-21T00:00:01.000Z",
      durationMs: 1_000,
      requestId: "req-success",
      sessionId: "session-a",
      threadId: "thread-a",
      incomingUrl: "/v1/responses",
      targetUrl: "https://api.example.com/v1/responses",
      requestBody: "TOP-SECRET-REQUEST",
      requestBytes: 18,
      responseStatus: 200,
      responseBody: "TOP-SECRET-RESPONSE",
      responseBytes: 19,
      stream: 1,
      upstreamRequestId: "upstream-1",
      errorType: null,
      errorMessage: null
    },
    {
      id: 2,
      startedAt: "2026-08-21T00:01:00.000Z",
      completedAt: "2026-08-21T00:01:00.200Z",
      durationMs: 200,
      requestId: "req-rejected",
      sessionId: null,
      threadId: null,
      incomingUrl: "/responses",
      targetUrl: "https://chatgpt.com/backend-api/codex/responses",
      requestBody: "{}",
      requestBytes: 2,
      responseStatus: 429,
      responseBody: "{}",
      responseBytes: 2,
      stream: 0,
      upstreamRequestId: null,
      errorType: null,
      errorMessage: null
    },
    {
      id: 3,
      startedAt: "2026-08-21T00:02:00.000Z",
      completedAt: null,
      durationMs: 20,
      requestId: "req-network-error",
      sessionId: null,
      threadId: null,
      incomingUrl: "/v1/responses?safe=1",
      targetUrl: "https://fallback.example.net/v1/responses",
      requestBody: "{}",
      requestBytes: 2,
      responseStatus: 502,
      responseBody: "{}",
      responseBytes: 2,
      stream: 0,
      upstreamRequestId: null,
      errorType: "proxy_upstream_error",
      errorMessage: "connection refused"
    }
  ];
  for (const row of rows) insert.run(row);
  database.close();
}

test("returns a stable empty page when Capture has not created its database", (t) => {
  const directory = makeTempDir(t);
  const service = new ForwardingRecordsService({ path: join(directory, "missing.sqlite3") });
  assert.deepEqual(service.list({ limit: 25 }), {
    storageState: "missing",
    records: [],
    page: { limit: 25, nextBefore: null },
    summary: { total: 0, success: 0, rejected: 0, aborted: 0, error: 0 }
  });
});

test("lists bounded metadata with keyset paging, filtering, and provider projection", (t) => {
  const directory = makeTempDir(t);
  const path = join(directory, "traffic.sqlite3");
  createDatabase(path);
  const service = new ForwardingRecordsService({
    path,
    listProviders: () => [
      { id: "primary", name: "Primary API", baseUrl: "https://api.example.com/v1" },
      { id: "fallback", name: "Fallback API", baseUrl: "https://fallback.example.net/v1" }
    ]
  });

  const first = service.list({ limit: 2 });
  assert.equal(first.storageState, "ready");
  assert.deepEqual(first.summary, { total: 3, success: 1, rejected: 1, aborted: 0, error: 1 });
  assert.deepEqual(first.records.map((record) => record.id), [3, 2]);
  assert.equal(first.page.nextBefore, 2);
  assert.deepEqual(first.records[0], {
    id: 3,
    startedAt: "2026-08-21T00:02:00.000Z",
    completedAt: null,
    durationMs: 20,
    requestId: "req-network-error",
    sessionId: null,
    threadId: null,
    method: "POST",
    incomingUrl: "/v1/responses?safe=1",
    targetUrl: "https://fallback.example.net/v1/responses",
    requestBytes: 2,
    responseStatus: 502,
    responseBytes: 2,
    stream: false,
    upstreamRequestId: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    detailsAvailable: false,
    usageObservationStatus: "legacy",
    errorType: "proxy_upstream_error",
    errorMessage: "connection refused",
    outcome: "error",
    providerId: "fallback",
    providerName: "Fallback API",
    route: "custom",
    routeReason: null,
    providerSelectionReason: null,
    requestedModel: null,
    forwardedModel: null
  });
  assert.equal(first.records[1].route, "account");
  assert.equal(first.records[1].providerName, "ChatGPT");

  const second = service.list({ limit: 2, before: first.page.nextBefore });
  assert.deepEqual(second.records.map((record) => record.id), [1]);
  assert.equal(second.page.nextBefore, null);
  assert.equal(second.records[0].providerName, "Primary API");
  const serialized = JSON.stringify(second);
  assert.doesNotMatch(serialized, /TOP-SECRET-(?:REQUEST|RESPONSE)/);
  assert.doesNotMatch(serialized, /request_headers_json|response_headers_json/);

  const rejected = service.list({ outcome: "rejected" });
  assert.deepEqual(rejected.records.map((record) => record.id), [2]);
  const searched = service.list({ search: "network-error" });
  assert.deepEqual(searched.records.map((record) => record.id), [3]);
});

test("projects token counts and separates client aborts from forwarding errors", (t) => {
  const directory = makeTempDir(t);
  const path = join(directory, "traffic.sqlite3");
  createDatabase(path);
  const database = new DatabaseSync(path);
  database.exec("ALTER TABLE http_transactions ADD COLUMN details_captured INTEGER NOT NULL DEFAULT 0");
  database.exec(`
    ALTER TABLE http_transactions ADD COLUMN input_tokens INTEGER;
    ALTER TABLE http_transactions ADD COLUMN output_tokens INTEGER;
    UPDATE http_transactions
      SET input_tokens = 31,
          output_tokens = 12
      WHERE id = 1;
    UPDATE http_transactions
      SET response_status = 200,
          error_type = 'proxy_client_abort',
          error_message = 'Client closed connection'
      WHERE id = 3;
  `);
  database.close();
  const service = new ForwardingRecordsService({ path });

  const page = service.list({ limit: 10 });
  assert.deepEqual(page.summary, {
    total: 3,
    success: 1,
    rejected: 1,
    aborted: 1,
    error: 0
  });
  const success = page.records.find(({ id }) => id === 1);
  assert.equal(success.inputTokens, 31);
  assert.equal(success.outputTokens, 12);
  assert.equal(success.usageObservationStatus, "observed");
  assert.deepEqual(
    service.list({ outcome: "aborted" }).records.map(({ id, outcome }) => ({ id, outcome })),
    [{ id: 3, outcome: "aborted" }]
  );
  assert.deepEqual(service.list({ outcome: "error" }).records, []);
});

test("returns nested captured details while legacy rows remain metadata-only", (t) => {
  const directory = makeTempDir(t);
  const path = join(directory, "traffic.sqlite3");
  createDatabase(path);
  const legacyService = new ForwardingRecordsService({ path });
  assert.deepEqual(legacyService.get(1), { id: 1, detailsAvailable: false });
  assert.equal(legacyService.get(999), null);

  const database = new DatabaseSync(path);
  database.exec(`
    ALTER TABLE http_transactions ADD COLUMN input_tokens INTEGER;
    ALTER TABLE http_transactions ADD COLUMN output_tokens INTEGER;
    ALTER TABLE http_transactions ADD COLUMN cached_input_tokens INTEGER;
    ALTER TABLE http_transactions ADD COLUMN details_captured INTEGER NOT NULL DEFAULT 0;
    UPDATE http_transactions
      SET input_tokens = 31,
          output_tokens = 12,
          cached_input_tokens = 7,
          details_captured = 1,
          request_headers_json = '{"authorization":"very-secret","content-type":"application/json"}',
          request_body = '{"model":"model-a"}',
          request_body_encoding = 'utf8',
          request_body_bytes = 20,
          response_headers_json = '{"content-type":"application/json"}',
          response_body = '{"id":"response-a"}',
          response_body_encoding = 'utf8-truncated',
          response_body_bytes = 40
      WHERE id = 1;
  `);
  database.close();

  const service = new ForwardingRecordsService({ path });
  const listed = service.list({ limit: 10 }).records.find(({ id }) => id === 1);
  assert.equal(listed.cachedInputTokens, 7);
  assert.equal(listed.detailsAvailable, true);
  const detail = service.get(1);
  assert.deepEqual(detail, {
    id: 1,
    detailsAvailable: true,
    request: {
      headers: {
        authorization: "[REDACTED]",
        "content-type": "application/json"
      },
      body: {
        content: '{"model":"model-a"}',
        encoding: "utf8",
        bytes: 20,
        truncated: false
      }
    },
    response: {
      headers: { "content-type": "application/json" },
      body: {
        content: '{"id":"response-a"}',
        encoding: "utf8-truncated",
        bytes: 40,
        truncated: true
      }
    }
  });
  assert.equal(JSON.stringify(detail).includes("very-secret"), false);
  assert.deepEqual(service.get(2), { id: 2, detailsAvailable: false });
});

test("projects oversized detail bodies and headers in SQLite before JS materialization", (t) => {
  const directory = makeTempDir(t);
  const path = join(directory, "traffic.sqlite3");
  createDatabase(path);
  const database = new DatabaseSync(path);
  database.exec("ALTER TABLE http_transactions ADD COLUMN details_captured INTEGER NOT NULL DEFAULT 0");
  const oversizedBody = "你".repeat(FORWARDING_DETAIL_LIMITS.bodyCodeUnits + 100);
  const oversizedHeaders = JSON.stringify(Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [`x-${index}`, "h".repeat(1_024)])
  ));
  database.prepare(`
    UPDATE http_transactions SET details_captured = 1,
      request_headers_json = @headers,
      request_body = @body,
      request_body_bytes = 1_000_000_000_001,
      request_body_encoding = 'utf8',
      response_body = @body,
      response_body_bytes = 1_000_000_000_001,
      response_body_encoding = 'utf8'
    WHERE id = 1
  `).run({ headers: oversizedHeaders, body: oversizedBody });
  database.close();
  const detail = new ForwardingRecordsService({ path }).get(1);
  assert.equal(detail.detailsAvailable, true);
  assert.equal(detail.request.body.content.length, FORWARDING_DETAIL_LIMITS.bodyCodeUnits);
  assert.equal(detail.request.body.truncated, true);
  assert.equal(detail.response.body.truncated, true);
  assert.equal(detail.request.body.bytes, 0);
  assert.equal(JSON.stringify(detail.request.headers).length <= FORWARDING_DETAIL_LIMITS.headersJsonBytes, true);
});

test("hides model catalog requests without corrupting paging or summary counts", (t) => {
  const directory = makeTempDir(t);
  const path = join(directory, "traffic.sqlite3");
  createDatabase(path);
  const database = new DatabaseSync(path);
  database.exec(`
    UPDATE http_transactions
      SET incoming_url = 'http://127.0.0.1:15100/v1/models?refresh=1',
          target_url = 'https://fallback.example.net/v1/models?refresh=1'
      WHERE id = 3;
  `);
  database.close();
  const service = new ForwardingRecordsService({ path });

  const visible = service.list({ limit: 1, includeModels: false });
  assert.deepEqual(visible.records.map(({ id }) => id), [2]);
  assert.equal(visible.page.nextBefore, 2);
  assert.deepEqual(visible.summary, {
    total: 2,
    success: 1,
    rejected: 1,
    aborted: 0,
    error: 0
  });
  assert.deepEqual(
    service.list({ limit: 1, before: visible.page.nextBefore, includeModels: false })
      .records.map(({ id }) => id),
    [1]
  );
  assert.deepEqual(service.list({ search: "models", includeModels: false }).records, []);

  const included = service.list({ limit: 10, includeModels: true });
  assert.deepEqual(included.records.map(({ id }) => id), [3, 2, 1]);
  assert.equal(included.summary.total, 3);
});

test("prefers persisted final provider attribution over the current provider catalog", (t) => {
  const directory = makeTempDir(t);
  const path = join(directory, "traffic.sqlite3");
  createDatabase(path);
  const database = new DatabaseSync(path);
  database.exec(`
    ALTER TABLE http_transactions ADD COLUMN provider_id TEXT;
    ALTER TABLE http_transactions ADD COLUMN provider_name TEXT;
    ALTER TABLE http_transactions ADD COLUMN route TEXT;
    ALTER TABLE http_transactions ADD COLUMN route_reason TEXT;
    ALTER TABLE http_transactions ADD COLUMN provider_selection_reason TEXT;
    ALTER TABLE http_transactions ADD COLUMN requested_model TEXT;
    ALTER TABLE http_transactions ADD COLUMN forwarded_model TEXT;
    UPDATE http_transactions
      SET provider_id = 'deleted-provider',
          provider_name = 'Historical provider',
          route = 'custom',
          route_reason = 'unsupported_operation',
          provider_selection_reason = 'model_priority',
          requested_model = 'model-a',
          forwarded_model = 'vendor/model-a'
      WHERE id = 1;
  `);
  database.close();
  const service = new ForwardingRecordsService({
    path,
    listProviders: () => [
      { id: "replacement", name: "Replacement provider", baseUrl: "https://api.example.com/v1" }
    ]
  });

  const record = service.list({ limit: 10 }).records.find(({ id }) => id === 1);
  assert.equal(record.providerId, "deleted-provider");
  assert.equal(record.providerName, "Historical provider");
  assert.equal(record.route, "custom");
  assert.equal(record.routeReason, "unsupported_operation");
  assert.equal(record.providerSelectionReason, "model_priority");
  assert.equal(record.requestedModel, "model-a");
  assert.equal(record.forwardedModel, "vendor/model-a");
  assert.deepEqual(
    service.list({ search: "Historical provider" }).records.map(({ id }) => id),
    [1]
  );
  assert.deepEqual(
    service.list({ search: "vendor/model-a" }).records.map(({ id }) => id),
    [1]
  );
  assert.deepEqual(
    service.list({ search: "unsupported_operation" }).records.map(({ id }) => id),
    [1]
  );
});

test("rejects invalid query shapes before opening the database", (t) => {
  const directory = makeTempDir(t);
  const service = new ForwardingRecordsService({ path: join(directory, "missing.sqlite3") });
  for (const options of [
    { limit: 0 },
    { limit: 101 },
    { before: 0 },
    { outcome: "pending" },
    { includeModels: "false" },
    { search: "x".repeat(101) },
    { since: "2026-08-21" },
    { since: "2026-02-30T00:00:00.000Z" },
    { until: "2026-08-21T00:00:00Z" },
    { since: "2026-08-21T00:00:00.000Z", until: "2026-08-21T00:00:00.000Z" },
    { since: "2026-08-22T00:00:00.000Z", until: "2026-08-21T00:00:00.000Z" },
    { model: "" }, { model: " padded " }, { model: "x".repeat(257) },
    { model: "bad\u0085value" }, { model: 1 },
    { providerId: "" }, { providerId: " padded " }, { providerId: "x".repeat(257) },
    { providerId: "bad\nvalue" }, { providerId: false },
    { sessionId: "" }, { sessionId: " padded " }, { sessionId: "x".repeat(257) },
    { sessionId: "bad\nvalue" }, { sessionId: false }
  ]) {
    assert.throws(() => service.list(options), /query is invalid/);
  }
});

test("wraps malformed Capture storage without exposing SQLite details", (t) => {
  const directory = makeTempDir(t);
  const path = join(directory, "traffic.sqlite3");
  writeFileSync(path, "not a sqlite database", "utf8");
  const service = new ForwardingRecordsService({ path });
  assert.throws(
    () => service.list(),
    (error) => error.code === "FORWARDING_RECORDS_UNAVAILABLE"
      && error.message === "Forwarding records could not be read."
  );
});

test("refuses a symlink Capture database without opening its target", (t) => {
  const directory = makeTempDir(t);
  const target = join(directory, "target.sqlite3");
  const link = join(directory, "traffic.sqlite3");
  createDatabase(target);
  symlinkSync(target, link);
  let opened = false;
  const service = new ForwardingRecordsService({
    path: link,
    openDatabase() {
      opened = true;
      throw new Error("must not open");
    }
  });
  assert.throws(() => service.list(), { code: "FORWARDING_RECORDS_UNAVAILABLE" });
  assert.equal(opened, false);
});

async function upgradeDatabase(path) {
  const manager = new CaptureManager({
    configPath: `${path}.config.json`,
    capture: { enabled: true, dbPath: path },
    watchRuntimeConfig: false
  }).start();
  try {
    await manager.waitForBackgroundTasks();
    assert.equal(manager.getPublicState().captureActive, true);
  } finally {
    manager.close();
    await manager.waitForBackgroundTasks();
  }
}

test("exact filters, time bounds, search and visibility scope facets before outcome and paging", async (t) => {
  const path = join(makeTempDir(t), "traffic.sqlite3");
  createDatabase(path);
  await upgradeDatabase(path);
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      UPDATE http_transactions SET provider_id = 'historical', route = 'custom',
        requested_model = 'model-a', forwarded_model = 'vendor/model-a';
      UPDATE http_transactions SET provider_id = 'chatgpt-account', route = 'account'
        WHERE id = 2;
      UPDATE http_transactions SET requested_model = 'model-a-extra',
        forwarded_model = 'other-model' WHERE id = 3;
    `);
  } finally { database.close(); }
  const service = new ForwardingRecordsService({ path });
  for (const model of ["model-a", "vendor/model-a"]) {
    const first = service.list({ model, limit: 1 });
    assert.deepEqual(first.records.map(({ id }) => id), [2]);
    assert.equal(first.page.nextBefore, 2);
    assert.deepEqual(first.summary, { total: 2, success: 1, rejected: 1, aborted: 0, error: 0 });
    const next = service.list({ model, limit: 1, before: 2, outcome: "success" });
    assert.deepEqual(next.records.map(({ id }) => id), [1]);
    assert.deepEqual(next.summary, first.summary);
  }
  assert.deepEqual(service.list({ providerId: "historical" }).records.map(({ id }) => id), [3, 1]);
  assert.deepEqual(service.list({ providerId: "chatgpt-account" }).records.map(({ id }) => id), [2]);
  assert.equal(service.list({ providerId: "hist" }).summary.total, 0);
  const filtered = service.list({
    since: "2026-08-21T00:01:00.000Z", until: "2026-08-21T00:02:00.000Z",
    model: "model-a", providerId: "chatgpt-account", search: "rejected", outcome: "success"
  });
  assert.deepEqual(filtered.records, []);
  assert.deepEqual(filtered.summary, { total: 1, success: 0, rejected: 1, aborted: 0, error: 0 });
  assert.deepEqual(service.list({ sessionId: "session-a" }).records.map(({ id }) => id), [1]);
  assert.equal(service.list({ sessionId: "session-a", outcome: "error" }).summary.total, 1);
  assert.equal(service.list({ sessionId: "session" }).summary.total, 0);
  assert.equal(service.list({ search: "%" }).summary.total, 0);
  assert.equal(service.list({ search: "_" }).summary.total, 1);
  const writer = new DatabaseSync(path);
  try { writer.exec("UPDATE http_transactions SET incoming_url = '/v1/models' WHERE id = 2"); }
  finally { writer.close(); }
  assert.equal(service.list({ model: "model-a", includeModels: false }).summary.total, 1);
  assert.equal(service.list({ search: "rejected", includeModels: false }).summary.total, 0);
});

test("legacy filters fail closed and the reader leaves schema and rows unchanged", (t) => {
  const path = join(makeTempDir(t), "traffic.sqlite3");
  createDatabase(path);
  const database = new DatabaseSync(path);
  let before;
  try { before = database.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(); }
  finally { database.close(); }
  const service = new ForwardingRecordsService({ path });
  for (const options of [{ model: "model-a" }, { providerId: "chatgpt-account" }]) {
    const result = service.list(options);
    assert.deepEqual(result.records, []);
    assert.equal(result.summary.total, 0);
  }
  assert.deepEqual(service.list({
    since: "2026-08-21T00:01:00.000Z", until: "2026-08-21T00:02:00.000Z"
  }).records.map(({ id }) => id), [2]);
  const after = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(after.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(), before);
    assert.equal(after.prepare("SELECT count(*) AS count FROM http_transactions").get().count, 3);
  } finally { after.close(); }
});

test("writer index covers actual list and summary queries without selecting captured bodies", async (t) => {
  const path = join(makeTempDir(t), "traffic.sqlite3");
  createDatabase(path);
  await upgradeDatabase(path);
  const plans = [];
  const service = new ForwardingRecordsService({
    path,
    openDatabase(databasePath) {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      return {
        exec: (sql) => database.exec(sql),
        close: () => database.close(),
        prepare(sql) {
          const statement = database.prepare(sql);
          if (!sql.includes(`INDEXED BY ${FORWARDING_METADATA_INDEX}`)) return statement;
          assert.doesNotMatch(sql, /\b(?:request_body|response_body|request_headers_json|response_headers_json)\b/);
          return Object.fromEntries(["all", "get"].map((method) => [method, (parameters) => {
            plans.push(database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(parameters));
            return statement[method](parameters);
          }]));
        }
      };
    }
  });
  const result = service.list({ includeModels: false });
  assert.doesNotMatch(JSON.stringify(result), /TOP-SECRET-(?:REQUEST|RESPONSE)/);
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.ok(plan.some(({ detail }) => detail.includes("COVERING INDEX")
      && detail.includes(FORWARDING_METADATA_INDEX)));
    assert.ok(plan.every(({ detail }) => !detail.includes("TEMP B-TREE")));
  }
});

test("list and facets share a WAL snapshot and subsequent reads observe edits and deletes", async (t) => {
  const path = join(makeTempDir(t), "traffic.sqlite3");
  createDatabase(path);
  await upgradeDatabase(path);
  const writer = new DatabaseSync(path);
  let mutate = true;
  try {
    const service = new ForwardingRecordsService({ path, openDatabase(databasePath) {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      return {
        exec: (sql) => database.exec(sql), close: () => database.close(),
        prepare(sql) {
          if (mutate && sql.includes("COUNT(*) AS total")) {
            writer.exec("UPDATE http_transactions SET response_status = 200 WHERE id = 2; DELETE FROM http_transactions WHERE id = 1");
            mutate = false;
          }
          return database.prepare(sql);
        }
      };
    } });
    const first = service.list();
    assert.equal(first.records.length, 3);
    assert.equal(first.summary.total, 3);
    assert.equal(first.summary.rejected, 1);
    const next = service.list();
    assert.deepEqual(next.records.map(({ id }) => id), [3, 2]);
    assert.deepEqual(next.summary, { total: 2, success: 1, rejected: 0, aborted: 0, error: 1 });
  } finally { writer.close(); }
});

test("synthetic body-bearing forwarding benchmark", {
  skip: process.env.CRP_FORWARDING_BENCHMARK !== "1"
}, async (t) => {
  const path = join(makeTempDir(t), "traffic.sqlite3");
  createDatabase(path);
  await upgradeDatabase(path);
  const database = new DatabaseSync(path);
  const rowCount = 4_000;
  const bodyBytes = 64 * 1024;
  try {
    database.exec(`DROP INDEX ${FORWARDING_METADATA_INDEX}; DELETE FROM http_transactions;`);
    database.prepare(`
      WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < @count)
      INSERT INTO http_transactions (
        id, started_at, request_id, method, incoming_url, target_url, provider_id,
        requested_model, forwarded_model, request_headers_json, request_body,
        request_body_encoding, request_body_bytes, response_status,
        response_headers_json, response_body, response_body_encoding, response_body_bytes,
        is_stream, error_type, error_message
      ) SELECT n, '2026-09-01T00:00:00.000Z', printf('synthetic-%d', n), 'POST',
        CASE WHEN n % 10 = 0 THEN '/v1/models' ELSE '/v1/responses' END,
        'https://synthetic.example/v1/responses', 'synthetic-provider',
        'synthetic-model', 'synthetic-model', '{}', @body, 'utf8', @bytes,
        CASE WHEN n % 5 = 0 THEN 429 ELSE 200 END, '{}', @body, 'utf8', @bytes,
        0, NULL, NULL FROM rows
    `).run({ count: rowCount, body: "b".repeat(bodyBytes), bytes: bodyBytes });
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { database.close(); }
  const service = new ForwardingRecordsService({ path });
  const measure = () => {
    const samples = [];
    let result;
    for (let i = 0; i < 5; i++) {
      const start = performance.now(); result = service.list({ includeModels: false });
      samples.push(performance.now() - start);
    }
    return { medianMs: samples.sort((a, b) => a - b)[2], result };
  };
  const beforeBytes = statSync(path).size;
  const before = measure();
  const start = performance.now(); await upgradeDatabase(path);
  const indexBuildMs = performance.now() - start;
  const after = measure();
  assert.deepEqual(after.result, before.result);
  assert.equal(after.result.summary.total, 3_600);
  t.diagnostic(JSON.stringify({ rowCount, bodyBytesPerDirection: bodyBytes,
    beforeMedianMs: Math.round(before.medianMs * 100) / 100,
    afterMedianMs: Math.round(after.medianMs * 100) / 100,
    indexBuildMs: Math.round(indexBuildMs), indexStorageBytes: statSync(path).size - beforeBytes,
    evidence: "synthetic local SQLite, 5 sequential warm-cache samples per path; no live speedup claim"
  }));
});

test("session filtering fails closed when a legacy database lacks the session column", (t) => {
  const path = join(makeTempDir(t), "traffic.sqlite3");
  createDatabase(path);
  const writer = new DatabaseSync(path);
  try { writer.exec("ALTER TABLE http_transactions DROP COLUMN session_id"); }
  finally { writer.close(); }
  const service = new ForwardingRecordsService({ path });
  assert.equal(service.list().records[0].sessionId, null);
  const result = service.list({ sessionId: "session-a" });
  assert.deepEqual(result.records, []);
  assert.equal(result.summary.total, 0);
});
