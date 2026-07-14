import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import http from "node:http";
import os from "node:os";
import { join } from "node:path";

import { createAdminServer } from "../../src/supervisor/admin-server.mjs";
import { SessionAuth } from "../../src/supervisor/session-auth.mjs";
import { createSupervisor } from "../../src/supervisor/supervisor.mjs";
import { runSupervisor } from "../../src/supervisor/supervisor-entry.mjs";
import { getPaths } from "../../src/shared/paths.mjs";
import { CrpError } from "../../src/shared/errors.mjs";

const SECRET = "admin-api-complete-secret-sentinel";
const CREDENTIAL_REF = "credential-ref-must-not-pass";

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
    async testProvider(id, model) {
      calls.push(["testProvider", id, model]);
      return { ok: true, code: null, apiKey: SECRET };
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
  const codexService = {
    async bootstrap() {
      calls.push(["bootstrap"]);
      return { changed: true, backupPath: `/private/${SECRET}` };
    },
    async getStatus() {
      return { configured: true, modelProvider: "OpenAI", proxyUrl: "http://127.0.0.1:15100" };
    }
  };
  const diagnosticsService = {
    async exportDiagnostics() {
      calls.push(["diagnostics"]);
      return { created: true, apiKey: SECRET, credentialRef: CREDENTIAL_REF };
    }
  };
  return {
    calls,
    providerService,
    activityStore,
    settingsService,
    codexService,
    diagnosticsService
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
        path: `${target.pathname}${target.search}`,
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

test("routes every approved Admin API operation through injected services", async (t) => {
  const harness = await createHarness(t);
  const authHeaders = bearer(harness);
  const requests = [
    ["GET", "/api/v1/status", undefined, 200],
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
    ["POST", "/api/v1/providers/provider-2/test", { model: "test-model" }, 200],
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
  assert.equal(harness.calls.some((call) => call[0] === "updateSettings"), false);
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

function supervisorDependencies(t, { listenGate = createGate() } = {}) {
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
      return Promise.resolve();
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
  const auth = {
    close() { order.push("auth.close"); }
  };
  const admin = {
    async listen() {
      order.push("admin.listen");
      return await listenGate.promise;
    },
    close() {
      order.push("admin.close");
      return Promise.resolve();
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
    workerManagerFactory: () => {
      order.push("worker");
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
      assert.equal(input.auth, auth);
      assert.equal(input.providerService, provider);
      return admin;
    }
  };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, paths, order, worker, admin, listenGate, registry, options };
}

test("supervisor migrates before registry construction and writes private state only after ready", async (t) => {
  const harness = supervisorDependencies(t);
  const supervisor = await createSupervisor(harness.options);
  assert.deepEqual(harness.order, [
    "activity",
    "credential",
    "migration",
    "registry",
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
  assert.deepEqual(harness.order.slice(-3), ["admin.close", "auth.close", "worker.close"]);
  assert.equal(existsSync(harness.paths.statePath), false);
});

test("supervisor cleans up in reverse order when Admin readiness fails", async (t) => {
  const harness = supervisorDependencies(t);
  const supervisor = await createSupervisor(harness.options);
  const failure = new Error(`private listen failure ${SECRET}`);
  harness.listenGate.reject(failure);
  await assert.rejects(() => supervisor.listen(), (error) => error === failure);
  assert.deepEqual(harness.order.slice(-3), ["admin.close", "auth.close", "worker.close"]);
  assert.equal(existsSync(harness.paths.statePath), false);
});

test("supervisor cleans constructed resources when composition fails before listen", async (t) => {
  const harness = supervisorDependencies(t);
  const failure = new Error(`private composition failure ${SECRET}`);
  harness.options.adminServerFactory = () => {
    harness.order.push("admin");
    throw failure;
  };
  await assert.rejects(() => createSupervisor(harness.options), (error) => error === failure);
  assert.deepEqual(harness.order.slice(-2), ["auth.close", "worker.close"]);
  assert.equal(existsSync(harness.paths.statePath), false);
});

test("supervisor keeps Codex and state filesystem adapters independent", async (t) => {
  const harness = supervisorDependencies(t);
  const codexFileOperations = { boundary: "codex-only" };
  let bootstrapInput = null;
  let codexService = null;
  harness.options.codexFileOperations = codexFileOperations;
  harness.options.bootstrapCodex = (input) => {
    bootstrapInput = input;
    return { changed: false, backupPath: null };
  };
  harness.options.adminServerFactory = (input) => {
    harness.order.push("admin");
    codexService = input.codexService;
    return harness.admin;
  };
  const supervisor = await createSupervisor(harness.options);
  assert.deepEqual(codexService.bootstrap(), { changed: false, backupPath: null });
  assert.equal(bootstrapInput.fileOperations, codexFileOperations);
  assert.equal(bootstrapInput.configPath, harness.paths.codexConfigPath);
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
      null,
      500,
      "Codex configuration could not be written safely.",
      "Repair local filesystem access and retry."
    ]
  ];

  for (const [code, status, message, action] of cases) {
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
        details: {}
      }
    });
  }
});

test("supervisor entry shares idempotent signal shutdown without exiting early", async () => {
  const processRef = new EventEmitter();
  processRef.exitCode = null;
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
