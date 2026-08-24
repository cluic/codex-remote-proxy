import { randomBytes } from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { sanitizeActivityValue } from "./activity-store.mjs";
import { listProviderPresets } from "../providers/provider-presets.mjs";
import { getPublicBuildInfo } from "../shared/build-info.mjs";
import { CrpError, toPublicError } from "../shared/errors.mjs";

const API_PREFIX = "/api/v1";
const PUBLIC_PROVIDER_FIELDS = [
  "id",
  "name",
  "baseUrl",
  "authHeader",
  "authScheme",
  "extraHeaders",
  "weight",
  "modelMode",
  "modelOverride",
  "modelMappingGroupId",
  "supportedModelsMode",
  "supportedModels",
  "lastTestAt",
  "lastTestStatus",
  "lastTestCode",
  "createdAt",
  "updatedAt",
  "credentialConfigured"
];
const PUBLIC_WORKER_FIELDS = [
  "phase",
  "pid",
  "generation",
  "state",
  "restartCount",
  "startedAt",
  "error"
];
const PUBLIC_CHILD_STATE_FIELDS = [
  "phase",
  "configured",
  "generation",
  "listening",
  "listenHost",
  "listenPort",
  "inFlight"
];
const SAFE_ERROR_DETAIL_FIELDS = new Set([
  "field",
  "reason",
  "committed",
  "degraded",
  "pending",
  "generation",
  "httpStatus"
]);
const METRIC_RESULTS = [
  "success",
  "upstreamRejected",
  "upstreamError",
  "timeout",
  "networkError",
  "clientAbort"
];
const METRIC_MAX_COUNT = 1_000_000_000_000;
const METRIC_MAX_TOKEN_TOTAL = 9_000_000_000_000_000;
const METRIC_MAX_LATENCY_MS = 300_000;
const MAX_SUPERVISOR_PID = 4_294_967_295;
const ACCOUNT_PHASES = new Set(["idle", "starting", "ready", "unavailable", "closed"]);
const ACCOUNT_AUTH_MODES = new Set([
  "apikey",
  "chatgpt",
  "chatgptAuthTokens",
  "headers",
  "agentIdentity",
  "personalAccessToken",
  "bedrockApiKey"
]);
const CHATGPT_AUTH_MODES = new Set([
  "chatgpt",
  "chatgptAuthTokens",
  "agentIdentity",
  "personalAccessToken"
]);
const ACCOUNT_QUOTA_STATUSES = new Set(["available", "exhausted", "unknown"]);
const ROUTING_MODES = new Set(["custom_only", "account_first"]);
const PUBLIC_TEXT_PATTERN = /^[^\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]{1,128}$/u;

function apiError(code, message, action, status) {
  return new CrpError(code, message, action, { status });
}

function bodyError(code) {
  const contracts = {
    API_CONTENT_TYPE_UNSUPPORTED: [
      "The request content type is not supported.",
      "Send a UTF-8 application/json request body.",
      415
    ],
    API_BODY_TOO_LARGE: [
      "The request body is too large.",
      "Reduce the request body and try again.",
      413
    ],
    API_BODY_INVALID: [
      "The request body is invalid.",
      "Send only the documented JSON fields and try again.",
      400
    ]
  };
  const [message, action, status] = contracts[code] ?? contracts.API_BODY_INVALID;
  return apiError(code, message, action, status);
}

function codexNotReady() {
  return new CrpError(
    "CODEX_NOT_READY",
    "The Codex configuration is not ready.",
    "Complete Codex bootstrap before activating a provider or starting or restarting the proxy.",
    { status: 409 }
  );
}

function createSerialGate() {
  let tail = Promise.resolve();
  return (operation) => {
    const previous = tail;
    let release;
    tail = new Promise((resolvePromise) => {
      release = resolvePromise;
    });
    return (async () => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    })();
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function exactObject(value, { allowed, required = [] }) {
  if (!isPlainObject(value)
    || Object.keys(value).some((field) => !allowed.includes(field))
    || required.some((field) => !Object.hasOwn(value, field))) {
    throw bodyError("API_BODY_INVALID");
  }
  return value;
}

function assertJsonContentType(contentType) {
  if (typeof contentType !== "string") throw bodyError("API_CONTENT_TYPE_UNSUPPORTED");
  const [mediaType, ...parameters] = contentType.split(";").map((part) => part.trim().toLowerCase());
  if (mediaType !== "application/json"
    || parameters.some((parameter) => parameter !== "charset=utf-8")) {
    throw bodyError("API_CONTENT_TYPE_UNSUPPORTED");
  }
}

async function readJsonBody(request, maxBodyBytes) {
  assertJsonContentType(request.headers["content-type"]);
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    request.resume();
    throw bodyError("API_BODY_TOO_LARGE");
  }
  const chunks = [];
  let length = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBodyBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) throw bodyError("API_BODY_TOO_LARGE");
  if (length === 0) throw bodyError("API_BODY_INVALID");
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    throw bodyError("API_BODY_INVALID");
  }
}

async function requireEmptyBody(request, maxBodyBytes) {
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBodyBytes) throw bodyError("API_BODY_TOO_LARGE");
  }
  if (length !== 0) throw bodyError("API_BODY_INVALID");
}

function setSafeHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    ...extraHeaders
  });
  response.end(bytes);
}

function sendBytes(response, status, bytes, contentType, { head = false } = {}) {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": bytes.length
  });
  response.end(head ? undefined : bytes);
}

function pick(source, fields) {
  const result = {};
  for (const field of fields) {
    if (Object.hasOwn(source ?? {}, field)) result[field] = structuredClone(source[field]);
  }
  return result;
}

function projectProvider(provider) {
  if (provider === null) return null;
  const projected = pick(provider, PUBLIC_PROVIDER_FIELDS);
  projected.weight = Number.isInteger(provider?.weight)
    && provider.weight >= 1
    && provider.weight <= 1_000
    ? provider.weight
    : 100;
  return projected;
}

function projectModelMappingGroup(group) {
  return {
    id: projectMetricText(group?.id, 128),
    name: projectMetricText(group?.name, 100),
    rules: Array.isArray(group?.rules)
      ? group.rules.slice(0, 50).map((rule) => ({
          sourceModel: projectMetricText(rule?.sourceModel, 256),
          targetModel: projectMetricText(rule?.targetModel, 256)
        })).filter((rule) => rule.sourceModel !== null && rule.targetModel !== null)
      : [],
    providerIds: Array.isArray(group?.providerIds)
      ? group.providerIds.slice(0, 100).map((id) => projectMetricText(id, 128)).filter(Boolean)
      : [],
    createdAt: projectMetricTimestamp(group?.createdAt),
    updatedAt: projectMetricTimestamp(group?.updatedAt)
  };
}

function projectRoutingRuleGroup(group) {
  return {
    id: projectMetricText(group?.id, 128),
    name: projectMetricText(group?.name, 100),
    rules: Array.isArray(group?.rules)
      ? group.rules.slice(0, 100).map((rule) => ({
          model: projectMetricText(rule?.model, 256),
          providerIds: Array.isArray(rule?.providerIds)
            ? rule.providerIds.slice(0, 100)
                .map((id) => projectMetricText(id, 128))
                .filter(Boolean)
            : []
        })).filter((rule) => rule.model !== null && rule.providerIds.length > 0)
      : [],
    active: group?.active === true,
    createdAt: projectMetricTimestamp(group?.createdAt),
    updatedAt: projectMetricTimestamp(group?.updatedAt)
  };
}

function projectWorker(worker) {
  if (worker === null || typeof worker !== "object") return null;
  const projected = pick(worker, PUBLIC_WORKER_FIELDS);
  projected.state = worker.state === null ? null : pick(worker.state, PUBLIC_CHILD_STATE_FIELDS);
  if (worker.error !== null && typeof worker.error === "object") {
    projected.error = pick(worker.error, ["code", "message"]);
  }
  return projected;
}

function projectProviderStatus(status) {
  return {
    activeProviderId: status?.activeProviderId ?? null,
    activeProvider: projectProvider(status?.activeProvider ?? null),
    generation: Number.isSafeInteger(status?.generation) ? status.generation : 0,
    worker: projectWorker(status?.worker ?? null)
  };
}

function projectTestResult(result) {
  return {
    ok: result?.ok === true,
    code: typeof result?.code === "string" ? result.code : null,
    initialActivation: projectInitialActivation(result?.initialActivation ?? null)
  };
}

function projectInitialActivation(activation) {
  if (activation === null || typeof activation !== "object") return null;
  return {
    automatic: activation.automatic === true,
    activeProviderId: typeof activation.activeProviderId === "string"
      ? activation.activeProviderId
      : null,
    workerStarted: activation.workerStarted === true
  };
}

function projectModelCatalog(catalog) {
  const state = ["missing", "fresh", "stale"].includes(catalog?.state)
    ? catalog.state
    : "missing";
  return {
    providerId: typeof catalog?.providerId === "string" ? catalog.providerId : null,
    state,
    fetchedAt: typeof catalog?.fetchedAt === "string" ? catalog.fetchedAt : null,
    expiresAt: typeof catalog?.expiresAt === "string" ? catalog.expiresAt : null,
    mode: catalog?.mode === "custom" ? "custom" : "auto",
    configuredModels: Array.isArray(catalog?.configuredModels)
      ? catalog.configuredModels.filter((model) => typeof model === "string").slice(0, 2_000)
      : [],
    models: Array.isArray(catalog?.models)
      ? catalog.models.filter((model) => typeof model === "string").slice(0, 2_000)
      : []
  };
}

function projectActivation(result) {
  return {
    activeProviderId: typeof result?.activeProviderId === "string"
      ? result.activeProviderId
      : null,
    activeProvider: projectProvider(result?.activeProvider ?? null),
    generation: Number.isSafeInteger(result?.generation) ? result.generation : 0,
    worker: projectWorker(result?.worker ?? null)
  };
}

function projectActivityEvent(event) {
  return {
    timestamp: typeof event?.timestamp === "string" ? event.timestamp : null,
    category: typeof event?.category === "string" ? event.category : null,
    action: typeof event?.action === "string" ? event.action : null,
    providerId: typeof event?.providerId === "string" ? event.providerId : null,
    result: typeof event?.result === "string" ? event.result : null,
    errorCode: typeof event?.errorCode === "string" ? event.errorCode : null,
    details: sanitizeActivityValue(event?.details ?? {})
  };
}

function projectSettings(settings) {
  const autoStartStates = new Set(["enabled", "disabled", "stale", "conflict", "unavailable"]);
  return {
    proxyHost: typeof settings?.proxyHost === "string" ? settings.proxyHost : null,
    proxyPort: Number.isInteger(settings?.proxyPort) ? settings.proxyPort : null,
    adminHost: typeof settings?.adminHost === "string" ? settings.adminHost : null,
    adminPort: Number.isInteger(settings?.adminPort) ? settings.adminPort : null,
    captureEnabled: settings?.captureEnabled === true,
    routingMode: ROUTING_MODES.has(settings?.routingMode)
      ? settings.routingMode
      : "custom_only",
    credentialBackend: typeof settings?.credentialBackend === "string"
      ? settings.credentialBackend
      : null,
    autoStartSupported: settings?.autoStartSupported === true,
    autoStartEnabled: settings?.autoStartEnabled === true,
    autoStartState: autoStartStates.has(settings?.autoStartState)
      ? settings.autoStartState
      : "unavailable",
    autoStartPlatform: typeof settings?.autoStartPlatform === "string"
      ? settings.autoStartPlatform
      : null
  };
}

async function projectCaptureState(worker, settings, fetchImpl) {
  const configured = settings?.captureEnabled === true;
  const listening = worker?.phase === "running" && worker?.state?.listening === true;
  if (!listening) {
    return {
      configured,
      workerAvailable: false,
      active: false,
      state: "stopped",
      synchronized: null,
      failedWriteCount: 0,
      lastWriteErrorAt: null
    };
  }
  try {
    const listenPort = Number.isInteger(worker?.state?.listenPort)
      && worker.state.listenPort >= 1 && worker.state.listenPort <= 65_535
      ? worker.state.listenPort
      : 15100;
    const response = await fetchImpl(`http://127.0.0.1:${listenPort}/_proxy/health`, {
      redirect: "manual",
      signal: AbortSignal.timeout(750)
    });
    if (!response?.ok) throw new Error("health unavailable");
    const health = await response.json();
    const runtimeConfigured = health?.captureConfigured === true;
    return {
      configured,
      workerAvailable: true,
      active: health?.captureActive === true,
      state: ["disabled", "enabling", "enabled", "disabling", "error"]
        .includes(health?.captureState) ? health.captureState : "unknown",
      synchronized: runtimeConfigured === configured,
      failedWriteCount: Number.isSafeInteger(health?.failedWriteCount)
        && health.failedWriteCount >= 0 ? health.failedWriteCount : 0,
      lastWriteErrorAt: isIsoTimestamp(health?.lastWriteErrorAt)
        ? health.lastWriteErrorAt : null
    };
  } catch {
    return {
      configured,
      workerAvailable: false,
      active: false,
      state: "unavailable",
      synchronized: null,
      failedWriteCount: 0,
      lastWriteErrorAt: null
    };
  }
}

function projectAccountWindow(window) {
  if (!isPlainObject(window)
    || (window.kind !== "primary" && window.kind !== "secondary")
    || !Number.isSafeInteger(window.usedPercent)
    || window.usedPercent < 0
    || window.usedPercent > 100) {
    return null;
  }
  return {
    kind: window.kind,
    usedPercent: window.usedPercent,
    remainingPercent: 100 - window.usedPercent,
    windowDurationMins: Number.isSafeInteger(window.windowDurationMins)
      && window.windowDurationMins > 0
      && window.windowDurationMins <= 10 * 365 * 24 * 60
      ? window.windowDurationMins
      : null,
    resetsAt: Number.isSafeInteger(window.resetsAt)
      && window.resetsAt >= 0
      && window.resetsAt <= 32_503_680_000
      ? window.resetsAt
      : null
  };
}

function projectAccountState(state) {
  const authMode = ACCOUNT_AUTH_MODES.has(state?.authMode) ? state.authMode : null;
  const quota = isPlainObject(state?.quota)
    && ACCOUNT_QUOTA_STATUSES.has(state.quota.status)
    ? {
        status: state.quota.status,
        windows: Array.isArray(state.quota.windows)
          ? state.quota.windows.map(projectAccountWindow).filter(Boolean).slice(0, 2)
          : [],
        rateLimitReachedType: typeof state.quota.rateLimitReachedType === "string"
          && PUBLIC_TEXT_PATTERN.test(state.quota.rateLimitReachedType)
          ? state.quota.rateLimitReachedType
          : null,
        spendControlReached: typeof state.quota.spendControlReached === "boolean"
          ? state.quota.spendControlReached
          : null,
        updatedAt: isIsoTimestamp(state.quota.updatedAt) ? state.quota.updatedAt : null
      }
    : null;
  return {
    phase: ACCOUNT_PHASES.has(state?.phase) ? state.phase : "unavailable",
    authMode,
    authenticated: authMode === null ? null : CHATGPT_AUTH_MODES.has(authMode),
    planType: typeof state?.planType === "string" && PUBLIC_TEXT_PATTERN.test(state.planType)
      ? state.planType
      : null,
    quotaSupported: typeof state?.quotaSupported === "boolean"
      ? state.quotaSupported
      : null,
    quota,
    updatedAt: isIsoTimestamp(state?.updatedAt) ? state.updatedAt : null,
    errorCode: typeof state?.errorCode === "string"
      && /^[A-Z][A-Z0-9_]{0,63}$/.test(state.errorCode)
      ? state.errorCode
      : null
  };
}

function projectHistoryCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : 0;
}

function projectBootstrap(result) {
  const historyRepair = result?.historyRepair && typeof result.historyRepair === "object"
    ? result.historyRepair
    : {};
  return {
    changed: result?.changed === true,
    backupCreated: typeof result?.backupPath === "string" && result.backupPath.length > 0,
    historyRepair: {
      required: historyRepair.required === true,
      completed: historyRepair.completed === true,
      resumed: historyRepair.resumed === true,
      backupCreated: historyRepair.backupCreated === true,
      rolloutFiles: projectHistoryCount(historyRepair.rolloutFiles),
      rolloutRecords: projectHistoryCount(historyRepair.rolloutRecords),
      sqliteFiles: projectHistoryCount(historyRepair.sqliteFiles),
      sqliteRows: projectHistoryCount(historyRepair.sqliteRows),
      encryptedContentDetected: historyRepair.encryptedContentDetected === true
    }
  };
}

function projectDiagnostics(result) {
  return {
    created: result?.created === true,
    generatedAt: typeof result?.generatedAt === "string" ? result.generatedAt : null,
    eventCount: Number.isSafeInteger(result?.eventCount) ? result.eventCount : null
  };
}

function projectMetricInteger(value, maximum = METRIC_MAX_COUNT) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
}

function projectMetricResults(results) {
  return Object.fromEntries(METRIC_RESULTS.map((result) => (
    [result, projectMetricInteger(results?.[result])]
  )));
}

function projectMetricTokens(tokens) {
  return {
    input: projectMetricInteger(tokens?.input, METRIC_MAX_TOKEN_TOTAL),
    output: projectMetricInteger(tokens?.output, METRIC_MAX_TOKEN_TOTAL),
    observedRequests: projectMetricInteger(tokens?.observedRequests)
  };
}

function projectMetricPercentile(value) {
  return value === null
    ? null
    : (Number.isSafeInteger(value) && value >= 0 && value <= METRIC_MAX_LATENCY_MS ? value : null);
}

function projectMetricLatency(latency) {
  return {
    p50UpperBoundMs: projectMetricPercentile(latency?.p50UpperBoundMs),
    p95UpperBoundMs: projectMetricPercentile(latency?.p95UpperBoundMs),
    overflowRequests: projectMetricInteger(latency?.overflowRequests)
  };
}

function projectMetricText(value, maximum) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum * 2
    && [...value].length <= maximum
    && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    ? value
    : null;
}

function projectMetricTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : null;
}

function projectMetricsOverview(metrics, requestedWindow) {
  const window = requestedWindow;
  const maximumSeries = window === "7d" ? 168 : 24;
  return {
    window,
    bucketMinutes: 60,
    storageState: ["ready", "degraded", "unavailable"].includes(metrics?.storageState)
      ? metrics.storageState
      : "unavailable",
    summary: {
      requests: projectMetricInteger(metrics?.summary?.requests),
      results: projectMetricResults(metrics?.summary?.results),
      tokens: projectMetricTokens(metrics?.summary?.tokens),
      latency: projectMetricLatency(metrics?.summary?.latency),
      responseStart: projectMetricLatency(metrics?.summary?.responseStart)
    },
    series: Array.isArray(metrics?.series)
      ? metrics.series.slice(0, maximumSeries).map((bucket) => ({
        start: projectMetricTimestamp(bucket?.start),
        requests: projectMetricInteger(bucket?.requests),
        results: projectMetricResults(bucket?.results),
        tokens: projectMetricTokens(bucket?.tokens)
      })).filter((bucket) => bucket.start !== null)
      : [],
    providers: Array.isArray(metrics?.providers)
      ? metrics.providers.slice(0, 16).map((provider) => ({
        providerId: projectMetricText(provider?.providerId, 128),
        requests: projectMetricInteger(provider?.requests),
        successfulRequests: projectMetricInteger(provider?.successfulRequests),
        tokens: projectMetricTokens(provider?.tokens),
        latency: projectMetricLatency(provider?.latency)
      })).filter((provider) => provider.providerId !== null)
      : [],
    providerOtherRequests: projectMetricInteger(metrics?.providerOtherRequests),
    models: Array.isArray(metrics?.models)
      ? metrics.models.slice(0, 16).map((model) => ({
        model: projectMetricText(model?.model, 256),
        requests: projectMetricInteger(model?.requests),
        tokens: projectMetricTokens(model?.tokens)
      })).filter((model) => model.model !== null)
      : [],
    modelOtherRequests: projectMetricInteger(metrics?.modelOtherRequests),
    dataQuality: {
      unknownModelRequests: projectMetricInteger(metrics?.dataQuality?.unknownModelRequests),
      modelOverflowRequests: projectMetricInteger(metrics?.dataQuality?.modelOverflowRequests),
      providerOverflowRequests: projectMetricInteger(metrics?.dataQuality?.providerOverflowRequests),
      droppedObservations: projectMetricInteger(metrics?.dataQuality?.droppedObservations)
    }
  };
}

function projectForwardingRecord(record) {
  const id = Number.isSafeInteger(record?.id) && record.id > 0 ? record.id : null;
  const outcome = ["success", "rejected", "aborted", "error"].includes(record?.outcome)
    ? record.outcome
    : "error";
  const route = ["account", "custom", "unknown"].includes(record?.route)
    ? record.route
    : "unknown";
  const boundedCount = (value) => Number.isSafeInteger(value)
    && value >= 0
    && value <= 1_000_000_000_000
    ? value
    : 0;
  const boundedTokenCount = (value) => Number.isSafeInteger(value)
    && value >= 0
    && value <= 100_000_000
    ? value
    : null;
  return {
    id,
    startedAt: projectMetricTimestamp(record?.startedAt),
    completedAt: projectMetricTimestamp(record?.completedAt),
    durationMs: record?.durationMs === null
      ? null
      : (Number.isSafeInteger(record?.durationMs)
          && record.durationMs >= 0
          && record.durationMs <= 30 * 24 * 60 * 60 * 1_000
          ? record.durationMs
          : null),
    requestId: projectMetricText(record?.requestId, 256),
    sessionId: projectMetricText(record?.sessionId, 256),
    threadId: projectMetricText(record?.threadId, 256),
    method: projectMetricText(record?.method, 32),
    incomingUrl: projectMetricText(record?.incomingUrl, 2_048),
    targetUrl: projectMetricText(record?.targetUrl, 2_048),
    requestBytes: boundedCount(record?.requestBytes),
    responseStatus: record?.responseStatus === null
      ? null
      : (Number.isInteger(record?.responseStatus)
          && record.responseStatus >= 100
          && record.responseStatus <= 599
          ? record.responseStatus
          : null),
    responseBytes: boundedCount(record?.responseBytes),
    stream: record?.stream === true,
    upstreamRequestId: projectMetricText(record?.upstreamRequestId, 256),
    inputTokens: boundedTokenCount(record?.inputTokens),
    outputTokens: boundedTokenCount(record?.outputTokens),
    usageObservationStatus: [
      "observed",
      "upstream_unreported",
      "protocol_unrecognized",
      "not_applicable",
      "legacy"
    ].includes(record?.usageObservationStatus) ? record.usageObservationStatus : "legacy",
    errorType: projectMetricText(record?.errorType, 256),
    errorMessage: projectMetricText(record?.errorMessage, 512),
    outcome,
    providerId: projectMetricText(record?.providerId, 256),
    providerName: projectMetricText(record?.providerName, 256),
    route
  };
}

function projectForwardingRecordsPage(result, requestedLimit) {
  const records = Array.isArray(result?.records)
    ? result.records.slice(0, requestedLimit).map(projectForwardingRecord)
      .filter((record) => record.id !== null)
    : [];
  const summaryCount = (value) => Number.isSafeInteger(value)
    && value >= 0
    && value <= METRIC_MAX_COUNT
    ? value
    : 0;
  return {
    storageState: ["missing", "ready"].includes(result?.storageState)
      ? result.storageState
      : "missing",
    records,
    page: {
      limit: requestedLimit,
      nextBefore: Number.isSafeInteger(result?.page?.nextBefore)
        && result.page.nextBefore > 0
        ? result.page.nextBefore
        : null
    },
    summary: {
      total: summaryCount(result?.summary?.total),
      success: summaryCount(result?.summary?.success),
      rejected: summaryCount(result?.summary?.rejected),
      aborted: summaryCount(result?.summary?.aborted),
      error: summaryCount(result?.summary?.error)
    }
  };
}

function projectSupervisorState(state) {
  return {
    pid: Number.isSafeInteger(state?.pid) ? state.pid : null,
    startedAt: typeof state?.startedAt === "string" ? state.startedAt : null
  };
}

function isSupervisorPid(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_SUPERVISOR_PID;
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function projectShutdownAcceptance(state) {
  if (!isSupervisorPid(state?.pid) || !isCanonicalTimestamp(state?.startedAt)) {
    throw new TypeError("Supervisor identity is invalid.");
  }
  return {
    accepted: true,
    supervisorPid: state.pid,
    startedAt: state.startedAt
  };
}

function supervisorIdentityChanged() {
  return new CrpError(
    "SUPERVISOR_IDENTITY_CHANGED",
    "The local supervisor identity changed.",
    "Refresh CRP status and retry against the current supervisor.",
    { status: 409 }
  );
}

function supervisorShutdownUnavailable() {
  return new CrpError(
    "SUPERVISOR_SHUTDOWN_UNAVAILABLE",
    "Supervisor shutdown is unavailable.",
    "Use CRP through the running Supervisor and try again.",
    { status: 503 }
  );
}

function projectCodexState(state) {
  return {
    configured: state?.configured === true,
    historyRepairPending: state?.historyRepairPending === true,
    modelProvider: typeof state?.modelProvider === "string" ? state.modelProvider : null,
    proxyUrl: typeof state?.proxyUrl === "string" ? state.proxyUrl : null
  };
}

function sanitizePublicError(error, requestId) {
  const payload = toPublicError(error, requestId);
  const sanitized = sanitizeActivityValue(payload.error.details);
  const details = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (SAFE_ERROR_DETAIL_FIELDS.has(key) || value === "[REDACTED]") details[key] = value;
  }
  payload.error.details = details;
  return payload;
}

function currentAddress(server, host, configuredPort) {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : configuredPort;
  return {
    host,
    port,
    authority: `${host}:${port}`,
    origin: `http://${host}:${port}`
  };
}

function parseProviderRoute(pathname) {
  const prefix = `${API_PREFIX}/providers/`;
  if (!pathname.startsWith(prefix)) return null;
  const rawParts = pathname.slice(prefix.length).split("/");
  if (rawParts.length < 1 || rawParts.length > 2 || rawParts.some((part) => part.length === 0)) {
    return null;
  }
  let id;
  try {
    id = decodeURIComponent(rawParts[0]);
  } catch {
    return null;
  }
  if (id.length === 0 || id.length > 128 || /[\\/\u0000-\u001f\u007f-\u009f]/.test(id)) return null;
  const action = rawParts[1] ?? null;
  if (action !== null
    && action !== "test"
    && action !== "activate"
    && action !== "models"
    && action !== "weight") {
    return null;
  }
  return { id, action };
}

function parseModelMappingRoute(pathname) {
  const prefix = `${API_PREFIX}/model-mappings/`;
  if (!pathname.startsWith(prefix)) return null;
  const rawId = pathname.slice(prefix.length);
  if (rawId.length === 0 || rawId.includes("/")) return null;
  let id;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (id.length === 0 || id.length > 128 || /[\\/\u0000-\u001f\u007f]/.test(id)) return null;
  return { id };
}

function parseRoutingRuleGroupRoute(pathname) {
  const prefix = `${API_PREFIX}/routing-rule-groups/`;
  if (!pathname.startsWith(prefix)) return null;
  const rawId = pathname.slice(prefix.length);
  if (rawId.length === 0 || rawId.includes("/")) return null;
  let id;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (id.length === 0 || id.length > 128 || /[\\/\u0000-\u001f\u007f]/.test(id)) return null;
  return { id };
}

function providerNotFound() {
  return new CrpError(
    "PROVIDER_NOT_FOUND",
    "The provider does not exist.",
    "Refresh the provider list and try again.",
    { status: 404 }
  );
}

function allowedMethods(pathname) {
  const exact = new Map([
    [`${API_PREFIX}/session`, ["POST"]],
    [`${API_PREFIX}/session/resume`, ["POST"]],
    [`${API_PREFIX}/status`, ["GET"]],
    [`${API_PREFIX}/account/refresh`, ["POST"]],
    [`${API_PREFIX}/metrics/overview`, ["GET"]],
    [`${API_PREFIX}/forwarding-records`, ["GET"]],
    [`${API_PREFIX}/model-mappings`, ["GET", "POST"]],
    [`${API_PREFIX}/provider-presets`, ["GET"]],
    [`${API_PREFIX}/routing-rule-groups`, ["GET", "POST"]],
    [`${API_PREFIX}/routing-rule-groups/active`, ["PATCH"]],
    [`${API_PREFIX}/providers`, ["GET", "POST"]],
    [`${API_PREFIX}/proxy/start`, ["POST"]],
    [`${API_PREFIX}/proxy/stop`, ["POST"]],
    [`${API_PREFIX}/proxy/restart`, ["POST"]],
    [`${API_PREFIX}/supervisor/shutdown`, ["POST"]],
    [`${API_PREFIX}/activity`, ["GET"]],
    [`${API_PREFIX}/settings`, ["GET", "PATCH"]],
    [`${API_PREFIX}/codex/bootstrap`, ["POST"]],
    [`${API_PREFIX}/diagnostics/export`, ["POST"]]
  ]);
  if (exact.has(pathname)) return exact.get(pathname);
  if (parseModelMappingRoute(pathname)) return ["GET", "PATCH", "DELETE"];
  if (parseRoutingRuleGroupRoute(pathname)) return ["GET", "PATCH", "DELETE"];
  const providerRoute = parseProviderRoute(pathname);
  if (!providerRoute) return null;
  if (providerRoute.action === null) return ["GET", "PATCH", "DELETE"];
  if (providerRoute.action === "models") return ["GET", "POST", "PATCH"];
  return providerRoute.action === "weight" ? ["PATCH"] : ["POST"];
}

function positiveQueryInteger(url, name, fallback, { min = 0, max }) {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return fallback;
  if (values.length !== 1 || !/^\d+$/.test(values[0])) {
    throw bodyError("API_BODY_INVALID");
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw bodyError("API_BODY_INVALID");
  }
  return value;
}

function uiAsset(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (/[\\\u0000-\u001f\u007f]/.test(decoded)
    || decoded.split("/").includes("..")) {
    return null;
  }
  const explicit = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/favicon.ico", [null, "image/x-icon"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]]
  ]);
  if (explicit.has(decoded)) return explicit.get(decoded);
  if (extname(decoded) === "") return explicit.get("/");
  return null;
}

export function createAdminServer({
  auth,
  providerService,
  activityStore,
  settingsService,
  codexService,
  diagnosticsService,
  metricsService,
  forwardingRecordsService,
  accountMonitor,
  getSupervisorState = () => ({ pid: process.pid, startedAt: null }),
  requestSupervisorShutdown = null,
  uiDir,
  host = "127.0.0.1",
  port = 15101,
  maxBodyBytes = 64 * 1_024,
  fetchImpl = globalThis.fetch,
  createRequestId = () => randomBytes(12).toString("base64url")
} = {}) {
  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 0 || port > 65_535
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1
    || typeof fetchImpl !== "function"
    || !auth || !providerService || !accountMonitor) {
    throw new TypeError("Admin server options are invalid.");
  }

  if (typeof getSupervisorState !== "function"
    || (requestSupervisorShutdown !== null
      && typeof requestSupervisorShutdown !== "function")) {
    throw new TypeError("Admin shutdown options are invalid.");
  }

  const runCodexExclusive = createSerialGate();
  const runWhenCodexReady = (operation) => runCodexExclusive(async () => {
    if (typeof codexService?.runWhenReady === "function") {
      return await codexService.runWhenReady(operation);
    }
    const status = await codexService?.getStatus?.();
    if (status?.configured !== true || status?.historyRepairPending === true) {
      throw codexNotReady();
    }
    return await operation();
  });
  let shutdownRequestPromise = null;
  const requestShutdownOnce = () => {
    if (shutdownRequestPromise) return shutdownRequestPromise;
    const attempt = Promise.resolve().then(() => requestSupervisorShutdown());
    shutdownRequestPromise = attempt;
    void attempt.catch(() => {
      if (shutdownRequestPromise === attempt) shutdownRequestPromise = null;
    });
    return attempt;
  };
  const scheduleShutdownAfterResponse = (response) => {
    response.once("finish", () => {
      setImmediate(() => {
        void requestShutdownOnce();
      });
    });
  };

  const server = http.createServer((request, response) => {
    setSafeHeaders(response);
    const requestId = createRequestId();
    response.setHeader("x-request-id", requestId);
    void handleRequest(request, response, requestId).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error?.clearCookie === true) response.setHeader("set-cookie", auth.clearCookie());
      const status = error instanceof CrpError ? error.status : 500;
      sendJson(response, status, sanitizePublicError(error, requestId));
    });
  });

  async function handleRequest(request, response, requestId) {
    const address = currentAddress(server, host, port);
    if (request.headers.host !== address.authority) {
      throw apiError(
        "API_HOST_INVALID",
        "The local request host is invalid.",
        "Open CRP through its configured loopback address.",
        403
      );
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== address.origin) {
      throw apiError(
        "API_ORIGIN_INVALID",
        "The local request origin is invalid.",
        "Open CRP through its configured loopback address.",
        403
      );
    }
    if (request.method === "OPTIONS") {
      throw apiError(
        "API_CORS_FORBIDDEN",
        "Cross-origin requests are not allowed.",
        "Use the bundled local CRP UI or CLI.",
        403
      );
    }

    const url = new URL(request.url, address.origin);
    if (url.pathname === `${API_PREFIX}/session`) {
      if (request.method !== "POST") {
        throw apiError(
          "API_METHOD_NOT_ALLOWED",
          "The API method is not allowed.",
          "Use the documented method for this endpoint.",
          405
        );
      }
      await requireEmptyBody(request, maxBodyBytes);
      const session = auth.createBrowserSession(request.headers.authorization);
      sendJson(response, 200, {
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt
      }, { "set-cookie": session.setCookie });
      return;
    }
    if (url.pathname === `${API_PREFIX}/session/resume`) {
      if (request.method !== "POST") {
        throw apiError(
          "API_METHOD_NOT_ALLOWED",
          "The API method is not allowed.",
          "Use the documented method for this endpoint.",
          405
        );
      }
      if (request.url !== `${API_PREFIX}/session/resume`) throw bodyError("API_BODY_INVALID");
      if (origin !== address.origin) {
        throw apiError(
          "API_ORIGIN_INVALID",
          "The local request origin is invalid.",
          "Open CRP through its configured loopback address.",
          403
        );
      }
      if (request.headers["x-crp-session-resume"] !== "1") {
        throw apiError(
          "AUTH_CSRF_INVALID",
          "The request could not be verified.",
          "Refresh the local CRP UI and try again.",
          403
        );
      }
      await requireEmptyBody(request, maxBodyBytes);
      const session = auth.resumeBrowserSession({
        cookie: request.headers.cookie,
        authorization: request.headers.authorization
      });
      sendJson(response, 200, {
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt
      }, { "set-cookie": session.setCookie });
      return;
    }

    const apiNamespace = url.pathname === "/api"
      || url.pathname.startsWith("/api/");
    if (!apiNamespace) {
      const asset = uiAsset(url.pathname);
      if (!asset) {
        throw apiError(
          "UI_NOT_FOUND",
          "The local UI resource was not found.",
          "Open the CRP UI root.",
          404
        );
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");
        throw apiError(
          "API_METHOD_NOT_ALLOWED",
          "The API method is not allowed.",
          "Use GET to load local UI resources.",
          405
        );
      }
      if (typeof uiDir !== "string" || uiDir.length === 0) {
        throw apiError(
          "UI_NOT_FOUND",
          "The local UI resource was not found.",
          "Install the bundled CRP UI files and try again.",
          404
        );
      }
      if (asset[0] === null) {
        sendBytes(response, 204, Buffer.alloc(0), asset[1], { head: true });
        return;
      }
      let bytes;
      try {
        bytes = await readFile(join(uiDir, asset[0]));
      } catch {
        throw apiError(
          "UI_NOT_FOUND",
          "The local UI resource was not found.",
          "Install the bundled CRP UI files and try again.",
          404
        );
      }
      sendBytes(response, 200, bytes, asset[1], { head: request.method === "HEAD" });
      return;
    }
    auth.authorize({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      csrfToken: request.headers["x-crp-csrf"],
      mutation: request.method !== "GET" && request.method !== "HEAD"
    });

    if (url.pathname === `${API_PREFIX}/status` && request.method === "GET") {
      const [providerStatus, codexStatus, settings] = await Promise.all([
        providerService.getStatus(),
        codexService?.getStatus?.() ?? { configured: false },
        settingsService.getSettings()
      ]);
      sendJson(response, 200, {
        build: getPublicBuildInfo(),
        supervisor: projectSupervisorState(getSupervisorState()),
        ...projectProviderStatus(providerStatus),
        codex: projectCodexState(codexStatus),
        account: projectAccountState(accountMonitor.getState()),
        capture: await projectCaptureState(providerStatus?.worker, settings, fetchImpl)
      });
      return;
    }
    if (url.pathname === `${API_PREFIX}/provider-presets` && request.method === "GET") {
      sendJson(response, 200, { providerPresets: listProviderPresets() });
      return;
    }
    if (url.pathname === `${API_PREFIX}/account/refresh` && request.method === "POST") {
      await requireEmptyBody(request, maxBodyBytes);
      sendJson(response, 200, {
        account: projectAccountState(await accountMonitor.refresh())
      });
      return;
    }
    if (url.pathname === `${API_PREFIX}/metrics/overview` && request.method === "GET") {
      for (const key of url.searchParams.keys()) {
        if (key !== "window") throw bodyError("API_BODY_INVALID");
      }
      const values = url.searchParams.getAll("window");
      if (values.length > 1 || (values.length === 1 && !["24h", "7d"].includes(values[0]))) {
        throw bodyError("API_BODY_INVALID");
      }
      const window = values[0] ?? "24h";
      const metrics = await metricsService?.getOverview?.({ window });
      sendJson(response, 200, { metrics: projectMetricsOverview(metrics, window) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/forwarding-records` && request.method === "GET") {
      const allowed = new Set(["limit", "before", "outcome", "search"]);
      for (const key of url.searchParams.keys()) {
        if (!allowed.has(key)) throw bodyError("API_BODY_INVALID");
      }
      const limit = positiveQueryInteger(url, "limit", 50, { min: 1, max: 100 });
      const beforeValues = url.searchParams.getAll("before");
      const before = beforeValues.length === 0
        ? null
        : positiveQueryInteger(url, "before", null, { min: 1, max: Number.MAX_SAFE_INTEGER });
      const outcomeValues = url.searchParams.getAll("outcome");
      if (outcomeValues.length > 1
        || (outcomeValues.length === 1
          && !["all", "success", "rejected", "aborted", "error"].includes(outcomeValues[0]))) {
        throw bodyError("API_BODY_INVALID");
      }
      const searchValues = url.searchParams.getAll("search");
      if (searchValues.length > 1
        || (searchValues.length === 1
          && ([...searchValues[0]].length > 100 || /[\u0000-\u001f\u007f]/.test(searchValues[0])))) {
        throw bodyError("API_BODY_INVALID");
      }
      if (!forwardingRecordsService || typeof forwardingRecordsService.list !== "function") {
        throw new CrpError(
          "FORWARDING_RECORDS_UNAVAILABLE",
          "Forwarding records could not be read.",
          "Verify the Capture database and try again.",
          { status: 503 }
        );
      }
      const result = forwardingRecordsService.list({
        limit,
        before,
        outcome: outcomeValues[0] ?? "all",
        search: searchValues[0] ?? ""
      });
      sendJson(response, 200, projectForwardingRecordsPage(result, limit));
      return;
    }
    if (url.pathname === `${API_PREFIX}/model-mappings` && request.method === "GET") {
      const groups = providerService.listModelMappingGroups();
      sendJson(response, 200, {
        modelMappingGroups: groups.map(projectModelMappingGroup)
      });
      return;
    }
    if (url.pathname === `${API_PREFIX}/model-mappings` && request.method === "POST") {
      const body = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["mappingGroup"],
        required: ["mappingGroup"]
      });
      if (!isPlainObject(body.mappingGroup)) throw bodyError("API_BODY_INVALID");
      const group = await providerService.createModelMappingGroup(body.mappingGroup);
      sendJson(response, 201, { modelMappingGroup: projectModelMappingGroup(group) });
      return;
    }
    const modelMappingRoute = parseModelMappingRoute(url.pathname);
    if (modelMappingRoute && request.method === "GET") {
      const group = providerService.listModelMappingGroups()
        .find((candidate) => candidate.id === modelMappingRoute.id);
      if (!group) {
        throw new CrpError(
          "MODEL_MAPPING_NOT_FOUND",
          "The model mapping group does not exist.",
          "Refresh model mappings and try again.",
          { status: 404 }
        );
      }
      sendJson(response, 200, { modelMappingGroup: projectModelMappingGroup(group) });
      return;
    }
    if (modelMappingRoute && request.method === "PATCH") {
      const body = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["mappingGroup"],
        required: ["mappingGroup"]
      });
      if (!isPlainObject(body.mappingGroup)) throw bodyError("API_BODY_INVALID");
      const group = await providerService.updateModelMappingGroup(
        modelMappingRoute.id,
        body.mappingGroup
      );
      sendJson(response, 200, { modelMappingGroup: projectModelMappingGroup(group) });
      return;
    }
    if (modelMappingRoute && request.method === "DELETE") {
      await requireEmptyBody(request, maxBodyBytes);
      const group = await providerService.deleteModelMappingGroup(modelMappingRoute.id);
      sendJson(response, 200, { modelMappingGroup: projectModelMappingGroup(group) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/routing-rule-groups` && request.method === "GET") {
      const groups = providerService.listRoutingRuleGroups();
      sendJson(response, 200, {
        routingRuleGroups: groups.map(projectRoutingRuleGroup)
      });
      return;
    }
    if (url.pathname === `${API_PREFIX}/routing-rule-groups` && request.method === "POST") {
      const body = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["routingRuleGroup"],
        required: ["routingRuleGroup"]
      });
      if (!isPlainObject(body.routingRuleGroup)) throw bodyError("API_BODY_INVALID");
      const group = await providerService.createRoutingRuleGroup(body.routingRuleGroup);
      sendJson(response, 201, { routingRuleGroup: projectRoutingRuleGroup(group) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/routing-rule-groups/active`
      && request.method === "PATCH") {
      const body = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["id"],
        required: ["id"]
      });
      if (body.id !== null && typeof body.id !== "string") throw bodyError("API_BODY_INVALID");
      const result = await providerService.setActiveRoutingRuleGroup(body.id);
      sendJson(response, 200, {
        activeRoutingRuleGroupId: typeof result.activeRoutingRuleGroupId === "string"
          ? result.activeRoutingRuleGroupId
          : null,
        generation: Number.isSafeInteger(result.generation) ? result.generation : 0,
        worker: projectWorker(result.worker)
      });
      return;
    }
    const routingRuleGroupRoute = parseRoutingRuleGroupRoute(url.pathname);
    if (routingRuleGroupRoute && request.method === "GET") {
      const group = providerService.listRoutingRuleGroups()
        .find((candidate) => candidate.id === routingRuleGroupRoute.id);
      if (!group) {
        throw new CrpError(
          "ROUTING_RULE_GROUP_NOT_FOUND",
          "The routing rule group does not exist.",
          "Refresh routing rules and try again.",
          { status: 404 }
        );
      }
      sendJson(response, 200, { routingRuleGroup: projectRoutingRuleGroup(group) });
      return;
    }
    if (routingRuleGroupRoute && request.method === "PATCH") {
      const body = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["routingRuleGroup"],
        required: ["routingRuleGroup"]
      });
      if (!isPlainObject(body.routingRuleGroup)) throw bodyError("API_BODY_INVALID");
      const group = await providerService.updateRoutingRuleGroup(
        routingRuleGroupRoute.id,
        body.routingRuleGroup
      );
      sendJson(response, 200, { routingRuleGroup: projectRoutingRuleGroup(group) });
      return;
    }
    if (routingRuleGroupRoute && request.method === "DELETE") {
      await requireEmptyBody(request, maxBodyBytes);
      const group = await providerService.deleteRoutingRuleGroup(routingRuleGroupRoute.id);
      sendJson(response, 200, { routingRuleGroup: projectRoutingRuleGroup(group) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/providers` && request.method === "GET") {
      const providers = await providerService.listProviders();
      sendJson(response, 200, { providers: providers.map(projectProvider) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/providers` && request.method === "POST") {
      const body = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["provider", "credential"],
        required: ["provider", "credential"]
      });
      if (!isPlainObject(body.provider)
        || typeof body.credential !== "string" || body.credential.length === 0) {
        throw bodyError("API_BODY_INVALID");
      }
      const provider = await providerService.createProvider(
        body.provider,
        body.credential
      );
      sendJson(response, 201, { provider: projectProvider(provider) });
      return;
    }
    const providerRoute = parseProviderRoute(url.pathname);
    if (providerRoute?.action === null && request.method === "GET") {
      const providers = await providerService.listProviders();
      const provider = providers.find((candidate) => candidate.id === providerRoute.id);
      if (!provider) throw providerNotFound();
      sendJson(response, 200, { provider: projectProvider(provider) });
      return;
    }
    if (providerRoute?.action === null && request.method === "PATCH") {
      const body = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["patch", "replacementCredential"],
        required: ["patch"]
      });
      if (!isPlainObject(body.patch)
        || (body.replacementCredential !== undefined
          && (typeof body.replacementCredential !== "string"
            || body.replacementCredential.length === 0))) {
        throw bodyError("API_BODY_INVALID");
      }
      const provider = await providerService.updateProvider(
        providerRoute.id,
        body.patch,
        body.replacementCredential
      );
      sendJson(response, 200, { provider: projectProvider(provider) });
      return;
    }
    if (providerRoute?.action === null && request.method === "DELETE") {
      await requireEmptyBody(request, maxBodyBytes);
      const provider = await providerService.deleteProvider(providerRoute.id);
      sendJson(response, 200, { provider: projectProvider(provider) });
      return;
    }
    if (providerRoute?.action === "test" && request.method === "POST") {
      const body = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["model", "activateIfNone"],
        required: ["model"]
      });
      if (typeof body.model !== "string" || body.model.trim().length === 0
        || (body.activateIfNone !== undefined && typeof body.activateIfNone !== "boolean")) {
        throw bodyError("API_BODY_INVALID");
      }
      const result = await providerService.testProvider(providerRoute.id, body.model, {
        activateIfNone: body.activateIfNone === true
      });
      sendJson(response, 200, { result: projectTestResult(result) });
      return;
    }
    if (providerRoute?.action === "models" && request.method === "GET") {
      const modelCatalog = await providerService.getProviderModels(providerRoute.id);
      sendJson(response, 200, { modelCatalog: projectModelCatalog(modelCatalog) });
      return;
    }
    if (providerRoute?.action === "models" && request.method === "POST") {
      await requireEmptyBody(request, maxBodyBytes);
      const modelCatalog = await providerService.refreshProviderModels(providerRoute.id);
      sendJson(response, 200, { modelCatalog: projectModelCatalog(modelCatalog) });
      return;
    }
    if (providerRoute?.action === "models" && request.method === "PATCH") {
      const body = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["mode", "models"],
        required: ["mode", "models"]
      });
      if ((body.mode !== "auto" && body.mode !== "custom") || !Array.isArray(body.models)) {
        throw bodyError("API_BODY_INVALID");
      }
      const modelCatalog = await providerService.setProviderSupportedModels(
        providerRoute.id,
        { mode: body.mode, models: body.models }
      );
      sendJson(response, 200, { modelCatalog: projectModelCatalog(modelCatalog) });
      return;
    }
    if (providerRoute?.action === "weight" && request.method === "PATCH") {
      const body = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["weight"],
        required: ["weight"]
      });
      if (!Number.isInteger(body.weight) || body.weight < 1 || body.weight > 1_000) {
        throw bodyError("API_BODY_INVALID");
      }
      const provider = await providerService.setProviderWeight(providerRoute.id, body.weight);
      sendJson(response, 200, { provider: projectProvider(provider) });
      return;
    }
    if (providerRoute?.action === "activate" && request.method === "POST") {
      await requireEmptyBody(request, maxBodyBytes);
      const activation = await runWhenCodexReady(
        () => providerService.activate(providerRoute.id)
      );
      sendJson(response, 200, { activation: projectActivation(activation) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/proxy/start` && request.method === "POST") {
      await requireEmptyBody(request, maxBodyBytes);
      const worker = await runWhenCodexReady(() => providerService.startProxy());
      sendJson(response, 200, { worker: projectWorker(worker) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/proxy/stop` && request.method === "POST") {
      await requireEmptyBody(request, maxBodyBytes);
      const worker = await providerService.stopProxy();
      sendJson(response, 200, { worker: projectWorker(worker) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/proxy/restart` && request.method === "POST") {
      await requireEmptyBody(request, maxBodyBytes);
      const worker = await runWhenCodexReady(() => providerService.restartProxy());
      sendJson(response, 200, { worker: projectWorker(worker) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/supervisor/shutdown` && request.method === "POST") {
      if (request.url !== `${API_PREFIX}/supervisor/shutdown`) {
        throw bodyError("API_BODY_INVALID");
      }
      const body = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["supervisorPid", "startedAt"],
        required: ["supervisorPid", "startedAt"]
      });
      if (!isSupervisorPid(body.supervisorPid) || !isCanonicalTimestamp(body.startedAt)) {
        throw bodyError("API_BODY_INVALID");
      }
      const current = getSupervisorState();
      if (body.supervisorPid !== current?.pid || body.startedAt !== current?.startedAt) {
        throw supervisorIdentityChanged();
      }
      if (typeof requestSupervisorShutdown !== "function") {
        throw supervisorShutdownUnavailable();
      }
      const shutdown = projectShutdownAcceptance(current);
      scheduleShutdownAfterResponse(response);
      sendJson(response, 202, { shutdown });
      return;
    }
    if (url.pathname === `${API_PREFIX}/activity` && request.method === "GET") {
      for (const key of url.searchParams.keys()) {
        if (key !== "limit" && key !== "offset") throw bodyError("API_BODY_INVALID");
      }
      const limit = positiveQueryInteger(url, "limit", 50, { min: 1, max: 100 });
      const offset = positiveQueryInteger(url, "offset", 0, { min: 0, max: 9_999 });
      const events = activityStore.list({ limit: Math.min(10_000, offset + limit + 1) });
      const page = events.slice(offset, offset + limit).map(projectActivityEvent);
      sendJson(response, 200, {
        events: page,
        page: {
          limit,
          offset,
          nextOffset: events.length > offset + limit ? offset + limit : null
        }
      });
      return;
    }
    if (url.pathname === `${API_PREFIX}/settings` && request.method === "GET") {
      sendJson(response, 200, { settings: projectSettings(await settingsService.getSettings()) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/settings` && request.method === "PATCH") {
      const patch = exactObject(await readJsonBody(request, maxBodyBytes), {
        allowed: ["autoStartEnabled", "captureEnabled", "routingMode"]
      });
      if (Object.keys(patch).length !== 1) {
        throw bodyError("API_BODY_INVALID");
      }
      if (Object.hasOwn(patch, "routingMode")) {
        if (!ROUTING_MODES.has(patch.routingMode)) throw bodyError("API_BODY_INVALID");
        sendJson(response, 200, {
          settings: projectSettings(await settingsService.updateSettings(patch))
        });
        return;
      }
      const booleanValue = Object.hasOwn(patch, "captureEnabled")
        ? patch.captureEnabled
        : patch.autoStartEnabled;
      if (typeof booleanValue !== "boolean") throw bodyError("API_BODY_INVALID");
      sendJson(response, 200, {
        settings: projectSettings(await settingsService.updateSettings(patch))
      });
      return;
    }
    if (url.pathname === `${API_PREFIX}/codex/bootstrap` && request.method === "POST") {
      await requireEmptyBody(request, maxBodyBytes);
      const result = await runCodexExclusive(() => codexService.bootstrap());
      sendJson(response, 200, { result: projectBootstrap(result) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/diagnostics/export` && request.method === "POST") {
      await requireEmptyBody(request, maxBodyBytes);
      const result = await diagnosticsService.exportDiagnostics();
      sendJson(response, 200, { diagnostics: projectDiagnostics(result) });
      return;
    }
    const methods = allowedMethods(url.pathname);
    if (methods) {
      response.setHeader("allow", methods.join(", "));
      throw apiError(
        "API_METHOD_NOT_ALLOWED",
        "The API method is not allowed.",
        "Use the documented method for this endpoint.",
        405
      );
    }
    throw apiError(
      "API_NOT_FOUND",
      "The API endpoint was not found.",
      "Use a documented local API endpoint.",
      404
    );
  }

  return {
    server,
    async listen() {
      if (!server.listening) {
        await new Promise((resolvePromise, rejectPromise) => {
          server.once("error", rejectPromise);
          server.listen(port, host, () => {
            server.off("error", rejectPromise);
            resolvePromise();
          });
        });
      }
      return currentAddress(server, host, port);
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) rejectPromise(error);
          else resolvePromise();
        });
        server.closeAllConnections?.();
      });
    }
  };
}
