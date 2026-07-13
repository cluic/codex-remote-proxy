import { test as base, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { join, resolve } from "node:path";

import { createAdminServer } from "../../src/supervisor/admin-server.mjs";
import { SessionAuth } from "../../src/supervisor/session-auth.mjs";
import { CrpError } from "../../src/shared/errors.mjs";

const REPO_UI_ROOT = resolve(import.meta.dirname, "../../ui");
const STARTED_AT = "2026-07-13T08:00:00.000Z";

function publicProvider(input = {}, index = 0) {
  const now = `2026-07-13T08:0${index}:00.000Z`;
  return {
    id: input.id ?? `provider-${index + 1}`,
    name: input.name ?? `Provider ${index + 1}`,
    baseUrl: input.baseUrl ?? `https://provider-${index + 1}.example/v1`,
    authHeader: input.authHeader ?? "authorization",
    authScheme: input.authScheme ?? "Bearer",
    extraHeaders: input.extraHeaders ?? {},
    modelMode: input.modelMode ?? "passthrough",
    modelOverride: input.modelOverride ?? null,
    lastTestAt: input.lastTestAt ?? now,
    lastTestStatus: input.lastTestStatus ?? "passed",
    lastTestCode: input.lastTestCode ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    credentialConfigured: true
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
  const state = {
    providers: [],
    activeProviderId: null,
    generation: 0,
    worker: stoppedWorker(),
    supervisorPid: 7001,
    nextWorkerPid: 4201,
    testFailureCode: null,
    nextMutationError: null,
    codex: {
      configured: false,
      modelProvider: null,
      proxyUrl: null
    },
    bootstrapCount: 0,
    activities: [],
    diagnostics: null
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

  const providerService = {
    async listProviders() {
      calls.push({ operation: "listProviders" });
      return structuredClone(state.providers);
    },
    async createProvider(input, credential, options) {
      rejectNextMutation("createProvider");
      assert.equal(typeof credential, "string");
      assert.ok(credential.length > 0);
      calls.push({
        operation: "createProvider",
        credentialLength: credential.length,
        fallbackConsent: options?.fallbackConsent === true
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
      if (id === state.activeProviderId) {
        throw new CrpError(
          "PROVIDER_ACTIVE",
          "The active provider cannot be edited.",
          "Activate another provider first.",
          { status: 409 }
        );
      }
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
        "modelOverride"
      ];
      const operationalChange = replacementCredential !== undefined
        || invalidatingFields.some((field) => JSON.stringify(provider[field]) !== JSON.stringify(patch[field]));
      Object.assign(provider, patch, {
        updatedAt: "2026-07-13T08:30:00.000Z",
        ...(!operationalChange ? {} : {
          lastTestAt: null,
          lastTestStatus: "untested",
          lastTestCode: null
        })
      });
      addActivity("provider", "update", id);
      return structuredClone(provider);
    },
    async deleteProvider(id) {
      rejectNextMutation("deleteProvider");
      if (id === state.activeProviderId) {
        throw new CrpError(
          "PROVIDER_ACTIVE",
          "The active provider cannot be deleted.",
          "Activate another provider first.",
          { status: 409 }
        );
      }
      const index = state.providers.findIndex((provider) => provider.id === id);
      if (index === -1) throw new CrpError("PROVIDER_NOT_FOUND", "Missing provider.", "Refresh.", { status: 404 });
      const [deleted] = state.providers.splice(index, 1);
      credentials.delete(id);
      calls.push({ operation: "deleteProvider", id });
      addActivity("provider", "delete", id);
      return structuredClone(deleted);
    },
    async testProvider(id, model) {
      assert.ok(model.trim().length > 0);
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) throw new CrpError("PROVIDER_NOT_FOUND", "Missing provider.", "Refresh.", { status: 404 });
      calls.push({ operation: "testProvider", id, model });
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
      return { ok: code === null, code };
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
      state.worker.generation = state.generation;
      if (state.worker.state) state.worker.state.generation = state.generation;
      calls.push({ operation: "activate", id, generation: state.generation });
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
    providerService,
    activityStore: {
      list({ limit }) {
        return structuredClone(state.activities.slice(0, limit));
      }
    },
    settingsService: {
      async getSettings() {
        return {
          proxyHost: "127.0.0.1",
          proxyPort: 15100,
          adminHost: "127.0.0.1",
          adminPort: 15101,
          captureEnabled: false,
          credentialBackend: "native"
        };
      }
    },
    codexService: {
      async bootstrap() {
        state.bootstrapCount += 1;
        state.codex = {
          configured: true,
          modelProvider: "OpenAI",
          proxyUrl: "http://127.0.0.1:15100"
        };
        calls.push({ operation: "bootstrap", count: state.bootstrapCount });
        return { changed: state.bootstrapCount === 1, backupPath: "/sanitized/backup" };
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

async function createFixtureHarness({ failAt = null, onResource = () => {} } = {}) {
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
        startedAt: STARTED_AT
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
      seedProviders({ providers, activeProviderId = null, generation = 4 } = {}) {
        services.state.providers = providers.map((provider, index) => publicProvider({
          baseUrl: `${resources.upstream.origin}/v1`,
          ...provider
        }, index));
        for (const provider of services.state.providers) services.seedCredential(provider.id, "seed-credential");
        services.state.activeProviderId = activeProviderId;
        services.state.generation = generation;
        services.state.codex = {
          configured: true,
          modelProvider: "OpenAI",
          proxyUrl: "http://127.0.0.1:15100"
        };
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
          { category: "migration", action: "legacy-config" },
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
  if (/^(authorization|apiKey|credential|replacementCredential|csrfToken)$/i.test(key)) return "[redacted]";
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
    const onConsole = (message) => records.push({ type: "console", text: message.text() });
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
        if (url.pathname === "/api/v1/session" && response.status() === 200) {
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
      }
    };
    try {
      await use();
    } finally {
      await crp.collectors.flush();
      await assertNoSecrets(page, crp);
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
      "h1, h2, h3, button, select, label, .eyebrow, .metric-label, [data-i18n], "
        + ".activity-row > *, .provider-row > *, .setting-row > *, .status-band > *, "
        + ".provider-band > *, .page-heading-actions > *, .topbar-actions > *"
    )).filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.matches(".visually-hidden")
        && !element.closest("[hidden]")
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
    return {
      documentOverflow: document.documentElement.scrollWidth > innerWidth,
      clipped,
      overlaps
    };
  });
  expect(result.documentOverflow).toBe(false);
  expect(result.clipped).toEqual([]);
  expect(result.overlaps).toEqual([]);
}
