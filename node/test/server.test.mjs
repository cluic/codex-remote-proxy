import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import { DatabaseSync } from "node:sqlite";

import { buildTargetUrl, createApp, createServer, isDirectExecution, loadConfig } from "../src/server.mjs";
import { RuntimeSettingsSource } from "../src/worker/runtime-settings.mjs";

function makeTempDir(prefix) {
  return join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function listen(server, host = "127.0.0.1") {
  return new Promise((resolvePromise, rejectPromise) => {
    server.listen(0, host, () => {
      const address = server.address();
      resolvePromise(address.port);
    });
    server.once("error", rejectPromise);
  });
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  const closed = once(server, "close");
  server.close();
  await closed;
}

function createGate() {
  let release;
  const promise = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release };
}

function createSignal() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function withDeadline(promise, message, timeoutMs = 2000) {
  let timer;
  const timeout = new Promise((_, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function makeSettings({
  baseUrl,
  apiKey = "test-api-key",
  authHeader = "authorization",
  authScheme = "Bearer",
  extraHeaders = {},
  timeoutMs = 300000,
  verifySsl = true,
  requestIdHeader = "x-client-request-id",
  modelMode = "passthrough",
  modelOverride = null,
  logLevel = "info",
  captureEnabled = true,
  routingMode = "custom_only",
  accountState = {
    authMode: null,
    quotaStatus: "unknown",
    blockedUntil: null,
    updatedAt: null
  }
}) {
  return {
    configPath: "/tmp/crp-task5-proxy-config.json",
    server: {
      host: "127.0.0.1",
      port: 0,
      logLevel
    },
    upstream: {
      baseUrl,
      apiKey,
      timeoutMs,
      verifySsl,
      authHeader,
      authScheme,
      extraHeaders
    },
    proxy: {
      overrideAuthorization: true,
      requestIdHeader,
      modelMode,
      modelOverride
    },
    capture: {
      enabled: captureEnabled,
      dbPath: "/tmp/crp-task5-traffic.sqlite3"
    },
    routing: {
      mode: routingMode,
      accountRevision: 1,
      account: structuredClone(accountState)
    }
  };
}

function createMemoryCaptureManager(publicState = {}) {
  const records = [];
  return {
    records,
    beginRecord() {
      let saved = false;
      return {
        save(record) {
          if (!saved) {
            saved = true;
            records.push(record);
          }
        }
      };
    },
    getPublicState() {
      return {
        captureConfigured: true,
        captureActive: true,
        ...publicState
      };
    },
    close() {}
  };
}

function createInactiveCaptureManager(publicState = {}) {
  return {
    beginRecord() {
      return null;
    },
    getPublicState() {
      return {
        captureConfigured: false,
        captureActive: false,
        ...publicState
      };
    },
    close() {}
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  return {
    status: response.status,
    body: await response.json()
  };
}

function requestJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local-secret",
      "x-client-request-id": "req-it-1",
      "thread-id": "thread-it-1"
    },
    body: JSON.stringify(body)
  });
}

function completedResponse(extra = {}) {
  return {
    id: "resp_test",
    object: "response",
    status: "completed",
    output: [],
    ...extra
  };
}

test("buildTargetUrl joins base and request paths with one separator", () => {
  const cases = [
    {
      baseUrl: "https://api.example.test/",
      requestUrl: "/responses?model=gpt%2F5",
      expected: "https://api.example.test/responses?model=gpt%2F5"
    },
    {
      baseUrl: "https://api.example.test/v1",
      requestUrl: "/responses",
      expected: "https://api.example.test/v1/responses"
    },
    {
      baseUrl: "https://api.example.test/v1/",
      requestUrl: "/responses",
      expected: "https://api.example.test/v1/responses"
    },
    {
      baseUrl: "https://api.example.test/v1/",
      requestUrl: "/",
      expected: "https://api.example.test/v1/"
    },
    {
      baseUrl: "https://api.example.test/v1/",
      requestUrl: "/responses/%2Fencoded?cursor=a%2Fb&space=a%20b",
      expected: "https://api.example.test/v1/responses/%2Fencoded?cursor=a%2Fb&space=a%20b"
    }
  ];

  for (const { baseUrl, requestUrl, expected } of cases) {
    assert.equal(buildTargetUrl(baseUrl, requestUrl).href, expected);
  }
});

test("buildTargetUrl preserves base query parameters without forwarding fragments", () => {
  assert.equal(
    buildTargetUrl(
      "https://api.example.test/v1?tenant=one%20two#section",
      "/responses?model=gpt%2F5"
    ).href,
    "https://api.example.test/v1/responses?tenant=one%20two&model=gpt%2F5"
  );
});

test("custom-only routing strips Codex account credentials before nonstandard provider auth", async (t) => {
  const observedSignal = createSignal();
  const metricSignal = createSignal();
  const metrics = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      observedSignal.resolve({
        hasAccountAuthorization: Object.hasOwn(req.headers, "authorization"),
        hasAccountId: Object.hasOwn(req.headers, "chatgpt-account-id"),
        customAuthMatches: req.headers["x-provider-auth"] === "Bearer custom-token-sentinel"
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completedResponse()));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: "custom-token-sentinel",
    authHeader: "x-provider-auth",
    captureEnabled: false,
    routingMode: "custom_only"
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 1, settings });
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    logFn() {},
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
      metricSignal.resolve();
    }
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer account-token-sentinel",
      "chatgpt-account-id": "account-id-sentinel"
    },
    body: JSON.stringify({ model: "account-id-sentinel", input: "hello" })
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const observed = await withDeadline(observedSignal.promise, "custom request was not observed");
  await withDeadline(metricSignal.promise, "custom metric was not observed");
  assert.equal(observed.hasAccountAuthorization, false);
  assert.equal(observed.hasAccountId, false);
  assert.equal(observed.customAuthMatches, true);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].model, null);
});

test("custom routing strips Codex account credentials when provider authorization passthrough is disabled", async (t) => {
  const observed = createSignal();
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      observed.resolve({
        hasAuthorization: Object.hasOwn(req.headers, "authorization"),
        hasAccountId: Object.hasOwn(req.headers, "chatgpt-account-id")
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completedResponse()));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false,
    routingMode: "custom_only"
  });
  settings.proxy.overrideAuthorization = false;
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 1, settings });
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer account-token-sentinel",
      "chatgpt-account-id": "account-id-sentinel"
    },
    body: JSON.stringify({ model: "client-account-model" })
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.deepEqual(
    await withDeadline(observed.promise, "custom request was not observed"),
    { hasAuthorization: false, hasAccountId: false }
  );
});

test("account-first sends eligible Responses traffic to the fixed Codex route", async (t) => {
  const accountObserved = createSignal();
  let customRequests = 0;
  const account = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      accountObserved.resolve({
        path: req.url,
        authorizationMatches: req.headers.authorization === "Bearer account-token-sentinel",
        accountMatches: req.headers["chatgpt-account-id"] === "account-id-sentinel",
        hasCustomAuth: Object.hasOwn(req.headers, "x-provider-auth"),
        hasCustomExtra: Object.hasOwn(req.headers, "x-provider-extra"),
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      });
      res.setHeader("content-type", "application/json");
      res.setHeader("x-codex-primary-used-percent", "35");
      res.setHeader("x-codex-primary-window-minutes", "300");
      res.end(JSON.stringify(completedResponse({
        usage: { input_tokens: 11, output_tokens: 4 }
      })));
    });
  });
  const accountPort = await listen(account);
  t.after(() => closeServer(account));
  const custom = http.createServer((_req, res) => {
    customRequests += 1;
    res.statusCode = 500;
    res.end();
  });
  const customPort = await listen(custom);
  t.after(() => closeServer(custom));

  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${customPort}/v1`,
    apiKey: "custom-token-sentinel",
    authHeader: "x-provider-auth",
    extraHeaders: { "x-provider-extra": "custom-extra-sentinel" },
    captureEnabled: false,
    routingMode: "account_first",
    accountState: {
      authMode: "chatgpt",
      quotaStatus: "available",
      blockedUntil: null,
      updatedAt: "2026-08-20T00:00:00.000Z"
    }
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 1, settings });
  const metricObserved = createSignal();
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    logFn() {},
    routingNow: () => Date.parse("2026-08-20T00:01:00.000Z"),
    resolveAccountTarget(target) {
      const local = new URL(`http://127.0.0.1:${accountPort}`);
      local.pathname = target.pathname;
      local.search = target.search;
      return local;
    },
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
      metricObserved.resolve();
    }
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const response = await fetch(`http://127.0.0.1:${proxyPort}/responses?stream=false`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer account-token-sentinel",
      "chatgpt-account-id": "account-id-sentinel",
      "x-provider-auth": "client-custom-auth-sentinel"
    },
    body: JSON.stringify({ model: "client-account-model", input: "hello" })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "completed");
  const observed = await withDeadline(accountObserved.promise, "account request was not observed");
  await withDeadline(metricObserved.promise, "account metric was not observed");

  assert.deepEqual(observed, {
    path: "/backend-api/codex/responses?stream=false",
    authorizationMatches: true,
    accountMatches: true,
    hasCustomAuth: false,
    hasCustomExtra: false,
    body: { model: "client-account-model", input: "hello" }
  });
  assert.equal(customRequests, 0);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].route, "account");
  assert.equal(metrics[0].model, "client-account-model");
});

test("account 429 replays once to custom API, rewrites its model, and activates cooldown", async (t) => {
  let accountRequests = 0;
  const accountBodies = [];
  const account = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      accountRequests += 1;
      accountBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.statusCode = 429;
      res.setHeader("x-codex-primary-used-percent", "100");
      res.setHeader("x-codex-primary-reset-after-seconds", "60");
      res.end(JSON.stringify({ error: { type: "rate_limit" } }));
    });
  });
  const accountPort = await listen(account);
  t.after(() => closeServer(account));

  const customObserved = [];
  const custom = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      customObserved.push({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        customAuthMatches: req.headers["x-provider-auth"] === "Bearer custom-token-sentinel",
        customExtraMatches: req.headers["x-provider-extra"] === "custom-extra-sentinel",
        hasAccountAuthorization: Object.hasOwn(req.headers, "authorization"),
        hasAccountId: Object.hasOwn(req.headers, "chatgpt-account-id")
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completedResponse({
        usage: { input_tokens: 9, output_tokens: 3 }
      })));
    });
  });
  const customPort = await listen(custom);
  t.after(() => closeServer(custom));

  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${customPort}/v1`,
    apiKey: "custom-token-sentinel",
    authHeader: "x-provider-auth",
    extraHeaders: { "x-provider-extra": "custom-extra-sentinel" },
    modelMode: "override",
    modelOverride: "custom-provider-model",
    captureEnabled: false,
    routingMode: "account_first",
    accountState: {
      authMode: "chatgpt",
      quotaStatus: "available",
      blockedUntil: null,
      updatedAt: "2026-08-20T00:00:00.000Z"
    }
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 2, settings });
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    logFn() {},
    routingNow: () => Date.parse("2026-08-20T00:01:00.000Z"),
    resolveAccountTarget(target) {
      const local = new URL(`http://127.0.0.1:${accountPort}`);
      local.pathname = target.pathname;
      local.search = target.search;
      return local;
    },
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
    }
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const send = (input) => fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer account-token-sentinel",
      "chatgpt-account-id": "account-id-sentinel"
    },
    body: JSON.stringify({ model: "client-account-model", input })
  });
  for (const input of ["first", "second"]) {
    const response = await send(input);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(accountRequests, 1);
  assert.deepEqual(accountBodies, [{ model: "client-account-model", input: "first" }]);
  assert.deepEqual(customObserved, [
    {
      body: { model: "custom-provider-model", input: "first" },
      customAuthMatches: true,
      customExtraMatches: true,
      hasAccountAuthorization: false,
      hasAccountId: false
    },
    {
      body: { model: "custom-provider-model", input: "second" },
      customAuthMatches: true,
      customExtraMatches: true,
      hasAccountAuthorization: false,
      hasAccountId: false
    }
  ]);
  assert.deepEqual(metrics.map(({ route, model }) => ({ route, model })), [
    { route: "custom", model: "custom-provider-model" },
    { route: "custom", model: "custom-provider-model" }
  ]);
});

test("account authentication and upstream failures are returned without custom fallback", async (t) => {
  const statuses = [401, 503];
  let accountRequests = 0;
  let customRequests = 0;
  const account = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = statuses[accountRequests++];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { type: "account-upstream" } }));
    });
  });
  const accountPort = await listen(account);
  t.after(() => closeServer(account));
  const custom = http.createServer((_req, res) => {
    customRequests += 1;
    res.statusCode = 200;
    res.end();
  });
  const customPort = await listen(custom);
  t.after(() => closeServer(custom));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${customPort}`,
    captureEnabled: false,
    routingMode: "account_first"
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 3, settings });
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    logFn() {},
    resolveAccountTarget(target) {
      const local = new URL(`http://127.0.0.1:${accountPort}`);
      local.pathname = target.pathname;
      return local;
    }
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  for (const expected of statuses) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer account-token-sentinel",
        "chatgpt-account-id": "account-id-sentinel"
      },
      body: JSON.stringify({ model: "client-account-model" })
    });
    assert.equal(response.status, expected);
    await response.arrayBuffer();
  }
  assert.equal(accountRequests, 2);
  assert.equal(customRequests, 0);
});

test("account network failures do not switch to the custom API", async (t) => {
  const unavailable = http.createServer();
  const unavailablePort = await listen(unavailable);
  await closeServer(unavailable);
  let customRequests = 0;
  const custom = http.createServer((_req, res) => {
    customRequests += 1;
    res.statusCode = 200;
    res.end();
  });
  const customPort = await listen(custom);
  t.after(() => closeServer(custom));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${customPort}`,
    captureEnabled: false,
    routingMode: "account_first"
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 4, settings });
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    logFn() {},
    resolveAccountTarget(target) {
      const local = new URL(`http://127.0.0.1:${unavailablePort}`);
      local.pathname = target.pathname;
      return local;
    }
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer account-token-sentinel",
      "chatgpt-account-id": "account-id-sentinel"
    },
    body: JSON.stringify({ model: "client-account-model" })
  });
  assert.equal(response.status, 502);
  await response.arrayBuffer();
  assert.equal(customRequests, 0);
});

test("server writes proxied request and response to sqlite", async () => {
  const dir = makeTempDir("crp-server");
  mkdirSync(dir, { recursive: true });

  const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const payload = Buffer.concat(chunks).toString("utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("x-request-id", "upstream-test-1");
      res.setHeader("x-provider-auth", "response-upstream-secret");
      res.end(JSON.stringify({ ok: true, echoed: JSON.parse(payload) }));
    });
  });
  const upstreamPort = await listen(upstreamServer);

  const runtimeConfigPath = join(dir, "proxy-config.json");
  const dbPath = join(dir, "traffic.sqlite3");
  writeFileSync(runtimeConfigPath, `${JSON.stringify({
    server: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "info"
    },
    upstream: {
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "upstream-secret",
      timeoutMs: 300000,
      verifySsl: true,
      authHeader: "x-provider-auth",
      authScheme: "Bearer",
      extraHeaders: {}
    },
    proxy: {
      overrideAuthorization: true,
      requestIdHeader: "x-client-request-id"
    },
    capture: {
      enabled: true,
      dbPath
    }
  }, null, 2)}\n`, "utf8");

  const { server, captureManager } = createApp({
    configPath: runtimeConfigPath,
    server: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "info"
    },
    upstream: {
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "upstream-secret",
      timeoutMs: 300000,
      verifySsl: true,
      authHeader: "x-provider-auth",
      authScheme: "Bearer",
      extraHeaders: {}
    },
    proxy: {
      overrideAuthorization: true,
      requestIdHeader: "x-client-request-id"
    },
    capture: {
      enabled: true,
      dbPath
    }
  });
  const proxyPort = await listen(server);

  const response = await requestJson(`http://127.0.0.1:${proxyPort}/responses`, {
    message: "hello"
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);

  server.close();
  await once(server, "close");
  upstreamServer.close();
  await once(upstreamServer, "close");

  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT * FROM http_transactions").all();
  db.close();
  captureManager.close();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_id, "req-it-1");
  assert.equal(rows[0].thread_id, "thread-it-1");
  assert.equal(rows[0].upstream_request_id, "upstream-test-1");
  assert.match(rows[0].request_headers_json, /REDACTED/);
  assert.doesNotMatch(rows[0].request_headers_json, /upstream-secret/);
  assert.match(rows[0].response_headers_json, /REDACTED/);
  assert.doesNotMatch(rows[0].response_headers_json, /response-upstream-secret/);
  assert.match(rows[0].response_body, /"ok":true/);

  rmSync(dir, { recursive: true, force: true });
});

test("large Capture bodies preserve totals while omitting prefixes that cannot be fully screened", async (t) => {
  const dir = makeTempDir("crp-server-large-capture");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const responseBody = Buffer.from(JSON.stringify(completedResponse({
    padding: "r".repeat(2 * 1024 * 1024),
    usage: { input_tokens: 71, output_tokens: 29 }
  })));
  let requestBytes = 0;
  const upstream = http.createServer((req, res) => {
    req.on("data", (chunk) => {
      requestBytes += chunk.length;
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.setHeader("content-length", String(responseBody.length));
      res.end(responseBody);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const dbPath = join(dir, "traffic.sqlite3");
  const settings = makeSettings({ baseUrl: `http://127.0.0.1:${upstreamPort}` });
  settings.configPath = join(dir, "proxy-config.json");
  settings.capture.dbPath = dbPath;
  writeFileSync(settings.configPath, JSON.stringify({ capture: settings.capture }));
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 19, settings });
  const metrics = [];
  const metricRecorded = createSignal();
  const app = createApp(settings, {
    settingsSource: source,
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
      metricRecorded.resolve();
    }
  });
  const proxyPort = await listen(app.server);
  t.after(() => closeServer(app.server));
  const requestBody = Buffer.from(JSON.stringify({
    padding: "q".repeat(1536 * 1024),
    model: "large-capture-model"
  }));
  const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody
  });
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, responseBody.length);
  await withDeadline(metricRecorded.promise, "large Capture request did not finish settlement");
  await closeServer(app.server);

  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT * FROM http_transactions").get();
  db.close();
  assert.equal(requestBytes, requestBody.length);
  assert.equal(row.request_body_encoding, "empty-truncated");
  assert.equal(row.request_body_bytes, requestBody.length);
  assert.equal(Buffer.byteLength(row.request_body), 0);
  assert.equal(row.response_body_encoding, "empty-truncated");
  assert.equal(row.response_body_bytes, responseBody.length);
  assert.equal(Buffer.byteLength(row.response_body), 0);
  assert.deepEqual(metrics.map(({ result, model, inputTokens, outputTokens }) => ({
    result,
    model,
    inputTokens,
    outputTokens
  })), [{
    result: "success",
    model: "large-capture-model",
    inputTokens: 71,
    outputTokens: 29
  }]);
});

test("isDirectExecution handles both POSIX and Windows paths", () => {
  assert.equal(
    isDirectExecution("file:///Users/example/project/node/src/server.mjs", "/Users/example/project/node/src/server.mjs"),
    true
  );
  assert.equal(
    isDirectExecution("file:///C:/Users/Xingh/project/node/src/server.mjs", "C:\\Users\\Xingh\\project\\node\\src\\server.mjs"),
    true
  );
  assert.equal(
    isDirectExecution("file:///c:/Users/Xingh/project/node/src/server.mjs", "C:/Users/Xingh/project/node/src/server.mjs"),
    true
  );
  assert.equal(
    isDirectExecution("file:///C:/Users/Xingh/project/node/src/server.mjs", "C:\\Users\\Xingh\\project\\node\\src\\other.mjs"),
    false
  );
});

test("standalone config defaults model passthrough and rejects unsafe overrides", (t) => {
  const dir = makeTempDir("crp-server-model-config");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "proxy-config.json");
  const base = {
    upstream: {
      baseUrl: "https://provider.example.test/v1",
      apiKey: "config-secret"
    },
    proxy: {}
  };
  writeFileSync(configPath, JSON.stringify(base));
  assert.deepEqual(
    (({ modelMode, modelOverride }) => ({ modelMode, modelOverride }))(loadConfig(configPath).proxy),
    { modelMode: "passthrough", modelOverride: null }
  );

  writeFileSync(configPath, JSON.stringify({
    ...base,
    proxy: { modelMode: "override", modelOverride: "unsafe\nmodel" }
  }));
  assert.throws(() => loadConfig(configPath), /proxy\.modelOverride/);
});

test("model override preserves compressed forwarding while Capture omits opaque protected bodies", async (t) => {
  const observed = createSignal();
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      observed.resolve({
        contentEncoding: req.headers["content-encoding"],
        contentLength: req.headers["content-length"],
        body,
        json: JSON.parse(zlib.gunzipSync(body).toString("utf8"))
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completedResponse()));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    modelMode: "override",
    modelOverride: "provider-model"
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 7, settings });
  const captureManager = createMemoryCaptureManager();
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager,
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const original = zlib.gzipSync(Buffer.from(JSON.stringify({
    model: "client-model",
    input: "keep-me",
    stream: false
  })));
  const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(original.length)
    },
    body: original
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();

  const forwarded = await observed.promise;
  assert.equal(forwarded.contentEncoding, "gzip");
  assert.equal(Number(forwarded.contentLength), forwarded.body.length);
  assert.deepEqual(forwarded.json, {
    model: "provider-model",
    input: "keep-me",
    stream: false
  });
  assert.equal(captureManager.records.length, 1);
  assert.equal(captureManager.records[0].requestBody.length, 0);
  assert.equal(captureManager.records[0].requestBodyTruncated, true);
  assert.equal(captureManager.records[0].requestBodyBytes, forwarded.body.length);
  assert.deepEqual(metrics.map(({ result, model }) => ({ result, model })), [
    { result: "success", model: "provider-model" }
  ]);
});

test("model override changes only top-level model lexemes and strips stale integrity headers", async (t) => {
  const observed = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observed.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completedResponse()));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    modelMode: "override",
    modelOverride: "provider-model",
    captureEnabled: false
  });
  const proxy = createServer(settings, {
    captureManager: createInactiveCaptureManager(),
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));
  const source = [
    "{\n",
    "  \"large\": 9007199254740993123456789,\n",
    "  \"overflow\": 1e400,\n",
    "  \"negativeZero\": -0,\n",
    "  \"duplicate\": 1, \"duplicate\": 2,\n",
    "  \"model\": \"client-a\",\n",
    "  \"nested\": {\"model\":\"keep-nested\"},\n",
    "  \"model\": \"client-b\"\n",
    "}"
  ].join("");
  const expected = source
    .replace('"model": "client-a"', '"model": "provider-model"')
    .replace('"model": "client-b"', '"model": "provider-model"');
  const absent = '{"large":9007199254740993123456789,"value":-0\n}';
  const absentExpected = `${absent.slice(0, -1)},"model":"provider-model"}`;

  for (const body of [source, absent]) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-md5": "stale-md5",
        digest: "sha-256=stale",
        "content-digest": "sha-256=:stale:",
        "repr-digest": "sha-256=:stale:",
        signature: "sig1=:stale:",
        "signature-input": "sig1=(\"content-digest\")"
      },
      body
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const invalid = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"model":"client","broken":}'
  });
  assert.equal(invalid.status, 400);
  assert.equal(observed.length, 2);
  assert.equal(observed[0].body, expected);
  assert.equal(observed[1].body, absentExpected);
  assert.match(observed[0].body, /"nested": \{"model":"keep-nested"\}/);
  for (const { headers } of observed) {
    for (const name of [
      "content-md5",
      "digest",
      "content-digest",
      "repr-digest",
      "signature",
      "signature-input"
    ]) {
      assert.equal(headers[name], undefined, `${name} survived a body rewrite`);
    }
  }
});

test("zstd override falls back to identity forwarding when native Node compression is unavailable", async (t) => {
  const compressed = Buffer.from(
    "KLUv/SAnOQEAeyJtb2RlbCI6ImNsaWVudC1tb2RlbCIsImlucHV0Ijoia2VlcCJ9",
    "base64"
  );
  const observed = createSignal();
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observed.resolve({
        encoding: req.headers["content-encoding"] ?? null,
        length: req.headers["content-length"],
        body: Buffer.concat(chunks).toString("utf8")
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completedResponse()));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    modelMode: "override",
    modelOverride: "provider-model",
    captureEnabled: false
  });
  const proxy = createServer(settings, {
    captureManager: createInactiveCaptureManager(),
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));
  const nativeCompress = zlib.zstdCompressSync;
  const nativeDecompress = zlib.zstdDecompressSync;
  zlib.zstdCompressSync = undefined;
  zlib.zstdDecompressSync = undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd"
      },
      body: compressed
    });
    await response.arrayBuffer();
  } finally {
    zlib.zstdCompressSync = nativeCompress;
    zlib.zstdDecompressSync = nativeDecompress;
  }
  assert.deepEqual(await observed.promise, {
    encoding: null,
    length: String(Buffer.byteLength('{"model":"provider-model","input":"keep"}')),
    body: '{"model":"provider-model","input":"keep"}'
  });
});

test("oversized model override requests fail before any upstream request", async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    req.resume();
    res.end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    modelMode: "override",
    modelOverride: "provider-model",
    captureEnabled: false
  });
  const proxy = createServer(settings, {
    captureManager: createInactiveCaptureManager(),
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const expanded = Buffer.from(JSON.stringify({
    model: "client-model",
    padding: "x".repeat(8 * 1024 * 1024)
  }));
  for (const [body, contentEncoding] of [
    [Buffer.alloc((8 * 1024 * 1024) + 1, 0x20), null],
    [zlib.gzipSync(expanded), "gzip"]
  ]) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(contentEncoding ? { "content-encoding": contentEncoding } : {})
      },
      body
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.type, "proxy_request_too_large");
  }
  assert.equal(upstreamHits, 0);
});

test("metric model inspection handles large JSON and rejects invalid UTF-8", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url.includes("invalid")) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: "invalid" } }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completedResponse()));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 11, settings });
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const largeResponse = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=large`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(96 * 1024), model: "model-after-64k" })
  });
  await largeResponse.arrayBuffer();

  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"model":"must-not-be-recorded","padding":"'),
    Buffer.from([0xff]),
    Buffer.from('"}')
  ]);
  const invalidResponse = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=invalid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: invalidUtf8
  });
  await invalidResponse.arrayBuffer();

  assert.deepEqual(metrics.map(({ result, model }) => ({ result, model })), [
    { result: "success", model: "model-after-64k" },
    { result: "upstreamRejected", model: null }
  ]);
});

test("compressed request model inspection covers 1-8 MiB and reports larger bodies as unknown", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completedResponse()));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 22, settings });
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));
  const decoded = Buffer.from(JSON.stringify({
    padding: "x".repeat(1280 * 1024),
    model: "compressed-large-model"
  }));
  const encodings = [
    ["gzip", (body) => zlib.gzipSync(body)],
    ["deflate", (body) => zlib.deflateSync(body)],
    ["br", (body) => zlib.brotliCompressSync(body)],
    ["zstd", () => Buffer.from([
      "KLUv/aAvABQArAAAaHsicGFkZGluZyI6IngBAPD/OfgCAgAQeAIAEHgCABB4AgAQeAIAEHgCABB4",
      "AgAQeAIAEHgCABB4XQEARAJ4IiwibW9kZWwiOiJjb21wcmVzc2VkLWxhcmdlLW1vZGVsIn0BAAYQ",
      "Ag=="
    ].join(""), "base64")]
  ];
  for (const [encoding, compress] of encodings) {
    const compressed = compress(decoded);
    const nativeZstd = zlib.zstdDecompressSync;
    if (encoding === "zstd") zlib.zstdDecompressSync = undefined;
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": encoding
        },
        body: compressed
      });
      await response.arrayBuffer();
    } finally {
      if (encoding === "zstd") zlib.zstdDecompressSync = nativeZstd;
    }
  }
  const beyondCeiling = zlib.gzipSync(Buffer.from(JSON.stringify({
    padding: "y".repeat((8 * 1024 * 1024) + 1024),
    model: "must-be-unknown"
  })));
  const beyondResponse = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip"
    },
    body: beyondCeiling
  });
  await beyondResponse.arrayBuffer();

  assert.deepEqual(metrics.map(({ result, model }) => ({ result, model })), [
    ...encodings.map(() => ({ result: "success", model: "compressed-large-model" })),
    { result: "success", model: null }
  ]);
});

test("dynamic requests capture current settings exactly once before body listeners", () => {
  const settings = makeSettings({ baseUrl: "http://127.0.0.1:9" });
  const runtime = new RuntimeSettingsSource();
  runtime.apply({ generation: 1, settings });
  const events = [];
  const settingsSource = {
    current() {
      events.push("current");
      return runtime.current();
    },
    publicState() {
      return runtime.publicState();
    }
  };
  const server = createServer(settings, {
    settingsSource,
    captureManager: createMemoryCaptureManager(),
    logFn() {}
  });
  const req = new EventEmitter();
  const originalOn = req.on.bind(req);
  req.on = (eventName, listener) => {
    if (eventName === "data" || eventName === "end") {
      events.push(`on:${eventName}`);
    }
    return originalOn(eventName, listener);
  };
  Object.assign(req, {
    url: "/responses",
    method: "POST",
    headers: {},
    rawHeaders: []
  });
  const res = {
    statusCode: 200,
    setHeader() {},
    end() {},
    on() {},
    appendHeader() {}
  };

  server.emit("request", req, res);

  assert.deepEqual(events, ["current", "on:data", "on:end"]);
});

test("TLS and timeout options stay pinned when settings change before the request body", async (t) => {
  const settingsA = makeSettings({
    baseUrl: "https://a.example.test:4443",
    timeoutMs: 1111,
    verifySsl: false
  });
  const settingsB = makeSettings({
    baseUrl: "https://b.example.test:5443",
    timeoutMs: 2222,
    verifySsl: true
  });
  const runtime = new RuntimeSettingsSource();
  runtime.apply({ generation: 1, settings: settingsA });
  const captured = createSignal();
  const settingsSource = {
    current() {
      const active = runtime.current();
      captured.resolve();
      return active;
    },
    publicState() {
      return runtime.publicState();
    }
  };
  const observed = {};
  const originalHttpsRequest = https.request;
  t.after(() => {
    https.request = originalHttpsRequest;
  });
  https.request = (options, onResponse) => {
    Object.assign(observed, options);
    const request = new EventEmitter();
    request.setTimeout = (timeoutMs) => {
      observed.timeoutMs = timeoutMs;
    };
    request.destroy = (error) => request.emit("error", error);
    request.write = () => true;
    request.end = () => {
      const response = Readable.from([Buffer.from(JSON.stringify({ ok: true }))]);
      response.statusCode = 200;
      response.headers = { "content-type": "application/json" };
      response.rawHeaders = ["content-type", "application/json"];
      queueMicrotask(() => onResponse(response));
    };
    return request;
  };

  const proxy = createServer(settingsB, {
    settingsSource,
    captureManager: createMemoryCaptureManager(),
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const responsePromise = new Promise((resolvePromise, rejectPromise) => {
    const clientRequest = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      path: "/responses",
      method: "POST"
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePromise({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      }));
    });
    clientRequest.on("error", rejectPromise);
    clientRequest.flushHeaders();
    captured.promise.then(() => {
      runtime.apply({ generation: 2, settings: settingsB });
      clientRequest.end("{}");
    }, rejectPromise);
  });

  const response = await responsePromise;
  assert.deepEqual(response, { status: 200, body: { ok: true } });
  assert.equal(observed.hostname, "a.example.test");
  assert.equal(observed.port, "4443");
  assert.equal(observed.rejectUnauthorized, false);
  assert.equal(observed.timeoutMs, 1111);
});

test("in-flight request keeps A target, credential, headers, capture, and logs while new request uses B", async (t) => {
  const releaseA = createGate();
  t.after(() => releaseA.release());
  const receivedA = createSignal();
  const observedA = [];
  const observedB = [];

  const upstreamA = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observedA.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (observedA.length === 1) {
        receivedA.resolve();
        releaseA.promise.then(() => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(completedResponse({ upstream: "A" })));
        });
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(completedResponse({ upstream: "A-unexpected-repeat" })));
      }
    });
  });
  const portA = await listen(upstreamA);
  t.after(async () => {
    releaseA.release();
    await closeServer(upstreamA);
  });

  const upstreamB = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observedB.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completedResponse({ upstream: "B" })));
    });
  });
  const portB = await listen(upstreamB);
  t.after(() => closeServer(upstreamB));

  const settingsA = makeSettings({
    baseUrl: `http://127.0.0.1:${portA}`,
    apiKey: "a-api-key-sentinel",
    authHeader: "x-provider-a-auth",
    authScheme: "Token",
    extraHeaders: { "x-snapshot-route": "snapshot-route-a" },
    timeoutMs: 5000,
    verifySsl: false,
    requestIdHeader: "x-a-request-id"
  });
  const settingsB = makeSettings({
    baseUrl: `http://127.0.0.1:${portB}`,
    apiKey: "b-api-key-sentinel",
    authHeader: "x-provider-b-auth",
    authScheme: "",
    extraHeaders: { "x-snapshot-route": "snapshot-route-b" },
    timeoutMs: 1000,
    verifySsl: true,
    requestIdHeader: "x-b-request-id"
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 1, settings: settingsA });
  const captureManager = createMemoryCaptureManager();
  const logs = [];
  const metrics = [];
  const proxy = createServer(settingsA, {
    settingsSource: source,
    captureManager,
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
    },
    logFn(level, message, fields) {
      logs.push({ level, message, fields });
    }
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    releaseA.release();
    await closeServer(proxy);
  });

  const responseAPromise = fetchJson(`http://127.0.0.1:${proxyPort}/responses?request=A`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-a-request-id": "request-a",
      "x-provider-a-auth": "client-a-value"
    },
    body: JSON.stringify({ request: "A", model: "model-a" })
  });
  await Promise.race([
    receivedA.promise,
    responseAPromise.then((response) => {
      throw new Error(`request A completed before reaching upstream A (${response.status})`);
    })
  ]);

  source.apply({ generation: 2, settings: settingsB });
  const responseB = await fetchJson(`http://127.0.0.1:${proxyPort}/responses?request=B`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-b-request-id": "request-b",
      "x-provider-b-auth": "client-b-value"
    },
    body: JSON.stringify({ request: "B", model: "model-b" })
  });
  releaseA.release();
  const responseA = await responseAPromise;

  assert.deepEqual(responseA, { status: 200, body: completedResponse({ upstream: "A" }) });
  assert.deepEqual(responseB, { status: 200, body: completedResponse({ upstream: "B" }) });
  assert.equal(observedA.length, 1);
  assert.equal(observedA[0].headers["x-provider-a-auth"], "Token a-api-key-sentinel");
  assert.equal(observedA[0].headers["x-snapshot-route"], "snapshot-route-a");
  assert.equal(observedB.length, 1);
  assert.equal(observedB[0].headers["x-provider-b-auth"], "b-api-key-sentinel");
  assert.equal(observedB[0].headers["x-snapshot-route"], "snapshot-route-b");
  assert.deepEqual(captureManager.records.map((record) => new URL(record.targetUrl).host), [
    `127.0.0.1:${portB}`,
    `127.0.0.1:${portA}`
  ]);
  assert.deepEqual(
    logs.filter((entry) => entry.message === "Proxied request").map((entry) => entry.fields.request_id).sort(),
    ["request-a", "request-b"]
  );
  assert.deepEqual(metrics.map(({ generation, result, model, inputTokens, outputTokens }) => ({
    generation,
    result,
    model,
    inputTokens,
    outputTokens
  })), [
    {
      generation: 2,
      result: "success",
      model: "model-b",
      inputTokens: null,
      outputTokens: null
    },
    {
      generation: 1,
      result: "success",
      model: "model-a",
      inputTokens: null,
      outputTokens: null
    }
  ]);
});

test("metrics extract bounded JSON and SSE usage while screening credential-bearing model ids", async (t) => {
  const secret = "metrics-active-credential-sentinel";
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (payload.stream === true) {
        res.setHeader("content-type", "text/event-stream");
        res.end(`data: ${JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 21, output_tokens: 8 } }
        })}\n\ndata: [DONE]\n\n`);
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completedResponse({
        id: "response-private-id",
        usage: { input_tokens: 13, output_tokens: 5 }
      })));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: secret,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 9, settings });
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createMemoryCaptureManager(),
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const jsonResponse = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "model-json", stream: false })
  });
  assert.equal(jsonResponse.status, 200);
  await jsonResponse.text();
  const streamResponse = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: `prefix-${secret}-suffix`, stream: true })
  });
  assert.equal(streamResponse.status, 200);
  await streamResponse.text();

  const encodedModels = [
    Buffer.from(secret).toString("base64url"),
    Buffer.from(secret).toString("hex").toUpperCase(),
    [...secret]
      .map((character) => `%${character.codePointAt(0).toString(16).padStart(2, "0")}`)
      .join("")
  ];
  for (const model of encodedModels) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false })
    });
    assert.equal(response.status, 200);
    await response.text();
  }

  assert.equal(metrics.length, 5);
  const serialized = JSON.stringify(metrics);
  assert.equal(serialized.includes(secret), false);
  for (const encodedModel of encodedModels) {
    assert.equal(serialized.includes(encodedModel), false);
  }
  assert.equal(serialized.includes("response-private-id"), false);
  assert.equal(serialized.includes("url"), false);
  assert.equal(serialized.includes("headers"), false);
  assert.equal(serialized.includes("body"), false);
  assert.deepEqual(metrics.map(({ generation, result, model, inputTokens, outputTokens }) => ({
    generation,
    result,
    model,
    inputTokens,
    outputTokens
  })), [
    {
      generation: 9,
      result: "success",
      model: "model-json",
      inputTokens: 13,
      outputTokens: 5
    },
    {
      generation: 9,
      result: "success",
      model: null,
      inputTokens: 21,
      outputTokens: 8
    },
    {
      generation: 9,
      result: "success",
      model: null,
      inputTokens: 13,
      outputTokens: 5
    },
    {
      generation: 9,
      result: "success",
      model: null,
      inputTokens: 13,
      outputTokens: 5
    },
    {
      generation: 9,
      result: "success",
      model: null,
      inputTokens: 13,
      outputTokens: 5
    }
  ]);
});

test("Responses metrics reject semantic JSON and SSE failures plus missing terminal completion", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = new URL(req.url, "http://upstream.test");
      const scenario = url.searchParams.get("case");
      if (scenario === "json-failed") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          id: "resp_failed",
          object: "response",
          status: "failed",
          output: [],
          error: { message: "provider failed" }
        }));
        return;
      }
      if (scenario === "invalid-json") {
        res.setHeader("content-type", "application/json");
        res.end(Buffer.concat([
          Buffer.from(JSON.stringify(completedResponse({ padding: "z".repeat(2 * 1024 * 1024) }))),
          Buffer.from([0xff])
        ]));
        return;
      }
      res.setHeader("content-type", "text/event-stream");
      if (scenario === "failed-then-completed") {
        res.end([
          `data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "failed" } } })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.completed",
            response: { usage: { input_tokens: 99, output_tokens: 99 } }
          })}\n\n`
        ].join(""));
        return;
      }
      res.end(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 12, settings });
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  for (const [scenario, stream] of [
    ["json-failed", false],
    ["invalid-json", false],
    ["failed-then-completed", true],
    ["missing-terminal", true]
  ]) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=${scenario}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "semantic-model", stream })
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }

  assert.deepEqual(metrics.map(({ result, inputTokens, outputTokens }) => ({
    result,
    inputTokens,
    outputTokens
  })), [
    { result: "upstreamError", inputTokens: null, outputTokens: null },
    { result: "upstreamError", inputTokens: null, outputTokens: null },
    { result: "upstreamError", inputTokens: null, outputTokens: null },
    { result: "upstreamError", inputTokens: null, outputTokens: null }
  ]);
});

test("bounded SSE inspection accepts a completed event larger than the former 64 KiB limit", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ text: "x".repeat(96 * 1024) }],
          usage: { input_tokens: 43, output_tokens: 19 }
        }
      })}\n\n`);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 18, settings });
  const metricSignal = createSignal();
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    recordMetric(observation) {
      metricSignal.resolve(structuredClone(observation));
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "large-event-model", stream: true })
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const metric = await withDeadline(metricSignal.promise, "large completed SSE event metric was not recorded");
  assert.deepEqual(
    (({ result, inputTokens, outputTokens }) => ({ result, inputTokens, outputTokens }))(metric),
    { result: "success", inputTokens: 43, outputTokens: 19 }
  );
});

test("SSE inspection bounds empty data lines including framing overhead", async (t) => {
  const emptyLines = "data:\n".repeat(Math.ceil((1024 * 1024) / 6) + 128);
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "text/event-stream");
      res.end(`${emptyLines}\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 47, output_tokens: 21 } }
      })}\n\n`);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 21, settings });
  const metricSignal = createSignal();
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    recordMetric(observation) {
      metricSignal.resolve(structuredClone(observation));
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));
  const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "empty-line-model", stream: true })
  });
  await response.arrayBuffer();
  const metric = await withDeadline(metricSignal.promise, "empty-line SSE metric was not recorded");
  assert.deepEqual(
    (({ result, inputTokens, outputTokens }) => ({ result, inputTokens, outputTokens }))(metric),
    { result: "success", inputTokens: 47, outputTokens: 21 }
  );
});

test("SSE inspection accepts CR-only and cross-chunk CRLF event delimiters", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "text/event-stream");
      const crossChunk = req.url.includes("cross-chunk");
      const payload = JSON.stringify({
        type: "response.completed",
        response: {
          usage: crossChunk
            ? { input_tokens: 53, output_tokens: 29 }
            : { input_tokens: 51, output_tokens: 27 }
        }
      });
      if (!crossChunk) {
        res.end(`data: ${payload}\r\r`);
        return;
      }
      res.write(`data: ${payload}\r`);
      setImmediate(() => res.end("\n\r\n"));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 24, settings });
  const metrics = [];
  const metricsReady = createSignal();
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
      if (metrics.length === 2) metricsReady.resolve();
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  for (const scenario of ["cr-only", "cross-chunk"]) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=${scenario}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "line-ending-model", stream: true })
    });
    await response.arrayBuffer();
  }
  await withDeadline(metricsReady.promise, "line-ending SSE metrics were not recorded");
  assert.deepEqual(metrics.map(({ result, inputTokens, outputTokens }) => ({
    result,
    inputTokens,
    outputTokens
  })), [
    { result: "success", inputTokens: 51, outputTokens: 27 },
    { result: "success", inputTokens: 53, outputTokens: 29 }
  ]);
});

test("passthrough preserves declared and headerless compressed request bytes", async (t) => {
  const observed = [];
  const receivedBoth = createSignal();
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observed.push({
        encoding: req.headers["content-encoding"] ?? null,
        body: Buffer.concat(chunks)
      });
      if (observed.length === 2) receivedBoth.resolve();
      res.end("ok");
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const proxy = createServer(settings, {
    captureManager: createInactiveCaptureManager(),
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify({ model: "byte-exact-model" })));

  for (const headers of [
    { "content-encoding": "gzip", "content-length": String(compressed.length) },
    { "content-length": String(compressed.length) }
  ]) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/passthrough`, {
      method: "POST",
      headers,
      body: compressed
    });
    assert.equal(await response.text(), "ok");
  }
  await withDeadline(receivedBoth.promise, "upstream did not receive both compressed requests");
  assert.deepEqual(observed.map(({ encoding }) => encoding), ["gzip", null]);
  assert.deepEqual(observed[0].body, compressed);
  assert.deepEqual(observed[1].body, compressed);
});

test("Connection tokens remove dynamically nominated request and response headers", async (t) => {
  const upstreamHeaders = createSignal();
  const upstream = http.createServer((req, res) => {
    upstreamHeaders.resolve(req.headers);
    req.resume();
    req.on("end", () => {
      res.setHeader("connection", "keep-alive, x-response-remove");
      res.setHeader("x-response-remove", "must-not-reach-client");
      res.setHeader("x-response-keep", "visible");
      res.end("ok");
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    extraHeaders: {
      connection: "configured-hop-secret",
      "transfer-encoding": "configured-hop-secret",
      upgrade: "configured-hop-secret",
      "x-generated-keep": "visible"
    },
    captureEnabled: false
  });
  const proxy = createServer(settings, {
    captureManager: createInactiveCaptureManager(),
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const received = await new Promise((resolvePromise, rejectPromise) => {
    const request = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      path: "/passthrough",
      method: "POST",
      headers: {
        connection: "keep-alive, x-remove-me",
        "x-remove-me": "must-not-reach-upstream",
        "x-request-keep": "visible"
      }
    }, (response) => {
      response.resume();
      response.on("end", () => resolvePromise(response.headers));
    });
    request.on("error", rejectPromise);
    request.end("body");
  });
  const forwarded = await upstreamHeaders.promise;
  assert.equal(forwarded["x-remove-me"], undefined);
  assert.equal(forwarded["x-request-keep"], "visible");
  assert.notEqual(forwarded.connection, "configured-hop-secret");
  assert.notEqual(forwarded["transfer-encoding"], "configured-hop-secret");
  assert.equal(forwarded.upgrade, undefined);
  assert.equal(forwarded["x-generated-keep"], "visible");
  assert.equal(received["x-response-remove"], undefined);
  assert.equal(received["x-response-keep"], "visible");
});

test("compressed JSON and SSE usage is inspected without changing response bytes or headers", async (t) => {
  const upstreamBodies = new Map();
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const scenario = new URL(req.url, "http://upstream.test").searchParams.get("case");
      const plain = scenario === "sse"
        ? Buffer.from([
            `data: ${JSON.stringify({
              type: "response.output_text.delta",
              delta: "s".repeat(2 * 1024 * 1024)
            })}\n\n`,
            `data: ${JSON.stringify({
              type: "response.completed",
              response: { usage: { input_tokens: 41, output_tokens: 17 } }
            })}\n\n`
          ].join(""))
        : Buffer.from(JSON.stringify(completedResponse({
            padding: "j".repeat(2 * 1024 * 1024),
            usage: { input_tokens: 37, output_tokens: 14 }
          })));
      const compressed = zlib.gzipSync(plain);
      upstreamBodies.set(scenario, compressed);
      res.setHeader("content-type", scenario === "sse" ? "text/event-stream" : "application/json");
      res.setHeader("content-encoding", "gzip");
      res.setHeader("content-length", String(compressed.length));
      res.end(compressed);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 13, settings });
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  for (const scenario of ["json", "sse"]) {
    const received = await new Promise((resolvePromise, rejectPromise) => {
      const request = http.request({
        host: "127.0.0.1",
        port: proxyPort,
        path: `/responses?case=${scenario}`,
        method: "POST",
        headers: { "content-type": "application/json" }
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolvePromise({
          encoding: response.headers["content-encoding"],
          body: Buffer.concat(chunks)
        }));
      });
      request.on("error", rejectPromise);
      request.end(JSON.stringify({ model: "compressed-model", stream: scenario === "sse" }));
    });
    assert.equal(received.encoding, "gzip");
    assert.deepEqual(received.body, upstreamBodies.get(scenario));
  }

  assert.deepEqual(metrics.map(({ result, inputTokens, outputTokens }) => ({
    result,
    inputTokens,
    outputTokens
  })), [
    { result: "success", inputTokens: 37, outputTokens: 14 },
    { result: "success", inputTokens: 41, outputTokens: 17 }
  ]);
});

test("zstd usage inspection falls back to fzstd while passthrough remains byte exact", async (t) => {
  const compressed = Buffer.from(
    "KLUv/SB23QIAksUSGICpbZDc5t9K8V9vy04UJrJiELmChRk4AscBKCVg1nUHvPnmUjbMVzi6JgOB+Zvf+yEygchm3Z+riU8XHp2BgCZO14VJPYXNSdkIBAA2C6BS9GDqjjCbeA==",
    "base64"
  );
  const nativeDecompress = zlib.zstdDecompressSync;
  zlib.zstdDecompressSync = undefined;
  t.after(() => {
    zlib.zstdDecompressSync = nativeDecompress;
  });
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.setHeader("content-encoding", "zstd");
      res.setHeader("content-length", String(compressed.length));
      res.end(compressed);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 14, settings });
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const received = await new Promise((resolvePromise, rejectPromise) => {
    const request = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      path: "/responses",
      method: "POST",
      headers: { "content-type": "application/json" }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePromise(Buffer.concat(chunks)));
    });
    request.on("error", rejectPromise);
    request.end(JSON.stringify({ model: "zstd-model", stream: false }));
  });

  assert.deepEqual(received, compressed);
  assert.deepEqual(metrics.map(({ result, inputTokens, outputTokens }) => ({
    result,
    inputTokens,
    outputTokens
  })), [
    { result: "success", inputTokens: 31, outputTokens: 12 }
  ]);
});

test("fzstd inspection accepts the exact bound and rejects multi-frame input without changing bytes", async (t) => {
  const exact = Buffer.from([
    "KLUv/YBYAACAAEwDALLGFRqAqS0GDCsSKCREfGO27MRgDKzoBTtmiiZhBMk3ktA5RW0NQQAwuDUh",
    "IvfYpRKacSNSdG0Fwr1L7crtg4sJpUjzrWvL6jZqyjV4MOT2mpLgoRQX3wfNCAQA9P5xeW1qCJQi",
    "xswmHgIAEHgCABB4AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4AgAQeAIAEHgC",
    "ABB4AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4AgAQeAIA",
    "EHgCABB4AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4AgAQ",
    "eAIAEHgCABB4AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4",
    "AgAQeAIAEHgCABB4AgAQeAIAEHgCABB4XQAAGHgifQEA+v85EAI="
  ].join(""), "base64");
  const single = Buffer.from(
    "KLUv/SB23QIAksUSGICpbZDc5t9K8V9vy04UJrJiELmChRk4AscBKCVg1nUHvPnmUjbMVzi6JgOB+Zvf+yEygchm3Z+riU8XHp2BgCZO14VJPYXNSdkIBAA2C6BS9GDqjjCbeA==",
    "base64"
  );
  const multi = Buffer.concat([single, single]);
  const validPrefix = Buffer.from(JSON.stringify(completedResponse({
    usage: { input_tokens: 71, output_tokens: 37 }
  })));
  const prefixHeader = Buffer.alloc(3);
  prefixHeader.writeUIntLE(validPrefix.length << 3, 0, 3);
  const extraSize = 10;
  const extraHeader = Buffer.alloc(3);
  extraHeader.writeUIntLE((extraSize << 3) | 0x03, 0, 3);
  const mismatchedSize = Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, validPrefix.length]),
    prefixHeader,
    validPrefix,
    extraHeader,
    Buffer.from("A")
  ]);
  const checksummedBody = Buffer.from(JSON.stringify(completedResponse({
    usage: { input_tokens: 73, output_tokens: 39 }
  })));
  const checksummedHeader = Buffer.alloc(3);
  checksummedHeader.writeUIntLE((checksummedBody.length << 3) | 0x01, 0, 3);
  const checksummed = Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x24, checksummedBody.length]),
    checksummedHeader,
    checksummedBody,
    Buffer.from([0xde, 0xad, 0xbe, 0xef])
  ]);
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const body = req.url.includes("multi")
        ? multi
        : (req.url.includes("mismatch")
          ? mismatchedSize
          : (req.url.includes("checksum") ? checksummed : exact));
      res.setHeader("content-type", "application/json");
      res.setHeader("content-encoding", "zstd");
      res.setHeader("content-length", String(body.length));
      res.end(body);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 23, settings });
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));
  const nativeDecompress = zlib.zstdDecompressSync;
  zlib.zstdDecompressSync = undefined;
  try {
    for (const [scenario, expected] of [
      ["exact", exact],
      ["multi", multi],
      ["mismatch", mismatchedSize],
      ["checksum", checksummed]
    ]) {
      const received = await new Promise((resolvePromise, rejectPromise) => {
        const request = http.request({
          host: "127.0.0.1",
          port: proxyPort,
          path: `/responses?case=${scenario}`,
          method: "POST",
          headers: { "content-type": "application/json" }
        }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => resolvePromise(Buffer.concat(chunks)));
        });
        request.on("error", rejectPromise);
        request.end(JSON.stringify({ model: "zstd-bound-model" }));
      });
      assert.deepEqual(received, expected);
    }
  } finally {
    zlib.zstdDecompressSync = nativeDecompress;
  }
  assert.deepEqual(metrics.map(({ result, inputTokens, outputTokens }) => ({
    result,
    inputTokens,
    outputTokens
  })), [
    { result: "success", inputTokens: 61, outputTokens: 23 },
    { result: "upstreamError", inputTokens: null, outputTokens: null },
    { result: "upstreamError", inputTokens: null, outputTokens: null },
    { result: "upstreamError", inputTokens: null, outputTokens: null }
  ]);
});

test("metrics response-start latency begins at the first response body byte", async (t) => {
  const releaseBody = createGate();
  const headersSent = createSignal();
  t.after(() => releaseBody.release());
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/bodyless") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.flushHeaders();
      headersSent.resolve();
      releaseBody.promise.then(() => res.end(JSON.stringify({ ok: true })));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 3, settings });
  const metricSignals = [createSignal(), createSignal()];
  const metrics = [];
  let metricNowMs = 1_000;
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createMemoryCaptureManager(),
    metricNow: () => metricNowMs,
    recordMetric(observation) {
      const index = metrics.length;
      const clone = structuredClone(observation);
      metrics.push(clone);
      metricSignals[index]?.resolve(clone);
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const bodyResponsePromise = fetch(`http://127.0.0.1:${proxyPort}/delayed-body`, {
    method: "POST",
    body: "{}"
  });
  await headersSent.promise;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  assert.equal(metrics.length, 0);
  metricNowMs = 1_301;
  releaseBody.release();
  const bodyResponse = await bodyResponsePromise;
  assert.equal(bodyResponse.status, 200);
  assert.deepEqual(await bodyResponse.json(), { ok: true });
  const bodyMetric = await metricSignals[0].promise;
  assert.equal(bodyMetric.responseStartBin, 3);

  metricNowMs = 2_000;
  const bodylessResponse = await fetch(`http://127.0.0.1:${proxyPort}/bodyless`, {
    method: "POST",
    body: "{}"
  });
  assert.equal(bodylessResponse.status, 204);
  await bodylessResponse.arrayBuffer();
  const bodylessMetric = await metricSignals[1].promise;
  assert.equal(bodylessMetric.responseStartBin, null);
});

test("passthrough streams request and multi-megabyte SSE response before either side completes", async (t) => {
  const firstRequestChunk = createSignal();
  const releaseResponse = createGate();
  let upstreamResponseEnded = false;
  const upstream = http.createServer((req, res) => {
    let observedRequestData = false;
    req.on("data", () => {
      if (!observedRequestData) {
        observedRequestData = true;
        firstRequestChunk.resolve();
      }
    });
    req.on("end", () => {
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ type: "response.created" })}\n\n`);
      releaseResponse.promise.then(() => {
        const delta = "x".repeat(60 * 1024);
        for (let index = 0; index < 36; index += 1) {
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
        }
        res.end(`data: ${JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 55, output_tokens: 34 } }
        })}\n\n`);
        upstreamResponseEnded = true;
      });
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => {
    releaseResponse.release();
    return closeServer(upstream);
  });
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    captureEnabled: false
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 15, settings });
  const metricSignal = createSignal();
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager: createInactiveCaptureManager(),
    recordMetric(observation) {
      const clone = structuredClone(observation);
      metrics.push(clone);
      metricSignal.resolve(clone);
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const firstResponseChunk = createSignal();
  const responseDone = createSignal();
  let responseBytes = 0;
  const request = http.request({
    host: "127.0.0.1",
    port: proxyPort,
    path: "/responses",
    method: "POST",
    headers: { "content-type": "application/json" }
  }, (response) => {
    response.on("data", (chunk) => {
      responseBytes += chunk.length;
      firstResponseChunk.resolve();
    });
    response.on("end", () => responseDone.resolve());
  });
  request.on("error", (error) => responseDone.resolve(error));
  request.write('{"model":"stream-model","stream":true,"input":"');
  await withDeadline(firstRequestChunk.promise, "upstream did not receive the request before client end");
  request.end('streamed"}');
  await withDeadline(firstResponseChunk.promise, "client did not receive the first response chunk");
  assert.equal(upstreamResponseEnded, false);
  releaseResponse.release();
  const responseError = await withDeadline(responseDone.promise, "large streamed response did not finish", 5000);
  if (responseError instanceof Error) throw responseError;
  const metric = await withDeadline(metricSignal.promise, "large streamed response metric was not recorded");

  assert.ok(responseBytes > 2 * 1024 * 1024, `received only ${responseBytes} bytes`);
  assert.deepEqual(
    (({ result, model, inputTokens, outputTokens }) => ({ result, model, inputTokens, outputTokens }))(metric),
    {
      result: "success",
      model: "stream-model",
      inputTokens: 55,
      outputTokens: 34
    }
  );
  assert.equal(metrics.length, 1);
});

test("downstream abort promptly cancels upstream work and records one clientAbort", async (t) => {
  const upstreamClosed = createSignal();
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "text/event-stream");
      res.on("close", () => upstreamClosed.resolve());
      res.write(`data: ${JSON.stringify({ type: "response.created" })}\n\n`);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({ baseUrl: `http://127.0.0.1:${upstreamPort}` });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 16, settings });
  const captureManager = createMemoryCaptureManager();
  const metricSignal = createSignal();
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager,
    recordMetric(observation) {
      const clone = structuredClone(observation);
      metrics.push(clone);
      metricSignal.resolve(clone);
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  await new Promise((resolvePromise, rejectPromise) => {
    const request = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      path: "/responses",
      method: "POST",
      headers: { "content-type": "application/json" }
    }, (response) => {
      response.once("data", () => {
        response.destroy();
        resolvePromise();
      });
    });
    request.on("error", rejectPromise);
    request.end(JSON.stringify({ model: "abort-model", stream: true }));
  });
  await withDeadline(upstreamClosed.promise, "upstream response was not cancelled after client abort");
  const metric = await withDeadline(metricSignal.promise, "client abort metric was not recorded");

  assert.equal(metric.result, "clientAbort");
  assert.equal(metrics.length, 1);
  assert.equal(captureManager.records.length, 1);
  assert.equal(captureManager.records[0].errorType, "proxy_client_abort");
});

test("partial upstream response failure closes downstream and finalizes capture plus metric once", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: partial-upstream-body\n\n");
      setImmediate(() => res.destroy(new Error("fixture partial response failure")));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({ baseUrl: `http://127.0.0.1:${upstreamPort}` });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 17, settings });
  const captureManager = createMemoryCaptureManager();
  const metricSignal = createSignal();
  const metrics = [];
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager,
    recordMetric(observation) {
      const clone = structuredClone(observation);
      metrics.push(clone);
      metricSignal.resolve(clone);
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  await withDeadline(new Promise((resolvePromise, rejectPromise) => {
    const request = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      path: "/responses",
      method: "POST",
      headers: { "content-type": "application/json" }
    }, (response) => {
      response.resume();
      response.once("aborted", resolvePromise);
      response.once("error", resolvePromise);
      response.once("close", resolvePromise);
    });
    request.on("error", rejectPromise);
    request.end(JSON.stringify({ model: "partial-model", stream: true }));
  }), "downstream did not close after partial upstream failure");
  const metric = await withDeadline(metricSignal.promise, "partial response metric was not recorded");

  assert.equal(metric.result, "networkError");
  assert.equal(metrics.length, 1);
  assert.equal(captureManager.records.length, 1);
  assert.equal(captureManager.records[0].errorType, "proxy_upstream_response_error");
  assert.match(captureManager.records[0].responseBody.toString("utf8"), /partial-upstream-body/);
});

test("an in-flight A request retains its longer timeout after B is applied", async (t) => {
  const releaseA = createGate();
  t.after(() => releaseA.release());
  const receivedA = createSignal();

  const upstreamA = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      receivedA.resolve();
      releaseA.promise.then(() => res.end(JSON.stringify(completedResponse({ upstream: "A" }))));
    });
  });
  const portA = await listen(upstreamA);
  t.after(async () => {
    releaseA.release();
    await closeServer(upstreamA);
  });

  const upstreamB = http.createServer((req) => {
    req.resume();
  });
  const portB = await listen(upstreamB);
  t.after(() => closeServer(upstreamB));

  const settingsA = makeSettings({ baseUrl: `http://127.0.0.1:${portA}`, timeoutMs: 5000 });
  const settingsB = makeSettings({ baseUrl: `http://127.0.0.1:${portB}`, timeoutMs: 75 });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 1, settings: settingsA });
  const metrics = [];
  const proxy = createServer(settingsB, {
    settingsSource: source,
    captureManager: createMemoryCaptureManager(),
    recordMetric(observation) {
      metrics.push(structuredClone(observation));
    },
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    releaseA.release();
    await closeServer(proxy);
  });

  const responseAPromise = fetchJson(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    body: "A"
  });
  await Promise.race([
    receivedA.promise,
    responseAPromise.then((response) => {
      throw new Error(`request A completed before reaching upstream A (${response.status})`);
    })
  ]);
  source.apply({ generation: 2, settings: settingsB });

  const responseB = await fetchJson(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    body: "B"
  });
  assert.equal(responseB.status, 504);
  assert.equal(responseB.body.error.type, "proxy_timeout");

  releaseA.release();
  const responseA = await responseAPromise;
  assert.deepEqual(responseA, { status: 200, body: completedResponse({ upstream: "A" }) });
  assert.deepEqual(metrics.map(({ generation, result }) => ({ generation, result })), [
    { generation: 2, result: "timeout" },
    { generation: 1, result: "success" }
  ]);
});

test("dynamic health is allowlisted and an unconfigured source never falls back to static settings", async (t) => {
  let staticUpstreamHits = 0;
  const staticUpstream = http.createServer((req, res) => {
    staticUpstreamHits += 1;
    req.resume();
    req.on("end", () => res.end(JSON.stringify({ unexpected: true })));
  });
  const upstreamPort = await listen(staticUpstream);
  t.after(() => closeServer(staticUpstream));

  const staticSettings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: "static-health-secret",
    authHeader: "x-static-health-auth",
    extraHeaders: { "x-static-health-extra": "static-extra-secret" }
  });
  const source = new RuntimeSettingsSource();
  const captureManager = createMemoryCaptureManager({ failedWriteCount: 0 });
  const proxy = createServer(staticSettings, { settingsSource: source, captureManager, logFn() {} });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const health = await fetchJson(`http://127.0.0.1:${proxyPort}/_proxy/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, {
    ok: true,
    configured: false,
    generation: 0,
    captureConfigured: true,
    captureActive: true,
    failedWriteCount: 0
  });

  const serializedHealth = JSON.stringify(health.body);
  for (const forbidden of [
    "settings",
    staticSettings.upstream.apiKey,
    staticSettings.upstream.authHeader,
    staticSettings.upstream.extraHeaders["x-static-health-extra"]
  ]) {
    assert.equal(serializedHealth.includes(forbidden), false, `health leaked ${forbidden}`);
  }

  const unavailable = await fetchJson(`http://127.0.0.1:${proxyPort}/responses`, {
    method: "POST",
    body: "{}"
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "RUNTIME_SETTINGS_UNAVAILABLE");
  assert.equal(staticUpstreamHits, 0);
});

test("debug and startup logs mask short keys and the active custom auth header", async (t) => {
  let observedAuthHeader = null;
  const upstream = http.createServer((req, res) => {
    observedAuthHeader = req.headers["x-provider-auth"] ?? null;
    req.resume();
    req.on("end", () => {
      res.setHeader("x-provider-auth", "response-custom-auth-secret");
      res.setHeader("set-cookie", "session-cookie-secret");
      res.setHeader("x-api-key", "tiny");
      res.setHeader("x-diagnostic", "trace-visible");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const staticSettings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: "static-api-key-sentinel",
    authHeader: "static-api-key-sentinel",
    authScheme: "",
    logLevel: "debug"
  });
  const activeSettings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: "k3y",
    authHeader: "x-provider-auth",
    authScheme: "",
    logLevel: "debug"
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 1, settings: activeSettings });
  const lines = [];
  const originalConsoleLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  t.after(() => {
    console.log = originalConsoleLog;
  });

  let app;
  try {
    app = createApp(staticSettings, { settingsSource: source });
    const proxyPort = await listen(app.server);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
      method: "POST",
      headers: {
        "x-provider-auth": "client-custom-auth-sentinel"
      },
      body: "{}"
    });
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    if (app) {
      await closeServer(app.server);
      app.captureManager.close();
    }
    console.log = originalConsoleLog;
  }

  const output = lines.join("\n");
  assert.equal(output.includes("static-api-key-sentinel"), false);
  assert.equal(output.includes("k3y"), false);
  assert.equal(output.includes("client-custom-auth-sentinel"), false);
  assert.equal(output.includes("response-custom-auth-secret"), false);
  assert.equal(output.includes("session-cookie-secret"), false);
  assert.equal(output.includes('"x-api-key": "tiny"'), false);
  assert.equal(output.includes(JSON.stringify(source.current())), false);
  assert.match(output, /DEBUG \[REQUEST\]/);
  assert.match(output, /"x-api-key": "\[REDACTED\]"/);
  assert.match(output, /"x-diagnostic": "trace-visible"/);
  assert.equal(observedAuthHeader, "k3y");
});

test("debug and Capture redact configured protected values under otherwise safe header names", async (t) => {
  const apiKey = "protected-api-key-complete-sentinel";
  const extraValue = "protected-extra-header-complete-sentinel";
  const shortValue = "k3y";
  let observedExtraHeader = null;
  const upstream = http.createServer((req, res) => {
    const compressed = req.headers["content-encoding"] === "gzip";
    observedExtraHeader = req.headers["x-route-marker"] ?? null;
    req.resume();
    req.on("end", () => {
      const responseBody = Buffer.from(JSON.stringify(completedResponse({
        output: [{ type: "message", text: `${apiKey}:${extraValue}:${shortValue}` }]
      })));
      res.setHeader("content-type", "application/json");
      res.setHeader("x-request-id", apiKey);
      res.setHeader("x-safe-api-echo", apiKey);
      res.setHeader("x-safe-route-echo", `prefix-${extraValue}-suffix`);
      res.setHeader("x-safe-short-echo", `${shortValue}-suffix`);
      if (compressed) {
        const encoded = zlib.gzipSync(responseBody);
        res.setHeader("content-encoding", "gzip");
        res.setHeader("content-length", String(encoded.length));
        res.end(encoded);
      } else {
        res.end(responseBody);
      }
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey,
    extraHeaders: {
      "x-route-marker": extraValue,
      "x-short-marker": shortValue
    },
    logLevel: "debug"
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 20, settings });
  const captureManager = createMemoryCaptureManager();
  const lines = [];
  const originalConsoleLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  t.after(() => {
    console.log = originalConsoleLog;
  });
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager,
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));
  const fullyEncodedApiKey = [...apiKey]
    .map((character) => `%${character.codePointAt(0).toString(16).padStart(2, "0")}`)
    .join("");
  let compressedBody;
  try {
    const escapedApiKey = [...apiKey]
      .map((character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses?trace=${fullyEncodedApiKey}&bad=%ZZ`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-note": apiKey,
        "x-client-request-id": apiKey,
        "session-id": extraValue,
        "thread-id": shortValue
      },
      body: `{"model":"safe-model","input":"${escapedApiKey}"}`
    });
    await response.arrayBuffer();
    compressedBody = zlib.gzipSync(Buffer.from(JSON.stringify({
      model: "safe-model",
      input: `${apiKey}:${extraValue}:${shortValue}`
    })));
    const compressedResponse = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=compressed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip"
      },
      body: compressedBody
    });
    await compressedResponse.arrayBuffer();
  } finally {
    console.log = originalConsoleLog;
  }

  const serialized = `${lines.join("\n")}\n${JSON.stringify(captureManager.records)}`;
  assert.equal(serialized.includes(apiKey), false);
  assert.equal(serialized.includes(extraValue), false);
  assert.equal(serialized.includes(shortValue), false);
  assert.equal(serialized.includes(fullyEncodedApiKey), false);
  assert.equal(observedExtraHeader, extraValue);
  assert.equal(captureManager.records[0].requestHeaders["x-client-note"], "[REDACTED]");
  assert.equal(captureManager.records[0].requestHeaders["x-route-marker"], "[REDACTED]");
  assert.equal(captureManager.records[0].responseHeaders["x-safe-api-echo"], "[REDACTED]");
  assert.equal(captureManager.records[0].responseHeaders["x-safe-route-echo"], "[REDACTED]");
  assert.equal(captureManager.records[0].responseHeaders["x-safe-short-echo"], "[REDACTED]");
  assert.equal(captureManager.records[0].requestId, "[REDACTED]");
  assert.equal(captureManager.records[0].sessionId, "[REDACTED]");
  assert.equal(captureManager.records[0].threadId, "[REDACTED]");
  assert.equal(captureManager.records[0].upstreamRequestId, "[REDACTED]");
  assert.equal(captureManager.records[0].incomingUrl, "[REDACTED]");
  assert.equal(captureManager.records[0].targetUrl, "[REDACTED]");
  assert.equal(captureManager.records[0].requestBody.length, 0);
  assert.equal(captureManager.records[0].requestBodyTruncated, true);
  assert.equal(captureManager.records[0].responseBody.length, 0);
  assert.equal(captureManager.records[0].responseBodyTruncated, true);
  for (const body of [
    captureManager.records[0].requestBody.toString("utf8"),
    captureManager.records[0].responseBody.toString("utf8")
  ]) {
    assert.equal(body.includes(apiKey), false);
    assert.equal(body.includes(extraValue), false);
    assert.equal(body.includes(shortValue), false);
  }
  assert.equal(captureManager.records[1].requestBody.length, 0);
  assert.equal(captureManager.records[1].requestBodyTruncated, true);
  assert.equal(captureManager.records[1].requestBodyBytes, compressedBody.length);
  assert.equal(captureManager.records[1].responseBody.length, 0);
  assert.equal(captureManager.records[1].responseBodyTruncated, true);
  assert.ok(captureManager.records[1].responseBodyBytes > 0);
});

test("Capture omits independently recoverable encodings and undeclared compressed bodies", async (t) => {
  const apiKey = "protected-api-key-complete-sentinel";
  const base64ProtectedValue = "!!>x";
  const base64NameProtectedValue = "j'!";
  const base64HeaderName = Buffer.from(base64NameProtectedValue).toString("base64url");
  const encodedApiKey = Buffer.from(apiKey).toString("base64");
  const percentEncodedApiKey = [...apiKey]
    .map((character) => `%${character.codePointAt(0).toString(16).padStart(2, "0")}`)
    .join("");
  const observedMethods = [];
  const upstream = http.createServer((req, res) => {
    observedMethods.push(req.method);
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.setHeader("x-request-id", encodedApiKey);
      res.end(JSON.stringify(completedResponse()));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey,
    extraHeaders: {
      "x-encoded-marker": base64ProtectedValue,
      "x-base64-name-marker": base64NameProtectedValue,
      "x-method-marker": "POST"
    },
    logLevel: "debug"
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 21, settings });
  const captureManager = createMemoryCaptureManager({
    captureDbPath: `${apiKey}:${encodedApiKey}`
  });
  const lines = [];
  const originalConsoleLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  t.after(() => {
    console.log = originalConsoleLog;
  });
  const proxy = createServer(settings, {
    settingsSource: source,
    captureManager,
    logFn() {}
  });
  const proxyPort = await listen(proxy);
  t.after(() => closeServer(proxy));

  const hex = Buffer.from(apiKey).toString("hex");
  const mixedCaseHex = [...hex].map((character, index) => (
    /[a-f]/u.test(character) && index % 2 === 0 ? character.toUpperCase() : character
  )).join("");
  const unpaddedStandardBase64 = Buffer.from(base64ProtectedValue)
    .toString("base64")
    .replace(/=+$/u, "");
  assert.match(unpaddedStandardBase64, /\+/u);
  const paddedBase64Url = Buffer.from(base64ProtectedValue)
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
  assert.match(paddedBase64Url, /-.*=+$/u);
  const whitespaceBase64 = encodedApiKey.replace(/.{4}/gu, "$& \r\n");
  assert.equal(Buffer.from(whitespaceBase64, "base64").toString("utf8") === apiKey, true);
  const zstdBody = typeof zlib.zstdCompressSync === "function"
    ? zlib.zstdCompressSync(Buffer.from(apiKey))
    : Buffer.from(
      "KLUv/SB23QIAksUSGICpbZDc5t9K8V9vy04UJrJiELmChRk4AscBKCVg1nUHvPnmUjbMVzi6JgOB+Zvf+yEygchm3Z+riU8XHp2BgCZO14VJPYXNSdkIBAA2C6BS9GDqjjCbeA==",
      "base64"
    );
  const skippableZstdBody = Buffer.concat([
    Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0x00, 0x00, 0x00, 0x00]),
    zstdBody
  ]);
  const bodies = [
    Buffer.from(mixedCaseHex),
    Buffer.from(unpaddedStandardBase64),
    Buffer.from(paddedBase64Url),
    Buffer.from(whitespaceBase64),
    zlib.gzipSync(Buffer.from(apiKey)),
    zlib.deflateSync(Buffer.from(apiKey)),
    zlib.brotliCompressSync(Buffer.from(apiKey)),
    zstdBody,
    skippableZstdBody
  ];

  for (const [index, body] of bodies.entries()) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses?case=${index}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        ...(index === 0 ? {
          "x-client-request-id": encodedApiKey,
          "session-id": percentEncodedApiKey,
          "thread-id": mixedCaseHex,
          "x-client-note": paddedBase64Url,
          [apiKey]: "literal-protected-name",
          [mixedCaseHex]: "hex-protected-name",
          [base64HeaderName]: "base64url-protected-name"
        } : {})
      },
      body
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }

  const healthResponse = await fetch(`http://127.0.0.1:${proxyPort}/_proxy/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  const serialized = `${lines.join("\n")}\n${JSON.stringify(captureManager.records)}\n${JSON.stringify(health)}`;
  for (const recoverable of [
    apiKey,
    encodedApiKey,
    percentEncodedApiKey,
    mixedCaseHex,
    unpaddedStandardBase64,
    paddedBase64Url,
    whitespaceBase64,
    base64HeaderName
  ]) {
    assert.equal(serialized.includes(recoverable), false);
  }
  assert.equal(captureManager.records.length, bodies.length);
  for (const [index, record] of captureManager.records.entries()) {
    assert.equal(record.requestBody.length, 0);
    assert.equal(record.requestBodyTruncated, true);
    assert.equal(record.requestBodyBytes, bodies[index].length);
    assert.equal(record.upstreamRequestId, "[REDACTED]");
  }
  assert.equal(observedMethods[0], "POST");
  assert.equal(captureManager.records[0].method, "[REDACTED]");
  assert.equal(captureManager.records[0].requestId, "[REDACTED]");
  assert.equal(captureManager.records[0].sessionId, "[REDACTED]");
  assert.equal(captureManager.records[0].threadId, "[REDACTED]");
  assert.equal(captureManager.records[0].requestHeaders["x-client-note"], "[REDACTED]");
  assert.equal(captureManager.records[0].requestHeaders["[REDACTED]"], "[REDACTED]");
  assert.equal(health.captureDbPath, "[REDACTED]");
});
