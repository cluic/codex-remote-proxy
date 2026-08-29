import { test as base, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { join, resolve } from "node:path";

import { createAdminServer } from "../../src/supervisor/admin-server.mjs";
import { projectAccountRoutingState } from "../../src/routing/account-routing.mjs";
import { ProviderScheduler } from "../../src/routing/provider-scheduler.mjs";
import { buildRoutePreview } from "../../src/routing/route-preview.mjs";
import { SessionAuth } from "../../src/supervisor/session-auth.mjs";
import { CrpError } from "../../src/shared/errors.mjs";

const REPO_UI_ROOT = resolve(import.meta.dirname, "../../ui");
const STARTED_AT = "2026-07-13T08:00:00.000Z";
const MODEL_CATALOG_FETCHED_AT = "2026-07-13T08:15:00.000Z";
const MODEL_CATALOG_EXPIRES_AT = "2026-07-14T08:15:00.000Z";
const MAX_METRIC_COUNTER = 1_000_000_000_000;
const MAX_METRIC_TOKENS = 9_000_000_000_000_000;
const METRIC_TEXT_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const METRIC_LATENCY_BOUNDS = new Set([
  50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000
]);
const METRIC_RESULTS = [
  "success",
  "upstreamRejected",
  "upstreamError",
  "timeout",
  "networkError",
  "clientAbort"
];

function emptyMetrics(window = "24h") {
  const bucketCount = window === "24h" ? 24 : 168;
  const currentStart = Date.parse(STARTED_AT);
  return {
    window,
    bucketMinutes: 60,
    storageState: "ready",
    summary: {
      requests: 0,
      results: {
        success: 0,
        upstreamRejected: 0,
        upstreamError: 0,
        timeout: 0,
        networkError: 0,
        clientAbort: 0
      },
      tokens: { input: 0, output: 0, observedRequests: 0 },
      latency: { p50UpperBoundMs: null, p95UpperBoundMs: null, overflowRequests: 0 },
      responseStart: { p50UpperBoundMs: null, p95UpperBoundMs: null, overflowRequests: 0 }
    },
    series: Array.from({ length: bucketCount }, (_, index) => ({
      start: new Date(currentStart - ((bucketCount - 1 - index) * 60 * 60 * 1_000)).toISOString(),
      requests: 0,
      results: {
        success: 0,
        upstreamRejected: 0,
        upstreamError: 0,
        timeout: 0,
        networkError: 0,
        clientAbort: 0
      },
      tokens: { input: 0, output: 0, observedRequests: 0 }
    })),
    providers: [],
    providerOtherRequests: 0,
    models: [],
    modelOtherRequests: 0,
    dataQuality: {
      unknownModelRequests: 0,
      modelOverflowRequests: 0,
      providerOverflowRequests: 0,
      droppedObservations: 0
    }
  };
}

function distributeTotal(total, count) {
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function distributeCapped(total, capacities) {
  const distributed = Array(capacities.length).fill(0);
  let remaining = total;
  for (let index = 0; index < capacities.length && remaining > 0; index += 1) {
    const fairShare = Math.ceil(remaining / (capacities.length - index));
    const amount = Math.min(capacities[index], fairShare);
    distributed[index] = amount;
    remaining -= amount;
  }
  assert.equal(remaining, 0);
  return distributed;
}

function metricSeries(window, summary) {
  const bucketCount = window === "24h" ? 24 : 168;
  const requests = distributeTotal(summary.requests, bucketCount);
  const remaining = [...requests];
  const results = Array.from({ length: bucketCount }, () => ({
    success: 0,
    upstreamRejected: 0,
    upstreamError: 0,
    timeout: 0,
    networkError: 0,
    clientAbort: 0
  }));
  for (const result of ["upstreamRejected", "upstreamError", "timeout", "networkError", "clientAbort"]) {
    const distributed = distributeCapped(summary.results[result], remaining);
    for (let index = 0; index < bucketCount; index += 1) {
      results[index][result] = distributed[index];
      remaining[index] -= distributed[index];
    }
  }
  assert.equal(remaining.reduce((sum, value) => sum + value, 0), summary.results.success);
  const observed = distributeCapped(summary.tokens.observedRequests, requests);
  const input = distributeTotal(summary.tokens.input, bucketCount);
  const output = distributeTotal(summary.tokens.output, bucketCount);
  const currentStart = Date.parse(STARTED_AT);
  return Array.from({ length: bucketCount }, (_, index) => ({
    start: new Date(currentStart - ((bucketCount - 1 - index) * 60 * 60 * 1_000)).toISOString(),
    requests: requests[index],
    results: { ...results[index], success: remaining[index] },
    tokens: {
      input: input[index],
      output: output[index],
      observedRequests: observed[index]
    }
  }));
}

function emptyTokenHeatmap() {
  const dayMs = 24 * 60 * 60 * 1_000;
  const currentDay = Math.floor(Date.parse(STARTED_AT) / dayMs) * dayMs;
  return {
    window: "12w",
    bucketMinutes: 1_440,
    storageState: "ready",
    days: Array.from({ length: 84 }, (_, index) => ({
      start: new Date(currentDay - ((83 - index) * dayMs)).toISOString(),
      requests: 0,
      tokens: { input: 0, output: 0, observedRequests: 0 }
    }))
  };
}

function tokenHeatmapFixture() {
  const heatmap = emptyTokenHeatmap();
  heatmap.days = heatmap.days.map((day, index) => {
    if (index % 9 === 0) return day;
    const requests = index % 5 + 1;
    const observedRequests = index % 13 === 0
      ? 0
      : index % 7 === 0
        ? Math.max(1, requests - 1)
        : requests;
    return {
      ...day,
      requests,
      tokens: {
        input: observedRequests > 0 ? (index + 1) * 1_100 : 0,
        output: observedRequests > 0 ? (index + 1) * 275 : 0,
        observedRequests
      }
    };
  });
  heatmap.days.at(-1).requests = 4;
  heatmap.days.at(-1).tokens = { input: 84_000, output: 21_000, observedRequests: 4 };
  return heatmap;
}

function assertTokenHeatmapFixture(heatmap) {
  assert.equal(heatmap.window, "12w");
  assert.equal(heatmap.bucketMinutes, 1_440);
  assert.ok(["ready", "degraded", "unavailable"].includes(heatmap.storageState));
  assert.equal(heatmap.days.length, 84);
  const dayMs = 24 * 60 * 60 * 1_000;
  const currentDay = Math.floor(Date.parse(STARTED_AT) / dayMs) * dayMs;
  heatmap.days.forEach((day, index) => {
    assert.equal(day.start, new Date(currentDay - ((83 - index) * dayMs)).toISOString());
    assert.ok(Number.isSafeInteger(day.requests) && day.requests >= 0);
    assert.ok(Number.isSafeInteger(day.tokens.input) && day.tokens.input >= 0);
    assert.ok(Number.isSafeInteger(day.tokens.output) && day.tokens.output >= 0);
    assert.ok(Number.isSafeInteger(day.tokens.observedRequests)
      && day.tokens.observedRequests >= 0
      && day.tokens.observedRequests <= day.requests);
    if (day.tokens.observedRequests === 0) {
      assert.equal(day.tokens.input, 0);
      assert.equal(day.tokens.output, 0);
    }
  });
}

function assertUnsaturatedMetricsFixture(metrics, expectedWindow = metrics.window) {
  assert.ok(expectedWindow === "24h" || expectedWindow === "7d", "metrics window must be supported");
  assert.equal(metrics.window, expectedWindow, "metrics payload window must match the requested window");
  assert.equal(metrics.bucketMinutes, 60, "metrics buckets must remain hourly");
  assert.ok(["ready", "degraded", "unavailable"].includes(metrics.storageState),
    "metrics storage state must use the public enum");

  const bucketCount = expectedWindow === "24h" ? 24 : 168;
  assert.equal(metrics.series.length, bucketCount, `${expectedWindow} metrics must contain ${bucketCount} buckets`);

  const assertCounter = (value, label, maximum = MAX_METRIC_COUNTER) => {
    assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= maximum,
      `${label} must be a bounded non-negative safe integer`);
  };
  const assertBoundedText = (value, maximum, label) => {
    assert.ok(typeof value === "string"
      && value.length > 0
      && value.length <= maximum * 2
      && [...value].length <= maximum
      && value.trim() === value
      && !METRIC_TEXT_CONTROL_PATTERN.test(value), `${label} must be bounded safe text`);
  };
  const assertLatency = (value, label) => {
    assert.deepEqual(Object.keys(value).sort(), ["overflowRequests", "p50UpperBoundMs", "p95UpperBoundMs"],
      `${label} must use the exact public latency fields`);
    assert.ok(value.p50UpperBoundMs === null || METRIC_LATENCY_BOUNDS.has(value.p50UpperBoundMs),
      `${label}.p50UpperBoundMs must use a fixed histogram boundary`);
    assert.ok(value.p95UpperBoundMs === null || METRIC_LATENCY_BOUNDS.has(value.p95UpperBoundMs),
      `${label}.p95UpperBoundMs must use a fixed histogram boundary`);
    assertCounter(value.overflowRequests, `${label}.overflowRequests`);
  };
  const resultTotal = (results, label) => METRIC_RESULTS.reduce((total, result) => {
    assertCounter(results[result], `${label}.${result}`);
    return total + results[result];
  }, 0);
  const seriesTotals = {
    requests: 0,
    results: Object.fromEntries(METRIC_RESULTS.map((result) => [result, 0])),
    input: 0,
    output: 0,
    observedRequests: 0
  };
  const currentStart = Date.parse(STARTED_AT);

  metrics.series.forEach((bucket, index) => {
    const expectedStart = new Date(currentStart - ((bucketCount - 1 - index) * 60 * 60 * 1_000)).toISOString();
    assert.equal(bucket.start, expectedStart, `metrics bucket ${index} must use the fixed UTC fixture timeline`);
    assertCounter(bucket.requests, `series[${index}].requests`);
    assert.equal(resultTotal(bucket.results, `series[${index}].results`), bucket.requests,
      `series[${index}] result counts must conserve requests`);
    assertCounter(bucket.tokens.input, `series[${index}].tokens.input`, MAX_METRIC_TOKENS);
    assertCounter(bucket.tokens.output, `series[${index}].tokens.output`, MAX_METRIC_TOKENS);
    assertCounter(bucket.tokens.observedRequests, `series[${index}].tokens.observedRequests`);
    assert.ok(bucket.tokens.observedRequests <= bucket.requests,
      `series[${index}] observed token requests cannot exceed requests`);

    seriesTotals.requests += bucket.requests;
    seriesTotals.input += bucket.tokens.input;
    seriesTotals.output += bucket.tokens.output;
    seriesTotals.observedRequests += bucket.tokens.observedRequests;
    for (const result of METRIC_RESULTS) seriesTotals.results[result] += bucket.results[result];
  });

  assertCounter(metrics.summary.requests, "summary.requests");
  assert.ok(metrics.summary.requests < MAX_METRIC_COUNTER,
    "conserving E2E fixtures must stay below the aggregate counter saturation boundary");
  assert.equal(resultTotal(metrics.summary.results, "summary.results"), metrics.summary.requests,
    "summary result counts must conserve requests");
  assertCounter(metrics.summary.tokens.input, "summary.tokens.input", MAX_METRIC_TOKENS);
  assertCounter(metrics.summary.tokens.output, "summary.tokens.output", MAX_METRIC_TOKENS);
  assert.ok(metrics.summary.tokens.input < MAX_METRIC_TOKENS
    && metrics.summary.tokens.output < MAX_METRIC_TOKENS,
    "conserving E2E fixtures must stay below the aggregate token saturation boundary");
  assertCounter(metrics.summary.tokens.observedRequests, "summary.tokens.observedRequests");
  assert.ok(metrics.summary.tokens.observedRequests <= metrics.summary.requests,
    "summary observed token requests cannot exceed requests");
  assert.equal(seriesTotals.requests, metrics.summary.requests, "series requests must match the summary");
  assert.equal(seriesTotals.input, metrics.summary.tokens.input, "series input tokens must match the summary");
  assert.equal(seriesTotals.output, metrics.summary.tokens.output, "series output tokens must match the summary");
  assert.equal(seriesTotals.observedRequests, metrics.summary.tokens.observedRequests,
    "series observed token requests must match the summary");
  for (const result of METRIC_RESULTS) {
    assert.equal(seriesTotals.results[result], metrics.summary.results[result],
      `series ${result} results must match the summary`);
  }
  assertLatency(metrics.summary.latency, "summary.latency");
  assertLatency(metrics.summary.responseStart, "summary.responseStart");

  const qualityFields = [
    "unknownModelRequests",
    "modelOverflowRequests",
    "providerOverflowRequests",
    "droppedObservations"
  ];
  assert.deepEqual(Object.keys(metrics.dataQuality).sort(), [...qualityFields].sort(),
    "data quality must use the exact public counters");
  for (const field of qualityFields) assertCounter(metrics.dataQuality[field], `dataQuality.${field}`);

  assert.ok(metrics.providers.length <= 16, "public metrics may contain at most 16 Provider rows");
  assert.equal(new Set(metrics.providers.map((provider) => provider.providerId)).size,
    metrics.providers.length, "Provider rows must be unique");
  for (const [index, provider] of metrics.providers.entries()) {
    assertBoundedText(provider.providerId, 128, `providers[${index}].providerId`);
    assertCounter(provider.requests, `providers[${index}].requests`);
    assertCounter(provider.successfulRequests, `providers[${index}].successfulRequests`);
    assert.ok(provider.successfulRequests <= provider.requests,
      `providers[${index}] successful requests cannot exceed requests`);
    assertCounter(provider.tokens.input, `providers[${index}].tokens.input`, MAX_METRIC_TOKENS);
    assertCounter(provider.tokens.output, `providers[${index}].tokens.output`, MAX_METRIC_TOKENS);
    assertCounter(provider.tokens.observedRequests, `providers[${index}].tokens.observedRequests`);
    assert.ok(provider.tokens.observedRequests <= provider.requests,
      `providers[${index}] observed token requests cannot exceed requests`);
    assertLatency(provider.latency, `providers[${index}].latency`);
  }
  assertCounter(metrics.providerOtherRequests, "providerOtherRequests");
  assert.equal(metrics.providers.reduce((total, provider) => total + provider.requests, 0)
    + metrics.providerOtherRequests, metrics.summary.requests,
    "provider distribution must conserve requests");
  assert.ok(metrics.dataQuality.providerOverflowRequests <= metrics.providerOtherRequests,
    "grouped Provider requests must include the Provider overflow remainder");

  assert.ok(metrics.models.length <= 16, "public metrics may contain at most 16 model rows");
  assert.equal(new Set(metrics.models.map((model) => model.model)).size,
    metrics.models.length, "model rows must be unique");
  for (const [index, model] of metrics.models.entries()) {
    assertBoundedText(model.model, 256, `models[${index}].model`);
    assertCounter(model.requests, `models[${index}].requests`);
    assertCounter(model.tokens.input, `models[${index}].tokens.input`, MAX_METRIC_TOKENS);
    assertCounter(model.tokens.output, `models[${index}].tokens.output`, MAX_METRIC_TOKENS);
    assertCounter(model.tokens.observedRequests, `models[${index}].tokens.observedRequests`);
    assert.ok(model.tokens.observedRequests <= model.requests,
      `models[${index}] observed token requests cannot exceed requests`);
  }
  assertCounter(metrics.modelOtherRequests, "modelOtherRequests");
  assert.equal(metrics.models.reduce((total, model) => total + model.requests, 0)
    + metrics.modelOtherRequests, metrics.summary.requests,
    "model distribution must conserve requests");
  assert.ok(Math.min(
    metrics.summary.requests,
    metrics.dataQuality.unknownModelRequests + metrics.dataQuality.modelOverflowRequests
  ) <= metrics.modelOtherRequests, "other models must include unknown and overflow requests");
}

function publicProvider(input = {}, index = 0) {
  const now = `2026-07-13T08:0${index}:00.000Z`;
  return {
    id: input.id ?? `provider-${index + 1}`,
    name: input.name ?? `Provider ${index + 1}`,
    baseUrl: input.baseUrl ?? `https://provider-${index + 1}.example/v1`,
    authHeader: input.authHeader ?? "authorization",
    authScheme: input.authScheme ?? "Bearer",
    extraHeaders: input.extraHeaders ?? {},
    weight: input.weight ?? 100,
    modelMode: input.modelMode ?? "passthrough",
    modelOverride: input.modelOverride ?? null,
    modelMappingGroupId: input.modelMappingGroupId ?? null,
    supportedModelsMode: input.supportedModelsMode ?? "auto",
    supportedModels: structuredClone(input.supportedModels ?? []),
    modelsPath: input.modelsPath ?? "/models",
    customModels: structuredClone(input.customModels ?? []),
    lastTestAt: Object.hasOwn(input, "lastTestAt") ? input.lastTestAt : now,
    lastTestStatus: input.lastTestStatus ?? "passed",
    lastTestCode: Object.hasOwn(input, "lastTestCode") ? input.lastTestCode : null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    credentialConfigured: input.credentialConfigured ?? true
  };
}

function projectFixtureModelCatalog(provider, catalog = {}) {
  const discoveredModels = structuredClone(catalog.models ?? []);
  const configuredModels = structuredClone(provider.supportedModels);
  const customModels = structuredClone(provider.customModels);
  const defaultEnabled = provider.supportedModelsMode === "auto";
  const discovered = new Set(discoveredModels);
  const configured = new Set(configuredModels);
  const custom = new Set(customModels);
  const modelIds = [...new Set([...configuredModels, ...customModels, ...discoveredModels])];
  const entries = modelIds.map((id) => ({
    id,
    discovered: discovered.has(id),
    custom: custom.has(id),
    enabled: configured.has(id) ? !defaultEnabled : defaultEnabled
  }));
  return {
    providerId: provider.id,
    state: catalog.state ?? "missing",
    fetchedAt: Object.hasOwn(catalog, "fetchedAt") ? catalog.fetchedAt : null,
    expiresAt: Object.hasOwn(catalog, "expiresAt") ? catalog.expiresAt : null,
    mode: provider.supportedModelsMode,
    configuredModels,
    modelsPath: provider.modelsPath,
    defaultEnabled,
    customModels,
    discoveredModels,
    entries,
    models: entries.filter((entry) => entry.enabled).map((entry) => entry.id)
  };
}

function stoppedWorker(generation = 0) {
  return {
    phase: "stopped",
    pid: null,
    generation,
    state: null,
    restartCount: 0,
    startedAt: null,
    error: null
  };
}

function createServices({ upstream }) {
  const calls = [];
  const credentials = new Map();
  const modelCatalogs = new Map();
  const state = {
    providers: [],
    modelMappingGroups: [],
    routingRuleGroups: [],
    activeProviderId: null,
    generation: 0,
    worker: stoppedWorker(),
    supervisorPid: 7001,
    supervisorStartedAt: STARTED_AT,
    supervisorShutdownAccepted: false,
    nextWorkerPid: 4201,
    testFailureCode: null,
    nextMutationError: null,
    routingMode: "custom_only",
    proxyHost: "127.0.0.1",
    apiKeyAuthEnabled: false,
    accessKeys: [],
    captureEnabled: true,
    captureDetailsEnabled: false,
    forwardingDetailFailures: new Set(),
    autoStartEnabled: false,
    forwardingRecords: [
      {
        id: 6,
        startedAt: "2026-07-13T08:45:00.000Z",
        completedAt: "2026-07-13T08:45:00.120Z",
        durationMs: 120,
        requestId: "req-fixture-models-6",
        sessionId: null,
        threadId: null,
        method: "GET",
        incomingUrl: "http://127.0.0.1:15100/models",
        targetUrl: "https://fallback.example/v1/models",
        requestBytes: 0,
        responseStatus: 200,
        responseBytes: 2_400,
        stream: false,
        upstreamRequestId: "fallback-models-6",
        inputTokens: null,
        outputTokens: null,
        usageObservationStatus: "not_applicable",
        errorType: null,
        errorMessage: null,
        outcome: "success",
        providerId: "provider-2",
        providerName: "Fallback API",
        route: "custom",
        requestedModel: null,
        forwardedModel: null
      },
      {
        id: 5,
        startedAt: "2026-07-13T08:44:00.000Z",
        completedAt: "2026-07-13T08:44:00.140Z",
        durationMs: 140,
        requestId: "req-fixture-models-5",
        sessionId: null,
        threadId: null,
        method: "GET",
        incomingUrl: "http://127.0.0.1:15100/v1/models?refresh=1",
        targetUrl: "https://fallback.example/v1/models?refresh=1",
        requestBytes: 0,
        responseStatus: 200,
        responseBytes: 2_100,
        stream: false,
        upstreamRequestId: "fallback-models-5",
        inputTokens: null,
        outputTokens: null,
        usageObservationStatus: "not_applicable",
        errorType: null,
        errorMessage: null,
        outcome: "success",
        providerId: "provider-2",
        providerName: "Fallback API",
        route: "custom",
        requestedModel: null,
        forwardedModel: null
      },
      {
        id: 4,
        startedAt: "2026-07-13T08:43:00.000Z",
        completedAt: "2026-07-13T08:43:00.360Z",
        durationMs: 360,
        requestId: "req-fixture-4",
        sessionId: null,
        threadId: "thread-fixture",
        method: "POST",
        incomingUrl: "http://127.0.0.1:15100/responses",
        targetUrl: "https://fallback.example/v1/responses",
        requestBytes: 820,
        responseStatus: 200,
        responseBytes: 1_420,
        stream: true,
        upstreamRequestId: "fallback-upstream-4",
        inputTokens: null,
        outputTokens: null,
        usageObservationStatus: "not_applicable",
        errorType: "proxy_client_abort",
        errorMessage: "Client closed connection",
        outcome: "aborted",
        providerId: "provider-2",
        providerName: "Fallback API",
        route: "custom",
        requestedModel: "gpt-5.6-sol",
        forwardedModel: "vendor/gpt-5.6-sol"
      },
      {
        id: 3,
        startedAt: "2026-07-13T08:42:00.000Z",
        completedAt: "2026-07-13T08:42:01.240Z",
        durationMs: 1_240,
        requestId: "req-fixture-3",
        sessionId: "session-fixture",
        threadId: "thread-fixture",
        method: "POST",
        incomingUrl: "http://127.0.0.1:15100/v1/responses",
        targetUrl: "https://chatgpt.com/backend-api/codex/responses",
        requestBytes: 1_280,
        responseStatus: 200,
        responseBytes: 18_420,
        stream: true,
        upstreamRequestId: "chatgpt-upstream-3",
        inputTokens: 128,
        outputTokens: 42,
        usageObservationStatus: "observed",
        errorType: null,
        errorMessage: null,
        outcome: "success",
        providerId: "chatgpt-account",
        providerName: "ChatGPT",
        route: "account",
        requestedModel: "gpt-5.6-sol",
        forwardedModel: "gpt-5.6-sol"
      },
      {
        id: 2,
        startedAt: "2026-07-13T08:39:00.000Z",
        completedAt: "2026-07-13T08:39:00.420Z",
        durationMs: 420,
        requestId: "req-fixture-2",
        sessionId: null,
        threadId: "thread-fixture",
        method: "POST",
        incomingUrl: "http://127.0.0.1:15100/responses",
        targetUrl: "https://fallback.example/v1/responses",
        requestBytes: 940,
        responseStatus: 429,
        responseBytes: 210,
        stream: false,
        upstreamRequestId: null,
        inputTokens: null,
        outputTokens: null,
        usageObservationStatus: "not_applicable",
        errorType: null,
        errorMessage: null,
        outcome: "rejected",
        providerId: "provider-2",
        providerName: "Fallback API",
        route: "custom",
        requestedModel: "gpt-5.6-luna",
        forwardedModel: "gpt-5.6-luna"
      },
      {
        id: 1,
        startedAt: "2026-07-13T08:35:00.000Z",
        completedAt: "2026-07-13T08:35:00.080Z",
        durationMs: 80,
        requestId: "req-fixture-1",
        sessionId: null,
        threadId: null,
        method: "POST",
        incomingUrl: "http://127.0.0.1:15100/v1/responses",
        targetUrl: "https://fallback.example/v1/responses",
        requestBytes: 760,
        responseStatus: 502,
        responseBytes: 96,
        stream: false,
        upstreamRequestId: null,
        inputTokens: null,
        outputTokens: null,
        usageObservationStatus: "not_applicable",
        errorType: "proxy_upstream_error",
        errorMessage: "connection refused",
        outcome: "error",
        providerId: "provider-2",
        providerName: "Fallback API",
        route: "custom",
        requestedModel: null,
        forwardedModel: null
      }
    ].map((record) => ({
      ...record,
      cachedInputTokens: record.id === 3 ? 64 : null,
      detailsAvailable: record.id === 3 || record.id === 4
    })),
    forwardingRecordDetails: new Map([
      [4, {
        id: 4,
        detailsAvailable: true,
        request: {
          headers: {
            "content-type": "application/json",
            "x-request-id": "req-fixture-4",
            authorization: "[REDACTED]"
          },
          body: {
            content: '{"model":"gpt-5.6-sol","stream":true}',
            encoding: "utf8",
            bytes: 820,
            truncated: false
          }
        },
        response: {
          headers: { "content-type": "text/event-stream" },
          body: {
            content: "event: response.completed\ndata: {\"id\":\"response-fixture-4\"}\n\n",
            encoding: "utf8-truncated",
            bytes: 1_420,
            truncated: true
          }
        }
      }],
      [3, {
        id: 3,
        detailsAvailable: true,
        request: {
          headers: { "content-type": "application/json" },
          body: {
            content: '{"model":"gpt-5.6-sol","input":"hello"}',
            encoding: "utf8",
            bytes: 1_280,
            truncated: false
          }
        },
        response: {
          headers: { "content-type": "application/json" },
          body: {
            content: '{"id":"response-fixture-3","status":"completed"}',
            encoding: "utf8",
            bytes: 18_420,
            truncated: false
          }
        }
      }]
    ]),
    account: {
      phase: "ready",
      authMode: "chatgpt",
      planType: "plus",
      quotaSupported: true,
      quota: {
        status: "available",
        windows: [
          {
            kind: "primary",
            usedPercent: 35,
            remainingPercent: 65,
            windowDurationMins: 300,
            resetsAt: Math.floor(Date.parse("2026-07-13T13:00:00.000Z") / 1_000)
          },
          {
            kind: "secondary",
            usedPercent: 62,
            remainingPercent: 38,
            windowDurationMins: 10_080,
            resetsAt: Math.floor(Date.parse("2026-07-19T08:00:00.000Z") / 1_000)
          }
        ],
        rateLimitReachedType: null,
        spendControlReached: false,
        updatedAt: STARTED_AT
      },
      updatedAt: STARTED_AT,
      errorCode: null
    },
    codex: {
      configured: false,
      modelProvider: null,
      proxyUrl: null,
      historyRepairPending: false
    },
    bootstrapCount: 0,
    activities: [],
    diagnostics: null,
    metrics: emptyMetrics(),
    metricsByWindow: new Map(),
    tokenHeatmap: tokenHeatmapFixture()
  };

  function addActivity(category, action, providerId, result = "success", errorCode = null) {
    state.activities.unshift({
      timestamp: new Date(Date.parse(STARTED_AT) + state.activities.length * 1_000).toISOString(),
      category,
      action,
      providerId,
      result,
      errorCode,
      details: result === "success" ? { generation: state.generation } : {}
    });
  }

  function hotApplyIfRunning() {
    if (state.worker.phase !== "running") return;
    state.generation += 1;
    state.worker.generation = state.generation;
    if (state.worker.state) state.worker.state.generation = state.generation;
  }

  function rejectNextMutation(operation) {
    const failure = state.nextMutationError;
    if (failure === null) return;
    state.nextMutationError = null;
    calls.push({ operation: "mutationRejected", target: operation, code: failure.code });
    throw new CrpError(
      failure.code,
      "Injected fixture mutation failure.",
      "Use the stable error code.",
      { status: failure.status, details: failure.details ?? {} }
    );
  }

  function currentProvider() {
    return state.providers.find((provider) => provider.id === state.activeProviderId) ?? null;
  }

  function buildFixtureRoutePreview(model) {
    const eligible = state.providers
      .filter((provider) => provider.lastTestStatus === "passed" && credentials.has(provider.id))
      .sort((left, right) => {
        if (left.weight !== right.weight) return right.weight - left.weight;
        if (left.id === state.activeProviderId && right.id !== state.activeProviderId) return -1;
        if (right.id === state.activeProviderId && left.id !== state.activeProviderId) return 1;
        const created = left.createdAt.localeCompare(right.createdAt);
        return created === 0 ? left.id.localeCompare(right.id) : created;
      });
    const mappingGroups = new Map(state.modelMappingGroups.map((group) => [group.id, group]));
    const providers = eligible.map((provider) => ({
      id: provider.id,
      name: provider.name,
      weight: provider.weight,
      supportedModels: provider.supportedModelsMode === "auto"
        ? null
        : structuredClone(provider.supportedModels),
      disabledModels: provider.supportedModelsMode === "auto"
        ? structuredClone(provider.supportedModels)
        : [],
      proxy: {
        modelMode: provider.modelMode,
        modelOverride: provider.modelOverride,
        modelMappings: provider.modelMappingGroupId === null
          ? []
          : structuredClone(mappingGroups.get(provider.modelMappingGroupId)?.rules ?? [])
      }
    }));
    const providerIds = new Set(providers.map((provider) => provider.id));
    const activeGroup = state.routingRuleGroups.find((group) => group.active) ?? null;
    const priorityRules = (activeGroup?.rules ?? []).flatMap((rule) => {
      const availableProviderIds = rule.providerIds.filter((providerId) => providerIds.has(providerId));
      return availableProviderIds.length === 0
        ? []
        : rule.models.map((ruleModel) => ({
            model: ruleModel,
            providerIds: structuredClone(availableProviderIds)
          }));
    });
    const running = state.worker.phase === "running" && state.worker.state?.listening === true;
    const preview = buildRoutePreview({
      source: running ? "live" : "configured",
      generation: running ? Math.max(1, state.worker.generation) : 0,
      settings: {
        providers,
        routing: { mode: state.routingMode, providerPriorityRules: priorityRules }
      },
      accountState: projectAccountRoutingState(state.account),
      providerScheduler: new ProviderScheduler({ now: () => Date.parse(STARTED_AT) }),
      nowMs: Date.parse(STARTED_AT),
      model
    });
    const matchedRule = activeGroup?.rules.find((rule) => rule.models.includes(model)) ?? null;
    const profiles = new Map(state.providers.map((provider) => [provider.id, provider]));
    return {
      ...preview,
      routingRule: preview.matchedPriorityRule && activeGroup && matchedRule ? {
        groupId: activeGroup.id,
        groupName: activeGroup.name,
        providerIds: structuredClone(matchedRule.providerIds)
      } : null,
      candidates: preview.candidates.map((candidate) => {
        const profile = profiles.get(candidate.providerId);
        const mappingGroup = candidate.transformation === "mapping"
          && profile?.modelMappingGroupId
          ? mappingGroups.get(profile.modelMappingGroupId) ?? null
          : null;
        return {
          ...candidate,
          mappingGroup: mappingGroup ? { id: mappingGroup.id, name: mappingGroup.name } : null
        };
      })
    };
  }

  const providerService = {
    async listProviders() {
      calls.push({ operation: "listProviders" });
      return structuredClone(state.providers);
    },
    listModelMappingGroups() {
      calls.push({ operation: "listModelMappingGroups" });
      return state.modelMappingGroups.map((group) => ({
        ...structuredClone(group),
        providerIds: state.providers
          .filter((provider) => provider.modelMappingGroupId === group.id)
          .map((provider) => provider.id)
      }));
    },
    async createModelMappingGroup(input) {
      rejectNextMutation("createModelMappingGroup");
      const now = "2026-07-13T08:32:00.000Z";
      const group = {
        id: `mapping-${state.modelMappingGroups.length + 1}`,
        name: input.name,
        rules: structuredClone(input.rules),
        createdAt: now,
        updatedAt: now
      };
      state.modelMappingGroups.push(group);
      calls.push({ operation: "createModelMappingGroup", input: structuredClone(input) });
      addActivity("settings", "model-mapping-create", null);
      return { ...structuredClone(group), providerIds: [] };
    },
    async updateModelMappingGroup(id, input) {
      rejectNextMutation("updateModelMappingGroup");
      const group = state.modelMappingGroups.find((item) => item.id === id);
      if (!group) throw new CrpError("MODEL_MAPPING_NOT_FOUND", "Missing mapping.", "Refresh.", { status: 404 });
      group.name = input.name;
      group.rules = structuredClone(input.rules);
      group.updatedAt = "2026-07-13T08:33:00.000Z";
      calls.push({ operation: "updateModelMappingGroup", id, input: structuredClone(input) });
      addActivity("settings", "model-mapping-update", null);
      return {
        ...structuredClone(group),
        providerIds: state.providers
          .filter((provider) => provider.modelMappingGroupId === id)
          .map((provider) => provider.id)
      };
    },
    async deleteModelMappingGroup(id) {
      rejectNextMutation("deleteModelMappingGroup");
      if (state.providers.some((provider) => provider.modelMappingGroupId === id)) {
        throw new CrpError(
          "MODEL_MAPPING_IN_USE",
          "Mapping group in use.",
          "Remove it from providers.",
          { status: 409 }
        );
      }
      const index = state.modelMappingGroups.findIndex((item) => item.id === id);
      if (index === -1) throw new CrpError("MODEL_MAPPING_NOT_FOUND", "Missing mapping.", "Refresh.", { status: 404 });
      const [group] = state.modelMappingGroups.splice(index, 1);
      calls.push({ operation: "deleteModelMappingGroup", id });
      addActivity("settings", "model-mapping-delete", null);
      return { ...structuredClone(group), providerIds: [] };
    },
    listRoutingRuleGroups() {
      calls.push({ operation: "listRoutingRuleGroups" });
      return structuredClone(state.routingRuleGroups);
    },
    async previewRoute(model) {
      calls.push({ operation: "previewRoute", model });
      return buildFixtureRoutePreview(model);
    },
    async createRoutingRuleGroup(input) {
      rejectNextMutation("createRoutingRuleGroup");
      const now = "2026-07-13T08:34:00.000Z";
      const group = {
        id: `routing-${state.routingRuleGroups.length + 1}`,
        name: input.name,
        rules: structuredClone(input.rules),
        active: false,
        createdAt: now,
        updatedAt: now
      };
      state.routingRuleGroups.push(group);
      calls.push({ operation: "createRoutingRuleGroup", input: structuredClone(input) });
      addActivity("settings", "routing-rule-create", null);
      return structuredClone(group);
    },
    async updateRoutingRuleGroup(id, input) {
      rejectNextMutation("updateRoutingRuleGroup");
      const group = state.routingRuleGroups.find((item) => item.id === id);
      if (!group) throw new CrpError("ROUTING_RULE_GROUP_NOT_FOUND", "Missing routing group.", "Refresh.", { status: 404 });
      group.name = input.name;
      group.rules = structuredClone(input.rules);
      group.updatedAt = "2026-07-13T08:35:00.000Z";
      hotApplyIfRunning();
      calls.push({ operation: "updateRoutingRuleGroup", id, input: structuredClone(input) });
      addActivity("settings", "routing-rule-update", null);
      return structuredClone(group);
    },
    async deleteRoutingRuleGroup(id) {
      rejectNextMutation("deleteRoutingRuleGroup");
      const index = state.routingRuleGroups.findIndex((item) => item.id === id);
      if (index === -1) throw new CrpError("ROUTING_RULE_GROUP_NOT_FOUND", "Missing routing group.", "Refresh.", { status: 404 });
      const [group] = state.routingRuleGroups.splice(index, 1);
      if (group.active) hotApplyIfRunning();
      calls.push({ operation: "deleteRoutingRuleGroup", id });
      addActivity("settings", "routing-rule-delete", null);
      return { ...structuredClone(group), active: false };
    },
    async setActiveRoutingRuleGroup(id) {
      rejectNextMutation("setActiveRoutingRuleGroup");
      if (id !== null && !state.routingRuleGroups.some((group) => group.id === id)) {
        throw new CrpError("ROUTING_RULE_GROUP_NOT_FOUND", "Missing routing group.", "Refresh.", { status: 404 });
      }
      for (const group of state.routingRuleGroups) group.active = group.id === id;
      hotApplyIfRunning();
      calls.push({ operation: "setActiveRoutingRuleGroup", id });
      addActivity("settings", "routing-rule-activate", null);
      return {
        activeRoutingRuleGroupId: id,
        generation: state.generation,
        worker: structuredClone(state.worker)
      };
    },
    async createProvider(input, credential) {
      rejectNextMutation("createProvider");
      assert.equal(typeof credential, "string");
      assert.ok(credential.length > 0);
      calls.push({
        operation: "createProvider",
        input: structuredClone(input),
        credentialLength: credential.length
      });
      const provider = publicProvider({
        ...input,
        id: `provider-${state.providers.length + 1}`,
        lastTestAt: null,
        lastTestStatus: "untested",
        lastTestCode: null
      }, state.providers.length);
      state.providers.push(provider);
      credentials.set(provider.id, credential);
      addActivity("provider", "create", provider.id);
      return structuredClone(provider);
    },
    async updateProvider(id, patch, replacementCredential) {
      rejectNextMutation("updateProvider");
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) throw new CrpError("PROVIDER_NOT_FOUND", "Missing provider.", "Refresh.", { status: 404 });
      if (replacementCredential !== undefined) {
        assert.ok(replacementCredential.length > 0);
        credentials.set(id, replacementCredential);
      }
      calls.push({
        operation: "updateProvider",
        id,
        replacedCredential: replacementCredential !== undefined,
        replacementLength: replacementCredential?.length ?? 0
      });
      const invalidatingFields = [
        "baseUrl",
        "authHeader",
        "authScheme",
        "extraHeaders",
        "modelMode",
        "modelOverride",
        "modelMappingGroupId"
      ];
      const operationalChange = replacementCredential !== undefined
        || invalidatingFields.some((field) => JSON.stringify(provider[field]) !== JSON.stringify(patch[field]));
      if (operationalChange) modelCatalogs.delete(id);
      const preserveTestStatus = state.worker.phase === "running"
        && provider.lastTestStatus === "passed";
      Object.assign(provider, patch, {
        updatedAt: "2026-07-13T08:30:00.000Z",
        ...(!operationalChange || preserveTestStatus ? {} : {
          lastTestAt: null,
          lastTestStatus: "untested",
          lastTestCode: null
        })
      });
      hotApplyIfRunning();
      addActivity("provider", "update", id);
      return structuredClone(provider);
    },
    async setProviderWeight(id, weight) {
      rejectNextMutation("setProviderWeight");
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) throw new CrpError("PROVIDER_NOT_FOUND", "Missing provider.", "Refresh.", { status: 404 });
      assert.ok(Number.isInteger(weight) && weight >= 1 && weight <= 1_000);
      provider.weight = weight;
      provider.updatedAt = "2026-07-13T08:31:00.000Z";
      if (state.worker.phase === "running") {
        state.generation += 1;
        state.worker.generation = state.generation;
        if (state.worker.state) state.worker.state.generation = state.generation;
      }
      calls.push({ operation: "setProviderWeight", id, weight });
      addActivity("provider", "weight", id);
      return structuredClone(provider);
    },
    async deleteProvider(id) {
      rejectNextMutation("deleteProvider");
      if (id === state.activeProviderId) {
        const fallback = state.providers.find((provider) => (
          provider.id !== id && provider.lastTestStatus === "passed"
        ));
        if (state.worker.phase === "running" && !fallback) {
          throw new CrpError(
            "PROVIDER_POOL_EMPTY",
            "The running provider pool cannot be left empty.",
            "Keep one tested provider or stop the proxy.",
            { status: 409 }
          );
        }
        state.activeProviderId = fallback?.id ?? null;
      }
      const index = state.providers.findIndex((provider) => provider.id === id);
      if (index === -1) throw new CrpError("PROVIDER_NOT_FOUND", "Missing provider.", "Refresh.", { status: 404 });
      const [deleted] = state.providers.splice(index, 1);
      credentials.delete(id);
      modelCatalogs.delete(id);
      for (const group of state.routingRuleGroups) {
        group.rules = group.rules.map((rule) => ({
          ...rule,
          providerIds: rule.providerIds.filter((providerId) => providerId !== id)
        })).filter((rule) => rule.providerIds.length > 0);
      }
      hotApplyIfRunning();
      calls.push({ operation: "deleteProvider", id });
      addActivity("provider", "delete", id);
      return structuredClone(deleted);
    },
    async getProviderModels(id) {
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) throw new CrpError("PROVIDER_NOT_FOUND", "Missing provider.", "Refresh.", { status: 404 });
      calls.push({ operation: "getProviderModels", id });
      const catalog = modelCatalogs.get(id) ?? {
        state: "missing",
        fetchedAt: null,
        expiresAt: null,
        models: []
      };
      return structuredClone(projectFixtureModelCatalog(provider, catalog));
    },
    async refreshProviderModels(id) {
      rejectNextMutation("refreshProviderModels");
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) throw new CrpError("PROVIDER_NOT_FOUND", "Missing provider.", "Refresh.", { status: 404 });
      const modelCatalog = {
        state: "fresh",
        fetchedAt: MODEL_CATALOG_FETCHED_AT,
        expiresAt: MODEL_CATALOG_EXPIRES_AT,
        models: ["gpt-5.1-codex-mini", "fixture-model"]
      };
      modelCatalogs.set(id, modelCatalog);
      calls.push({ operation: "refreshProviderModels", id });
      addActivity("provider", "models", id);
      return structuredClone(projectFixtureModelCatalog(provider, modelCatalog));
    },
    async setProviderSupportedModels(id, input) {
      rejectNextMutation("setProviderSupportedModels");
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) throw new CrpError("PROVIDER_NOT_FOUND", "Missing provider.", "Refresh.", { status: 404 });
      const priorModelsPath = provider.modelsPath;
      provider.supportedModelsMode = input.mode;
      provider.supportedModels = structuredClone(input.models);
      provider.modelsPath = input.modelsPath ?? provider.modelsPath;
      provider.customModels = structuredClone(input.customModels ?? provider.customModels);
      provider.updatedAt = "2026-07-13T08:36:00.000Z";
      hotApplyIfRunning();
      if (provider.modelsPath !== priorModelsPath) modelCatalogs.delete(id);
      const current = modelCatalogs.get(id) ?? {
        state: "missing",
        fetchedAt: null,
        expiresAt: null,
        models: []
      };
      modelCatalogs.set(id, current);
      calls.push({ operation: "setProviderSupportedModels", id, input: structuredClone(input) });
      addActivity("provider", "models-update", id);
      return structuredClone(projectFixtureModelCatalog(provider, current));
    },
    async testProvider(id, model, { activateIfNone = false } = {}) {
      assert.ok(model.trim().length > 0);
      assert.equal(typeof activateIfNone, "boolean");
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) throw new CrpError("PROVIDER_NOT_FOUND", "Missing provider.", "Refresh.", { status: 404 });
      if (activateIfNone && state.activeProviderId === null && state.worker.phase !== "stopped") {
        throw new CrpError(
          "PROVIDER_INITIAL_ACTIVATION_UNSAFE",
          "The initial provider cannot be selected while the worker is running.",
          "Stop the worker and try again.",
          { status: 409 }
        );
      }
      calls.push({ operation: "testProvider", id, model, activateIfNone });
      const target = new URL("responses", provider.baseUrl.endsWith("/")
        ? provider.baseUrl
        : `${provider.baseUrl}/`);
      if (target.origin !== upstream.origin) {
        throw new Error(`external provider access blocked: ${target.origin}`);
      }
      const credential = credentials.get(id) ?? "seed-credential";
      upstream.expectRequest({
        path: target.pathname,
        model,
        authHeader: provider.authHeader,
        authScheme: provider.authScheme,
        credential,
        extraHeaders: provider.extraHeaders
      });
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...provider.extraHeaders,
          [provider.authHeader]: provider.authScheme
            ? `${provider.authScheme} ${credential}`
            : credential
        },
        body: JSON.stringify({ model, input: "Reply with OK.", stream: false })
      });
      let responsePayload = null;
      try {
        responsePayload = await response.json();
      } catch {
        responsePayload = null;
      }
      const validResponse = response.ok
        && typeof responsePayload?.id === "string"
        && responsePayload.id.length > 0
        && responsePayload?.object === "response"
        && Array.isArray(responsePayload?.output);
      const code = !response.ok
        ? response.status === 401 || response.status === 403
          ? "PROVIDER_TEST_AUTH"
          : "PROVIDER_TEST_HTTP"
        : validResponse
          ? null
          : "PROVIDER_TEST_INVALID_RESPONSES";
      provider.lastTestAt = "2026-07-13T08:20:00.000Z";
      provider.lastTestStatus = code === null ? "passed" : "failed";
      provider.lastTestCode = code;
      addActivity("provider", "test", id, code === null ? "success" : "failed", code);
      let initialActivation = null;
      if (code === null && activateIfNone && state.activeProviderId === null) {
        state.activeProviderId = id;
        initialActivation = { automatic: true, activeProviderId: id, workerStarted: false };
        addActivity("provider", "activate", id);
      }
      return { ok: code === null, code, initialActivation };
    },
    async activate(id) {
      rejectNextMutation("activate");
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) throw new CrpError("PROVIDER_NOT_FOUND", "Missing provider.", "Refresh.", { status: 404 });
      if (provider.lastTestStatus !== "passed") {
        throw new CrpError(
          "PROVIDER_NOT_READY",
          "Provider is not compatible.",
          "Run a successful compatibility test.",
          { status: 409 }
        );
      }
      state.activeProviderId = id;
      state.generation += 1;
      const workerStarted = state.worker.phase === "stopped";
      if (workerStarted) {
        const pid = state.nextWorkerPid++;
        state.worker = {
          phase: "running",
          pid,
          generation: state.generation,
          state: {
            phase: "running",
            configured: true,
            generation: state.generation,
            listening: true,
            listenHost: "127.0.0.1",
            listenPort: 15100,
            inFlight: 0
          },
          restartCount: 0,
          startedAt: "2026-07-13T08:25:00.000Z",
          error: null
        };
      } else {
        state.worker.generation = state.generation;
        if (state.worker.state) state.worker.state.generation = state.generation;
      }
      calls.push({ operation: "activate", id, generation: state.generation, workerStarted });
      addActivity("provider", "activate", id);
      return {
        activeProviderId: id,
        activeProvider: structuredClone(provider),
        generation: state.generation,
        worker: structuredClone(state.worker)
      };
    },
    async getStatus() {
      calls.push({ operation: "getStatus" });
      return {
        activeProviderId: state.activeProviderId,
        activeProvider: structuredClone(currentProvider()),
        generation: state.generation,
        worker: structuredClone(state.worker)
      };
    },
    async startProxy() {
      rejectNextMutation("startProxy");
      if (!state.activeProviderId) {
        throw new CrpError("PROXY_NOT_CONFIGURED", "No provider.", "Activate a provider.", { status: 409 });
      }
      const pid = state.nextWorkerPid++;
      state.worker = {
        phase: "running",
        pid,
        generation: state.generation,
        state: {
          phase: "running",
          configured: true,
          generation: state.generation,
          listening: true,
          listenHost: "127.0.0.1",
          listenPort: 15100,
          inFlight: 0
        },
        restartCount: state.worker.restartCount ?? 0,
        startedAt: "2026-07-13T08:25:00.000Z",
        error: null
      };
      calls.push({ operation: "startProxy", pid });
      addActivity("proxy", "start", state.activeProviderId);
      return structuredClone(state.worker);
    },
    async stopProxy() {
      rejectNextMutation("stopProxy");
      state.worker = stoppedWorker(state.generation);
      calls.push({ operation: "stopProxy" });
      addActivity("proxy", "stop", state.activeProviderId);
      return structuredClone(state.worker);
    },
    async restartProxy() {
      rejectNextMutation("restartProxy");
      const priorPid = state.worker.pid;
      const inFlight = state.worker.state?.inFlight ?? 0;
      const restartCount = (state.worker.restartCount ?? 0) + 1;
      const pid = state.nextWorkerPid++;
      state.worker = {
        ...state.worker,
        phase: "running",
        pid,
        restartCount,
        startedAt: "2026-07-13T08:40:00.000Z",
        state: {
          ...(state.worker.state ?? {}),
          phase: "running",
          configured: true,
          generation: state.generation,
          listening: true,
          listenHost: "127.0.0.1",
          listenPort: 15100,
          inFlight: 0
        }
      };
      calls.push({ operation: "restartProxy", priorPid, pid, inFlight });
      addActivity("proxy", "restart", state.activeProviderId);
      return structuredClone(state.worker);
    }
  };

  return {
    state,
    calls,
    seedCredential(id, credential) {
      credentials.set(id, credential);
    },
    resetModelCatalogs() {
      modelCatalogs.clear();
    },
    seedModelCatalog(id, input = {}) {
      const provider = state.providers.find((candidate) => candidate.id === id);
      modelCatalogs.set(id, {
        state: input.state ?? "fresh",
        fetchedAt: Object.hasOwn(input, "fetchedAt") ? input.fetchedAt : MODEL_CATALOG_FETCHED_AT,
        expiresAt: Object.hasOwn(input, "expiresAt") ? input.expiresAt : MODEL_CATALOG_EXPIRES_AT,
        models: structuredClone(input.models ?? ["gpt-5.1-codex-mini", "fixture-model"])
      });
      if (provider) {
        provider.supportedModelsMode = input.mode ?? provider.supportedModelsMode;
        provider.supportedModels = structuredClone(
          input.configuredModels ?? provider.supportedModels
        );
        provider.modelsPath = input.modelsPath ?? provider.modelsPath;
        provider.customModels = structuredClone(input.customModels ?? provider.customModels);
      }
    },
    providerService,
    activityStore: {
      async append(event) {
        state.activities.unshift(structuredClone(event));
      },
      list({ limit }) {
        return structuredClone(state.activities.slice(0, limit));
      }
    },
    accessKeyService: {
      list() {
        return structuredClone(state.accessKeys);
      },
      get(id) {
        const key = state.accessKeys.find((candidate) => candidate.id === id);
        if (!key) throw new CrpError("ACCESS_KEY_NOT_FOUND", "API key missing.", "Refresh.", { status: 404 });
        return structuredClone(key);
      },
      create(input) {
        const key = {
          id: `access-key-${state.accessKeys.length + 1}`,
          name: input.name,
          keyHint: `${input.secret.slice(0, 4)}…${input.secret.slice(-4)}`,
          enabled: true,
          expiresAt: input.expiresAt,
          requestLimit: input.requestLimit,
          requestCount: 0,
          createdAt: STARTED_AT,
          updatedAt: STARTED_AT,
          lastUsedAt: null
        };
        state.accessKeys.push(key);
        calls.push({ operation: "createAccessKey", id: key.id, name: key.name });
        return structuredClone(key);
      },
      update(id, patch) {
        const key = state.accessKeys.find((candidate) => candidate.id === id);
        if (!key) throw new CrpError("ACCESS_KEY_NOT_FOUND", "API key missing.", "Refresh.", { status: 404 });
        Object.assign(key, structuredClone(patch), { updatedAt: STARTED_AT });
        calls.push({ operation: "updateAccessKey", id, patch: structuredClone(patch) });
        return structuredClone(key);
      },
      delete(id) {
        const index = state.accessKeys.findIndex((candidate) => candidate.id === id);
        if (index === -1) throw new CrpError("ACCESS_KEY_NOT_FOUND", "API key missing.", "Refresh.", { status: 404 });
        const [key] = state.accessKeys.splice(index, 1);
        calls.push({ operation: "deleteAccessKey", id });
        return structuredClone(key);
      }
    },
    metricsService: {
      getOverview({ window }) {
        calls.push({ operation: "getMetrics", window });
        const configured = state.metricsByWindow.get(window);
        const response = structuredClone(configured ?? state.metrics);
        if (configured === undefined && response.window !== window) {
          response.window = window;
          response.series = metricSeries(window, response.summary);
        }
        assertUnsaturatedMetricsFixture(response, window);
        return response;
      },
      getTokenHeatmap({ window }) {
        calls.push({ operation: "getTokenHeatmap", window });
        const response = structuredClone(state.tokenHeatmap);
        assertTokenHeatmapFixture(response);
        return response;
      }
    },
    forwardingRecordsService: {
      list({ limit, before, outcome, search, includeModels }) {
        calls.push({ operation: "getForwardingRecords", limit, before, outcome, search, includeModels });
        let records = state.forwardingRecords;
        if (!includeModels) {
          records = records.filter((record) => {
            const pathname = new URL(record.incomingUrl, "http://127.0.0.1").pathname;
            return !pathname.endsWith("/models");
          });
        }
        const summaryRecords = records;
        if (before !== null) records = records.filter((record) => record.id < before);
        if (outcome !== "all") records = records.filter((record) => record.outcome === outcome);
        if (search) {
          const query = search.toLowerCase();
          records = records.filter((record) => JSON.stringify(record).toLowerCase().includes(query));
        }
        const page = records.slice(0, limit);
        return {
          storageState: "ready",
          records: structuredClone(page),
          page: { limit, nextBefore: records.length > limit ? page.at(-1)?.id ?? null : null },
          summary: {
            total: summaryRecords.length,
            success: summaryRecords.filter((record) => record.outcome === "success").length,
            rejected: summaryRecords.filter((record) => record.outcome === "rejected").length,
            aborted: summaryRecords.filter((record) => record.outcome === "aborted").length,
            error: summaryRecords.filter((record) => record.outcome === "error").length
          }
        };
      },
      get(id) {
        calls.push({ operation: "getForwardingRecordDetail", id });
        if (state.forwardingDetailFailures.has(id)) {
          throw new CrpError(
            "FORWARDING_RECORD_DETAIL_FAILED",
            "The forwarding detail fixture failed.",
            "Retry the detail request.",
            { status: 503 }
          );
        }
        const record = state.forwardingRecords.find((candidate) => candidate.id === id);
        if (!record) return null;
        const detail = state.forwardingRecordDetails.get(id);
        return detail
          ? structuredClone(detail)
          : { id, detailsAvailable: false };
      }
    },
    requestSupervisorShutdown() {
      calls.push({
        operation: "shutdownSupervisor",
        supervisorPid: state.supervisorPid,
        startedAt: state.supervisorStartedAt
      });
      state.supervisorShutdownAccepted = true;
    },
    settingsService: {
      async getSettings() {
        return {
          proxyHost: state.proxyHost,
          proxyPort: 15100,
          adminHost: "127.0.0.1",
          adminPort: 15101,
          apiKeyAuthEnabled: state.apiKeyAuthEnabled,
          captureEnabled: state.captureEnabled,
          captureDetailsEnabled: state.captureDetailsEnabled,
          routingMode: state.routingMode,
          credentialBackend: "native",
          autoStartSupported: true,
          autoStartEnabled: state.autoStartEnabled,
          autoStartState: state.autoStartEnabled ? "enabled" : "disabled",
          autoStartPlatform: "darwin"
        };
      },
      async updateSettings(patch) {
        rejectNextMutation("updateSettings");
        assert.equal(Object.keys(patch).length, 1);
        if (Object.hasOwn(patch, "routingMode")) {
          assert.ok(patch.routingMode === "custom_only" || patch.routingMode === "account_first");
          state.routingMode = patch.routingMode;
          if (state.worker.phase === "running") {
            state.generation += 1;
            state.worker.generation = state.generation;
            if (state.worker.state) state.worker.state.generation = state.generation;
          }
          calls.push({ operation: "updateRoutingMode", mode: state.routingMode });
          addActivity("settings", "routing-mode", null);
        } else if (Object.hasOwn(patch, "captureEnabled")) {
          assert.equal(typeof patch.captureEnabled, "boolean");
          state.captureEnabled = patch.captureEnabled;
          if (!state.captureEnabled) state.captureDetailsEnabled = false;
          calls.push({ operation: "updateCapture", enabled: state.captureEnabled });
          addActivity("settings", "capture", null);
        } else if (Object.hasOwn(patch, "captureDetailsEnabled")) {
          assert.equal(typeof patch.captureDetailsEnabled, "boolean");
          assert.equal(state.captureEnabled || !patch.captureDetailsEnabled, true);
          state.captureDetailsEnabled = patch.captureDetailsEnabled;
          calls.push({ operation: "updateCaptureDetails", enabled: state.captureDetailsEnabled });
          addActivity("settings", "capture-details", null);
        } else if (Object.hasOwn(patch, "apiKeyAuthEnabled")) {
          assert.equal(typeof patch.apiKeyAuthEnabled, "boolean");
          if (state.proxyHost === "0.0.0.0" && !patch.apiKeyAuthEnabled) {
            throw new CrpError(
              "API_KEY_AUTH_REQUIRED",
              "API key authentication is required.",
              "Use loopback before disabling it.",
              { status: 409 }
            );
          }
          state.apiKeyAuthEnabled = patch.apiKeyAuthEnabled;
          calls.push({ operation: "updateApiKeyAuth", enabled: state.apiKeyAuthEnabled });
          addActivity("settings", "api-key-auth", null);
        } else if (Object.hasOwn(patch, "proxyHost")) {
          assert.ok(patch.proxyHost === "127.0.0.1" || patch.proxyHost === "0.0.0.0");
          if (state.worker.phase === "running") {
            throw new CrpError(
              "PROXY_HOST_UPDATE_FAILED",
              "Stop the Worker first.",
              "Stop the Worker before changing the listen address.",
              { status: 409 }
            );
          }
          state.proxyHost = patch.proxyHost;
          if (state.proxyHost === "0.0.0.0") state.apiKeyAuthEnabled = true;
          calls.push({ operation: "updateProxyHost", host: state.proxyHost });
          addActivity("settings", "proxy-host", null);
        } else {
          assert.equal(typeof patch.autoStartEnabled, "boolean");
          state.autoStartEnabled = patch.autoStartEnabled;
          calls.push({ operation: "updateAutoStart", enabled: state.autoStartEnabled });
          addActivity("settings", "autostart", null);
        }
        return await this.getSettings();
      }
    },
    accountMonitor: {
      getState() {
        return structuredClone(state.account);
      },
      async refresh() {
        state.account.updatedAt = "2026-07-13T08:55:00.000Z";
        if (state.account.quota) state.account.quota.updatedAt = state.account.updatedAt;
        calls.push({ operation: "refreshAccount" });
        return structuredClone(state.account);
      }
    },
    codexService: {
      async bootstrap() {
        state.bootstrapCount += 1;
        state.codex = {
          configured: true,
          modelProvider: "OpenAI",
          proxyUrl: "http://127.0.0.1:15100",
          historyRepairPending: false
        };
        calls.push({ operation: "bootstrap", count: state.bootstrapCount });
        return {
          changed: state.bootstrapCount === 1,
          backupPath: "/sanitized/backup",
          historyRepair: {
            required: false,
            completed: false,
            resumed: false,
            backupCreated: false,
            rolloutFiles: 0,
            rolloutRecords: 0,
            sqliteFiles: 0,
            sqliteRows: 0,
            encryptedContentDetected: false
          }
        };
      },
      async getStatus() {
        return structuredClone(state.codex);
      }
    },
    diagnosticsService: {
      async exportDiagnostics() {
        rejectNextMutation("diagnostics");
        calls.push({ operation: "diagnostics" });
        state.diagnostics = {
          created: true,
          generatedAt: "2026-07-13T08:50:00.000Z",
          eventCount: state.activities.length
        };
        return structuredClone(state.diagnostics);
      }
    }
  };
}

async function proveBackendHealth(origin, controlToken) {
  const session = await fetch(`${origin}/api/v1/session`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${controlToken}`,
      origin
    }
  });
  assert.equal(session.status, 200, "the injected session endpoint must be healthy");
  const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie, "the injected session endpoint must issue a cookie");
  const status = await fetch(`${origin}/api/v1/status`, {
    headers: { cookie, origin }
  });
  assert.equal(status.status, 200, "the injected Admin /api/v1/status must be healthy");
  const payload = await status.json();
  assert.equal(payload.supervisor.pid, 7001);
  return payload;
}

async function createMockUpstream() {
  let status = 200;
  let expectedRequest = null;
  let responsePayload = {
    id: "resp_fixture",
    object: "response",
    status: "completed",
    output: []
  };
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyBytes = Buffer.concat(chunks);
    let body = null;
    try {
      body = JSON.parse(bodyBytes.toString("utf8"));
    } catch {
      body = null;
    }
    const expectation = expectedRequest;
    expectedRequest = null;
    const authHeader = expectation?.authHeader?.toLowerCase() ?? null;
    const expectedAuthorization = expectation
      ? expectation.authScheme
        ? `${expectation.authScheme} ${expectation.credential}`
        : expectation.credential
      : null;
    const credentialMatched = authHeader !== null
      && request.headers[authHeader] === expectedAuthorization;
    const extraHeadersMatched = expectation !== null
      && Object.entries(expectation.extraHeaders ?? {}).every(
        ([name, value]) => request.headers[name.toLowerCase()] === value
      );
    const requestValid = expectation !== null
      && request.method === "POST"
      && request.url === expectation.path
      && request.headers["content-type"] === "application/json"
      && body?.model === expectation.model
      && body?.input === "Reply with OK."
      && body?.stream === false
      && Object.keys(body ?? {}).sort().join(",") === "input,model,stream"
      && credentialMatched
      && extraHeadersMatched;
    const successPayload = structuredClone(responsePayload);
    const responseShapeValid = typeof successPayload?.id === "string"
      && successPayload.id.length > 0
      && successPayload?.object === "response"
      && Array.isArray(successPayload?.output);
    requests.push({
      method: request.method,
      path: request.url,
      contentType: request.headers["content-type"] ?? null,
      model: body?.model ?? null,
      input: body?.input ?? null,
      stream: body?.stream ?? null,
      authHeader: expectation?.authHeader ?? null,
      authScheme: expectation?.authScheme ?? null,
      credentialMatched,
      extraHeadersMatched,
      requestValid,
      responseShapeValid,
      bodyLength: bodyBytes.length
    });
    const responseStatus = requestValid ? status : 400;
    const payload = responseStatus === 200
      ? successPayload
      : { error: { code: "fixture_auth" } };
    const bytes = Buffer.from(JSON.stringify(payload));
    response.writeHead(responseStatus, {
      "content-type": "application/json",
      "content-length": bytes.length
    });
    response.end(bytes);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    expectRequest(next) {
      assert.equal(expectedRequest, null, "the prior upstream expectation must be consumed");
      expectedRequest = structuredClone(next);
    },
    getStatus: () => status,
    setStatus: (next) => { status = next; },
    setResponsePayload: (next) => { responsePayload = structuredClone(next); },
    close: async () => await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise());
    })
  };
}

async function cleanupFixtureResources(resources, { throwOnError = true } = {}) {
  const operations = [
    ["admin", async () => await resources.admin?.close()],
    ["upstream", async () => await resources.upstream?.close()],
    ["session", async () => resources.auth?.close()],
    ["temp", async () => {
      if (resources.tempRoot) rmSync(resources.tempRoot, { recursive: true, force: true });
    }]
  ];
  const settled = await Promise.allSettled(
    operations.map(([, operation]) => Promise.resolve().then(operation))
  );
  const errors = settled.flatMap((result, index) => result.status === "rejected"
    ? [new Error(`${operations[index][0]} cleanup failed`, { cause: result.reason })]
    : []);
  resources.admin = null;
  resources.upstream = null;
  resources.auth = null;
  if (throwOnError && errors.length > 0) throw new AggregateError(errors, "CRP fixture cleanup failed");
  return errors;
}

export async function createFixtureHarness({ failAt = null, onResource = () => {} } = {}) {
  const resources = { tempRoot: null, upstream: null, auth: null, admin: null };
  try {
    resources.tempRoot = mkdtempSync(join(os.tmpdir(), "crp-ui-e2e-"));
    onResource("tempRoot", resources.tempRoot);
    const uiRoot = join(resources.tempRoot, "ui");
    mkdirSync(uiRoot, { recursive: true });
    for (const asset of ["index.html", "styles.css", "app.js"]) {
      copyFileSync(join(REPO_UI_ROOT, asset), join(uiRoot, asset));
    }
    const controlTokenPath = join(resources.tempRoot, "control-token");
    resources.upstream = await createMockUpstream();
    onResource("upstreamOrigin", resources.upstream.origin);
    const credential = `crp-e2e-secret-${randomBytes(18).toString("base64url")}`;
    let nowMs = Date.parse(STARTED_AT);
    resources.auth = new SessionAuth({
      controlTokenPath,
      now: () => nowMs,
      sessionTtlMs: 60 * 60 * 1_000
    });
    const services = createServices({ upstream: resources.upstream });
    resources.admin = createAdminServer({
      auth: resources.auth,
      ...services,
      getSupervisorState: () => ({
        pid: services.state.supervisorPid,
        startedAt: services.state.supervisorStartedAt
      }),
      fetchImpl: async () => new Response(JSON.stringify({
        captureConfigured: services.state.captureEnabled,
        captureDetailsConfigured: services.state.captureDetailsEnabled,
        captureActive: services.state.captureEnabled,
        captureState: services.state.captureEnabled ? "enabled" : "disabled",
        failedWriteCount: 0,
        lastWriteErrorAt: null
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
      uiDir: uiRoot,
      host: "127.0.0.1",
      port: 0
    });
    const address = await resources.admin.listen();
    onResource("adminOrigin", address.origin);
    if (failAt === "after-admin-listen") {
      const error = new Error("controlled fixture setup failure");
      error.code = "FIXTURE_SETUP_INJECTED";
      throw error;
    }
    const controlToken = readFileSync(controlTokenPath, "utf8").trim();
    const backendStatus = await proveBackendHealth(address.origin, controlToken);
    const secrets = new Set([credential, controlToken]);
    const attachmentPaths = new Set();
    const harness = {
      origin: address.origin,
      uiRoot,
      upstreamOrigin: resources.upstream.origin,
      upstreamBaseUrl: `${resources.upstream.origin}/v1`,
      upstreamRequests: resources.upstream.requests,
      credential,
      controlToken,
      backendStatus,
      calls: services.calls,
      state: services.state,
      secrets,
      attachmentPaths,
      collectors: null,
      registerSecret(secret) {
        secrets.add(secret);
        return secret;
      },
      registerAttachment(path) {
        attachmentPaths.add(path);
      },
      fixtureSnapshot() {
        return {
          state: services.state,
          calls: services.calls,
          upstreamRequests: resources.upstream.requests,
          diagnostics: services.state.diagnostics
        };
      },
      failNextMutation({ code, status, details = {} }) {
        services.state.nextMutationError = { code, status, details };
      },
      failForwardingDetail(id) {
        services.state.forwardingDetailFailures.add(id);
      },
      passForwardingDetail(id) {
        services.state.forwardingDetailFailures.delete(id);
      },
      replaceSupervisorIdentity({ pid, startedAt }) {
        services.state.supervisorPid = pid;
        services.state.supervisorStartedAt = startedAt;
      },
      seedProviders({ providers, activeProviderId = null, generation = 4 } = {}) {
        services.resetModelCatalogs();
        services.state.routingRuleGroups = [];
        services.state.providers = providers.map((provider, index) => publicProvider({
          baseUrl: `${resources.upstream.origin}/v1`,
          ...provider
        }, index));
        for (const provider of services.state.providers) {
          if (provider.credentialConfigured) services.seedCredential(provider.id, "seed-credential");
        }
        services.state.activeProviderId = activeProviderId;
        services.state.generation = generation;
        services.state.codex = {
          configured: true,
          modelProvider: "OpenAI",
          proxyUrl: "http://127.0.0.1:15100",
          historyRepairPending: false
        };
        services.state.worker = stoppedWorker(generation);
        if (activeProviderId) {
          services.state.worker = {
            phase: "running",
            pid: services.state.nextWorkerPid++,
            generation,
            state: {
              phase: "running",
              configured: true,
              generation,
              listening: true,
              listenHost: "127.0.0.1",
              listenPort: 15100,
              inFlight: 0
            },
            restartCount: 0,
            startedAt: STARTED_AT,
            error: null
          };
        }
        const primary = services.state.providers[0]?.id ?? "unknown";
        const secondary = services.state.providers[1]?.id ?? null;
        const providerMetrics = [
          {
            providerId: primary,
            requests: secondary ? 82 : 128,
            successfulRequests: secondary ? 78 : 119,
            tokens: {
              input: secondary ? 530000 : 842000,
              output: secondary ? 142000 : 214000,
              observedRequests: secondary ? 64 : 96
            },
            latency: { p50UpperBoundMs: 1000, p95UpperBoundMs: 2500, overflowRequests: 0 }
          },
          ...(secondary ? [{
            providerId: secondary,
            requests: 46,
            successfulRequests: 41,
            tokens: { input: 312000, output: 72000, observedRequests: 32 },
            latency: { p50UpperBoundMs: 1000, p95UpperBoundMs: 5000, overflowRequests: 0 }
          }] : [])
        ];
        const metricsSummary = {
          requests: 128,
          results: {
            success: 119,
            upstreamRejected: 3,
            upstreamError: 2,
            timeout: 1,
            networkError: 1,
            clientAbort: 2
          },
          tokens: { input: 842000, output: 214000, observedRequests: 96 },
          latency: { p50UpperBoundMs: 1000, p95UpperBoundMs: 5000, overflowRequests: 0 },
          responseStart: { p50UpperBoundMs: 250, p95UpperBoundMs: 1000, overflowRequests: 0 }
        };
        services.state.metrics = {
          ...emptyMetrics(),
          summary: metricsSummary,
          series: metricSeries("24h", metricsSummary),
          providers: providerMetrics,
          models: [
            {
              model: "gpt-5.1-codex-mini",
              requests: 88,
              tokens: { input: 588000, output: 151000, observedRequests: 67 }
            },
            {
              model: "gpt-4.1",
              requests: 40,
              tokens: { input: 254000, output: 63000, observedRequests: 29 }
            }
          ]
        };
        assertUnsaturatedMetricsFixture(services.state.metrics);
        services.state.metricsByWindow.clear();
      },
      emptyMetrics(window = "24h") {
        return structuredClone(emptyMetrics(window));
      },
      metricSeries(window, summary) {
        return structuredClone(metricSeries(window, summary));
      },
      emptyTokenHeatmap() {
        return structuredClone(emptyTokenHeatmap());
      },
      setTokenHeatmap(heatmap) {
        const next = structuredClone(heatmap);
        assertTokenHeatmapFixture(next);
        services.state.tokenHeatmap = next;
      },
      setMetrics(metrics, { window = null } = {}) {
        const next = structuredClone(metrics);
        assertUnsaturatedMetricsFixture(next, window ?? next.window);
        if (window === null) {
          services.state.metrics = next;
          services.state.metricsByWindow.clear();
          return;
        }
        assert.ok(window === "24h" || window === "7d", "metrics window must be supported");
        services.state.metricsByWindow.set(window, next);
      },
      seedProviderModels(id, input = {}) {
        assert.ok(services.state.providers.some((provider) => provider.id === id), "provider must exist");
        services.seedModelCatalog(id, input);
      },
      setInFlight(count) {
        assert.ok(services.state.worker.state, "a running worker is required");
        services.state.worker.state.inFlight = count;
      },
      failProviderTestsWith(code) {
        resources.upstream.setStatus(code === "PROVIDER_TEST_AUTH" ? 401 : 503);
      },
      passProviderTests() {
        resources.upstream.setStatus(200);
      },
      setUpstreamResponsePayload(payload) {
        resources.upstream.setResponsePayload(payload);
      },
      setAccount(account) {
        services.state.account = structuredClone(account);
      },
      async rotateBrowserSession(page) {
        return await page.evaluate(async (token) => {
          const response = await fetch("/api/v1/session", {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            credentials: "same-origin"
          });
          const payload = await response.json();
          return {
            status: response.status,
            csrfTokenLength: typeof payload.csrfToken === "string" ? payload.csrfToken.length : 0
          };
        }, controlToken);
      },
      seedActivity(count) {
        const templates = [
          { category: "proxy", action: "start" },
          { category: "provider", action: "test" },
          { category: "settings", action: "capture" },
          { category: "settings", action: "autostart" },
          { category: "migration", action: "provider-registry-schema-4" },
          { category: "provider", action: "weight" },
          { category: "proxy", action: "stop" },
          { category: "proxy", action: "restart" }
        ];
        services.state.activities = Array.from({ length: count }, (_, index) => {
          const template = templates[index % templates.length];
          const result = template.category === "migration"
            ? "failed"
            : ["success", "failed", "degraded"][index % 3];
          const rollbackDegraded = template.category === "migration";
          return {
            timestamp: new Date(Date.parse(STARTED_AT) + index * 1_000).toISOString(),
            ...template,
            providerId: services.state.providers[index % Math.max(1, services.state.providers.length)]?.id ?? null,
            result,
            errorCode: rollbackDegraded
              ? "MIGRATION_ROLLBACK_DEGRADED"
              : result === "success"
              ? null
              : template.category === "provider"
                ? "PROVIDER_TEST_TIMEOUT"
                : `${template.category.toUpperCase()}_${template.action.toUpperCase()}_${result.toUpperCase()}`,
            details: rollbackDegraded ? { index, rollbackDegraded: true } : { index }
          };
        }).reverse();
      },
      expireSession() {
        nowMs += 60 * 60 * 1_000 + 1;
      }
    };
    return {
      harness,
      cleanup: async () => await cleanupFixtureResources(resources)
    };
  } catch (error) {
    const cleanupErrors = await cleanupFixtureResources(resources, { throwOnError: false });
    error.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "CRP fixture setup and cleanup failed");
    }
    throw error;
  }
}

function redactCollectedValue(value, key = "") {
  if (/^(authorization|apiKey|credential|replacementCredential|csrfToken|secret)$/i.test(key)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) return value.map((item) => redactCollectedValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(
      ([childKey, childValue]) => [childKey, redactCollectedValue(childValue, childKey)]
    ));
  }
  return value;
}

function sanitizeCollectedBody(body) {
  if (body === null || body === undefined || body.length === 0) return null;
  try {
    return JSON.stringify(redactCollectedValue(JSON.parse(body)));
  } catch {
    return body;
  }
}

export const test = base.extend({
  crp: async ({}, use) => {
    const fixture = await createFixtureHarness();
    try {
      await use(fixture.harness);
    } finally {
      await fixture.cleanup();
    }
  },
  _secretCollectors: [async ({ page, crp }, use) => {
    const records = [];
    const rawResponses = [];
    const sessionSecrets = new Set();
    const pending = new Set();
    const track = (promise) => {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    };
    const onConsole = (message) => records.push({
      type: "console",
      level: message.type(),
      text: message.text()
    });
    const onPageError = (error) => records.push({ type: "pageerror", text: error.stack ?? error.message });
    const onRequest = (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/v1/")) return;
      records.push({
        type: "request",
        method: request.method(),
        url: `${url.pathname}${url.search}`,
        body: sanitizeCollectedBody(request.postData())
      });
    };
    const onResponse = (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/api/v1/")) return;
      const task = response.body().then((bytes) => {
        const rawBytes = Buffer.from(bytes);
        const allowedSecrets = new Set();
        if ((url.pathname === "/api/v1/session" || url.pathname === "/api/v1/session/resume")
          && response.status() === 200) {
          try {
            const payload = JSON.parse(rawBytes.toString("utf8"));
            if (typeof payload?.csrfToken === "string" && payload.csrfToken.length > 0) {
              allowedSecrets.add(payload.csrfToken);
              sessionSecrets.add(payload.csrfToken);
            }
          } catch {
            // Invalid session JSON is not an expected secret-bearing response.
          }
        }
        rawResponses.push({ bytes: rawBytes, allowedSecrets });
        records.push({
          type: "response",
          status: response.status(),
          url: `${url.pathname}${url.search}`,
          body: sanitizeCollectedBody(rawBytes.toString("utf8"))
        });
      }).catch(() => {
        records.push({ type: "response", status: response.status(), url: url.pathname, body: null });
      });
      track(task);
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("request", onRequest);
    page.on("response", onResponse);
    crp.collectors = {
      records,
      sensitiveSecrets() {
        return [...sessionSecrets];
      },
      hasUnexpectedRawResponseSecret(secret) {
        const bytes = Buffer.from(secret, "utf8");
        return rawResponses.some((response) => (
          !response.allowedSecrets.has(secret) && response.bytes.includes(bytes)
        ));
      },
      async flush() {
        while (pending.size > 0) await Promise.allSettled([...pending]);
      },
      unexpectedClientErrors() {
        return records.filter((record) => record.type === "pageerror" && record.text.trim().length > 0
          || record.type === "console" && record.level === "error"
            && record.text.trim().length > 0
            && !record.text.startsWith("Failed to load resource:"));
      }
    };
    try {
      await use();
    } finally {
      await crp.collectors.flush();
      await assertNoSecrets(page, crp);
      expect(crp.collectors.unexpectedClientErrors()).toEqual([]);
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("request", onRequest);
      page.off("response", onResponse);
    }
  }, { auto: true }]
});

async function endpointReachable(origin) {
  if (!origin) return false;
  try {
    await fetch(origin, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

export async function probeFixtureSetupCleanup() {
  const observed = {};
  let cleanupErrors = [];
  try {
    await createFixtureHarness({
      failAt: "after-admin-listen",
      onResource: (name, value) => { observed[name] = value; }
    });
    assert.fail("the controlled setup failure must throw");
  } catch (error) {
    assert.equal(error.code, "FIXTURE_SETUP_INJECTED");
    cleanupErrors = error.cleanupErrors ?? [];
  }
  return {
    tempRootExists: existsSync(observed.tempRoot),
    adminReachable: await endpointReachable(observed.adminOrigin),
    upstreamReachable: await endpointReachable(observed.upstreamOrigin),
    cleanupErrors: cleanupErrors.length
  };
}

export { expect };

export async function openCrp(page, crp) {
  await page.goto(`${crp.origin}/#token=${crp.controlToken}`);
  await expect(page.locator("html")).toHaveAttribute("aria-busy", "false");
}

export async function assertNoSecrets(page, crp, extra = []) {
  await crp.collectors?.flush();
  const snapshot = await page.locator("html").evaluate(async (element) => {
    const readStorage = (storageName) => {
      try {
        const storage = window[storageName];
        return Object.fromEntries(
          Array.from({ length: storage.length }, (_, index) => {
            const key = storage.key(index);
            return [key, storage.getItem(key)];
          })
        );
      } catch {
        return null;
      }
    };
    let indexedDbNames = null;
    try {
      indexedDbNames = typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map((database) => database.name)
        : [];
    } catch {
      indexedDbNames = null;
    }
    return {
      html: element.outerHTML,
      text: element.textContent,
      inputValues: Array.from(document.querySelectorAll("input, textarea, select"), (input) => input.value),
      localStorage: readStorage("localStorage"),
      sessionStorage: readStorage("sessionStorage"),
      indexedDbNames,
      url: location.href,
      historyState: history.state,
      resources: performance.getEntriesByType("resource").map((entry) => entry.name),
      historyLength: history.length,
      canvasCount: document.querySelectorAll("canvas").length
    };
  });
  const deepSnapshot = {
    browser: snapshot,
    collectors: crp.collectors?.records ?? [],
    fixture: crp.fixtureSnapshot()
  };
  const serialized = JSON.stringify(deepSnapshot);
  const secrets = new Set([
    ...crp.secrets,
    ...extra,
    ...(crp.collectors?.sensitiveSecrets() ?? [])
  ].filter(Boolean));
  if ([...secrets].some((secret) => crp.collectors?.hasUnexpectedRawResponseSecret(secret))) {
    throw new Error("Raw API response contained sensitive data outside the session exchange.");
  }
  for (const secret of secrets) {
    if (!secret) continue;
    if (serialized.includes(secret)) {
      throw new Error("Rendered or recorded state contained sensitive data.");
    }
    for (const attachmentPath of crp.attachmentPaths) {
      if (readFileSync(attachmentPath).includes(Buffer.from(secret))) {
        throw new Error("A test attachment contained sensitive data.");
      }
    }
  }
  if (snapshot.localStorage !== null) {
    expect(Object.keys(snapshot.localStorage).every((key) => key === "crp.locale")).toBe(true);
    expect(Object.keys(snapshot.localStorage).length).toBeLessThanOrEqual(1);
  }
  if (snapshot.sessionStorage !== null) expect(Object.keys(snapshot.sessionStorage)).toHaveLength(0);
  if (snapshot.indexedDbNames !== null) expect(snapshot.indexedDbNames).toHaveLength(0);
  expect(snapshot.canvasCount).toBe(0);
}

export async function assertLayoutIntegrity(page) {
  const result = await page.evaluate(() => {
    const viewport = { width: innerWidth, height: innerHeight };
    const candidates = Array.from(document.querySelectorAll(
      "h1, h2, h3, button, input, select, textarea, label, .setup-eyebrow, "
        + ".page-header > *, .runtime-facts > *, .metric-card, .section-heading > *, "
        + ".overview-command-bar > *, .overview-panel-header > *, .overview-summary-panel > *, "
        + ".provider-card-header > *, .provider-card-actions > *, .activity-event summary > *, "
        + ".setup-progress li, .setup-stage-actions > *, .pagination > *, .topbar-actions > *, "
        + ".modal-footer > *"
    )).filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const sidebar = element.closest(".sidebar");
      return !element.closest(".visually-hidden")
        && !element.closest(".layout-contained-scroll")
        && !element.closest("[hidden]")
        && !element.closest("dialog:not([open])")
        && !(innerWidth <= 840 && sidebar && !sidebar.classList.contains("sidebar-open"))
        && style.visibility !== "hidden" && style.display !== "none"
        && rect.width > 0 && rect.height > 0;
    });
    const clipped = candidates.filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const overflowSensitive = ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)
        || [style.overflowX, style.overflowY].some((value) => value === "hidden" || value === "clip");
      return rect.left < -0.5 || rect.right > viewport.width + 0.5
        || overflowSensitive && (
          element.scrollWidth > element.clientWidth + 1
          || element.scrollHeight > element.clientHeight + 1
        );
    }).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        text: element.textContent.trim().slice(0, 80),
        tag: element.tagName,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        left: Math.round(rect.left),
        right: Math.round(rect.right)
      };
    });
    const overlaps = [];
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
        const left = candidates[leftIndex];
        const right = candidates[rightIndex];
        if (left.contains(right) || right.contains(left) || left.parentElement !== right.parentElement) continue;
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
          overlaps.push(`${left.textContent.trim().slice(0, 40)} <> ${right.textContent.trim().slice(0, 40)}`);
        }
      }
    }
    const overflowSources = Array.from(document.querySelectorAll("body *")).filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const sidebar = element.closest(".sidebar");
      return style.display !== "none" && style.visibility !== "hidden"
        && !element.closest(".visually-hidden")
        && !element.closest(".layout-contained-scroll")
        && !element.closest("dialog:not([open])")
        && !element.closest(".table-scroll")
        && !(innerWidth <= 840 && sidebar && !sidebar.classList.contains("sidebar-open"))
        && rect.width > 0 && (rect.left < -0.5 || rect.right > innerWidth + 0.5);
    }).slice(0, 12).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className : "",
        text: element.textContent.trim().slice(0, 60),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width)
      };
    });
    return {
      documentOverflow: document.documentElement.scrollWidth > innerWidth,
      clipped,
      overlaps,
      overflowSources
    };
  });
  expect(result).toEqual({
    documentOverflow: false,
    clipped: [],
    overlaps: [],
    overflowSources: []
  });
}
