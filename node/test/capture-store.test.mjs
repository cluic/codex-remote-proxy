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
    upstreamRequestId: "upstream-1"
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
  assert.match(rows[0].request_headers_json, /REDACTED/);
  assert.match(rows[0].response_body, /event: ok/);

  rmSync(dir, { recursive: true, force: true });
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
