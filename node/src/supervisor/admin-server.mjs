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
  "generation",
  "httpStatus"
]);

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
    code: typeof result?.code === "string" ? result.code : null
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

function projectBootstrap(result) {
  return {
    changed: result?.changed === true,
    backupCreated: typeof result?.backupPath === "string" && result.backupPath.length > 0
  };
}

function projectDiagnostics(result) {
  return {
    created: result?.created === true,
    generatedAt: typeof result?.generatedAt === "string" ? result.generatedAt : null,
    eventCount: Number.isSafeInteger(result?.eventCount) ? result.eventCount : null
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
  if (action !== null && action !== "test" && action !== "activate") return null;
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
    [`${API_PREFIX}/status`, ["GET"]],
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
  return providerRoute.action === null ? ["GET", "PATCH", "DELETE"] : ["POST"];
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
        allowed: ["model"],
        required: ["model"]
      });
      if (typeof body.model !== "string" || body.model.trim().length === 0) {
        throw bodyError("API_BODY_INVALID");
      }
      const result = await providerService.testProvider(providerRoute.id, body.model);
      sendJson(response, 200, { result: projectTestResult(result) });
      return;
    }
    if (providerRoute?.action === "activate" && request.method === "POST") {
      await requireEmptyBody(request, maxBodyBytes);
      const activation = await providerService.activate(providerRoute.id);
      sendJson(response, 200, { activation: projectActivation(activation) });
      return;
    }
    if (url.pathname === `${API_PREFIX}/proxy/start` && request.method === "POST") {
      await requireEmptyBody(request, maxBodyBytes);
      const worker = await providerService.startProxy();
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
      const worker = await providerService.restartProxy();
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
      const result = await codexService.bootstrap();
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
