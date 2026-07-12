import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import { DatabaseSync } from "node:sqlite";

import { createApp, createServer, isDirectExecution } from "../src/server.mjs";
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

function makeSettings({
  baseUrl,
  apiKey = "test-api-key",
  authHeader = "authorization",
  authScheme = "Bearer",
  extraHeaders = {},
  timeoutMs = 300000,
  verifySsl = true,
  requestIdHeader = "x-client-request-id",
  logLevel = "info",
  captureEnabled = true
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
      requestIdHeader
    },
    capture: {
      enabled: captureEnabled,
      dbPath: "/tmp/crp-task5-traffic.sqlite3"
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
          res.end(JSON.stringify({ upstream: "A" }));
        });
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ upstream: "A-unexpected-repeat" }));
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
      res.end(JSON.stringify({ upstream: "B" }));
    });
  });
  const portB = await listen(upstreamB);
  t.after(() => closeServer(upstreamB));

  const settingsA = makeSettings({
    baseUrl: `http://127.0.0.1:${portA}`,
    apiKey: "a-api-key-sentinel",
    authHeader: "x-provider-a-auth",
    authScheme: "Token",
    extraHeaders: { "x-snapshot-route": "A" },
    timeoutMs: 5000,
    verifySsl: false,
    requestIdHeader: "x-a-request-id"
  });
  const settingsB = makeSettings({
    baseUrl: `http://127.0.0.1:${portB}`,
    apiKey: "b-api-key-sentinel",
    authHeader: "x-provider-b-auth",
    authScheme: "",
    extraHeaders: { "x-snapshot-route": "B" },
    timeoutMs: 1000,
    verifySsl: true,
    requestIdHeader: "x-b-request-id"
  });
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 1, settings: settingsA });
  const captureManager = createMemoryCaptureManager();
  const logs = [];
  const proxy = createServer(settingsA, {
    settingsSource: source,
    captureManager,
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
    body: JSON.stringify({ request: "A" })
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
    body: JSON.stringify({ request: "B" })
  });
  releaseA.release();
  const responseA = await responseAPromise;

  assert.deepEqual(responseA, { status: 200, body: { upstream: "A" } });
  assert.deepEqual(responseB, { status: 200, body: { upstream: "B" } });
  assert.equal(observedA.length, 1);
  assert.equal(observedA[0].headers["x-provider-a-auth"], "Token a-api-key-sentinel");
  assert.equal(observedA[0].headers["x-snapshot-route"], "A");
  assert.equal(observedB.length, 1);
  assert.equal(observedB[0].headers["x-provider-b-auth"], "b-api-key-sentinel");
  assert.equal(observedB[0].headers["x-snapshot-route"], "B");
  assert.deepEqual(captureManager.records.map((record) => new URL(record.targetUrl).host), [
    `127.0.0.1:${portB}`,
    `127.0.0.1:${portA}`
  ]);
  assert.deepEqual(
    logs.filter((entry) => entry.message === "Proxied request").map((entry) => entry.fields.request_id).sort(),
    ["request-a", "request-b"]
  );
});

test("an in-flight A request retains its longer timeout after B is applied", async (t) => {
  const releaseA = createGate();
  t.after(() => releaseA.release());
  const receivedA = createSignal();

  const upstreamA = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      receivedA.resolve();
      releaseA.promise.then(() => res.end(JSON.stringify({ upstream: "A" })));
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
  const proxy = createServer(settingsB, {
    settingsSource: source,
    captureManager: createMemoryCaptureManager(),
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
  assert.deepEqual(responseA, { status: 200, body: { upstream: "A" } });
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
  assert.match(output, /DEBUG \[REQUEST\]/);
  assert.equal(output.includes("k3y"), false);
  assert.equal(output.includes("client-custom-auth-sentinel"), false);
  assert.equal(output.includes("response-custom-auth-secret"), false);
  assert.equal(output.includes("session-cookie-secret"), false);
  assert.equal(output.includes('"x-api-key": "tiny"'), false);
  assert.match(output, /"x-api-key": "\[REDACTED\]"/);
  assert.match(output, /"x-diagnostic": "trace-visible"/);
  assert.equal(output.includes(JSON.stringify(source.current())), false);
  assert.equal(observedAuthHeader, "k3y");
});
