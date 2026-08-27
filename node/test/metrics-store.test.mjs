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
  METRICS_DAILY_RETENTION_DAYS,
  METRICS_MAX_FILE_BYTES,
  MetricsStore
} from "../src/supervisor/metrics-store.mjs";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_COUNTER = 1_000_000_000_000;

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

function saturatedBucket(start, suffix) {
  const durationBins = Array.from({ length: 13 }, (_, index) => index === 0 ? MAX_COUNTER : 0);
  return {
    start,
    requests: MAX_COUNTER,
    results: {
      success: MAX_COUNTER,
      upstreamRejected: 0,
      upstreamError: 0,
      timeout: 0,
      networkError: 0,
      clientAbort: 0
    },
    usageObservedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationBins,
    responseStartBins: Array(13).fill(0),
    unknownModelRequests: 0,
    modelOverflowRequests: 0,
    providerOverflowRequests: 0,
    droppedObservations: 0,
    providers: [{
      providerId: `provider-${suffix}`,
      requests: MAX_COUNTER,
      successfulRequests: MAX_COUNTER,
      usageObservedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationBins
    }],
    models: [{
      model: `model-${suffix}`,
      requests: MAX_COUNTER,
      usageObservedRequests: 0,
      inputTokens: 0,
      outputTokens: 0
    }]
  };
}

function emptyLegacyBucket(start) {
  return {
    start,
    requests: 0,
    results: {
      success: 0,
      upstreamRejected: 0,
      upstreamError: 0,
      timeout: 0,
      networkError: 0,
      clientAbort: 0
    },
    usageObservedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationBins: Array(13).fill(0),
    responseStartBins: Array(13).fill(0),
    unknownModelRequests: 0,
    modelOverflowRequests: 0,
    providerOverflowRequests: 0,
    droppedObservations: 0,
    providers: [{
      providerId: "provider-a",
      requests: 0,
      successfulRequests: 0,
      usageObservedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationBins: Array(13).fill(0)
    }],
    models: [{
      model: "gpt-5-codex",
      requests: 0,
      usageObservedRequests: 0,
      inputTokens: 0,
      outputTokens: 0
    }]
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

test("token heatmap returns 84 zero-filled UTC days", (t) => {
  const state = harness(t);
  const heatmap = state.store.getTokenHeatmap({ window: "12w" });
  assert.equal(heatmap.window, "12w");
  assert.equal(heatmap.bucketMinutes, 1_440);
  assert.equal(heatmap.storageState, "ready");
  assert.equal(heatmap.days.length, METRICS_DAILY_RETENTION_DAYS);
  assert.equal(heatmap.days.every((day) => (
    day.requests === 0
      && day.tokens.input === 0
      && day.tokens.output === 0
      && day.tokens.observedRequests === 0
  )), true);
  assert.equal(heatmap.days.at(-1).start, "2026-07-16T00:00:00.000Z");
  assert.equal(heatmap.days[0].start, "2026-04-24T00:00:00.000Z");
});

test("token heatmap aggregates usage across the UTC day boundary", (t) => {
  const state = harness(t, { timestamp: Date.parse("2026-07-16T23:59:59.000Z") });
  assert.equal(state.store.record(observation({ inputTokens: 100, outputTokens: 20 })), true);
  state.advance(1_000);
  assert.equal(state.store.record(observation({ inputTokens: 7, outputTokens: 3 })), true);

  const days = state.store.getTokenHeatmap({ window: "12w" }).days;
  assert.deepEqual(days.at(-2), {
    start: "2026-07-16T00:00:00.000Z",
    requests: 1,
    tokens: { input: 100, output: 20, observedRequests: 1 }
  });
  assert.deepEqual(days.at(-1), {
    start: "2026-07-17T00:00:00.000Z",
    requests: 1,
    tokens: { input: 7, output: 3, observedRequests: 1 }
  });
});

test("legacy schema 1 metrics load with reconstructed daily buckets and upgrade on write", (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), "crp-metrics-legacy-"));
  const path = join(dir, "metrics.json");
  const start = "2026-07-16T12:00:00.000Z";
  const bucket = emptyLegacyBucket(start);
  bucket.requests = 2;
  bucket.results.success = 2;
  bucket.usageObservedRequests = 2;
  bucket.inputTokens = 100;
  bucket.outputTokens = 25;
  bucket.durationBins[4] = 2;
  bucket.providers[0].requests = 2;
  bucket.providers[0].successfulRequests = 2;
  bucket.providers[0].usageObservedRequests = 2;
  bucket.providers[0].inputTokens = 100;
  bucket.providers[0].outputTokens = 25;
  bucket.providers[0].durationBins[4] = 2;
  bucket.models[0].requests = 2;
  bucket.models[0].usageObservedRequests = 2;
  bucket.models[0].inputTokens = 100;
  bucket.models[0].outputTokens = 25;
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    bucketMinutes: 60,
    retentionBuckets: 168,
    buckets: [bucket]
  }) + "\n", { mode: 0o600 });
  const store = new MetricsStore({
    path,
    now: () => Date.parse("2026-07-16T12:30:00.000Z"),
    flushDelayMs: 60_000
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const migrated = store.getTokenHeatmap({ window: "12w" });
  assert.deepEqual(migrated.days.at(-1), {
    start: "2026-07-16T00:00:00.000Z",
    requests: 2,
    tokens: { input: 100, output: 25, observedRequests: 2 }
  });
  assert.equal(store.record(observation({ inputTokens: 5, outputTokens: 2 })), true);
  assert.equal(store.flush(), true);
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(Array.isArray(persisted.dailyBuckets), true);
  assert.equal(persisted.dailyBuckets.length, 1);
  assert.deepEqual(persisted.dailyBuckets[0], {
    start: "2026-07-16T00:00:00.000Z",
    requests: 3,
    usageObservedRequests: 3,
    inputTokens: 105,
    outputTokens: 27
  });
});

test("token heatmap prunes daily buckets after 84 UTC days", (t) => {
  const state = harness(t, { timestamp: Date.parse("2026-04-24T00:05:00.000Z") });
  for (let index = 0; index < METRICS_DAILY_RETENTION_DAYS + 1; index += 1) {
    assert.equal(state.store.record(observation({ inputTokens: 1, outputTokens: 1 })), true);
    if (index < METRICS_DAILY_RETENTION_DAYS) state.advance(DAY_MS);
  }
  const heatmap = state.store.getTokenHeatmap({ window: "12w" });
  assert.equal(heatmap.days.length, METRICS_DAILY_RETENTION_DAYS);
  assert.equal(heatmap.days[0].tokens.input, 1);
  assert.equal(heatmap.days.at(-1).tokens.input, 1);
  assert.equal(state.store.dailyBuckets.length, METRICS_DAILY_RETENTION_DAYS);
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
  assert.equal(overview.modelOtherRequests, 1);
  assert.deepEqual(overview.providers.map((provider) => ({
    providerId: provider.providerId,
    requests: provider.requests,
    successfulRequests: provider.successfulRequests
  })), [{ providerId: "provider-a", requests: 2, successfulRequests: 1 }]);
  assert.deepEqual(overview.models.map((model) => ({ model: model.model, requests: model.requests })), [
    { model: "gpt-5-codex", requests: 1 }
  ]);
  assert.equal(
    overview.models.reduce((sum, model) => sum + model.requests, overview.modelOtherRequests),
    overview.summary.requests
  );
  assert.equal(
    overview.providers.reduce((sum, provider) => sum + provider.requests, overview.providerOtherRequests),
    overview.summary.requests
  );

  assert.equal(state.store.flush(), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(state.path).mode & 0o777, 0o600);
  }
  const document = JSON.parse(readFileSync(state.path, "utf8"));
  assert.deepEqual(Object.keys(document).sort(), [
    "bucketMinutes",
    "buckets",
    "dailyBuckets",
    "retentionBuckets",
    "schemaVersion"
  ]);
  assert.equal(document.schemaVersion, 2);
  assert.equal(document.buckets.length, 1);
  assert.equal(document.dailyBuckets.length, 1);

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
  assert.equal(
    overview.models.reduce((sum, model) => sum + model.requests, overview.modelOtherRequests),
    overview.summary.requests
  );
  assert.equal(
    overview.providers.reduce((sum, provider) => sum + provider.requests, overview.providerOtherRequests),
    overview.summary.requests
  );

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

test("late high-volume dimensions replace bounded low-volume groups without losing requests", (t) => {
  const state = harness(t);
  for (let index = 0; index < 64; index += 1) {
    assert.equal(state.store.record(observation({ model: `early-model-${index}` })), true);
  }
  for (let index = 0; index < 40; index += 1) {
    assert.equal(state.store.record(observation({ model: "late-heavy-model" })), true);
  }
  for (let index = 0; index < 32; index += 1) {
    assert.equal(state.store.record(observation({
      providerId: `early-provider-${index}`,
      model: "late-heavy-model"
    })), true);
  }
  for (let index = 0; index < 30; index += 1) {
    assert.equal(state.store.record(observation({
      providerId: "late-heavy-provider",
      model: "late-heavy-model"
    })), true);
  }

  const overview = state.store.getOverview();
  assert.equal(overview.models[0].model, "late-heavy-model");
  assert.equal(overview.models[0].requests, 102);
  assert.equal(overview.providers.some((provider) => (
    provider.providerId === "late-heavy-provider" && provider.requests === 30
  )), true);
  assert.ok(overview.dataQuality.modelOverflowRequests > 0);
  assert.ok(overview.dataQuality.providerOverflowRequests > 0);
  assert.equal(
    overview.models.reduce((sum, model) => sum + model.requests, overview.modelOtherRequests),
    overview.summary.requests
  );
  assert.equal(
    overview.providers.reduce((sum, provider) => sum + provider.requests, overview.providerOtherRequests),
    overview.summary.requests
  );
});

test("hourly windows include the current UTC bucket and exclude the exact outer boundary", (t) => {
  const day = harness(t, { timestamp: Date.parse("2026-07-01T12:00:00.000Z") });
  assert.equal(day.store.record(observation()), true);
  day.advance((24 * HOUR_MS) - 1);
  let overview = day.store.getOverview({ window: "24h" });
  assert.equal(overview.summary.requests, 1);
  assert.equal(overview.series.length, 24);
  assert.equal(overview.series[0].start, "2026-07-01T12:00:00.000Z");
  day.advance(1);
  overview = day.store.getOverview({ window: "24h" });
  assert.equal(overview.summary.requests, 0);
  assert.equal(overview.series[0].start, "2026-07-01T13:00:00.000Z");

  const week = harness(t, { timestamp: Date.parse("2026-07-01T12:00:00.000Z") });
  assert.equal(week.store.record(observation()), true);
  week.advance((168 * HOUR_MS) - 1);
  overview = week.store.getOverview({ window: "7d" });
  assert.equal(overview.summary.requests, 1);
  assert.equal(overview.series.length, 168);
  week.advance(1);
  overview = week.store.getOverview({ window: "7d" });
  assert.equal(overview.summary.requests, 0);
});

test("maximum valid seven-day dimensions fit the metrics storage limit", (t) => {
  const state = harness(t, { timestamp: Date.parse("2026-04-24T00:05:00.000Z") });
  const providerSuffix = "供".repeat(114);
  const modelSuffix = "模".repeat(245);

  for (let day = 0; day < 77; day += 1) {
    assert.equal(state.store.record(observation({ inputTokens: null, outputTokens: null })), true);
    state.advance(DAY_MS);
  }
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
  assert.equal(document.dailyBuckets.length, METRICS_DAILY_RETENTION_DAYS);
  assert.equal(document.buckets.every((bucket) => bucket.providers.length === 32), true);
  assert.equal(document.buckets.every((bucket) => bucket.models.length === 64), true);

  const restored = new MetricsStore({
    path: state.path,
    now: () => Date.parse("2026-07-16T23:05:00.000Z"),
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

test("public distributions conserve a summary capped across valid maximum buckets", (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), "crp-metrics-capped-"));
  const path = join(dir, "metrics.json");
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    bucketMinutes: 60,
    retentionBuckets: 168,
    buckets: [
      saturatedBucket("2026-07-16T11:00:00.000Z", "a"),
      saturatedBucket("2026-07-16T12:00:00.000Z", "b")
    ]
  })}\n`, { mode: 0o600 });
  const store = new MetricsStore({
    path,
    now: () => Date.parse("2026-07-16T12:30:00.000Z"),
    flushDelayMs: 60_000
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const overview = store.getOverview({ window: "24h" });
  assert.equal(overview.summary.requests, MAX_COUNTER);
  assert.ok(overview.dataQuality.droppedObservations > 0);
  assert.equal(
    overview.providers.reduce((sum, provider) => sum + provider.requests, overview.providerOtherRequests),
    overview.summary.requests
  );
  assert.equal(
    overview.models.reduce((sum, model) => sum + model.requests, overview.modelOtherRequests),
    overview.summary.requests
  );
  assert.equal(overview.providers.every((provider) => (
    provider.successfulRequests <= provider.requests
      && provider.tokens.observedRequests <= provider.requests
  )), true);
  assert.equal(overview.models.every((model) => model.tokens.observedRequests <= model.requests), true);
});

test("recording after a saturated bucket preserves its persisted partition invariants", (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), "crp-metrics-saturated-record-"));
  const path = join(dir, "metrics.json");
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    bucketMinutes: 60,
    retentionBuckets: 168,
    buckets: [saturatedBucket("2026-07-16T12:00:00.000Z", "stable")]
  })}\n`, { mode: 0o600 });
  const now = () => Date.parse("2026-07-16T12:30:00.000Z");
  const store = new MetricsStore({ path, now, flushDelayMs: 60_000 });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(store.record(observation({
    providerId: "provider-new",
    model: "model-new",
    result: "upstreamError",
    durationBin: 4
  })), true);
  let overview = store.getOverview({ window: "24h" });
  assert.equal(overview.summary.requests, MAX_COUNTER);
  assert.equal(overview.summary.results.success, MAX_COUNTER);
  assert.equal(overview.summary.results.upstreamError, 0);
  assert.equal(overview.dataQuality.droppedObservations, 1);
  assert.equal(store.flush(), true);
  store.close();

  const restored = new MetricsStore({ path, now, flushDelayMs: 60_000 });
  t.after(() => restored.close());
  overview = restored.getOverview({ window: "24h" });
  assert.equal(overview.storageState, "ready");
  assert.equal(overview.summary.requests, MAX_COUNTER);
  assert.equal(overview.summary.results.success, MAX_COUNTER);
  assert.equal(overview.summary.results.upstreamError, 0);
  assert.equal(overview.dataQuality.droppedObservations, 1);
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
