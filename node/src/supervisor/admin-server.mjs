import { randomBytes } from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { sanitizeActivityValue } from "./activity-store.mjs";
import { CrpError, toPublicError } from "../shared/errors.mjs";

const API_PREFIX = "/api/v1";
const PUBLIC_PROVIDER_FIELDS = [
  "id",
  "name",
  "baseUrl",
  "authHeader",
  "authScheme",
  "extraHeaders",
  "modelMode",
  "modelOverride",
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
  return provider === null ? null : pick(provider, PUBLIC_PROVIDER_FIELDS);
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
  return {
    proxyHost: typeof settings?.proxyHost === "string" ? settings.proxyHost : null,
    proxyPort: Number.isInteger(settings?.proxyPort) ? settings.proxyPort : null,
    adminHost: typeof settings?.adminHost === "string" ? settings.adminHost : null,
    adminPort: Number.isInteger(settings?.adminPort) ? settings.adminPort : null,
    captureEnabled: settings?.captureEnabled === true,
    credentialBackend: typeof settings?.credentialBackend === "string"
      ? settings.credentialBackend
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

function projectSupervisorState(state) {
  return {
    pid: Number.isSafeInteger(state?.pid) ? state.pid : null,
    startedAt: typeof state?.startedAt === "string" ? state.startedAt : null
  };
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
  if (id.length === 0 || id.length > 128 || /[\\/\u0000-\u001f\u007f]/.test(id)) return null;
  const action = rawParts[1] ?? null;
  if (action !== null && action !== "test" && action !== "activate" && action !== "models") {
    return null;
  }
  return { id, action };
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
    [`${API_PREFIX}/metrics/overview`, ["GET"]],
    [`${API_PREFIX}/providers`, ["GET", "POST"]],
    [`${API_PREFIX}/proxy/start`, ["POST"]],
    [`${API_PREFIX}/proxy/stop`, ["POST"]],
    [`${API_PREFIX}/proxy/restart`, ["POST"]],
    [`${API_PREFIX}/activity`, ["GET"]],
    [`${API_PREFIX}/settings`, ["GET", "PATCH"]],
    [`${API_PREFIX}/codex/bootstrap`, ["POST"]],
    [`${API_PREFIX}/diagnostics/export`, ["POST"]]
  ]);
  if (exact.has(pathname)) return exact.get(pathname);
  const providerRoute = parseProviderRoute(pathname);
  if (!providerRoute) return null;
  if (providerRoute.action === null) return ["GET", "PATCH", "DELETE"];
  return providerRoute.action === "models" ? ["GET", "POST"] : ["POST"];
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
  getSupervisorState = () => ({ pid: process.pid, startedAt: null }),
  uiDir,
  host = "127.0.0.1",
  port = 15101,
  maxBodyBytes = 64 * 1_024,
  createRequestId = () => randomBytes(12).toString("base64url")
} = {}) {
  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 0 || port > 65_535
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1
    || !auth || !providerService) {
    throw new TypeError("Admin server options are invalid.");
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
      const [providerStatus, codexStatus] = await Promise.all([
        providerService.getStatus(),
        codexService?.getStatus?.() ?? { configured: false }
      ]);
      sendJson(response, 200, {
        supervisor: projectSupervisorState(getSupervisorState()),
        ...projectProviderStatus(providerStatus),
        codex: projectCodexState(codexStatus)
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
        allowed: ["captureEnabled"]
      });
      if (Object.keys(patch).length === 0 || typeof patch.captureEnabled !== "boolean") {
        throw bodyError("API_BODY_INVALID");
      }
      throw new CrpError(
        "SETTINGS_READ_ONLY",
        "Local settings are read-only in this version.",
        "Keep the fixed proxy settings and use a supported provider operation.",
        { status: 409 }
      );
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
      });
    }
  };
}
