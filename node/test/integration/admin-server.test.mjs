import test from "node:test";
import assert from "node:assert/strict";
import * as realFileOperations from "node:fs";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import http from "node:http";
import os from "node:os";
import { dirname, join } from "node:path";

import { createAdminServer } from "../../src/supervisor/admin-server.mjs";
import { SessionAuth } from "../../src/supervisor/session-auth.mjs";
import { createSupervisor } from "../../src/supervisor/supervisor.mjs";
import { runSupervisor } from "../../src/supervisor/supervisor-entry.mjs";
import { getPaths } from "../../src/shared/paths.mjs";
import { CrpError } from "../../src/shared/errors.mjs";

const SECRET = "admin-api-complete-secret-sentinel";
const CREDENTIAL_REF = "credential-ref-must-not-pass";
const NO_HISTORY_REPAIR = Object.freeze({
  required: false,
  completed: false,
  resumed: false,
  backupCreated: false,
  rolloutFiles: 0,
  rolloutRecords: 0,
  sqliteFiles: 0,
  sqliteRows: 0,
  encryptedContentDetected: false
});

function publicProvider(overrides = {}) {
  return {
    id: "provider-1",
    name: "Primary",
    baseUrl: "https://provider.example/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    modelMode: "passthrough",
    modelOverride: null,
    lastTestAt: null,
    lastTestStatus: "untested",
    lastTestCode: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    credentialConfigured: true,
    credentialRef: CREDENTIAL_REF,
    apiKey: SECRET,
    ...overrides
  };
}

function workerState(overrides = {}) {
  return {
    phase: "running",
    pid: 12345,
    generation: 1,
    state: {
      phase: "running",
      configured: true,
      generation: 1,
      listening: true,
      listenHost: "127.0.0.1",
      listenPort: 15100,
      inFlight: 0,
      apiKey: SECRET
    },
    restartCount: 0,
    startedAt: "2026-07-13T00:00:00.000Z",
    error: null,
    settings: { apiKey: SECRET },
    ...overrides
  };
}

function createServices() {
  const calls = [];
  const providers = [publicProvider()];
  const providerService = {
    async listProviders() {
      calls.push(["listProviders"]);
      return providers.map((provider) => ({ ...provider }));
    },
    async createProvider(input, secret, ...extraArguments) {
      calls.push(["createProvider", input, secret, ...extraArguments]);
      const created = publicProvider({ id: "provider-2", name: input.name });
      providers.push(created);
      return created;
    },
    async updateProvider(id, patch, replacementSecret) {
      calls.push(["updateProvider", id, patch, replacementSecret]);
      const current = providers.find((provider) => provider.id === id);
      Object.assign(current, patch, { updatedAt: "2026-07-13T00:01:00.000Z" });
      return { ...current };
    },
    async deleteProvider(id) {
      calls.push(["deleteProvider", id]);
      if (id === "provider-1") {
        throw new CrpError(
          "PROVIDER_ACTIVE",
          "The active provider cannot be deleted.",
          "Activate another provider or stop the proxy first.",
          { status: 409, details: { authorization: SECRET, note: SECRET } }
        );
      }
      const index = providers.findIndex((provider) => provider.id === id);
      return providers.splice(index, 1)[0];
    },
    async testProvider(id, model, options) {
      calls.push(["testProvider", id, model, options]);
      return {
        ok: true,
        code: null,
        initialActivation: options?.activateIfNone === true ? {
          automatic: true,
          activeProviderId: id,
          workerStarted: false,
          apiKey: SECRET
        } : null,
        apiKey: SECRET
      };
    },
    async getProviderModels(id) {
      calls.push(["getProviderModels", id]);
      return {
        providerId: id,
        state: "stale",
        fetchedAt: "2026-07-12T00:00:00.000Z",
        expiresAt: "2026-07-13T00:00:00.000Z",
        models: ["cached-model"],
        apiKey: SECRET
      };
    },
    async refreshProviderModels(id) {
      calls.push(["refreshProviderModels", id]);
      return {
        providerId: id,
        state: "fresh",
        fetchedAt: "2026-07-13T00:00:00.000Z",
        expiresAt: "2026-07-14T00:00:00.000Z",
        models: ["fresh-model"],
        credentialRef: CREDENTIAL_REF
      };
    },
    async activate(id) {
      calls.push(["activate", id]);
      return {
        activeProviderId: id,
        activeProvider: providers.find((provider) => provider.id === id),
        generation: 2,
        worker: workerState({ generation: 2 })
      };
    },
    async getStatus() {
      calls.push(["getStatus"]);
      return {
        activeProviderId: "provider-1",
        activeProvider: providers[0],
        generation: 1,
        worker: workerState()
      };
    },
    async startProxy() {
      calls.push(["startProxy"]);
      return workerState();
    },
    async stopProxy() {
      calls.push(["stopProxy"]);
      return workerState({ phase: "stopped", pid: null, generation: 1, state: null });
    },
    async restartProxy() {
      calls.push(["restartProxy"]);
      return workerState({ pid: 54321 });
    }
  };
  const activityStore = {
    list({ limit }) {
      calls.push(["activity", limit]);
      return Array.from({ length: 8 }, (_, index) => ({
        timestamp: `2026-07-13T00:00:0${index}.000Z`,
        category: "provider",
        action: "test",
        providerId: "provider-1",
        result: "success",
        errorCode: null,
        details: index === 0 ? { authorization: "[REDACTED]" } : { index }
      })).reverse();
    }
  };
  const settingsService = {
    async getSettings() {
      calls.push(["getSettings"]);
      return {
        proxyHost: "127.0.0.1",
        proxyPort: 15100,
        adminHost: "127.0.0.1",
        adminPort: 15101,
        captureEnabled: false,
        credentialBackend: "native",
        apiKey: SECRET
      };
    },
    async updateSettings(patch) {
      calls.push(["updateSettings", patch]);
      return { ...(await this.getSettings()), ...patch };
    }
  };
  const codexState = {
    configured: true,
    modelProvider: "OpenAI",
    proxyUrl: "http://127.0.0.1:15100",
    historyRepairPending: false
  };
  const codexService = {
    state: codexState,
    async bootstrap() {
      calls.push(["bootstrap"]);
      Object.assign(codexState, {
        configured: true,
        historyRepairPending: false
      });
      return {
        changed: true,
        backupPath: `/private/${SECRET}`,
        historyRepair: {
          required: true,
          completed: true,
          resumed: false,
          backupCreated: true,
          rolloutFiles: -1,
          rolloutRecords: 1_000_001,
          sqliteFiles: 1_000_000,
          sqliteRows: 4,
          encryptedContentDetected: true,
          rolloutPaths: [`/private/${SECRET}/rollout.jsonl`],
          sessionBody: `private session body ${SECRET}`,
          apiKey: SECRET
        }
      };
    },
    async getStatus() {
      return structuredClone(codexState);
    },
    async runWhenReady(operation) {
      calls.push(["runWhenReady"]);
      const status = await this.getStatus();
      if (status.configured !== true || status.historyRepairPending === true) {
        throw new CrpError(
          "CODEX_NOT_READY",
          "The Codex configuration is not ready.",
          "Complete Codex bootstrap before activating a provider or starting or restarting the proxy.",
          { status: 409 }
        );
      }
      return await operation();
    }
  };
  const diagnosticsService = {
    async exportDiagnostics() {
      calls.push(["diagnostics"]);
      return { created: true, apiKey: SECRET, credentialRef: CREDENTIAL_REF };
    }
  };
  const metricsService = {
    async getOverview({ window }) {
      calls.push(["metrics", window]);
      return {
        window,
        bucketMinutes: 60,
        storageState: "ready",
        summary: {
          requests: 3,
          results: {
            success: 2,
            upstreamRejected: 1,
            upstreamError: 0,
            timeout: 0,
            networkError: 0,
            clientAbort: 0,
            rawError: SECRET
          },
          tokens: { input: 100, output: 25, observedRequests: 2, body: SECRET },
          latency: { p50UpperBoundMs: 500, p95UpperBoundMs: 2_500, overflowRequests: 0 },
          responseStart: { p50UpperBoundMs: 250, p95UpperBoundMs: 1_000, overflowRequests: 0 }
        },
        series: [{
          start: "2026-07-13T00:00:00.000Z",
          requests: 3,
          results: {
            success: 2,
            upstreamRejected: 1,
            upstreamError: 0,
            timeout: 0,
            networkError: 0,
            clientAbort: 0
          },
          tokens: { input: 100, output: 25, observedRequests: 2 },
          requestId: SECRET
        }],
        providers: [{
          providerId: "provider-1",
          requests: 3,
          successfulRequests: 2,
          tokens: { input: 100, output: 25, observedRequests: 2 },
          latency: { p50UpperBoundMs: 500, p95UpperBoundMs: 2_500, overflowRequests: 0 },
          url: SECRET
        }],
        providerOtherRequests: 0,
        models: [{
          model: "gpt-5-codex",
          requests: 3,
          tokens: { input: 100, output: 25, observedRequests: 2 },
          headers: SECRET
        }],
        modelOtherRequests: 0,
        dataQuality: {
          unknownModelRequests: 0,
          modelOverflowRequests: 0,
          providerOverflowRequests: 0,
          droppedObservations: 0,
          error: SECRET
        },
        apiKey: SECRET
      };
    }
  };
  return {
    calls,
    providerService,
    activityStore,
    settingsService,
    codexService,
    diagnosticsService,
    metricsService
  };
}

async function createHarness(t, overrides = {}) {
  const dir = mkdtempSync(join(os.tmpdir(), "crp-admin-server-"));
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>CRP test UI</title>\n");
  writeFileSync(join(uiDir, "styles.css"), "body { color: black; }\n");
  writeFileSync(join(uiDir, "app.js"), "globalThis.__crpTest = true;\n");
  const controlTokenPath = join(dir, "control-token");
  const auth = new SessionAuth({ controlTokenPath });
  const services = createServices();
  const admin = createAdminServer({
    auth,
    ...services,
    getSupervisorState: () => ({ pid: 9001, startedAt: "2026-07-13T00:00:00.000Z", apiKey: SECRET }),
    uiDir,
    host: "127.0.0.1",
    port: 0,
    ...overrides
  });
  const address = await admin.listen();
  const controlToken = readFileSync(controlTokenPath, "utf8").trim();
  t.after(async () => {
    await admin.close();
    auth.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function request(path, options = {}) {
    const target = new URL(`${address.origin}${path}`);
    const received = await new Promise((resolvePromise, rejectPromise) => {
      const outgoing = http.request({
        host: target.hostname,
        port: target.port,
        path: options.rawPath ?? `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        headers: { ...(options.headers ?? {}) }
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolvePromise({
          status: response.statusCode,
          headers: new Headers(response.headers),
          text: Buffer.concat(chunks).toString("utf8")
        }));
      });
      outgoing.once("error", rejectPromise);
      if (options.body !== undefined) outgoing.write(options.body);
      outgoing.end();
    });
    const response = { status: received.status, headers: received.headers };
    const text = received.text;
    let json = null;
    if (text && response.headers.get("content-type")?.startsWith("application/json")) {
      json = JSON.parse(text);
    }
    return { response, text, json };
  }

  return {
    ...services,
    admin,
    address,
    auth,
    controlToken,
    request
  };
}

async function browserSession(harness, headers = {}) {
  const created = await harness.request("/api/v1/session", {
    method: "POST",
    headers: {
      authorization: `Bearer ${harness.controlToken}`,
      origin: harness.address.origin,
      ...headers
    }
  });
  assert.equal(created.response.status, 200);
  return {
    cookie: created.response.headers.get("set-cookie").split(";")[0],
    csrfToken: created.json.csrfToken
  };
}

function bearer(harness, extra = {}) {
  return { authorization: `Bearer ${harness.controlToken}`, ...extra };
}

function assertNoSensitiveResponse(result) {
  const serialized = `${result.text}\n${JSON.stringify(result.json)}`;
  for (const forbidden of [SECRET, CREDENTIAL_REF, "credentialRef", "apiKey", "backupPath"]) {
    assert.equal(serialized.includes(forbidden), false, `response leaked ${forbidden}`);
  }
}

test("enforces Host, Origin, disabled CORS, bearer, and browser read sessions", async (t) => {
  const harness = await createHarness(t);

  const badHost = await harness.request("/api/v1/session", {
    method: "POST",
    headers: bearer(harness, { host: "attacker.example" })
  });
  assert.equal(badHost.response.status, 403);
  assert.equal(badHost.json.error.code, "API_HOST_INVALID");

  const badOrigin = await harness.request("/api/v1/session", {
    method: "POST",
    headers: bearer(harness, { origin: "https://attacker.example" })
  });
  assert.equal(badOrigin.response.status, 403);
  assert.equal(badOrigin.json.error.code, "API_ORIGIN_INVALID");

  const preflight = await harness.request("/api/v1/providers", {
    method: "OPTIONS",
    headers: {
      origin: harness.address.origin,
      "access-control-request-method": "POST"
    }
  });
  assert.equal(preflight.response.status, 403);
  assert.equal(preflight.json.error.code, "API_CORS_FORBIDDEN");
  assert.equal(preflight.response.headers.has("access-control-allow-origin"), false);

  const unauthenticated = await harness.request("/api/v1/status");
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.json.error.code, "AUTH_REQUIRED");

  const session = await browserSession(harness);
  const browserRead = await harness.request("/api/v1/status", {
    headers: { cookie: session.cookie, origin: harness.address.origin }
  });
  assert.equal(browserRead.response.status, 200);
  const providers = await harness.request("/api/v1/providers", {
    headers: { cookie: session.cookie, origin: harness.address.origin }
  });
  assert.equal(providers.response.status, 200);
  for (const result of [badHost, badOrigin, preflight, unauthenticated, browserRead, providers]) {
    assert.equal(result.response.headers.has("access-control-allow-origin"), false);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assertNoSensitiveResponse(result);
  }
});

test("requires CSRF for browser mutations while bearer mutations bypass CSRF", async (t) => {
  const harness = await createHarness(t);
  const session = await browserSession(harness);
  const missingCsrf = await harness.request("/api/v1/proxy/stop", {
    method: "POST",
    headers: { cookie: session.cookie, origin: harness.address.origin }
  });
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.json.error.code, "AUTH_CSRF_INVALID");

  const browserMutation = await harness.request("/api/v1/proxy/stop", {
    method: "POST",
    headers: {
      cookie: session.cookie,
      origin: harness.address.origin,
      "x-crp-csrf": session.csrfToken
    }
  });
  assert.equal(browserMutation.response.status, 200);

  const cliMutation = await harness.request("/api/v1/proxy/start", {
    method: "POST",
    headers: bearer(harness)
  });
  assert.equal(cliMutation.response.status, 200);
  for (const result of [missingCsrf, browserMutation, cliMutation]) {
    assert.equal(result.response.headers.has("access-control-allow-origin"), false);
    assertNoSensitiveResponse(result);
  }
});

test("accepts identity-bound Supervisor shutdown through bearer or browser CSRF and schedules once", async (t) => {
  const shutdownGate = createGate();
  let shutdownCalls = 0;
  const harness = await createHarness(t, {
    requestSupervisorShutdown() {
      shutdownCalls += 1;
      return shutdownGate.promise;
    }
  });
  const identity = {
    supervisorPid: 9001,
    startedAt: "2026-07-13T00:00:00.000Z"
  };
  const body = JSON.stringify(identity);
  const session = await browserSession(harness);

  const unauthenticated = await harness.request("/api/v1/supervisor/shutdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.json.error.code, "AUTH_REQUIRED");

  const missingCsrf = await harness.request("/api/v1/supervisor/shutdown", {
    method: "POST",
    headers: {
      cookie: session.cookie,
      origin: harness.address.origin,
      "content-type": "application/json"
    },
    body
  });
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.json.error.code, "AUTH_CSRF_INVALID");

  const [browserResult, bearerResult] = await Promise.all([
    harness.request("/api/v1/supervisor/shutdown", {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: harness.address.origin,
        "x-crp-csrf": session.csrfToken,
        "content-type": "application/json"
      },
      body
    }),
    harness.request("/api/v1/supervisor/shutdown", {
      method: "POST",
      headers: { ...bearer(harness), "content-type": "application/json" },
      body
    })
  ]);

  for (const result of [unauthenticated, missingCsrf, browserResult, bearerResult]) {
    assertNoSensitiveResponse(result);
  }
  for (const result of [browserResult, bearerResult]) {
    assert.equal(result.response.status, 202, result.text);
    assert.deepEqual(result.json, {
      shutdown: { accepted: true, ...identity }
    });
  }
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(shutdownCalls, 1);
  shutdownGate.resolve();
});

test("rejects stale or malformed Supervisor shutdown identities without scheduling close", async (t) => {
  let shutdownCalls = 0;
  const harness = await createHarness(t, {
    requestSupervisorShutdown() {
      shutdownCalls += 1;
    }
  });
  const headers = { ...bearer(harness), "content-type": "application/json" };
  const identity = {
    supervisorPid: 9001,
    startedAt: "2026-07-13T00:00:00.000Z"
  };

  for (const body of [
    { ...identity, supervisorPid: 9002 },
    { ...identity, startedAt: "2026-07-13T00:00:01.000Z" }
  ]) {
    const stale = await harness.request("/api/v1/supervisor/shutdown", {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    assertNoSensitiveResponse(stale);
    assert.equal(stale.response.status, 409, stale.text);
    assert.equal(stale.json.error.code, "SUPERVISOR_IDENTITY_CHANGED");
  }

  for (const body of [
    {},
    { ...identity, supervisorPid: 0 },
    { ...identity, supervisorPid: 4_294_967_296 },
    { ...identity, startedAt: "2026-07-13T00:00:00Z" },
    { ...identity, unexpected: true }
  ]) {
    const malformed = await harness.request("/api/v1/supervisor/shutdown", {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    assertNoSensitiveResponse(malformed);
    assert.equal(malformed.response.status, 400, malformed.text);
    assert.equal(malformed.json.error.code, "API_BODY_INVALID");
  }

  const emptyBody = await harness.request("/api/v1/supervisor/shutdown", {
    method: "POST",
    headers
  });
  assert.equal(emptyBody.response.status, 400, emptyBody.text);
  assert.equal(emptyBody.json.error.code, "API_BODY_INVALID");

  const query = await harness.request("/api/v1/supervisor/shutdown?retry=1", {
    method: "POST",
    headers,
    body: JSON.stringify(identity)
  });
  assert.equal(query.response.status, 400, query.text);
  assert.equal(query.json.error.code, "API_BODY_INVALID");

  const wrongMethod = await harness.request("/api/v1/supervisor/shutdown", {
    method: "GET",
    headers: bearer(harness)
  });
  assert.equal(wrongMethod.response.status, 405, wrongMethod.text);
  assert.equal(wrongMethod.response.headers.get("allow"), "POST");
  assert.equal(wrongMethod.json.error.code, "API_METHOD_NOT_ALLOWED");

  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(shutdownCalls, 0);
});

test("fails closed when no Supervisor shutdown coordinator is injected", async (t) => {
  const harness = await createHarness(t);
  const result = await harness.request("/api/v1/supervisor/shutdown", {
    method: "POST",
    headers: { ...bearer(harness), "content-type": "application/json" },
    body: JSON.stringify({
      supervisorPid: 9001,
      startedAt: "2026-07-13T00:00:00.000Z"
    })
  });
  assertNoSensitiveResponse(result);
  assert.equal(result.response.status, 503, result.text);
  assert.equal(result.json.error.code, "SUPERVISOR_SHUTDOWN_UNAVAILABLE");
});

test("finishes the shutdown response before closing the Admin server", async (t) => {
  let adminToClose;
  let shutdownCalls = 0;
  const harness = await createHarness(t, {
    requestSupervisorShutdown() {
      shutdownCalls += 1;
      return adminToClose.close();
    }
  });
  adminToClose = harness.admin;
  const closed = new Promise((resolvePromise) => {
    harness.admin.server.once("close", resolvePromise);
  });

  const result = await harness.request("/api/v1/supervisor/shutdown", {
    method: "POST",
    headers: { ...bearer(harness), "content-type": "application/json" },
    body: JSON.stringify({
      supervisorPid: 9001,
      startedAt: "2026-07-13T00:00:00.000Z"
    })
  });
  assert.equal(result.response.status, 202, result.text);
  assert.deepEqual(result.json, {
    shutdown: {
      accepted: true,
      supervisorPid: 9001,
      startedAt: "2026-07-13T00:00:00.000Z"
    }
  });
  await closed;
  assert.equal(shutdownCalls, 1);
});

test("retries the shutdown coordinator after a failed asynchronous close attempt", async (t) => {
  let shutdownCalls = 0;
  const harness = await createHarness(t, {
    requestSupervisorShutdown() {
      shutdownCalls += 1;
      if (shutdownCalls === 1) return Promise.reject(new Error("private close failure"));
      return Promise.resolve();
    }
  });
  const request = () => harness.request("/api/v1/supervisor/shutdown", {
    method: "POST",
    headers: { ...bearer(harness), "content-type": "application/json" },
    body: JSON.stringify({
      supervisorPid: 9001,
      startedAt: "2026-07-13T00:00:00.000Z"
    })
  });

  const first = await request();
  assert.equal(first.response.status, 202, first.text);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const second = await request();
  assert.equal(second.response.status, 202, second.text);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(shutdownCalls, 2);
});

test("resumes a valid cookie session only through the strict same-origin bootstrap", async (t) => {
  const harness = await createHarness(t);
  const session = await browserSession(harness);
  const originalSessionSecrets = [
    harness.controlToken,
    session.cookie.split("=")[1],
    session.csrfToken
  ];
  const assertAuthSecretsAbsent = (result, secrets = originalSessionSecrets) => {
    const surface = `${result.text}\n${JSON.stringify([...result.response.headers])}`;
    for (const secret of secrets) assert.equal(surface.includes(secret), false);
  };
  const resumeHeaders = {
    cookie: session.cookie,
    origin: harness.address.origin,
    "x-crp-session-resume": "1"
  };

  const missingOrigin = await harness.request("/api/v1/session/resume", {
    method: "POST",
    headers: { cookie: session.cookie, "x-crp-session-resume": "1" }
  });
  assertAuthSecretsAbsent(missingOrigin);
  assert.equal(missingOrigin.response.status, 403);
  assert.equal(missingOrigin.json.error.code, "API_ORIGIN_INVALID");

  const missingHeader = await harness.request("/api/v1/session/resume", {
    method: "POST",
    headers: { cookie: session.cookie, origin: harness.address.origin }
  });
  assertAuthSecretsAbsent(missingHeader);
  assert.equal(missingHeader.response.status, 403);
  assert.equal(missingHeader.json.error.code, "AUTH_CSRF_INVALID");

  const wrongOrigin = await harness.request("/api/v1/session/resume", {
    method: "POST",
    headers: { ...resumeHeaders, origin: "https://attacker.example" }
  });
  assertAuthSecretsAbsent(wrongOrigin);
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.json.error.code, "API_ORIGIN_INVALID");

  const wrongHeader = await harness.request("/api/v1/session/resume", {
    method: "POST",
    headers: { ...resumeHeaders, "x-crp-session-resume": "yes" }
  });
  assertAuthSecretsAbsent(wrongHeader);
  assert.equal(wrongHeader.response.status, 403);
  assert.equal(wrongHeader.json.error.code, "AUTH_CSRF_INVALID");

  const queryRejected = await harness.request("/api/v1/session/resume?again=1", {
    method: "POST",
    headers: resumeHeaders
  });
  assertAuthSecretsAbsent(queryRejected);
  assert.equal(queryRejected.response.status, 400);
  assert.equal(queryRejected.json.error.code, "API_BODY_INVALID");

  const emptyQueryRejected = await harness.request("/api/v1/session/resume?", {
    method: "POST",
    headers: resumeHeaders,
    rawPath: "/api/v1/session/resume?"
  });
  assertAuthSecretsAbsent(emptyQueryRejected);
  assert.equal(emptyQueryRejected.response.status, 400);
  assert.equal(emptyQueryRejected.json.error.code, "API_BODY_INVALID");

  const normalizedPathRejected = await harness.request("/api/v1/ignored/../session/resume", {
    method: "POST",
    headers: resumeHeaders,
    rawPath: "/api/v1/ignored/../session/resume"
  });
  assertAuthSecretsAbsent(normalizedPathRejected);
  assert.equal(normalizedPathRejected.response.status, 400);
  assert.equal(normalizedPathRejected.json.error.code, "API_BODY_INVALID");

  const bodyRejected = await harness.request("/api/v1/session/resume", {
    method: "POST",
    headers: { ...resumeHeaders, "content-type": "application/json" },
    body: "{}"
  });
  assertAuthSecretsAbsent(bodyRejected);
  assert.equal(bodyRejected.response.status, 400);
  assert.equal(bodyRejected.json.error.code, "API_BODY_INVALID");

  const bearerRejected = await harness.request("/api/v1/session/resume", {
    method: "POST",
    headers: { ...resumeHeaders, authorization: `Bearer ${harness.controlToken}` }
  });
  assertAuthSecretsAbsent(bearerRejected);
  assert.equal(bearerRejected.response.status, 401);
  assert.equal(bearerRejected.json.error.code, "AUTH_REQUIRED");

  const wrongMethod = await harness.request("/api/v1/session/resume", {
    method: "GET",
    headers: resumeHeaders
  });
  assertAuthSecretsAbsent(wrongMethod);
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.json.error.code, "API_METHOD_NOT_ALLOWED");

  const resumed = await harness.request("/api/v1/session/resume", {
    method: "POST",
    headers: resumeHeaders
  });
  assertAuthSecretsAbsent(resumed);
  assert.equal(resumed.response.status, 200);
  assert.deepEqual(Object.keys(resumed.json).sort(), ["csrfToken", "expiresAt"]);
  assert.match(resumed.json.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(resumed.json.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const resumedCookie = resumed.response.headers.get("set-cookie").split(";")[0];
  const resumedSessionSecrets = [resumedCookie.split("=")[1], resumed.json.csrfToken];
  assert.notEqual(resumedCookie, session.cookie);

  const oldSession = await harness.request("/api/v1/status", {
    headers: { cookie: session.cookie, origin: harness.address.origin }
  });
  assertAuthSecretsAbsent(oldSession);
  assert.equal(oldSession.response.status, 401);
  assert.equal(oldSession.json.error.code, "AUTH_REQUIRED");

  const missingCsrf = await harness.request("/api/v1/proxy/stop", {
    method: "POST",
    headers: { cookie: resumedCookie, origin: harness.address.origin }
  });
  assertAuthSecretsAbsent(missingCsrf, [...originalSessionSecrets, ...resumedSessionSecrets]);
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.json.error.code, "AUTH_CSRF_INVALID");

  const mutation = await harness.request("/api/v1/proxy/stop", {
    method: "POST",
    headers: {
      cookie: resumedCookie,
      origin: harness.address.origin,
      "x-crp-csrf": resumed.json.csrfToken
    }
  });
  assertAuthSecretsAbsent(mutation, [...originalSessionSecrets, ...resumedSessionSecrets]);
  assert.equal(mutation.response.status, 200);
  assert.equal(JSON.stringify(resumed.json).includes(harness.controlToken), false);
  for (const result of [
    missingOrigin,
    missingHeader,
    wrongOrigin,
    wrongHeader,
    queryRejected,
    emptyQueryRejected,
    normalizedPathRejected,
    bodyRejected,
    bearerRejected,
    wrongMethod,
    oldSession,
    missingCsrf,
    mutation
  ]) {
    assertNoSensitiveResponse(result);
  }
});

test("routes every approved Admin API operation through injected services", async (t) => {
  const harness = await createHarness(t);
  const authHeaders = bearer(harness);
  const requests = [
    ["GET", "/api/v1/status", undefined, 200],
    ["GET", "/api/v1/metrics/overview?window=7d", undefined, 200],
    ["GET", "/api/v1/providers", undefined, 200],
    ["POST", "/api/v1/providers", {
      provider: { name: "Backup", baseUrl: "https://backup.example/v1" },
      credential: SECRET
    }, 201],
    ["GET", "/api/v1/providers/provider-2", undefined, 200],
    ["PATCH", "/api/v1/providers/provider-2", {
      patch: { name: "Backup Updated" },
      replacementCredential: SECRET
    }, 200],
    ["POST", "/api/v1/providers/provider-2/test", {
      model: "test-model",
      activateIfNone: true
    }, 200],
    ["GET", "/api/v1/providers/provider-2/models", undefined, 200],
    ["POST", "/api/v1/providers/provider-2/models", undefined, 200],
    ["POST", "/api/v1/providers/provider-2/activate", undefined, 200],
    ["POST", "/api/v1/proxy/start", undefined, 200],
    ["POST", "/api/v1/proxy/stop", undefined, 200],
    ["POST", "/api/v1/proxy/restart", undefined, 200],
    ["GET", "/api/v1/activity?limit=3&offset=2", undefined, 200],
    ["GET", "/api/v1/settings", undefined, 200],
    ["PATCH", "/api/v1/settings", { captureEnabled: true }, 409, "SETTINGS_READ_ONLY"],
    ["POST", "/api/v1/codex/bootstrap", undefined, 200],
    ["POST", "/api/v1/diagnostics/export", undefined, 200],
    ["DELETE", "/api/v1/providers/provider-2", undefined, 200]
  ];

  for (const [method, path, body, expectedStatus, expectedCode] of requests) {
    const result = await harness.request(path, {
      method,
      headers: { ...authHeaders, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    assert.equal(result.response.status, expectedStatus, `${method} ${path}: ${result.text}`);
    if (expectedCode) assert.equal(result.json.error.code, expectedCode);
    assertNoSensitiveResponse(result);
  }

  const activityCall = harness.calls.find((call) => call[0] === "activity");
  assert.deepEqual(activityCall, ["activity", 6]);
  const createCall = harness.calls.find((call) => call[0] === "createProvider");
  assert.equal(createCall[2], SECRET);
  assert.equal(createCall.length, 3);
  assert.ok(harness.calls.some((call) => call[0] === "restartProxy"));
  assert.ok(harness.calls.some((call) => call[0] === "bootstrap"));
  assert.ok(harness.calls.some((call) => call[0] === "diagnostics"));
  assert.ok(harness.calls.some((call) => call[0] === "metrics" && call[1] === "7d"));
  assert.equal(harness.calls.some((call) => call[0] === "updateSettings"), false);
});

test("metrics overview is authenticated read-only, bounded, and positively projected", async (t) => {
  const harness = await createHarness(t);
  const unauthenticated = await harness.request("/api/v1/metrics/overview");
  assert.equal(unauthenticated.response.status, 401);

  const session = await browserSession(harness);
  const result = await harness.request("/api/v1/metrics/overview?window=24h", {
    headers: { cookie: session.cookie, origin: harness.address.origin }
  });
  assert.equal(result.response.status, 200, result.text);
  assertNoSensitiveResponse(result);
  for (const forbidden of ["rawError", "requestId", "url", "headers", "body", "metric-secret-sentinel"]) {
    assert.equal(result.text.includes(forbidden), false);
  }
  assert.deepEqual(result.json, {
    metrics: {
      window: "24h",
      bucketMinutes: 60,
      storageState: "ready",
      summary: {
        requests: 3,
        results: {
          success: 2,
          upstreamRejected: 1,
          upstreamError: 0,
          timeout: 0,
          networkError: 0,
          clientAbort: 0
        },
        tokens: { input: 100, output: 25, observedRequests: 2 },
        latency: { p50UpperBoundMs: 500, p95UpperBoundMs: 2_500, overflowRequests: 0 },
        responseStart: { p50UpperBoundMs: 250, p95UpperBoundMs: 1_000, overflowRequests: 0 }
      },
      series: [{
        start: "2026-07-13T00:00:00.000Z",
        requests: 3,
        results: {
          success: 2,
          upstreamRejected: 1,
          upstreamError: 0,
          timeout: 0,
          networkError: 0,
          clientAbort: 0
        },
        tokens: { input: 100, output: 25, observedRequests: 2 }
      }],
      providers: [{
        providerId: "provider-1",
        requests: 3,
        successfulRequests: 2,
        tokens: { input: 100, output: 25, observedRequests: 2 },
        latency: { p50UpperBoundMs: 500, p95UpperBoundMs: 2_500, overflowRequests: 0 }
      }],
      providerOtherRequests: 0,
      models: [{
        model: "gpt-5-codex",
        requests: 3,
        tokens: { input: 100, output: 25, observedRequests: 2 }
      }],
      modelOtherRequests: 0,
      dataQuality: {
        unknownModelRequests: 0,
        modelOverflowRequests: 0,
        providerOverflowRequests: 0,
        droppedObservations: 0
      }
    }
  });

  for (const path of [
    "/api/v1/metrics/overview?window=30d",
    "/api/v1/metrics/overview?window=24h&window=7d",
    "/api/v1/metrics/overview?unknown=1"
  ]) {
    const invalid = await harness.request(path, { headers: bearer(harness) });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.json.error.code, "API_BODY_INVALID");
  }
  const wrongMethod = await harness.request("/api/v1/metrics/overview", {
    method: "POST",
    headers: bearer(harness)
  });
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get("allow"), "GET");
});

test("projects only the bounded history-repair summary and pending Codex state", async (t) => {
  const harness = await createHarness(t);
  const bootstrap = await harness.request("/api/v1/codex/bootstrap", {
    method: "POST",
    headers: bearer(harness)
  });
  const status = await harness.request("/api/v1/status", {
    headers: bearer(harness)
  });

  for (const result of [bootstrap, status]) assertNoSensitiveResponse(result);
  const bootstrapText = `${bootstrap.text}\n${JSON.stringify(bootstrap.json)}`;
  for (const forbidden of ["/private/", "rollout.jsonl", "private session body", "rolloutPaths", "sessionBody"]) {
    assert.equal(bootstrapText.includes(forbidden), false);
  }
  assert.equal(bootstrap.response.status, 200, bootstrap.text);
  assert.deepEqual(bootstrap.json, {
    result: {
      changed: true,
      backupCreated: true,
      historyRepair: {
        required: true,
        completed: true,
        resumed: false,
        backupCreated: true,
        rolloutFiles: 0,
        rolloutRecords: 0,
        sqliteFiles: 1_000_000,
        sqliteRows: 4,
        encryptedContentDetected: true
      }
    }
  });
  assert.equal(status.response.status, 200, status.text);
  assert.deepEqual(status.json.codex, {
    configured: true,
    modelProvider: "OpenAI",
    proxyUrl: "http://127.0.0.1:15100",
    historyRepairPending: false
  });
});

test("Admin rejects activation and Worker start or restart while Codex is pending or unconfigured", async (t) => {
  const harness = await createHarness(t);
  const before = harness.calls.length;

  for (const state of [
    { configured: true, historyRepairPending: true },
    { configured: false, historyRepairPending: true },
    { configured: false, historyRepairPending: false }
  ]) {
    Object.assign(harness.codexService.state, state);
    for (const path of [
      "/api/v1/providers/provider-1/activate",
      "/api/v1/proxy/start",
      "/api/v1/proxy/restart"
    ]) {
      const result = await harness.request(path, {
        method: "POST",
        headers: bearer(harness)
      });
      assertNoSensitiveResponse(result);
      assert.equal(result.response.status, 409, result.text);
      assert.deepEqual(result.json.error, {
        code: "CODEX_NOT_READY",
        message: "The Codex configuration is not ready.",
        action: "Complete Codex bootstrap before activating a provider or starting or restarting the proxy.",
        requestId: result.json.error.requestId,
        details: {}
      });
    }
  }
  assert.deepEqual(
    harness.calls.slice(before).filter(([operation]) => (
      operation === "activate" || operation === "startProxy" || operation === "restartProxy"
    )),
    []
  );
});

test("Admin serializes concurrent bootstrap, activation, and Worker start before readiness recheck", async (t) => {
  const bootstrapStarted = createGate();
  const releaseBootstrap = createGate();
  const startStarted = createGate();
  const releaseStart = createGate();
  const events = [];
  const state = {
    configured: false,
    modelProvider: "OpenAI",
    proxyUrl: "http://127.0.0.1:15100",
    historyRepairPending: true
  };
  const codexService = {
    async bootstrap() {
      events.push("bootstrap-start");
      bootstrapStarted.resolve();
      await releaseBootstrap.promise;
      Object.assign(state, { configured: true, historyRepairPending: false });
      events.push("bootstrap-complete");
      return { changed: true, backupPath: null, historyRepair: NO_HISTORY_REPAIR };
    },
    async getStatus() {
      return structuredClone(state);
    }
  };
  const providerService = {
    async startProxy() {
      events.push("start-start");
      startStarted.resolve();
      await releaseStart.promise;
      events.push("start-complete");
      return workerState();
    },
    async activate(id) {
      events.push("activate");
      return {
        activeProviderId: id,
        activeProvider: publicProvider(),
        generation: 1,
        worker: workerState()
      };
    }
  };
  const harness = await createHarness(t, { codexService, providerService });
  const headers = bearer(harness);

  const bootstrapping = harness.request("/api/v1/codex/bootstrap", {
    method: "POST",
    headers
  });
  await bootstrapStarted.promise;
  const starting = harness.request("/api/v1/proxy/start", {
    method: "POST",
    headers
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const activating = harness.request("/api/v1/providers/provider-1/activate", {
    method: "POST",
    headers
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(events, ["bootstrap-start"]);
  releaseBootstrap.resolve();

  await startStarted.promise;
  assert.deepEqual(events, ["bootstrap-start", "bootstrap-complete", "start-start"]);
  releaseStart.resolve();

  const [bootstrapResult, startResult, activateResult] = await Promise.all([
    bootstrapping,
    starting,
    activating
  ]);
  assert.equal(bootstrapResult.response.status, 200, bootstrapResult.text);
  assert.equal(startResult.response.status, 200, startResult.text);
  assert.equal(activateResult.response.status, 200, activateResult.text);
  assert.deepEqual(events, [
    "bootstrap-start",
    "bootstrap-complete",
    "start-start",
    "start-complete",
    "activate"
  ]);
});

test("provider tests opt into initial selection explicitly and project only safe fields", async (t) => {
  const harness = await createHarness(t);
  const headers = { ...bearer(harness), "content-type": "application/json" };
  const automatic = await harness.request("/api/v1/providers/provider-1/test", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "test-model", activateIfNone: true })
  });
  assertNoSensitiveResponse(automatic);
  assert.equal(automatic.response.status, 200, automatic.text);
  assert.deepEqual(automatic.json, {
    result: {
      ok: true,
      code: null,
      initialActivation: {
        automatic: true,
        activeProviderId: "provider-1",
        workerStarted: false
      }
    }
  });

  const defaulted = await harness.request("/api/v1/providers/provider-1/test", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "test-model" })
  });
  assertNoSensitiveResponse(defaulted);
  assert.equal(defaulted.response.status, 200, defaulted.text);
  assert.deepEqual(defaulted.json, {
    result: { ok: true, code: null, initialActivation: null }
  });
  assert.deepEqual(
    harness.calls.filter(([operation]) => operation === "testProvider"),
    [
      ["testProvider", "provider-1", "test-model", { activateIfNone: true }],
      ["testProvider", "provider-1", "test-model", { activateIfNone: false }]
    ]
  );

  for (const body of [
    { model: "test-model", activateIfNone: "true" },
    { model: "test-model", activateIfNone: true, unexpected: true }
  ]) {
    const invalid = await harness.request("/api/v1/providers/provider-1/test", {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    assertNoSensitiveResponse(invalid);
    assert.equal(invalid.response.status, 400, invalid.text);
    assert.equal(invalid.json.error.code, "API_BODY_INVALID");
  }
});

test("model catalog routes distinguish cached reads from refreshes with strict projections", async (t) => {
  const harness = await createHarness(t);
  const headers = bearer(harness);
  const cached = await harness.request("/api/v1/providers/provider-1/models", { headers });
  assertNoSensitiveResponse(cached);
  assert.equal(cached.response.status, 200, cached.text);
  assert.deepEqual(cached.json, {
    modelCatalog: {
      providerId: "provider-1",
      state: "stale",
      fetchedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-13T00:00:00.000Z",
      models: ["cached-model"]
    }
  });

  const refreshed = await harness.request("/api/v1/providers/provider-1/models", {
    method: "POST",
    headers
  });
  assertNoSensitiveResponse(refreshed);
  assert.equal(refreshed.response.status, 200, refreshed.text);
  assert.deepEqual(refreshed.json, {
    modelCatalog: {
      providerId: "provider-1",
      state: "fresh",
      fetchedAt: "2026-07-13T00:00:00.000Z",
      expiresAt: "2026-07-14T00:00:00.000Z",
      models: ["fresh-model"]
    }
  });
  assert.deepEqual(
    harness.calls.filter(([operation]) => operation.includes("ProviderModels")),
    [
      ["getProviderModels", "provider-1"],
      ["refreshProviderModels", "provider-1"]
    ]
  );

  const bodyRejected = await harness.request("/api/v1/providers/provider-1/models", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}"
  });
  assertNoSensitiveResponse(bodyRejected);
  assert.equal(bodyRejected.response.status, 400, bodyRejected.text);
  assert.equal(bodyRejected.json.error.code, "API_BODY_INVALID");

  const methodRejected = await harness.request("/api/v1/providers/provider-1/models", {
    method: "DELETE",
    headers
  });
  assertNoSensitiveResponse(methodRejected);
  assert.equal(methodRejected.response.status, 405, methodRejected.text);
  assert.equal(methodRejected.response.headers.get("allow"), "GET, POST");
  assert.equal(methodRejected.json.error.code, "API_METHOD_NOT_ALLOWED");
});

test("enforces JSON content type, exact shape, and a bounded request body", async (t) => {
  const harness = await createHarness(t, { maxBodyBytes: 256 });
  const headers = bearer(harness);
  const valid = await harness.request("/api/v1/providers", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      provider: { name: "Bounded", baseUrl: "https://bounded.example/v1" },
      credential: "write-only-test-value"
    })
  });
  assert.equal(valid.response.status, 201, valid.text);

  const cases = [
    [{
      method: "POST",
      headers: { ...headers, "content-type": "text/plain" },
      body: "not-json"
    }, 415, "API_CONTENT_TYPE_UNSUPPORTED"],
    [{
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{"
    }, 400, "API_BODY_INVALID"],
    [{
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ credential: "x".repeat(512) })
    }, 413, "API_BODY_TOO_LARGE"],
    [{
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ provider: {}, credential: "x", unexpected: true })
    }, 400, "API_BODY_INVALID"],
    [{
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        provider: { name: "Rejected fallback", baseUrl: "https://fallback.example/v1" },
        credential: SECRET,
        fallbackConsent: true
      })
    }, 400, "API_BODY_INVALID"]
  ];
  for (const [options, status, code] of cases) {
    const result = await harness.request("/api/v1/providers", options);
    assert.equal(result.response.status, status, result.text);
    assert.equal(result.json.error.code, code);
    assertNoSensitiveResponse(result);
  }
  for (const [path, options] of [
    ["/api/v1/session", {
      method: "POST",
      headers: { ...bearer(harness), "content-type": "application/json" },
      body: "{}"
    }],
    ["/api/v1/proxy/start", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}"
    }]
  ]) {
    const result = await harness.request(path, options);
    assert.equal(result.response.status, 400, result.text);
    assert.equal(result.json.error.code, "API_BODY_INVALID");
  }
  assertNoSensitiveResponse(valid);
});

test("returns stable sanitized errors and strict route, method, and path failures", async (t) => {
  const harness = await createHarness(t);
  const headers = bearer(harness);
  const conflict = await harness.request("/api/v1/providers/provider-1", {
    method: "DELETE",
    headers
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.json.error.code, "PROVIDER_ACTIVE");
  assert.equal(typeof conflict.json.error.requestId, "string");
  assert.deepEqual(conflict.json.error.details, { authorization: "[REDACTED]" });

  const cases = [
    ["/api/v1", { headers }, 404, "API_NOT_FOUND"],
    ["/api/v1/missing", { headers }, 404, "API_NOT_FOUND"],
    ["/api/v1/providers", { method: "PUT", headers }, 405, "API_METHOD_NOT_ALLOWED"],
    ["/api/v1/providers/provider-2%2Factivate", { headers }, 404, "API_NOT_FOUND"]
  ];
  for (const [path, options, status, code] of cases) {
    const result = await harness.request(path, options);
    assert.equal(result.response.status, status, `${path}: ${result.text}`);
    assert.equal(result.json.error.code, code);
    assertNoSensitiveResponse(result);
  }
  assertNoSensitiveResponse(conflict);
});

test("serves only explicit static assets with safe headers and an index fallback", async (t) => {
  const harness = await createHarness(t);
  for (const [path, type, content] of [
    ["/", "text/html; charset=utf-8", "CRP test UI"],
    ["/index.html", "text/html; charset=utf-8", "CRP test UI"],
    ["/styles.css", "text/css; charset=utf-8", "color: black"],
    ["/app.js", "text/javascript; charset=utf-8", "__crpTest"],
    ["/providers/provider-1", "text/html; charset=utf-8", "CRP test UI"]
  ]) {
    const result = await harness.request(path);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("content-type"), type);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
    assert.match(result.text, new RegExp(content));
  }

  const favicon = await harness.request("/favicon.ico");
  assert.equal(favicon.response.status, 204);
  assert.equal(favicon.text, "");
  assert.equal(favicon.response.headers.get("cache-control"), "no-store");

  const missingAsset = await harness.request("/missing.css");
  assert.equal(missingAsset.response.status, 404);
  const postUi = await harness.request("/", { method: "POST" });
  assert.equal(postUi.response.status, 405);
});

function createGate() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function supervisorDependencies(t, {
  listenGate = createGate(),
  adminCloseGate = null,
  workerCloseImpl = null
} = {}) {
  const home = mkdtempSync(join(os.tmpdir(), "crp-supervisor-"));
  const paths = {
    ...getPaths(home),
    runtimeConfigPath: join(home, ".codex-remote-proxy", "node", "proxy-config.json"),
    capturePath: join(home, ".codex-remote-proxy", "traffic.sqlite3")
  };
  const order = [];
  const worker = {
    getPublicState: () => workerState(),
    close: () => {
      order.push("worker.close");
      return workerCloseImpl?.() ?? Promise.resolve();
    }
  };
  const activity = { append() {}, list: () => [] };
  const credentials = { backend: "native" };
  const registry = { getDocument: () => ({ settings: {
    proxyHost: "127.0.0.1",
    proxyPort: 15100,
    adminHost: "127.0.0.1",
    adminPort: 15101,
    captureEnabled: false
  } }) };
  const provider = { getStatus: async () => ({ worker: workerState() }) };
  const metrics = {
    observations: [],
    dropped: 0,
    record(observation) {
      this.observations.push(structuredClone(observation));
      return true;
    },
    noteDropped() {
      this.dropped += 1;
    },
    getOverview() {
      return null;
    },
    close() {
      order.push("metrics.close");
    }
  };
  const auth = {
    close() { order.push("auth.close"); }
  };
  let adminOptions = null;
  const admin = {
    async listen() {
      order.push("admin.listen");
      return await listenGate.promise;
    },
    close() {
      order.push("admin.close");
      return adminCloseGate?.promise ?? Promise.resolve();
    }
  };
  const options = {
    home,
    paths,
    pid: 4242,
    now: () => "2026-07-13T03:00:00.000Z",
    activityStoreFactory: ({ path }) => {
      order.push("activity");
      assert.equal(path, paths.activityPath);
      return activity;
    },
    credentialStoreFactory: ({ paths: received }) => {
      order.push("credential");
      assert.deepEqual(received, paths);
      return credentials;
    },
    migrate: async (input) => {
      order.push("migration");
      assert.equal(input.credentialStore, credentials);
      assert.equal(input.activityStore, activity);
      return { migrated: false, reason: "no-legacy-config" };
    },
    registryFactory: ({ path }) => {
      order.push("registry");
      assert.equal(path, paths.registryPath);
      assert.ok(order.includes("migration"));
      return registry;
    },
    metricsStoreFactory: ({ path, now }) => {
      order.push("metrics");
      assert.equal(path, paths.metricsPath);
      assert.equal(now(), "2026-07-13T03:00:00.000Z");
      return metrics;
    },
    workerManagerFactory: (input) => {
      order.push("worker");
      assert.equal(input.recordMetric({ providerId: "provider-test" }), true);
      input.noteDroppedMetric();
      return worker;
    },
    providerServiceFactory: (input) => {
      order.push("provider");
      assert.equal(input.registry, registry);
      assert.equal(input.credentialStore, credentials);
      assert.equal(input.workerManager, worker);
      return provider;
    },
    authFactory: ({ controlTokenPath }) => {
      order.push("auth");
      assert.equal(controlTokenPath, paths.controlTokenPath);
      return auth;
    },
    adminServerFactory: (input) => {
      order.push("admin");
      adminOptions = input;
      assert.equal(input.auth, auth);
      assert.equal(input.providerService, provider);
      assert.equal(input.metricsService, metrics);
      return admin;
    }
  };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    paths,
    order,
    worker,
    admin,
    listenGate,
    registry,
    metrics,
    options,
    getAdminOptions: () => adminOptions
  };
}

test("supervisor migrates before registry construction and writes private state only after ready", async (t) => {
  const harness = supervisorDependencies(t);
  const supervisor = await createSupervisor(harness.options);
  assert.deepEqual(harness.order, [
    "activity",
    "credential",
    "migration",
    "registry",
    "metrics",
    "worker",
    "provider",
    "auth",
    "admin"
  ]);

  const listening = supervisor.listen();
  assert.equal(existsSync(harness.paths.statePath), false);
  harness.listenGate.resolve({
    host: "127.0.0.1",
    port: 15101,
    authority: "127.0.0.1:15101",
    origin: "http://127.0.0.1:15101"
  });
  const address = await listening;
  assert.equal(address.port, 15101);
  assert.equal(existsSync(harness.paths.statePath), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(harness.paths.statePath).mode & 0o777, 0o600);
  }
  const stateBytes = readFileSync(harness.paths.statePath, "utf8");
  const state = JSON.parse(stateBytes);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.supervisorPid, 4242);
  assert.equal(state.startedAt, "2026-07-13T03:00:00.000Z");
  assert.equal(state.admin.origin, "http://127.0.0.1:15101");
  assert.equal(state.worker.generation, 1);
  for (const forbidden of [SECRET, "apiKey", "settings", CREDENTIAL_REF]) {
    assert.equal(stateBytes.includes(forbidden), false);
  }

  const firstClose = supervisor.close();
  const secondClose = supervisor.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  assert.deepEqual(harness.order.slice(-4), [
    "worker.close", "admin.close", "auth.close", "metrics.close"
  ]);
  assert.equal(existsSync(harness.paths.statePath), false);
});

test("supervisor cleans up in reverse order when Admin readiness fails", async (t) => {
  const harness = supervisorDependencies(t);
  const supervisor = await createSupervisor(harness.options);
  const failure = new Error(`private listen failure ${SECRET}`);
  harness.listenGate.reject(failure);
  await assert.rejects(() => supervisor.listen(), (error) => error === failure);
  assert.deepEqual(harness.order.slice(-4), [
    "worker.close", "admin.close", "auth.close", "metrics.close"
  ]);
  assert.equal(existsSync(harness.paths.statePath), false);
});

test("supervisor preserves discoverable state and retries after Worker close fails", async (t) => {
  const failure = new Error("private Worker close failure");
  let closeAttempts = 0;
  const harness = supervisorDependencies(t, {
    workerCloseImpl() {
      closeAttempts += 1;
      if (closeAttempts === 1) return Promise.reject(failure);
      return Promise.resolve();
    }
  });
  harness.listenGate.resolve({
    host: "127.0.0.1",
    port: 15101,
    authority: "127.0.0.1:15101",
    origin: "http://127.0.0.1:15101"
  });
  const supervisor = await createSupervisor(harness.options);
  await supervisor.listen();

  await assert.rejects(() => supervisor.close(), (error) => error === failure);
  assert.equal(existsSync(harness.paths.statePath), true);
  assert.equal(harness.order.filter((entry) => entry === "admin.close").length, 0);
  await supervisor.close();
  assert.equal(closeAttempts, 2);
  assert.equal(harness.order.filter((entry) => entry === "admin.close").length, 1);
  assert.equal(existsSync(harness.paths.statePath), false);
});

test("supervisor retries an interrupted fixed-marker state deletion", async (t) => {
  const harness = supervisorDependencies(t);
  const claimPath = `${harness.paths.statePath}.stale`;
  let failClaimRemoval = true;
  harness.options.stateFileOperations = {
    ...realFileOperations,
    rmSync(path, ...args) {
      if (path === claimPath && failClaimRemoval) {
        failClaimRemoval = false;
        const error = new Error("private state removal failure");
        error.code = "EIO";
        throw error;
      }
      return realFileOperations.rmSync(path, ...args);
    }
  };
  harness.listenGate.resolve({
    host: "127.0.0.1",
    port: 15101,
    authority: "127.0.0.1:15101",
    origin: "http://127.0.0.1:15101"
  });
  const supervisor = await createSupervisor(harness.options);
  await supervisor.listen();

  await assert.rejects(() => supervisor.close(), (error) => error?.code === "EIO");
  assert.equal(existsSync(harness.paths.statePath), false);
  assert.equal(existsSync(claimPath), true);
  await supervisor.close();
  assert.equal(existsSync(harness.paths.statePath), false);
  assert.equal(existsSync(claimPath), false);
});

test("supervisor cleans constructed resources when composition fails before listen", async (t) => {
  const harness = supervisorDependencies(t);
  const failure = new Error(`private composition failure ${SECRET}`);
  harness.options.adminServerFactory = () => {
    harness.order.push("admin");
    throw failure;
  };
  await assert.rejects(() => createSupervisor(harness.options), (error) => error === failure);
  assert.deepEqual(harness.order.slice(-3), ["auth.close", "worker.close", "metrics.close"]);
  assert.equal(existsSync(harness.paths.statePath), false);
});

test("supervisor keeps Codex and state filesystem adapters independent", async (t) => {
  const harness = supervisorDependencies(t);
  const codexFileOperations = { boundary: "codex-only" };
  const historyRepair = {
    plan() {},
    hasPending() { return false; },
    async run() {}
  };
  let bootstrapInput = null;
  let codexService = null;
  harness.options.codexFileOperations = codexFileOperations;
  harness.options.codexHistoryRepair = historyRepair;
  harness.options.bootstrapCodex = async (input) => {
    bootstrapInput = input;
    return { changed: false, backupPath: null, historyRepair: NO_HISTORY_REPAIR };
  };
  harness.options.adminServerFactory = (input) => {
    harness.order.push("admin");
    codexService = input.codexService;
    return harness.admin;
  };
  const supervisor = await createSupervisor(harness.options);
  assert.deepEqual(
    await codexService.bootstrap(),
    { changed: false, backupPath: null, historyRepair: NO_HISTORY_REPAIR }
  );
  assert.equal(bootstrapInput.fileOperations, codexFileOperations);
  assert.equal(bootstrapInput.configPath, harness.paths.codexConfigPath);
  assert.equal(bootstrapInput.historyRepair, historyRepair);
  await supervisor.close();
});

test("Supervisor injects the complete production history-recovery adapter", async (t) => {
  const harness = supervisorDependencies(t);
  let bootstrapInput;
  let codexService;
  harness.options.bootstrapCodex = async (input) => {
    bootstrapInput = input;
    return { changed: false, backupPath: null, historyRepair: NO_HISTORY_REPAIR };
  };
  harness.options.adminServerFactory = (input) => {
    harness.order.push("admin");
    codexService = input.codexService;
    return harness.admin;
  };
  const supervisor = await createSupervisor(harness.options);

  await codexService.bootstrap();
  assert.deepEqual(
    Object.keys(bootstrapInput.historyRepair).sort(),
    ["hasPending", "inspectPending", "plan", "run"]
  );
  for (const operation of Object.values(bootstrapInput.historyRepair)) {
    assert.equal(typeof operation, "function");
  }
  await supervisor.close();
});

test("Supervisor Codex status is configured only when matching config has no pending repair", async (t) => {
  const harness = supervisorDependencies(t);
  const codexRoot = join(harness.home, ".codex");
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(harness.paths.codexConfigPath, [
    'model_provider = "OpenAI"',
    "",
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    'base_url = "http://127.0.0.1:15100"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    ""
  ].join("\n"));
  let pending = true;
  const pendingInputs = [];
  const historyRepair = {
    plan() {},
    hasPending(input) {
      pendingInputs.push(input);
      return pending;
    },
    async run() {}
  };
  let codexService;
  harness.options.codexHistoryRepair = historyRepair;
  harness.options.adminServerFactory = (input) => {
    harness.order.push("admin");
    codexService = input.codexService;
    return harness.admin;
  };
  const supervisor = await createSupervisor(harness.options);

  assert.deepEqual(await codexService.getStatus(), {
    configured: false,
    modelProvider: "OpenAI",
    proxyUrl: "http://127.0.0.1:15100",
    historyRepairPending: true
  });
  pending = false;
  assert.deepEqual(await codexService.getStatus(), {
    configured: true,
    modelProvider: "OpenAI",
    proxyUrl: "http://127.0.0.1:15100",
    historyRepairPending: false
  });
  writeFileSync(`${harness.paths.codexConfigPath}.crp.lock`, "managed-crash-lock\n");
  assert.deepEqual(await codexService.getStatus(), {
    configured: false,
    modelProvider: "OpenAI",
    proxyUrl: "http://127.0.0.1:15100",
    historyRepairPending: false
  });
  assert.deepEqual(pendingInputs, [
    { codexRoot },
    { codexRoot },
    { codexRoot },
    { codexRoot },
    { codexRoot },
    { codexRoot }
  ]);
  await supervisor.close();
});

test("Supervisor Codex status rechecks pending state after reading config", async (t) => {
  const harness = supervisorDependencies(t);
  const codexRoot = join(harness.home, ".codex");
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(harness.paths.codexConfigPath, [
    'model_provider = "OpenAI"',
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    'base_url = "http://127.0.0.1:15100"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    ""
  ].join("\n"));
  let checks = 0;
  let codexService;
  harness.options.codexHistoryRepair = {
    plan() {},
    hasPending() {
      checks += 1;
      return checks >= 2;
    },
    async run() {}
  };
  harness.options.adminServerFactory = (input) => {
    harness.order.push("admin");
    codexService = input.codexService;
    return harness.admin;
  };
  const supervisor = await createSupervisor(harness.options);

  assert.deepEqual(await codexService.getStatus(), {
    configured: false,
    modelProvider: "OpenAI",
    proxyUrl: "http://127.0.0.1:15100",
    historyRepairPending: true
  });
  assert.equal(checks, 2);
  await supervisor.close();
});

test("Supervisor Codex status strictly rejects ambiguous, malformed, and symlink configs", async (t) => {
  const harness = supervisorDependencies(t);
  const secret = "strict-status-private-secret-sentinel";
  const codexRoot = join(harness.home, ".codex");
  const configPath = harness.paths.codexConfigPath;
  const valid = [
    'model_provider = "OpenAI"',
    "",
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    'base_url = "http://127.0.0.1:15100"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    ""
  ].join("\n");
  const historyRepair = {
    plan() {},
    hasPending() { return false; },
    async run() {}
  };
  let codexService;
  harness.options.codexHistoryRepair = historyRepair;
  harness.options.adminServerFactory = (input) => {
    harness.order.push("admin");
    codexService = input.codexService;
    return harness.admin;
  };
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(configPath, valid, "utf8");
  const supervisor = await createSupervisor(harness.options);

  assert.equal((await codexService.getStatus()).configured, true);
  writeFileSync(configPath, [
    'developer_instructions = """',
    'model_provider = "decoy"',
    "[model_providers.decoy]",
    'base_url = "https://decoy.example/v1"',
    '"""',
    valid
  ].join("\n"), "utf8");
  assert.equal((await codexService.getStatus()).configured, true);
  writeFileSync(configPath, [
    'model_provider = "OpenAI"',
    'model_providers.OpenAI.name = "OpenAI"',
    'model_providers.OpenAI.base_url = "http://127.0.0.1:15100"',
    'model_providers.OpenAI.wire_api = "responses"',
    "model_providers.OpenAI.requires_openai_auth = true",
    ""
  ].join("\n"), "utf8");
  assert.equal((await codexService.getStatus()).configured, true);
  for (const invalid of [
    valid.replace('model_provider = "OpenAI"', [
      'model_provider = "OpenAI"',
      'model_provider = "Other"'
    ].join("\n")),
    `${valid}\n[model_providers.OpenAI]\nbase_url = "http://127.0.0.1:15100"\n`,
    valid.replace(
      "[model_providers.OpenAI]",
      `[model_providers.OpenAI ${secret}`
    ),
    valid.replace("[model_providers.OpenAI]", [
      "this is invalid toml",
      "[model_providers.OpenAI]"
    ].join("\n"))
  ]) {
    writeFileSync(configPath, invalid, "utf8");
    const status = await codexService.getStatus();
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal(status.configured, false);
  }

  writeFileSync(configPath, Buffer.concat([
    Buffer.from(valid, "utf8"),
    Buffer.from("# invalid utf8 ", "utf8"),
    Buffer.from([0xff]),
    Buffer.from("\n", "utf8")
  ]));
  assert.equal((await codexService.getStatus()).configured, false);

  if (process.platform !== "win32") {
    const targetPath = join(harness.home, "outside-config.toml");
    writeFileSync(targetPath, valid, "utf8");
    rmSync(configPath);
    realFileOperations.symlinkSync(targetPath, configPath);
    assert.equal((await codexService.getStatus()).configured, false);
  }
  await supervisor.close();
});

test("Supervisor Codex status uses no-follow descriptors and rejects a read identity race", async (t) => {
  const harness = supervisorDependencies(t);
  const codexRoot = join(harness.home, ".codex");
  const configPath = harness.paths.codexConfigPath;
  const displacedPath = join(codexRoot, "config.displaced.toml");
  const valid = [
    'model_provider = "OpenAI"',
    "",
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    'base_url = "http://127.0.0.1:15100"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    ""
  ].join("\n");
  let configDescriptor;
  let replacementInjected = false;
  let sawNoFollow = false;
  const operations = {
    ...realFileOperations,
    openSync(path, flags, ...args) {
      const descriptor = realFileOperations.openSync(path, flags, ...args);
      if (path === configPath) {
        configDescriptor = descriptor;
        if (typeof realFileOperations.constants.O_NOFOLLOW === "number") {
          sawNoFollow = (flags & realFileOperations.constants.O_NOFOLLOW) !== 0;
        }
      }
      return descriptor;
    },
    readFileSync(target, ...args) {
      const bytes = realFileOperations.readFileSync(target, ...args);
      if (target === configDescriptor && !replacementInjected) {
        replacementInjected = true;
        realFileOperations.renameSync(configPath, displacedPath);
        realFileOperations.writeFileSync(configPath, valid, "utf8");
      }
      return bytes;
    }
  };
  const historyRepair = {
    plan() {},
    hasPending() { return false; },
    async run() {}
  };
  let codexService;
  harness.options.codexFileOperations = operations;
  harness.options.codexHistoryRepair = historyRepair;
  harness.options.adminServerFactory = (input) => {
    harness.order.push("admin");
    codexService = input.codexService;
    return harness.admin;
  };
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(configPath, valid, "utf8");
  const supervisor = await createSupervisor(harness.options);

  const status = await codexService.getStatus();
  assert.equal(replacementInjected, true);
  if (typeof realFileOperations.constants.O_NOFOLLOW === "number") {
    assert.equal(sawNoFollow, true);
  }
  assert.equal(status.configured, false);
  await supervisor.close();
});

test("Supervisor Codex status reports no pending repair for a fresh missing Codex root", async (t) => {
  const harness = supervisorDependencies(t);
  let codexService;
  harness.options.codexHistoryRepair = {
    plan() {},
    hasPending() {
      assert.fail("A missing Codex root cannot contain pending repair state");
    },
    async run() {}
  };
  harness.options.adminServerFactory = (input) => {
    harness.order.push("admin");
    codexService = input.codexService;
    return harness.admin;
  };
  const supervisor = await createSupervisor(harness.options);

  assert.deepEqual(await codexService.getStatus(), {
    configured: false,
    modelProvider: "OpenAI",
    proxyUrl: "http://127.0.0.1:15100",
    historyRepairPending: false
  });
  await supervisor.close();
});

test("Supervisor serializes bootstrap and Worker readiness through one Codex gate", async (t) => {
  const harness = supervisorDependencies(t);
  const codexRoot = join(harness.home, ".codex");
  const valid = [
    'model_provider = "OpenAI"',
    "",
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    'base_url = "http://127.0.0.1:15100"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    ""
  ].join("\n");
  const bootstrapStarted = createGate();
  const releaseBootstrap = createGate();
  const events = [];
  let codexService;
  harness.options.codexHistoryRepair = {
    plan() {},
    hasPending() { return false; },
    async run() {}
  };
  harness.options.bootstrapCodex = async () => {
    events.push("bootstrap-start");
    bootstrapStarted.resolve();
    await releaseBootstrap.promise;
    mkdirSync(codexRoot, { recursive: true });
    writeFileSync(harness.paths.codexConfigPath, valid, "utf8");
    events.push("bootstrap-complete");
    return { changed: true, backupPath: null, historyRepair: NO_HISTORY_REPAIR };
  };
  harness.options.adminServerFactory = (input) => {
    harness.order.push("admin");
    codexService = input.codexService;
    return harness.admin;
  };
  const supervisor = await createSupervisor(harness.options);

  const bootstrapping = codexService.bootstrap();
  await bootstrapStarted.promise;
  const starting = codexService.runWhenReady(async () => {
    events.push("worker-start");
    return "started";
  });
  await Promise.resolve();
  assert.deepEqual(events, ["bootstrap-start"]);
  releaseBootstrap.resolve();

  assert.equal(await starting, "started");
  await bootstrapping;
  assert.deepEqual(events, ["bootstrap-start", "bootstrap-complete", "worker-start"]);
  await supervisor.close();
});

test("Supervisor injects strict Codex readiness around unexpected-exit recovery", async (t) => {
  const harness = supervisorDependencies(t);
  let runRecoveryWhenReady;
  harness.options.workerManagerFactory = (options) => {
    runRecoveryWhenReady = options.runRecoveryWhenReady;
    return harness.worker;
  };
  const supervisor = await createSupervisor(harness.options);
  let recoveryCalls = 0;

  await assert.rejects(
    () => runRecoveryWhenReady(async () => {
      recoveryCalls += 1;
    }),
    (error) => error?.code === "CODEX_NOT_READY"
  );
  assert.equal(recoveryCalls, 0);

  mkdirSync(dirname(harness.paths.codexConfigPath), { recursive: true });
  writeFileSync(harness.paths.codexConfigPath, [
    'model_provider = "OpenAI"',
    "",
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    'base_url = "http://127.0.0.1:15100"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    ""
  ].join("\n"), "utf8");
  assert.equal(await runRecoveryWhenReady(async () => {
    recoveryCalls += 1;
    return "recovered";
  }), "recovered");
  assert.equal(recoveryCalls, 1);

  await supervisor.close();
});

test("Supervisor Codex gate recovers after bootstrap and readiness operation failures", async (t) => {
  const harness = supervisorDependencies(t);
  const codexRoot = join(harness.home, ".codex");
  const valid = [
    'model_provider = "OpenAI"',
    "",
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    'base_url = "http://127.0.0.1:15100"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    ""
  ].join("\n");
  const privateFailure = new Error("private bootstrap failure");
  let codexService;
  harness.options.codexHistoryRepair = {
    plan() {},
    hasPending() { return false; },
    async run() {}
  };
  harness.options.bootstrapCodex = async () => {
    throw privateFailure;
  };
  harness.options.adminServerFactory = (input) => {
    harness.order.push("admin");
    codexService = input.codexService;
    return harness.admin;
  };
  const supervisor = await createSupervisor(harness.options);

  await assert.rejects(
    () => codexService.bootstrap(),
    (error) => error?.code === "CODEX_CONFIG_WRITE_FAILED"
  );
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(harness.paths.codexConfigPath, valid, "utf8");
  await assert.rejects(
    () => codexService.runWhenReady(async () => {
      throw new Error("operation failed");
    }),
    /operation failed/
  );
  assert.equal(await codexService.runWhenReady(async () => "recovered"), "recovered");
  await supervisor.close();
});

test("real Supervisor and Admin project stable safe Codex bootstrap failures", async (t) => {
  const harness = supervisorDependencies(t);
  const originalSettings = harness.registry.getDocument().settings;
  harness.registry.getDocument = () => ({ settings: { ...originalSettings, adminPort: 0 } });
  let bootstrapFailure;
  let requestId = "bootstrap-unset";
  harness.options.bootstrapCodex = () => {
    throw bootstrapFailure;
  };
  harness.options.authFactory = ({ controlTokenPath }) => {
    harness.order.push("auth");
    return new SessionAuth({ controlTokenPath });
  };
  harness.options.adminServerFactory = (input) => {
    harness.order.push("admin");
    return createAdminServer({
      ...input,
      createRequestId: () => requestId
    });
  };

  const supervisor = await createSupervisor(harness.options);
  const address = await supervisor.listen();
  const controlToken = readFileSync(harness.paths.controlTokenPath, "utf8").trim();
  t.after(() => supervisor.close());

  const cases = [
    [
      "CODEX_CONFIG_PARENT_UNSAFE",
      500,
      "The Codex configuration directory is unsafe.",
      "Repair the Codex configuration directory and retry."
    ],
    [
      "CODEX_CONFIG_BUSY",
      409,
      "Codex configuration is already being updated.",
      "Wait for the current update to finish and retry."
    ],
    [
      "CODEX_CONFIG_CHANGED",
      409,
      "Codex configuration changed during bootstrap.",
      "Review the current Codex configuration and retry."
    ],
    [
      "CODEX_CONFIG_READ_FAILED",
      500,
      "Codex configuration could not be read safely.",
      "Repair local filesystem access and retry."
    ],
    [
      "CODEX_CONFIG_COMMITTED_DEGRADED",
      500,
      "The Codex configuration was updated, but completion could not be confirmed.",
      "Review the Codex configuration and retry before starting the proxy.",
      { committed: true, degraded: true, pending: false }
    ],
    [
      "CODEX_HISTORY_REPAIR_INVALID",
      400,
      "The Codex history repair input is invalid.",
      "Repair the Codex configuration or history state and try again."
    ],
    [
      "CODEX_HISTORY_REPAIR_CONFLICT",
      409,
      "Another Codex history repair transition is already pending.",
      "Complete or recover the pending Codex history repair before retrying."
    ],
    [
      "CODEX_HISTORY_REPAIR_FAILED",
      500,
      "Codex history repair could not be completed.",
      "Repair local Codex history storage and retry before starting the proxy."
    ],
    [
      "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED",
      500,
      "Codex configuration was updated, but history repair remains pending.",
      "Retry crp start to resume Codex history repair before using the proxy.",
      { committed: true, degraded: true, pending: true }
    ],
    [
      null,
      500,
      "Codex configuration could not be written safely.",
      "Repair local filesystem access and retry."
    ]
  ];

  for (const [code, status, message, action, expectedDetails = {}] of cases) {
    const privateMarker = `private-bootstrap-${code ?? "unknown"}`;
    const privateCause = new Error(`private-cause-${privateMarker}`);
    bootstrapFailure = code === "CODEX_CONFIG_BUSY"
      ? new CrpError(code, privateMarker, privateMarker, {
        status,
        details: { path: harness.paths.codexConfigPath },
        cause: privateCause
      })
      : new Error(`${privateMarker} ${harness.paths.codexConfigPath}`, {
        cause: privateCause
      });
    if (code !== null && !(bootstrapFailure instanceof CrpError)) {
      bootstrapFailure.code = code;
    }
    requestId = `request-${code ?? "write"}`;

    const received = await new Promise((resolvePromise, rejectPromise) => {
      const outgoing = http.request({
        host: address.host,
        port: address.port,
        path: "/api/v1/codex/bootstrap",
        method: "POST",
        headers: { authorization: `Bearer ${controlToken}` }
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolvePromise({
          status: response.statusCode,
          text: Buffer.concat(chunks).toString("utf8")
        }));
      });
      outgoing.once("error", rejectPromise);
      outgoing.end();
    });

    const serialized = received.text;
    for (const forbidden of [
      privateMarker,
      harness.paths.codexConfigPath,
      "private-cause",
      "cause",
      "stack"
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.equal(received.status, status);
    assert.deepEqual(JSON.parse(serialized), {
      error: {
        code: code ?? "CODEX_CONFIG_WRITE_FAILED",
        message,
        action,
        requestId,
        details: expectedDetails
      }
    });
  }
});

test("supervisor entry shares idempotent signal shutdown without exiting early", async () => {
  const processRef = new EventEmitter();
  processRef.exitCode = null;
  processRef.connected = true;
  let disconnectCalls = 0;
  processRef.disconnect = () => {
    disconnectCalls += 1;
    processRef.connected = false;
  };
  const closed = createGate();
  let closeCalls = 0;
  const supervisor = {
    async listen() {
      return { origin: "http://127.0.0.1:15101" };
    },
    close() {
      closeCalls += 1;
      return closed.promise;
    }
  };
  await runSupervisor({
    processRef,
    createSupervisorImpl: async () => supervisor,
    supervisorOptions: { home: "/unused/injected-home" }
  });
  assert.equal(disconnectCalls, 1);
  assert.equal(processRef.listenerCount("SIGTERM"), 1);
  assert.equal(processRef.listenerCount("SIGINT"), 1);
  processRef.emit("SIGTERM");
  processRef.emit("SIGINT");
  assert.equal(closeCalls, 1);
  assert.equal(processRef.exitCode, null);
  closed.resolve();
  await closed.promise;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(processRef.exitCode, 0);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
});

test("Supervisor Admin and signal shutdown share the same close-once coordinator", async (t) => {
  const adminCloseGate = createGate();
  const harness = supervisorDependencies(t, { adminCloseGate });
  harness.listenGate.resolve({
    host: "127.0.0.1",
    port: 15101,
    authority: "127.0.0.1:15101",
    origin: "http://127.0.0.1:15101"
  });
  const supervisor = await createSupervisor(harness.options);
  const processRef = new EventEmitter();
  processRef.exitCode = null;
  processRef.connected = false;
  await runSupervisor({
    processRef,
    createSupervisorImpl: async () => supervisor
  });

  const fromAdmin = harness.getAdminOptions().requestSupervisorShutdown();
  const direct = supervisor.requestShutdown();
  assert.equal(fromAdmin, direct);
  processRef.emit("SIGTERM");
  await Promise.resolve();
  assert.equal(harness.order.filter((entry) => entry === "admin.close").length, 1);
  assert.equal(processRef.exitCode, null);

  adminCloseGate.resolve();
  await fromAdmin;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  for (const operation of ["admin.close", "auth.close", "worker.close", "metrics.close"]) {
    assert.equal(harness.order.filter((entry) => entry === operation).length, 1);
  }
  assert.equal(processRef.exitCode, 0);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
  assert.equal(existsSync(harness.paths.statePath), false);
});

test("supervisor entry reports one sanitized startup failure over IPC", async () => {
  const secret = "startup-cause-must-not-cross-ipc";
  const failure = new CrpError(
    "MIGRATION_INPUT_INVALID",
    secret,
    secret,
    {
      status: 400,
      details: { reason: secret, privateValue: secret },
      cause: new Error(secret)
    }
  );
  const processRef = new EventEmitter();
  processRef.connected = true;
  processRef.exitCode = null;
  const sent = [];
  const events = [];
  const sendObserved = createGate();
  let sendCallback = null;
  let disconnectCalls = 0;
  processRef.send = (message, _handle, _options, callback) => {
    sent.push(structuredClone(message));
    events.push("send");
    sendCallback = callback;
    sendObserved.resolve();
    return true;
  };
  processRef.disconnect = () => {
    disconnectCalls += 1;
    events.push("disconnect");
    processRef.connected = false;
  };

  const startup = runSupervisor({
    processRef,
    createSupervisorImpl: async () => { throw failure; }
  });
  await sendObserved.promise;
  assert.equal(disconnectCalls, 0);
  assert.equal(typeof sendCallback, "function");
  events.push("callback");
  sendCallback(null);
  const caught = await startup.then(
    () => null,
    (error) => error
  );

  const serialized = JSON.stringify(sent);
  assert.equal(serialized.includes(secret), false);
  assert.equal(caught === failure, true);
  assert.deepEqual(sent, [{
    version: 1,
    type: "startup-failed",
    error: {
      code: "MIGRATION_INPUT_INVALID",
      message: "The legacy provider configuration is invalid.",
      action: "Restore a complete legacy provider URL and credential before migrating.",
      status: 400,
      details: {}
    }
  }]);
  assert.equal(disconnectCalls, 1);
  assert.deepEqual(events, ["send", "callback", "disconnect"]);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
});

test("supervisor entry maps an unknown startup error to a static IPC failure", async () => {
  const secret = "unknown-startup-error-must-not-cross-ipc";
  const processRef = new EventEmitter();
  processRef.connected = true;
  const sent = [];
  let closeCalls = 0;
  let disconnectCalls = 0;
  processRef.send = (message, _handle, _options, callback) => {
    sent.push(structuredClone(message));
    callback?.(null);
    return true;
  };
  processRef.disconnect = () => {
    disconnectCalls += 1;
    processRef.connected = false;
  };

  const caught = await runSupervisor({
      processRef,
      createSupervisorImpl: async () => ({
        async listen() { throw new Error(secret); },
        async close() { closeCalls += 1; }
      })
    }).then(
      () => null,
      (error) => error
    );

  const serialized = JSON.stringify(sent);
  assert.equal(serialized.includes(secret), false);
  assert.equal(caught?.message === secret, true);
  assert.deepEqual(sent, [{
    version: 1,
    type: "startup-failed",
    error: {
      code: "SUPERVISOR_START_FAILED",
      message: "The local supervisor could not be started.",
      action: "Review the supervisor log and try again.",
      status: 500,
      details: {}
    }
  }]);
  assert.equal(closeCalls, 1);
  assert.equal(disconnectCalls, 1);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
});
