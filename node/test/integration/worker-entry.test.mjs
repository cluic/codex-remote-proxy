import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateChildMessage } from "../../src/worker/protocol.mjs";
import { AccessKeyStore } from "../../src/access-key-store.mjs";

const WORKER_ENTRY_PATH = fileURLToPath(new URL("../../src/worker/worker-entry.mjs", import.meta.url));
const EVENT_DEADLINE_MS = 3000;

function makeTempDir(prefix) {
  return join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

function listen(server, host = "127.0.0.1") {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, host, () => {
      server.off("error", rejectPromise);
      resolvePromise(server.address().port);
    });
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

function withDeadline(promise, description, timeoutMs = EVENT_DEADLINE_MS) {
  let timeout;
  const deadline = new Promise((_, rejectPromise) => {
    timeout = setTimeout(() => rejectPromise(new Error(`Timed out waiting for ${description}`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

async function waitForListenerClose(port, timeoutMs = EVENT_DEADLINE_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise((resolvePromise) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.once("error", () => resolvePromise(false));
    });
    if (!connected) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for listener on port ${port} to close`);
}

function waitForExit(child, timeoutMs = EVENT_DEADLINE_MS) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return withDeadline(
    once(child, "exit").then(([code, signal]) => ({ code, signal })),
    "worker exit",
    timeoutMs
  );
}

function sendMessage(child, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.send(message, (error) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
  });
}

async function cleanupChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (child.connected) {
    try {
      await sendMessage(child, { version: 1, type: "shutdown", requestId: "test-cleanup" });
      await waitForExit(child, 500);
      return;
    } catch {
      // Escalate below.
    }
  }
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 500);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 1000).catch(() => {});
  }
}

function spawnWorker(t) {
  const child = fork(WORKER_ENTRY_PATH, [], {
    execPath: process.execPath,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  const messages = [];
  const waiters = new Set();
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("message", (message) => {
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  });
  child.on("exit", (code, signal) => {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter.reject(new Error(`Worker exited before ${waiter.description}: code=${code} signal=${signal}`));
    }
  });

  t.after(() => cleanupChild(child));

  function waitForMessage(predicate, description) {
    const existing = messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    let waiter;
    const pending = new Promise((resolvePromise, rejectPromise) => {
      waiter = { predicate, resolve: resolvePromise, reject: rejectPromise, description };
      waiters.add(waiter);
    });
    return withDeadline(pending, description).finally(() => waiters.delete(waiter));
  }

  return {
    child,
    messages: () => [...messages],
    output: () => `${stdout}\n${stderr}`,
    waitForMessage
  };
}

function makeSettings({ baseUrl, configPath, port = 0, apiKey = "worker-integration-secret" }) {
  const upstream = {
    baseUrl,
    apiKey,
    timeoutMs: 5000,
    verifySsl: true,
    authHeader: "x-provider-auth",
    authScheme: "Bearer",
    extraHeaders: {}
  };
  const proxy = {
    overrideAuthorization: true,
    requestIdHeader: "x-client-request-id",
    modelMode: "passthrough",
    modelOverride: null,
    modelMappings: []
  };
  return {
    configPath,
    server: {
      host: "127.0.0.1",
      port,
      logLevel: "info"
    },
    providers: [{
      id: "provider-1",
      name: "Primary",
      weight: 100,
      supportedModels: null,
      disabledModels: [],
      upstream,
      proxy
    }],
    upstream,
    proxy,
    capture: {
      enabled: false,
      detailsEnabled: false,
      dbPath: join(configPath, "..", "traffic.sqlite3")
    },
    access: {
      enabled: false,
      dbPath: join(configPath, "..", "access-keys.sqlite3"),
      localToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    },
    routing: {
      mode: "custom_only",
      providerPriorityRules: [],
      accountRevision: 1,
      account: {
        authMode: null,
        quotaStatus: "unknown",
        blockedUntil: null,
        updatedAt: null
      }
    }
  };
}

test("worker configures once, proxies traffic, reports public state, and shuts down cleanly", async (t) => {
  const dir = makeTempDir("crp-worker-entry");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let observedAuthorization = null;
  const upstream = http.createServer((req, res) => {
    observedAuthorization = req.headers["x-provider-auth"] ?? null;
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ upstream: true }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const configPath = join(dir, "proxy-config.json");
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    configPath
  });
  writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const worker = spawnWorker(t);
  const ready = await worker.waitForMessage(
    (message) => message?.type === "ready",
    "worker ready"
  );
  validateChildMessage(ready);
  assert.deepEqual(ready.state, {
    phase: "ready",
    configured: false,
    generation: 0,
    listening: false,
    listenHost: null,
    listenPort: null,
    inFlight: 0
  });

  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-1",
    generation: 1,
    settings
  });
  const configured = await worker.waitForMessage(
    (message) => message?.type === "configured" && message.requestId === "configure-1",
    "worker configured"
  );
  validateChildMessage(configured);
  assert.equal(configured.state.phase, "running");
  assert.equal(configured.state.generation, 1);
  assert.equal(configured.state.listening, true);
  assert.equal(configured.state.listenHost, "127.0.0.1");
  assert.ok(configured.state.listenPort > 0);

  await sendMessage(worker.child, {
    version: 1,
    type: "route-preview",
    requestId: "route-preview-1",
    model: "preview-model"
  });
  const routePreview = await worker.waitForMessage(
    (message) => message?.type === "route-preview" && message.requestId === "route-preview-1",
    "worker route preview"
  );
  assert.equal(JSON.stringify(routePreview).includes(settings.upstream.apiKey), false);
  validateChildMessage(routePreview);
  assert.equal(routePreview.preview.source, "live");
  assert.equal(routePreview.preview.generation, 1);
  assert.equal(routePreview.preview.route, "custom");
  assert.equal(routePreview.preview.reason, "custom_only");
  assert.equal(routePreview.preview.customPrimaryProviderId, "provider-1");
  assert.equal(routePreview.preview.candidates[0].providerName, "Primary");

  const proxyUrl = `http://127.0.0.1:${configured.state.listenPort}`;
  const proxyResponse = await fetch(`${proxyUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-request-id": "proxy-request-1"
    },
    body: JSON.stringify({ hello: "worker" })
  });
  assert.equal(proxyResponse.status, 200);
  assert.deepEqual(await proxyResponse.json(), { upstream: true });
  assert.equal(observedAuthorization, "Bearer worker-integration-secret");

  const healthResponse = await fetch(`${proxyUrl}/_proxy/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.configured, true);
  assert.equal(health.generation, 1);
  assert.equal(JSON.stringify(health).includes(settings.upstream.apiKey), false);

  await sendMessage(worker.child, { version: 1, type: "status", requestId: "status-1" });
  const status = await worker.waitForMessage(
    (message) => message?.type === "status" && message.requestId === "status-1",
    "worker status"
  );
  validateChildMessage(status);
  assert.deepEqual(status.state, configured.state);
  assert.equal(JSON.stringify(status).includes(settings.upstream.apiKey), false);

  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-2",
    generation: 2,
    settings
  });
  const reconfigured = await worker.waitForMessage(
    (message) => message?.type === "configured" && message.requestId === "configure-2",
    "worker reconfigured"
  );
  assert.equal(reconfigured.state.generation, 2);
  assert.equal(reconfigured.state.listenPort, configured.state.listenPort);
  const reconfiguredHealth = await fetch(`${proxyUrl}/_proxy/health`).then((response) => response.json());
  assert.equal(reconfiguredHealth.generation, 2);
  assert.equal(JSON.stringify(reconfiguredHealth).includes(settings.upstream.apiKey), false);

  await sendMessage(worker.child, { version: 1, type: "shutdown", requestId: "shutdown-1" });
  const exit = await waitForExit(worker.child);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(worker.output().includes(settings.upstream.apiKey), false);
});

test("worker enforces durable client key limits while its local Codex token bypasses user quotas", async (t) => {
  const dir = makeTempDir("crp-worker-access");
  mkdirSync(dir, { recursive: true });
  const observedAccessHeaders = [];
  const upstream = http.createServer((req, res) => {
    observedAccessHeaders.push({
      accessKey: req.headers["x-crp-api-key"] ?? null,
      localToken: req.headers["x-crp-local-token"] ?? null
    });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const configPath = join(dir, "proxy-config.json");
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    configPath
  });
  settings.access.enabled = true;
  const accessSecret = "crp_worker_access_0123456789abcdef";
  const accessStore = new AccessKeyStore({
    path: settings.access.dbPath,
    now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    createId: () => "worker-key"
  });
  accessStore.create({
    name: "Worker integration",
    secret: accessSecret,
    expiresAt: null,
    requestLimit: 1
  });
  t.after(() => accessStore.close());
  writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const worker = spawnWorker(t);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await worker.waitForMessage((message) => message?.type === "ready", "worker ready");
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-access",
    generation: 1,
    settings
  });
  const configured = await worker.waitForMessage(
    (message) => message?.type === "configured" && message.requestId === "configure-access",
    "worker access configured"
  );
  const origin = `http://127.0.0.1:${configured.state.listenPort}`;

  const health = await fetch(`${origin}/_proxy/health`);
  assert.equal(health.status, 200);
  assert.equal(accessStore.get("worker-key").requestCount, 0);

  const missing = await fetch(`${origin}/responses`, { method: "POST", body: "{}" });
  assert.equal(missing.status, 401);
  const accepted = await fetch(`${origin}/responses`, {
    method: "POST",
    headers: { "x-crp-api-key": accessSecret },
    body: "{}"
  });
  assert.equal(accepted.status, 200);
  await accepted.arrayBuffer();
  assert.equal(accessStore.get("worker-key").requestCount, 1);
  const exhausted = await fetch(`${origin}/responses`, {
    method: "POST",
    headers: { "x-crp-api-key": accessSecret },
    body: "{}"
  });
  assert.equal(exhausted.status, 429);

  const local = await fetch(`${origin}/responses`, {
    method: "POST",
    headers: { "x-crp-local-token": settings.access.localToken },
    body: "{}"
  });
  assert.equal(local.status, 200);
  await local.arrayBuffer();
  assert.equal(accessStore.get("worker-key").requestCount, 1);
  assert.deepEqual(observedAccessHeaders, [
    { accessKey: null, localToken: null },
    { accessKey: null, localToken: null }
  ]);
});

test("worker drain rejects new traffic and waits for an in-flight request before acknowledging", async (t) => {
  const dir = makeTempDir("crp-worker-drain");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const releaseUpstream = createGate();
  const receivedUpstream = createSignal();
  t.after(() => releaseUpstream.release());
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      receivedUpstream.resolve();
      releaseUpstream.promise.then(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ drained: true }));
      });
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => {
    releaseUpstream.release();
    await closeServer(upstream);
  });

  const configPath = join(dir, "proxy-config.json");
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    configPath,
    apiKey: "worker-drain-secret"
  });
  writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const worker = spawnWorker(t);
  await worker.waitForMessage((message) => message?.type === "ready", "worker ready");
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-drain",
    generation: 1,
    settings
  });
  const configured = await worker.waitForMessage(
    (message) => message?.type === "configured" && message.requestId === "configure-drain",
    "worker configured"
  );
  const proxyUrl = `http://127.0.0.1:${configured.state.listenPort}`;

  const firstRequest = fetch(`${proxyUrl}/responses`, {
    method: "POST",
    body: "in-flight"
  });
  t.after(() => firstRequest.catch(() => {}));
  await withDeadline(receivedUpstream.promise, "upstream receiving in-flight request");

  await sendMessage(worker.child, { version: 1, type: "drain", requestId: "drain-1" });
  await sendMessage(worker.child, { version: 1, type: "status", requestId: "status-draining" });
  const draining = await worker.waitForMessage(
    (message) => message?.type === "status" && message.requestId === "status-draining",
    "draining worker status"
  );
  assert.equal(draining.state.phase, "draining");
  assert.equal(draining.state.inFlight, 1);
  assert.equal(draining.state.listening, false);

  await assert.rejects(fetch(`${proxyUrl}/responses`, {
    method: "POST",
    body: "must-not-be-accepted"
  }));

  releaseUpstream.release();
  const firstResponse = await firstRequest;
  assert.equal(firstResponse.status, 200);
  assert.deepEqual(await firstResponse.json(), { drained: true });

  await sendMessage(worker.child, { version: 1, type: "status", requestId: "status-after-response" });
  const afterResponse = await worker.waitForMessage(
    (message) => message?.type === "status" && message.requestId === "status-after-response",
    "post-response worker status"
  );
  assert.equal(afterResponse.state.phase, "drained");
  assert.equal(afterResponse.state.inFlight, 0);

  const drained = await worker.waitForMessage(
    (message) => message?.type === "drained" && message.requestId === "drain-1",
    "worker drained"
  );
  validateChildMessage(drained);
  assert.equal(drained.state.phase, "drained");
  assert.equal(drained.state.inFlight, 0);
  assert.equal(drained.state.listening, false);

  await sendMessage(worker.child, { version: 1, type: "shutdown", requestId: "shutdown-drained" });
  assert.deepEqual(await waitForExit(worker.child), { code: 0, signal: null });
  assert.equal(worker.output().includes(settings.upstream.apiKey), false);
});

test("worker keeps duplicate drain acknowledgements and status drained", async (t) => {
  const dir = makeTempDir("crp-worker-duplicate-drain");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const configPath = join(dir, "proxy-config.json");
  const settings = makeSettings({
    baseUrl: "http://127.0.0.1:9",
    configPath,
    apiKey: "worker-duplicate-drain-secret"
  });
  writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const worker = spawnWorker(t);
  await worker.waitForMessage((message) => message?.type === "ready", "worker ready");
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-duplicate-drain",
    generation: 1,
    settings
  });
  const configured = await worker.waitForMessage(
    (message) => message?.type === "configured"
      && message.requestId === "configure-duplicate-drain",
    "worker configured"
  );

  await sendMessage(worker.child, { version: 1, type: "drain", requestId: "drain-first" });
  const firstDrained = await worker.waitForMessage(
    (message) => message?.type === "drained" && message.requestId === "drain-first",
    "first drain acknowledgement"
  );
  assert.equal(firstDrained.state.phase, "drained");
  assert.equal(firstDrained.state.listening, false);

  await sendMessage(worker.child, { version: 1, type: "drain", requestId: "drain-second" });
  const secondDrained = await worker.waitForMessage(
    (message) => message?.type === "drained" && message.requestId === "drain-second",
    "second drain acknowledgement"
  );
  assert.equal(secondDrained.state.phase, "drained");
  assert.equal(secondDrained.state.listening, false);

  await sendMessage(worker.child, { version: 1, type: "status", requestId: "status-after-drains" });
  const status = await worker.waitForMessage(
    (message) => message?.type === "status" && message.requestId === "status-after-drains",
    "status after duplicate drain"
  );
  assert.equal(status.state.phase, "drained");
  assert.equal(status.state.listening, false);

  await sendMessage(worker.child, { version: 1, type: "shutdown", requestId: "shutdown-duplicate-drain" });
  assert.deepEqual(await waitForExit(worker.child), { code: 0, signal: null });
  assert.equal(worker.output().includes(settings.upstream.apiKey), false);

  const portProbe = http.createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    portProbe.once("error", rejectPromise);
    portProbe.listen(configured.state.listenPort, "127.0.0.1", resolvePromise);
  });
  await closeServer(portProbe);
});

test("worker rejects configure during drain without losing the in-flight drain", async (t) => {
  const dir = makeTempDir("crp-worker-drain-configure");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const releaseUpstream = createGate();
  const receivedUpstream = createSignal();
  t.after(() => releaseUpstream.release());
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      receivedUpstream.resolve();
      releaseUpstream.promise.then(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ drained: true }));
      });
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => {
    releaseUpstream.release();
    await closeServer(upstream);
  });

  const configPath = join(dir, "proxy-config.json");
  const settingsA = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    configPath,
    apiKey: "worker-drain-race-a-secret"
  });
  const settingsB = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    configPath,
    apiKey: "worker-drain-race-b-secret"
  });
  writeFileSync(configPath, `${JSON.stringify(settingsA, null, 2)}\n`, "utf8");

  const worker = spawnWorker(t);
  await worker.waitForMessage((message) => message?.type === "ready", "worker ready");
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-drain-race-a",
    generation: 1,
    settings: settingsA
  });
  const configured = await worker.waitForMessage(
    (message) => message?.type === "configured" && message.requestId === "configure-drain-race-a",
    "worker configured"
  );
  const proxyUrl = `http://127.0.0.1:${configured.state.listenPort}`;

  const firstRequest = fetch(`${proxyUrl}/responses`, {
    method: "POST",
    body: "in-flight"
  });
  t.after(() => firstRequest.catch(() => {}));
  await withDeadline(receivedUpstream.promise, "upstream receiving drain-race request");

  await sendMessage(worker.child, { version: 1, type: "drain", requestId: "drain-race" });
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-during-drain",
    generation: 2,
    settings: settingsB
  });
  const outcome = await worker.waitForMessage(
    (message) => message?.requestId === "configure-during-drain"
      && (message.type === "fatal" || message.type === "configured"),
    "configure-during-drain outcome"
  );
  releaseUpstream.release();

  assert.equal(outcome.type, "fatal");
  validateChildMessage(outcome);
  assert.deepEqual(outcome.error, {
    code: "WORKER_CONFIGURE_FAILED",
    message: "Worker configuration failed."
  });

  const firstResponse = await firstRequest;
  assert.equal(firstResponse.status, 200);
  assert.deepEqual(await firstResponse.json(), { drained: true });
  const drained = await worker.waitForMessage(
    (message) => message?.type === "drained" && message.requestId === "drain-race",
    "drain-race acknowledgement"
  );
  assert.equal(drained.state.phase, "drained");
  assert.equal(drained.state.listening, false);
  assert.equal(drained.state.inFlight, 0);

  assert.deepEqual(await waitForExit(worker.child), { code: 1, signal: null });
  assert.equal(
    worker.messages().some((message) => (
      message?.type === "configured" && message.requestId === "configure-during-drain"
    )),
    false
  );
  const output = `${JSON.stringify(worker.messages())}\n${worker.output()}`;
  assert.equal(output.includes(settingsA.upstream.apiKey), false);
  assert.equal(output.includes(settingsB.upstream.apiKey), false);

  const portProbe = http.createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    portProbe.once("error", rejectPromise);
    portProbe.listen(configured.state.listenPort, "127.0.0.1", resolvePromise);
  });
  await closeServer(portProbe);
});

test("worker rejects an invalid configure message before listening without echoing its payload", async (t) => {
  const worker = spawnWorker(t);
  const ready = await worker.waitForMessage((message) => message?.type === "ready", "worker ready");
  assert.equal(ready.state.listening, false);

  const reflectedRequestId = "sk-secret-sentinel";
  const settings = makeSettings({
    baseUrl: "http://127.0.0.1:9",
    configPath: "/tmp/crp-invalid-worker-config.json",
    apiKey: "invalid-configure-secret"
  });
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: reflectedRequestId,
    generation: 1,
    settings,
    unexpected: "invalid-payload-secret"
  });

  const fatal = await worker.waitForMessage(
    (message) => message?.type === "fatal",
    "invalid protocol fatal"
  );
  validateChildMessage(fatal);
  assert.deepEqual(fatal, {
    version: 1,
    type: "fatal",
    requestId: "worker-fatal",
    error: {
      code: "WORKER_PROTOCOL_INVALID",
      message: "Worker protocol message is invalid."
    }
  });
  const serialized = JSON.stringify(fatal);
  assert.equal(serialized.includes("invalid-configure-secret"), false);
  assert.equal(serialized.includes("invalid-payload-secret"), false);
  assert.equal(serialized.includes(reflectedRequestId), false);
  assert.deepEqual(await waitForExit(worker.child), { code: 1, signal: null });
  assert.equal(worker.output().includes("invalid-configure-secret"), false);
  assert.equal(worker.output().includes("invalid-payload-secret"), false);
  assert.equal(worker.output().includes(reflectedRequestId), false);
});

test("worker rejects an unsendable API key without leaking it", async (t) => {
  const apiKey = "invalid-key\r\nsk-secret-api-key-sentinel";
  const settings = makeSettings({
    baseUrl: "http://127.0.0.1:9",
    configPath: "/tmp/crp-invalid-worker-api-key.json",
    apiKey
  });
  const worker = spawnWorker(t);
  await worker.waitForMessage((message) => message?.type === "ready", "worker ready");
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-invalid-api-key",
    generation: 1,
    settings
  });

  const outcome = await worker.waitForMessage(
    (message) => message?.type === "fatal" || message?.type === "configured",
    "invalid API key outcome"
  );
  assert.equal(outcome.type, "fatal");
  validateChildMessage(outcome);
  assert.deepEqual(outcome, {
    version: 1,
    type: "fatal",
    requestId: "worker-fatal",
    error: {
      code: "WORKER_PROTOCOL_INVALID",
      message: "Worker protocol message is invalid."
    }
  });
  assert.deepEqual(await waitForExit(worker.child), { code: 1, signal: null });
  const output = `${JSON.stringify(worker.messages())}\n${worker.output()}`;
  assert.equal(output.includes(apiKey), false);
  assert.equal(output.includes("sk-secret-api-key-sentinel"), false);
});

test("worker rejects a stale generation safely and releases its listening port", async (t) => {
  const dir = makeTempDir("crp-worker-stale");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const configPath = join(dir, "proxy-config.json");
  const settingsA = makeSettings({
    baseUrl: "http://127.0.0.1:9",
    configPath,
    apiKey: "worker-stale-a-secret"
  });
  const settingsB = makeSettings({
    baseUrl: "http://127.0.0.1:10",
    configPath,
    apiKey: "worker-stale-b-secret"
  });
  writeFileSync(configPath, `${JSON.stringify(settingsA, null, 2)}\n`, "utf8");

  const worker = spawnWorker(t);
  await worker.waitForMessage((message) => message?.type === "ready", "worker ready");
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-stale-a",
    generation: 1,
    settings: settingsA
  });
  const configured = await worker.waitForMessage(
    (message) => message?.type === "configured" && message.requestId === "configure-stale-a",
    "worker configured"
  );

  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-stale-b",
    generation: 1,
    settings: settingsB
  });
  const fatal = await worker.waitForMessage(
    (message) => message?.type === "fatal" && message.requestId === "configure-stale-b",
    "stale snapshot fatal"
  );
  validateChildMessage(fatal);
  assert.equal(fatal.error.code, "STALE_SNAPSHOT");
  assert.equal(JSON.stringify(fatal).includes(settingsA.upstream.apiKey), false);
  assert.equal(JSON.stringify(fatal).includes(settingsB.upstream.apiKey), false);
  assert.deepEqual(await waitForExit(worker.child), { code: 1, signal: null });
  assert.equal(worker.output().includes(settingsA.upstream.apiKey), false);
  assert.equal(worker.output().includes(settingsB.upstream.apiKey), false);

  const portProbe = http.createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    portProbe.once("error", rejectPromise);
    portProbe.listen(configured.state.listenPort, "127.0.0.1", resolvePromise);
  });
  await closeServer(portProbe);
});

test("worker reports a sanitized startup fatal when the requested port is occupied", async (t) => {
  const dir = makeTempDir("crp-worker-port-busy");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const blocker = http.createServer();
  const blockedPort = await listen(blocker);
  t.after(() => closeServer(blocker));

  const configPath = join(dir, "proxy-config.json");
  const settings = makeSettings({
    baseUrl: "http://127.0.0.1:9",
    configPath,
    port: blockedPort,
    apiKey: "worker-port-busy-secret"
  });
  writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const worker = spawnWorker(t);
  await worker.waitForMessage((message) => message?.type === "ready", "worker ready");
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-port-busy",
    generation: 1,
    settings
  });
  const fatal = await worker.waitForMessage(
    (message) => message?.type === "fatal" && message.requestId === "configure-port-busy",
    "port conflict fatal"
  );
  validateChildMessage(fatal);
  assert.deepEqual(fatal.error, {
    code: "WORKER_START_FAILED",
    message: "Worker failed to start."
  });
  assert.equal(JSON.stringify(fatal).includes(settings.upstream.apiKey), false);
  assert.deepEqual(await waitForExit(worker.child), { code: 1, signal: null });
  assert.equal(worker.output().includes(settings.upstream.apiKey), false);
  assert.equal(blocker.listening, true);
});

test("worker closes resources when the parent IPC channel disconnects", async (t) => {
  const dir = makeTempDir("crp-worker-disconnect");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const configPath = join(dir, "proxy-config.json");
  const settings = makeSettings({
    baseUrl: "http://127.0.0.1:9",
    configPath,
    apiKey: "worker-disconnect-secret"
  });
  writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const worker = spawnWorker(t);
  await worker.waitForMessage((message) => message?.type === "ready", "worker ready");
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-disconnect",
    generation: 1,
    settings
  });
  const configured = await worker.waitForMessage(
    (message) => message?.type === "configured" && message.requestId === "configure-disconnect",
    "worker configured"
  );

  worker.child.disconnect();
  assert.deepEqual(await waitForExit(worker.child), { code: 0, signal: null });
  assert.equal(worker.output().includes(settings.upstream.apiKey), false);

  const portProbe = http.createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    portProbe.once("error", rejectPromise);
    portProbe.listen(configured.state.listenPort, "127.0.0.1", resolvePromise);
  });
  await closeServer(portProbe);
});

test("worker bounds parent disconnect cleanup with a hanging upstream request", async (t) => {
  const dir = makeTempDir("crp-worker-disconnect-hanging");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const receivedUpstream = createSignal();
  const upstream = http.createServer((req) => {
    req.resume();
    req.on("end", () => receivedUpstream.resolve());
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => {
    upstream.closeAllConnections?.();
    await closeServer(upstream);
  });

  const configPath = join(dir, "proxy-config.json");
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    configPath,
    apiKey: "worker-disconnect-hanging-secret"
  });
  settings.upstream.timeoutMs = 30_000;
  writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const worker = spawnWorker(t);
  await worker.waitForMessage((message) => message?.type === "ready", "worker ready");
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-disconnect-hanging",
    generation: 1,
    settings
  });
  const configured = await worker.waitForMessage(
    (message) => message?.type === "configured"
      && message.requestId === "configure-disconnect-hanging",
    "worker configured"
  );
  const proxyRequestOutcome = fetch(`http://127.0.0.1:${configured.state.listenPort}/responses`, {
    method: "POST",
    body: "hang-until-parent-disconnect"
  }).then(
    () => ({ status: "resolved" }),
    () => ({ status: "rejected" })
  );
  await withDeadline(receivedUpstream.promise, "upstream receiving disconnect request");

  worker.child.disconnect();
  assert.deepEqual(await waitForExit(worker.child, 1500), { code: 0, signal: null });
  const requestOutcome = await withDeadline(
    proxyRequestOutcome,
    "proxy request settling after parent disconnect",
    1500
  );
  assert.equal(requestOutcome.status, "rejected");

  const output = `${JSON.stringify(worker.messages())}\n${worker.output()}`;
  assert.equal(output.includes(settings.upstream.apiKey), false);

  const portProbe = http.createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    portProbe.once("error", rejectPromise);
    portProbe.listen(configured.state.listenPort, "127.0.0.1", resolvePromise);
  });
  await closeServer(portProbe);
});

test("worker bounds parent disconnect cleanup after shutdown is already waiting", async (t) => {
  const dir = makeTempDir("crp-worker-shutdown-disconnect-hanging");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const receivedUpstream = createSignal();
  const upstream = http.createServer((req) => {
    req.resume();
    req.on("end", () => receivedUpstream.resolve());
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => {
    upstream.closeAllConnections?.();
    await closeServer(upstream);
  });

  const configPath = join(dir, "proxy-config.json");
  const settings = makeSettings({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    configPath,
    apiKey: "worker-shutdown-disconnect-hanging-secret"
  });
  settings.upstream.timeoutMs = 30_000;
  writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const worker = spawnWorker(t);
  await worker.waitForMessage((message) => message?.type === "ready", "worker ready");
  await sendMessage(worker.child, {
    version: 1,
    type: "configure",
    requestId: "configure-shutdown-disconnect-hanging",
    generation: 1,
    settings
  });
  const configured = await worker.waitForMessage(
    (message) => message?.type === "configured"
      && message.requestId === "configure-shutdown-disconnect-hanging",
    "worker configured"
  );
  const proxyRequestOutcome = fetch(`http://127.0.0.1:${configured.state.listenPort}/responses`, {
    method: "POST",
    body: "hang-through-shutdown-until-parent-disconnect"
  }).then(
    () => ({ status: "resolved" }),
    () => ({ status: "rejected" })
  );
  await withDeadline(receivedUpstream.promise, "upstream receiving shutdown-disconnect request");

  await sendMessage(worker.child, {
    version: 1,
    type: "shutdown",
    requestId: "shutdown-before-parent-disconnect"
  });
  await waitForListenerClose(configured.state.listenPort);
  worker.child.disconnect();

  assert.deepEqual(await waitForExit(worker.child, 1500), { code: 0, signal: null });
  const requestOutcome = await withDeadline(
    proxyRequestOutcome,
    "proxy request settling after shutdown and parent disconnect",
    1500
  );
  assert.equal(requestOutcome.status, "rejected");

  const output = `${JSON.stringify(worker.messages())}\n${worker.output()}`;
  assert.equal(output.includes(settings.upstream.apiKey), false);

  const portProbe = http.createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    portProbe.once("error", rejectPromise);
    portProbe.listen(configured.state.listenPort, "127.0.0.1", resolvePromise);
  });
  await closeServer(portProbe);
});
