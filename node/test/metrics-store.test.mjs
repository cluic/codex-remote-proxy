import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
  METRICS_MAX_FILE_BYTES,
  MetricsStore
} from "../src/supervisor/metrics-store.mjs";

const HOUR_MS = 60 * 60 * 1_000;

function observation(overrides = {}) {
  return {
    providerId: "provider-a",
    result: "success",
    model: "gpt-5-codex",
    inputTokens: 120,
    outputTokens: 30,
    durationBin: 4,
    responseStartBin: 2,
    ...overrides
  };
}

function harness(t, { timestamp = Date.parse("2026-07-16T12:34:56.000Z") } = {}) {
  const dir = mkdtempSync(join(os.tmpdir(), "crp-metrics-"));
  const path = join(dir, "metrics.json");
  let now = timestamp;
  const store = new MetricsStore({ path, now: () => now, flushDelayMs: 60_000 });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    path,
    store,
    advance(milliseconds) {
      now += milliseconds;
    }
  };
}

test("empty metrics return stable zero-filled 24h and 7d chart series", (t) => {
  const state = harness(t);
  for (const [window, expectedBuckets] of [["24h", 24], ["7d", 168]]) {
    const overview = state.store.getOverview({ window });
    assert.equal(overview.window, window);
    assert.equal(overview.storageState, "ready");
    assert.equal(overview.series.length, expectedBuckets);
    assert.equal(overview.series.every((bucket) => bucket.requests === 0), true);
    assert.equal(overview.summary.requests, 0);
    assert.deepEqual(overview.summary.tokens, { input: 0, output: 0, observedRequests: 0 });
    assert.deepEqual(overview.summary.latency, {
      p50UpperBoundMs: null,
      p95UpperBoundMs: null,
      overflowRequests: 0
    });
    assert.deepEqual(overview.providers, []);
    assert.deepEqual(overview.models, []);
  }
});

test("metrics store aggregates hourly observations and restores the strict private document", (t) => {
  const state = harness(t);
  assert.equal(state.store.record(observation()), true);
  assert.equal(state.store.record(observation({
    result: "upstreamRejected",
    model: null,
    inputTokens: null,
    outputTokens: null,
    durationBin: 6,
    responseStartBin: 3
  })), true);

  const overview = state.store.getOverview({ window: "24h" });
  assert.equal(overview.series.length, 24);
  assert.equal(overview.series.at(-1).start, "2026-07-16T12:00:00.000Z");
  assert.deepEqual(overview.summary.results, {
    success: 1,
    upstreamRejected: 1,
    upstreamError: 0,
    timeout: 0,
    networkError: 0,
    clientAbort: 0
  });
  assert.deepEqual(overview.summary.tokens, { input: 120, output: 30, observedRequests: 1 });
  assert.deepEqual(overview.summary.latency, {
    p50UpperBoundMs: 1_000,
    p95UpperBoundMs: 5_000,
    overflowRequests: 0
  });
  assert.equal(overview.dataQuality.unknownModelRequests, 1);
  assert.deepEqual(overview.providers.map((provider) => ({
    providerId: provider.providerId,
    requests: provider.requests,
    successfulRequests: provider.successfulRequests
  })), [{ providerId: "provider-a", requests: 2, successfulRequests: 1 }]);
  assert.deepEqual(overview.models.map((model) => ({ model: model.model, requests: model.requests })), [
    { model: "gpt-5-codex", requests: 1 }
  ]);

  assert.equal(state.store.flush(), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(state.path).mode & 0o777, 0o600);
  }
  const document = JSON.parse(readFileSync(state.path, "utf8"));
  assert.deepEqual(Object.keys(document).sort(), [
    "bucketMinutes",
    "buckets",
    "retentionBuckets",
    "schemaVersion"
  ]);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.buckets.length, 1);

  const restored = new MetricsStore({
    path: state.path,
    now: () => Date.parse("2026-07-16T12:45:00.000Z"),
    flushDelayMs: 60_000
  });
  t.after(() => restored.close());
  assert.deepEqual(restored.getOverview({ window: "24h" }), state.store.getOverview({ window: "24h" }));
});

test("metrics store bounds dimensions, prunes after seven days, and rejects unsafe observations", (t) => {
  const state = harness(t, { timestamp: Date.parse("2026-07-01T00:05:00.000Z") });
  const sentinel = "metrics-private-sentinel";
  assert.equal(state.store.record({
    ...observation(),
    requestId: sentinel,
    url: `https://${sentinel}.invalid`,
    headers: { authorization: sentinel },
    body: sentinel,
    error: sentinel
  }), false);
  assert.equal(state.store.record(observation({ inputTokens: 100_000_001 })), false);
  assert.equal(state.store.record(observation({ model: `bad\u0000${sentinel}` })), false);

  for (let index = 0; index < 65; index += 1) {
    assert.equal(state.store.record(observation({ model: `model-${index}` })), true);
  }
  for (let index = 0; index < 33; index += 1) {
    assert.equal(state.store.record(observation({ providerId: `provider-${index}`, model: null })), true);
  }
  let overview = state.store.getOverview({ window: "7d" });
  assert.equal(overview.series.length, 168);
  assert.equal(overview.dataQuality.modelOverflowRequests, 1);
  assert.equal(overview.dataQuality.providerOverflowRequests, 2);
  assert.equal(overview.dataQuality.unknownModelRequests, 33);

  assert.equal(state.store.flush(), true);
  const persisted = readFileSync(state.path, "utf8");
  assert.equal(persisted.includes(sentinel), false);
  assert.equal(persisted.includes("requestId"), false);
  assert.equal(persisted.includes("headers"), false);
  assert.equal(persisted.includes("body"), false);
  assert.equal(persisted.includes("error"), false);

  state.advance(168 * HOUR_MS);
  assert.equal(state.store.record(observation({ providerId: "provider-new", model: "model-new" })), true);
  overview = state.store.getOverview({ window: "7d" });
  assert.equal(overview.summary.requests, 1);
  assert.equal(overview.providers[0].providerId, "provider-new");
  assert.equal(overview.models[0].model, "model-new");
});

test("maximum valid seven-day dimensions fit the metrics storage limit", (t) => {
  const state = harness(t, { timestamp: Date.parse("2026-07-09T00:05:00.000Z") });
  const providerSuffix = "供".repeat(114);
  const modelSuffix = "模".repeat(245);

  for (let hour = 0; hour < 168; hour += 1) {
    for (let index = 0; index < 64; index += 1) {
      assert.equal(state.store.record(observation({
        providerId: `p-${index % 32}-${providerSuffix}`,
        model: `m-${index}-${modelSuffix}`,
        inputTokens: null,
        outputTokens: null
      })), true);
    }
    if (hour < 167) state.advance(HOUR_MS);
  }

  assert.equal(state.store.flush(), true);
  const persistedSize = statSync(state.path).size;
  assert.ok(persistedSize > 4 * 1024 * 1024);
  assert.ok(persistedSize <= METRICS_MAX_FILE_BYTES);
  const document = JSON.parse(readFileSync(state.path, "utf8"));
  assert.equal(document.buckets.length, 168);
  assert.equal(document.buckets.every((bucket) => bucket.providers.length === 32), true);
  assert.equal(document.buckets.every((bucket) => bucket.models.length === 64), true);

  const restored = new MetricsStore({
    path: state.path,
    now: () => Date.parse("2026-07-15T23:05:00.000Z"),
    flushDelayMs: 60_000
  });
  t.after(() => restored.close());
  const overview = restored.getOverview({ window: "7d" });
  assert.equal(overview.storageState, "ready");
  assert.equal(overview.summary.requests, 168 * 64);
  assert.equal(overview.providers.length, 16);
  assert.equal(overview.models.length, 16);
  assert.equal(overview.providerOtherRequests, 168 * 32);
  assert.equal(overview.modelOtherRequests, 168 * 48);
});

test("invalid canonical storage is unavailable and is never overwritten", (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), "crp-metrics-invalid-"));
  const path = join(dir, "metrics.json");
  const original = `{"schemaVersion":99,"secret":"do-not-overwrite"}\n`;
  writeFileSync(path, original, { mode: 0o600 });
  chmodSync(path, 0o600);
  const store = new MetricsStore({
    path,
    now: () => Date.parse("2026-07-16T12:00:00.000Z"),
    flushDelayMs: 60_000
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(store.getOverview().storageState, "unavailable");
  assert.equal(store.record(observation()), true);
  assert.equal(store.flush(), false);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(store.getOverview().summary.requests, 1);
});

test("persistence failure degrades metrics without losing in-memory aggregates", (t) => {
  const state = harness(t);
  assert.equal(state.store.record(observation()), true);
  mkdirSync(state.path);

  assert.equal(state.store.flush(), false);
  const overview = state.store.getOverview();
  assert.equal(overview.storageState, "degraded");
  assert.equal(overview.summary.requests, 1);
  assert.equal(overview.summary.tokens.observedRequests, 1);
});
