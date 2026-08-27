import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ForwardingRecordsService } from "../src/supervisor/forwarding-records-service.mjs";

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
    outputTokens: null,
    usageObservationStatus: "legacy",
    errorType: "proxy_upstream_error",
    errorMessage: "connection refused",
    outcome: "error",
    providerId: "fallback",
    providerName: "Fallback API",
    route: "custom",
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

test("prefers persisted final provider attribution over the current provider catalog", (t) => {
  const directory = makeTempDir(t);
  const path = join(directory, "traffic.sqlite3");
  createDatabase(path);
  const database = new DatabaseSync(path);
  database.exec(`
    ALTER TABLE http_transactions ADD COLUMN provider_id TEXT;
    ALTER TABLE http_transactions ADD COLUMN provider_name TEXT;
    ALTER TABLE http_transactions ADD COLUMN route TEXT;
    ALTER TABLE http_transactions ADD COLUMN requested_model TEXT;
    ALTER TABLE http_transactions ADD COLUMN forwarded_model TEXT;
    UPDATE http_transactions
      SET provider_id = 'deleted-provider',
          provider_name = 'Historical provider',
          route = 'custom',
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
});

test("rejects invalid query shapes before opening the database", (t) => {
  const directory = makeTempDir(t);
  const service = new ForwardingRecordsService({ path: join(directory, "missing.sqlite3") });
  for (const options of [
    { limit: 0 },
    { limit: 101 },
    { before: 0 },
    { outcome: "pending" },
    { search: "x".repeat(101) }
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
