import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { WorkerManager } from "../src/supervisor/worker-manager.mjs";

const SECRET = "manager-unit-secret";

function makeSnapshot(generation = 1, port = 15100, providerId = null) {
  const upstream = {
    baseUrl: "http://127.0.0.1:41001",
    apiKey: SECRET,
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
    ...(providerId === null ? {} : { providerId }),
    generation,
    settings: {
      configPath: "/tmp/crp-worker-manager/proxy-config.json",
      server: { host: "127.0.0.1", port, logLevel: "info" },
      providers: [{
        id: providerId ?? "provider-1",
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
        dbPath: "/tmp/crp-worker-manager/traffic.sqlite3"
      },
      access: {
        enabled: false,
        dbPath: "/tmp/crp-worker-manager/access-keys.sqlite3",
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
    }
  };
}

function state(overrides = {}) {
  return {
    phase: "running",
    configured: true,
    generation: 1,
    listening: true,
    listenHost: "127.0.0.1",
    listenPort: 15100,
    inFlight: 0,
    ...overrides
  };
}

function childMessage(type, requestId, overrides = {}) {
  return { version: 1, type, requestId, state: state(overrides) };
}

function routePreview(generation = 1) {
  return {
    source: "live",
    generation,
    evaluatedAt: "2030-01-01T00:00:00.000Z",
    operation: "responses",
    requestFormat: "json",
    route: "custom",
    reason: "custom_only",
    account: {
      enabled: false,
      selected: false,
      reason: "custom_only",
      operationSupported: true,
      fallbackAvailable: true
    },
    matchedPriorityRule: false,
    customSelectionReason: "sole_eligible",
    customPrimaryProviderId: "provider-1",
    candidates: [{
      providerId: "provider-1",
      providerName: "Primary",
      weight: 100,
      targetModel: null,
      transformation: "passthrough",
      availability: "ready",
      coolingUntil: null,
      order: 1
    }]
  };
}

function createClock() {
  let current = 1_000;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(callback, delay) {
      const id = ++sequence;
      timers.set(id, { id, at: current + delay, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    nextDelay() {
      if (timers.size === 0) return null;
      return Math.min(...[...timers.values()].map((timer) => timer.at - current));
    },
    async advance(delay) {
      current += delay;
      const due = [...timers.values()]
        .filter((timer) => timer.at <= current)
        .sort((left, right) => left.at - right.at || left.id - right.id);
      for (const timer of due) {
        timers.delete(timer.id);
        timer.callback();
        await Promise.resolve();
      }
    },
    pending: () => timers.size
  };
}

let nextPid = 9_000;

class FakeChild extends EventEmitter {
  constructor(script = {}) {
    super();
    this.pid = ++nextPid;
    this.connected = true;
    this.exitCode = null;
    this.signalCode = null;
    this.sent = [];
    this.killed = [];
    this.script = script;
    this.sendCounts = new Map();
    queueMicrotask(() => {
      if (script.ready !== false) {
        this.emit("message", childMessage("ready", "worker-ready", {
          phase: "ready",
          configured: false,
          generation: 0,
          listening: false,
          listenHost: null,
          listenPort: null
        }));
      }
    });
  }

  send(message, callback) {
    this.sent.push(structuredClone(message));
    const sendCount = (this.sendCounts.get(message.type) ?? 0) + 1;
    this.sendCounts.set(message.type, sendCount);
    queueMicrotask(() => {
      if (this.script.failSend?.[message.type]?.includes(sendCount)) {
        callback?.(new Error("sensitive send failure must not pass"));
        return;
      }
      if (message.type === "configure"
        && this.script.ackBeforeCallback
        && this.script.configure !== false) {
        const requestId = this.script.configureRequestId ?? message.requestId;
        this.emit("message", childMessage("configured", requestId, {
          generation: message.generation,
          listenHost: message.settings.server.host,
          listenPort: message.settings.server.port
        }));
        callback?.(null);
        return;
      }
      callback?.(null);
      if (message.type === "configure" && this.script.configure !== false) {
        const requestId = this.script.configureRequestId ?? message.requestId;
        this.emit("message", childMessage("configured", requestId, {
          generation: message.generation,
          listenHost: message.settings.server.host,
          listenPort: message.settings.server.port
        }));
      }
      if (message.type === "account-state" && this.script.accountState !== false) {
        this.emit("message", {
          version: 1,
          type: "account-state-applied",
          requestId: message.requestId,
          revision: message.revision
        });
      }
      if (message.type === "route-preview" && this.script.routePreview !== false) {
        const generation = this.sent.findLast((candidate) => candidate.type === "configure")?.generation ?? 1;
        this.emit("message", {
          version: 1,
          type: "route-preview",
          requestId: message.requestId,
          preview: this.script.preview ?? routePreview(generation)
        });
      }
      if (message.type === "drain" && this.script.drain !== false) {
        this.emit("message", childMessage("drained", message.requestId, {
          phase: "drained",
          generation: this.script.generation ?? 1,
          listening: false,
          listenHost: null,
          listenPort: null
        }));
      }
      if (message.type === "shutdown" && this.script.shutdown !== false) {
        this.exit(0, null);
      }
    });
  }

  kill(signal = "SIGTERM") {
    this.killed.push(signal);
    if (signal === "SIGTERM" && this.script.ignoreTerm) return true;
    if (signal === "SIGKILL" && this.script.ignoreKill) return true;
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }

  disconnect() {
    this.connected = false;
  }

  exit(code = 1, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.connected = false;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function createHarness(scripts = [], {
  healthOk = true,
  forkError = false,
  portError = false,
  useDefaultFork = false,
  runRecoveryWhenReady = (operation) => operation(),
  recordMetric,
  noteDroppedMetric
} = {}) {
  const clock = createClock();
  const children = [];
  const healthCalls = [];
  const portChecks = [];
  const forkCalls = [];
  const metrics = [];
  let droppedMetrics = 0;
  const forkWorker = () => {
    if (forkError) throw new Error("sensitive fork cause must not pass");
    const child = new FakeChild(scripts[children.length] ?? {});
    children.push(child);
    return child;
  };
  const forkDependency = useDefaultFork ? {
    forkImpl(entryPath, args, options) {
      forkCalls.push({
        entryPath,
        args: structuredClone(args),
        options: structuredClone(options)
      });
      return forkWorker();
    }
  } : { forkWorker };
  const manager = new WorkerManager({
    host: "127.0.0.1",
    port: 15100,
    clock,
    readyTimeoutMs: 100,
    ackTimeoutMs: 100,
    healthTimeoutMs: 100,
    terminateTimeoutMs: 100,
    killTimeoutMs: 100,
    ...forkDependency,
    async fetchImpl(url) {
      healthCalls.push(url);
      const generation = children.at(-1)?.sent.findLast((message) => message.type === "configure")?.generation;
      return { ok: healthOk, json: async () => ({ configured: healthOk, generation }) };
    },
    async waitForPortFree(host, port) {
      portChecks.push({ host, port });
      if (portError) {
        const error = new Error("sensitive port probe cause must not pass");
        error.code = "WORKER_PORT_BUSY";
        throw error;
      }
    },
    runRecoveryWhenReady,
    recordMetric: recordMetric ?? ((observation) => {
      metrics.push(structuredClone(observation));
      return true;
    }),
    noteDroppedMetric: noteDroppedMetric ?? (() => {
      droppedMetrics += 1;
    })
  });
  return {
    manager,
    clock,
    children,
    forkCalls,
    healthCalls,
    portChecks,
    metrics,
    get droppedMetrics() {
      return droppedMetrics;
    }
  };
}

async function settle(promise, clock, { maxSteps = 30 } = {}) {
  let settled = false;
  let result;
  let failure;
  promise.then((value) => {
    settled = true;
    result = value;
  }, (error) => {
    settled = true;
    failure = error;
  });
  for (let step = 0; step < maxSteps && !settled; step += 1) {
    for (let turn = 0; turn < 12 && !settled; turn += 1) {
      await Promise.resolve();
    }
    if (!settled && clock.nextDelay() !== null) {
      await clock.advance(clock.nextDelay());
    }
  }
  if (!settled) throw new Error("Test promise did not settle.");
  if (failure) throw failure;
  return result;
}

async function flushUntil(predicate, description, maxTurns = 40) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function collectUnhandledRejections(t) {
  const reasons = [];
  const listener = (reason) => reasons.push(reason);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  return reasons;
}

test("start waits for ready, correlated configure, and matching health before running", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());

  assert.equal(harness.manager.getPublicState().phase, "stopped");
  const started = await settle(harness.manager.start(makeSnapshot()), harness.clock);

  assert.equal(started.phase, "running");
  assert.equal(started.pid, harness.children[0].pid);
  assert.equal(started.generation, 1);
  assert.equal(started.state.phase, "running");
  assert.equal(started.restartCount, 0);
  assert.equal(typeof started.startedAt, "string");
  assert.deepEqual(Object.keys(started).sort(), [
    "error", "generation", "phase", "pid", "restartCount", "startedAt", "state"
  ]);
  assert.equal(JSON.stringify(started).includes(SECRET), false);
  assert.equal(harness.healthCalls.length, 1);
  assert.equal(harness.children[0].sent[0].type, "configure");
  assert.equal(harness.children[0].sent[0].settings.upstream.apiKey, SECRET);
});

test("public bind snapshots still use loopback health probes and release the public listener", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  const snapshot = makeSnapshot();
  snapshot.settings.server.host = "0.0.0.0";
  snapshot.settings.access.enabled = true;

  const running = await settle(harness.manager.start(snapshot), harness.clock);
  assert.equal(running.state.listenHost, "0.0.0.0");
  assert.deepEqual(harness.healthCalls, ["http://127.0.0.1:15100/_proxy/health"]);
  await settle(harness.manager.stop(), harness.clock);
  assert.deepEqual(harness.portChecks.at(-1), { host: "0.0.0.0", port: 15100 });
});

test("default worker forks stay hidden across start, restart, and crash recovery", async (t) => {
  const harness = createHarness([], { useDefaultFork: true });
  t.after(() => harness.manager.close());

  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  await settle(harness.manager.restart(makeSnapshot(2)), harness.clock);
  harness.children[1].exit(1, null);
  await flushUntil(
    () => harness.manager.getPublicState().phase === "backoff",
    "hidden worker recovery backoff"
  );
  await harness.clock.advance(250);
  await flushUntil(
    () => harness.manager.getPublicState().phase === "running",
    "hidden worker recovery"
  );

  assert.equal(harness.forkCalls.length, 3);
  for (const call of harness.forkCalls) {
    assert.match(call.entryPath, /worker-entry\.mjs$/);
    assert.deepEqual(call.args, []);
    assert.deepEqual(call.options, {
      execPath: process.execPath,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true
    });
  }
});

test("applySnapshot updates the confirmed generation only after a matching acknowledgement", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);

  const applied = await settle(harness.manager.applySnapshot(makeSnapshot(2)), harness.clock);
  assert.equal(applied.generation, 2);
  assert.equal(applied.state.generation, 2);

  harness.children[0].script.configureRequestId = "wrong-request";
  await assert.rejects(
    settle(harness.manager.applySnapshot(makeSnapshot(3)), harness.clock),
    (error) => error?.code === "WORKER_ACK_TIMEOUT" && !error.message.includes(SECRET)
  );
  assert.equal(harness.manager.getPublicState().generation, 2);
  assert.equal(harness.manager.getPublicState().state.generation, 2);
});

test("metric observations retain request-generation provider attribution across hot switching", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot(1, 15100, "provider-a")), harness.clock);
  await settle(harness.manager.applySnapshot(makeSnapshot(2, 15100, "provider-b")), harness.clock);
  const child = harness.children[0];
  const metric = (generation, providerId, result, model) => ({
    version: 1,
    type: "metric",
    requestId: "metric-observation",
    observation: {
      generation,
      route: "custom",
      providerId,
      result,
      model,
      inputTokens: result === "success" ? 12 : null,
      outputTokens: result === "success" ? 3 : null,
      durationBin: 4,
      responseStartBin: result === "success" ? 2 : null
    }
  });

  child.emit("message", metric(2, "provider-b", "success", "model-b"));
  child.emit("message", metric(1, "provider-a", "upstreamError", "model-a"));
  child.emit("message", metric(999, "provider-missing", "networkError", null));
  await Promise.resolve();

  assert.deepEqual(harness.metrics, [
    {
      providerId: "provider-b",
      result: "success",
      model: "model-b",
      inputTokens: 12,
      outputTokens: 3,
      durationBin: 4,
      responseStartBin: 2
    },
    {
      providerId: "provider-a",
      result: "upstreamError",
      model: "model-a",
      inputTokens: null,
      outputTokens: null,
      durationBin: 4,
      responseStartBin: null
    }
  ]);
  assert.equal(harness.droppedMetrics, 1);
  assert.equal(harness.manager.getPublicState().phase, "running");
  assert.equal(JSON.stringify(harness.manager.getPublicState()).includes("provider-a"), false);
});

test("account route metrics use the built-in account attribution", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot(1, 15100, "provider-a")), harness.clock);

  harness.children[0].emit("message", {
    version: 1,
    type: "metric",
    requestId: "metric-observation",
    observation: {
      generation: 1,
      route: "account",
      providerId: null,
      result: "success",
      model: "gpt-5-codex",
      inputTokens: 12,
      outputTokens: 3,
      durationBin: 4,
      responseStartBin: 2
    }
  });
  await Promise.resolve();

  assert.equal(harness.metrics.length, 1);
  assert.equal(harness.metrics[0].providerId, "crp-chatgpt-account");
});

test("account routing state updates are acknowledged and stale revisions are skipped", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  const update = {
    revision: 2,
    state: {
      authMode: "chatgpt",
      quotaStatus: "available",
      blockedUntil: null,
      updatedAt: "2026-08-20T00:00:00.000Z"
    }
  };

  await settle(harness.manager.applyAccountState(update), harness.clock);
  await settle(harness.manager.applyAccountState(update), harness.clock);

  assert.equal(
    harness.children[0].sent.filter((message) => message.type === "account-state").length,
    1
  );
});

test("route previews use a bounded read-only IPC request without changing lifecycle state", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);

  const preview = await settle(harness.manager.previewRoute("model-a"), harness.clock);
  assert.deepEqual(preview, routePreview(1));
  assert.deepEqual(
    harness.children[0].sent.find((message) => message.type === "route-preview"),
    {
      version: 1,
      type: "route-preview",
      requestId: "route-preview-2",
      model: "model-a",
      operation: "responses",
      requestFormat: "json"
    }
  );
  assert.equal(harness.manager.getPublicState().phase, "running");

  await settle(harness.manager.previewRoute(
    "gpt-image-2",
    "images/edits",
    "multipart"
  ), harness.clock);
  assert.deepEqual(
    harness.children[0].sent.findLast((message) => message.type === "route-preview"),
    {
      version: 1,
      type: "route-preview",
      requestId: "route-preview-3",
      model: "gpt-image-2",
      operation: "images/edits",
      requestFormat: "multipart"
    }
  );

  const sentinel = "route-preview-secret-sentinel";
  await assert.rejects(
    harness.manager.previewRoute(` ${sentinel}`),
    (error) => {
      assert.equal(String(error?.message).includes(sentinel), false);
      return error?.code === "WORKER_PROTOCOL_INVALID";
    }
  );
  await assert.rejects(
    harness.manager.previewRoute("model-a", "images/variations"),
    (error) => error?.code === "WORKER_PROTOCOL_INVALID"
  );
});

test("metric callback failures are dropped without changing worker lifecycle state", async (t) => {
  let dropped = 0;
  const harness = createHarness([], {
    recordMetric() {
      throw new Error("private metrics persistence failure");
    },
    noteDroppedMetric() {
      dropped += 1;
    }
  });
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot(1, 15100, "provider-a")), harness.clock);

  harness.children[0].emit("message", {
    version: 1,
    type: "metric",
    requestId: "metric-observation",
    observation: {
      generation: 1,
      route: "custom",
      providerId: "provider-a",
      result: "success",
      model: null,
      inputTokens: null,
      outputTokens: null,
      durationBin: 0,
      responseStartBin: 0
    }
  });
  await Promise.resolve();

  assert.equal(dropped, 1);
  assert.equal(harness.manager.getPublicState().phase, "running");
  assert.equal(harness.manager.getPublicState().error, null);
});

test("stop drains, shuts down, observes exit, and confirms fixed-port release", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);

  const stopped = await settle(harness.manager.stop({ drainTimeoutMs: 100 }), harness.clock);

  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.pid, null);
  assert.deepEqual(harness.children[0].sent.map((message) => message.type), [
    "configure", "drain", "shutdown"
  ]);
  assert.deepEqual(harness.portChecks, [{ host: "127.0.0.1", port: 15100 }]);
});

test("stop escalates a drain timeout through TERM and bounded KILL", async (t) => {
  const harness = createHarness([{ drain: false, ignoreTerm: true }]);
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);

  await settle(harness.manager.stop({ drainTimeoutMs: 100 }), harness.clock);

  assert.deepEqual(harness.children[0].killed, ["SIGTERM", "SIGKILL"]);
  assert.equal(harness.manager.getPublicState().phase, "stopped");
  assert.equal(harness.portChecks.length, 1);
});

test("termination timeout retains child control so a later close can retry cleanup", async () => {
  const harness = createHarness([{
    drain: false,
    ignoreTerm: true,
    ignoreKill: true
  }]);
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  const child = harness.children[0];

  await assert.rejects(
    settle(harness.manager.stop({ drainTimeoutMs: 100 }), harness.clock),
    (error) => error?.code === "WORKER_STOP_FAILED"
  );
  const failed = harness.manager.getPublicState();
  assert.equal(failed.phase, "failed");
  assert.equal(failed.pid, child.pid);
  assert.equal(child.listenerCount("exit"), 1);
  assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
  assert.equal(harness.children.length, 1);
  await Promise.resolve();
  await assert.rejects(
    harness.manager.start(makeSnapshot()),
    (error) => error?.code === "WORKER_STOP_FAILED"
  );
  assert.equal(harness.children.length, 1);
  assert.equal(harness.manager.getPublicState().pid, child.pid);

  child.script.ignoreTerm = false;
  child.script.ignoreKill = false;
  const closed = await settle(harness.manager.close(), harness.clock);
  assert.equal(closed.phase, "stopped");
  assert.equal(closed.pid, null);
  assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL", "SIGTERM"]);
  assert.equal(harness.portChecks.length, 1);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(harness.children.length, 1);
});

test("partial-start termination timeout preserves the startup error and retryable child control", async () => {
  const harness = createHarness([{
    ignoreTerm: true,
    ignoreKill: true
  }], { healthOk: false });
  const childPromise = harness.manager.start(makeSnapshot());

  await assert.rejects(
    settle(childPromise, harness.clock),
    (error) => error?.code === "WORKER_HEALTH_FAILED"
  );
  const failed = harness.manager.getPublicState();
  const child = harness.children[0];
  assert.equal(failed.phase, "failed");
  assert.equal(failed.pid, child.pid);
  assert.deepEqual(failed.error, {
    code: "WORKER_HEALTH_FAILED",
    message: "Worker health verification failed."
  });
  assert.equal(child.listenerCount("exit"), 1);

  child.script.ignoreTerm = false;
  child.script.ignoreKill = false;
  const closed = await settle(harness.manager.close(), harness.clock);
  assert.equal(closed.phase, "stopped");
  assert.equal(closed.pid, null);
  assert.equal(harness.portChecks.length, 1);
  assert.equal(harness.children.length, 1);
});

test("restart releases the fixed port, changes PID, and requires matching health", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  const oldPid = harness.manager.getPublicState().pid;

  const restarted = await settle(
    harness.manager.restart(makeSnapshot(2), { drainTimeoutMs: 100 }),
    harness.clock
  );

  assert.equal(restarted.phase, "running");
  assert.notEqual(restarted.pid, oldPid);
  assert.equal(restarted.generation, 2);
  assert.equal(restarted.restartCount, 1);
  assert.equal(harness.children.length, 2);
  assert.equal(harness.portChecks.length, 1);
  assert.equal(harness.healthCalls.length, 2);
});

test("restart shares an active lifecycle operation before inspecting its snapshot", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  const starting = harness.manager.start(makeSnapshot());
  let validationReads = 0;
  const invalid = {
    get generation() {
      validationReads += 1;
      return 0;
    }
  };

  const concurrent = harness.manager.restart(invalid, { drainTimeoutMs: 100 });
  void concurrent.catch(() => {});

  assert.equal(validationReads, 0);
  assert.equal(concurrent, starting);
  assert.deepEqual(
    await settle(concurrent, harness.clock),
    await starting
  );
});

test("restart rejects an invalid snapshot before draining or changing the running worker", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  const before = harness.manager.getPublicState();
  const invalid = makeSnapshot(2);
  invalid.settings.upstream.baseUrl = "http://remote.example.test";

  await assert.rejects(
    harness.manager.restart(invalid, { drainTimeoutMs: 100 }),
    (error) => error?.code === "WORKER_SNAPSHOT_INVALID"
  );

  const after = harness.manager.getPublicState();
  assert.equal(after.phase, "running");
  assert.equal(after.pid, before.pid);
  assert.equal(after.generation, before.generation);
  assert.deepEqual(after.state, before.state);
  assert.deepEqual(harness.children[0].sent.map((message) => message.type), ["configure"]);
});

test("an unexpected exit backs off 250 ms and ignores the old child epoch after recovery", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  const oldChild = harness.children[0];

  oldChild.exit(1, null);
  await flushUntil(
    () => harness.manager.getPublicState().phase === "backoff",
    "worker backoff"
  );
  assert.equal(harness.clock.nextDelay(), 250);
  await harness.clock.advance(250);
  await flushUntil(
    () => harness.manager.getPublicState().phase === "running"
      && harness.manager.getPublicState().pid !== oldChild.pid,
    "worker recovery"
  );
  const recovered = harness.manager.getPublicState();

  oldChild.emit("message", childMessage("configured", "late-old", { generation: 99 }));
  oldChild.emit("exit", 1, null);
  await Promise.resolve();

  assert.equal(harness.manager.getPublicState().pid, recovered.pid);
  assert.equal(harness.manager.getPublicState().generation, 1);
  assert.equal(harness.manager.getPublicState().phase, "running");
  assert.equal(harness.manager.getPublicState().restartCount, 1);
});

test("unexpected-exit recovery rechecks readiness immediately before spawning", async (t) => {
  let ready = false;
  let readinessChecks = 0;
  const harness = createHarness([], {
    async runRecoveryWhenReady(operation) {
      readinessChecks += 1;
      if (!ready) {
        const error = new Error("private Codex readiness failure");
        error.code = "CODEX_NOT_READY";
        throw error;
      }
      return operation();
    }
  });
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  harness.children[0].exit(1, null);
  await flushUntil(
    () => harness.manager.getPublicState().phase === "backoff",
    "worker recovery backoff"
  );

  await harness.clock.advance(250);
  await flushUntil(
    () => readinessChecks === 1
      && harness.manager.getPublicState().phase === "backoff"
      && harness.clock.nextDelay() === 500,
    "blocked recovery readiness check"
  );
  assert.equal(harness.children.length, 1);
  assert.equal(harness.portChecks.length, 1);
  assert.equal(harness.clock.nextDelay(), 500);

  ready = true;
  await harness.clock.advance(500);
  await flushUntil(
    () => harness.manager.getPublicState().phase === "running",
    "readiness-approved recovery"
  );
  assert.equal(readinessChecks, 2);
  assert.equal(harness.portChecks.length, 2);
  assert.equal(harness.children.length, 2);
});

test("stop cancels an unexpected-exit recovery waiting inside the readiness gate", async (t) => {
  let gateEntered = false;
  let releaseGate;
  const gate = new Promise((resolvePromise) => {
    releaseGate = resolvePromise;
  });
  const harness = createHarness([], {
    async runRecoveryWhenReady(operation) {
      gateEntered = true;
      await gate;
      return operation();
    }
  });
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  harness.children[0].exit(1, null);
  await flushUntil(
    () => harness.manager.getPublicState().phase === "backoff",
    "worker recovery backoff"
  );
  await harness.clock.advance(250);
  await flushUntil(() => gateEntered, "recovery readiness gate");

  const stopped = await harness.manager.stop();
  releaseGate();
  await flushUntil(
    () => harness.manager.getPublicState().phase === "stopped",
    "cancelled recovery"
  );
  assert.equal(stopped.phase, "stopped");
  assert.equal(harness.children.length, 1);
  assert.equal(harness.clock.pending(), 0);
});

test("close cancels an unexpected-exit recovery waiting inside the readiness gate", async () => {
  let gateEntered = false;
  let releaseGate;
  const gate = new Promise((resolvePromise) => {
    releaseGate = resolvePromise;
  });
  const harness = createHarness([], {
    async runRecoveryWhenReady(operation) {
      gateEntered = true;
      await gate;
      return operation();
    }
  });
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  harness.children[0].exit(1, null);
  await flushUntil(
    () => harness.manager.getPublicState().phase === "backoff",
    "worker recovery backoff"
  );
  await harness.clock.advance(250);
  await flushUntil(() => gateEntered, "recovery readiness gate");

  await harness.manager.close();
  releaseGate();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.manager.getPublicState().phase, "stopped");
  assert.equal(harness.children.length, 1);
  assert.equal(harness.clock.pending(), 0);
});

test("readiness rejection uses bounded backoff without exposing its private failure", async (t) => {
  const sentinel = "recovery-readiness-secret-sentinel";
  const unhandled = collectUnhandledRejections(t);
  let readinessChecks = 0;
  const harness = createHarness([], {
    async runRecoveryWhenReady() {
      readinessChecks += 1;
      throw new Error(sentinel);
    }
  });
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  harness.children[0].exit(1, null);
  const delays = [];

  for (const delay of [250, 500, 1_000, 2_000]) {
    await flushUntil(
      () => harness.manager.getPublicState().phase === "backoff"
        && harness.clock.nextDelay() === delay,
      `recovery delay ${delay}`
    );
    delays.push(harness.clock.nextDelay());
    await harness.clock.advance(delay);
  }
  await flushUntil(
    () => harness.manager.getPublicState().phase === "failed",
    "terminal readiness failure"
  );

  assert.deepEqual(delays, [250, 500, 1_000, 2_000]);
  assert.equal(readinessChecks, 4);
  assert.equal(harness.children.length, 1);
  assert.equal(harness.clock.pending(), 0);
  assert.equal(unhandled.length, 0);
  assert.equal(JSON.stringify(harness.manager.getPublicState()).includes(sentinel), false);
});

test("the fifth crash in 60 seconds enters failed without spawning again", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  const observedDelays = [];

  for (let crash = 1; crash <= 5; crash += 1) {
    harness.children.at(-1).exit(1, null);
    if (crash === 5) {
      await flushUntil(
        () => harness.manager.getPublicState().phase === "failed",
        "terminal failed state"
      );
      break;
    }
    await flushUntil(
      () => harness.manager.getPublicState().phase === "backoff",
      `backoff ${crash}`
    );
    observedDelays.push(harness.clock.nextDelay());
    await harness.clock.advance(harness.clock.nextDelay());
    await flushUntil(
      () => harness.manager.getPublicState().phase === "running",
      `recovery ${crash}`
    );
  }

  assert.deepEqual(observedDelays, [250, 500, 1000, 2000]);
  assert.equal(harness.manager.getPublicState().phase, "failed");
  assert.equal(harness.manager.getPublicState().restartCount, 4);
  assert.equal(harness.children.length, 5);
  assert.equal(harness.clock.pending(), 0);
});

test("close is idempotent, cancels backoff, and permanently disables recovery and start", async () => {
  const harness = createHarness();
  const first = harness.manager.start(makeSnapshot());
  const concurrent = harness.manager.start(makeSnapshot());
  assert.equal(first, concurrent);
  await settle(first, harness.clock);

  harness.children[0].exit(1, null);
  await flushUntil(
    () => harness.manager.getPublicState().phase === "backoff",
    "worker backoff before close"
  );
  assert.equal(harness.clock.pending(), 1);

  const closing = harness.manager.close();
  assert.equal(harness.manager.close(), closing);
  await settle(closing, harness.clock);

  assert.equal(harness.clock.pending(), 0);
  assert.equal(harness.manager.getPublicState().phase, "stopped");
  assert.equal(harness.children.length, 1);
  await assert.rejects(
    harness.manager.start(makeSnapshot()),
    (error) => error?.code === "WORKER_MANAGER_CLOSED"
  );
});

test("stop cancels backoff and prevents the scheduled recovery from spawning", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  harness.children[0].exit(1, null);
  await flushUntil(
    () => harness.manager.getPublicState().phase === "backoff",
    "backoff before stop"
  );
  assert.equal(harness.clock.nextDelay(), 250);

  const stopped = await harness.manager.stop();
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.pid, null);
  assert.equal(harness.clock.pending(), 0);
  assert.equal(harness.children.length, 1);
});

test("a correlated fatal rejects startup with its stable code instead of waiting for timeout", async (t) => {
  const harness = createHarness([{ configure: false }]);
  t.after(() => harness.manager.close());
  const starting = harness.manager.start(makeSnapshot());
  await flushUntil(
    () => harness.children[0]?.sent.some((message) => message.type === "configure"),
    "configure send before fatal"
  );
  const requestId = harness.children[0].sent.find((message) => message.type === "configure").requestId;

  harness.children[0].emit("message", {
    version: 1,
    type: "fatal",
    requestId,
    error: {
      code: "WORKER_CONFIGURE_FAILED",
      message: "Worker configuration failed."
    }
  });

  await assert.rejects(
    settle(starting, harness.clock),
    (error) => error?.code === "WORKER_CONFIGURE_FAILED"
      && error.message === "Worker configuration failed."
      && !error.message.includes(SECRET)
  );
});

test("send failures cancel and consume start, apply, and drain waiters without unhandled rejection", async (t) => {
  const unhandled = collectUnhandledRejections(t);

  const starting = createHarness([{ failSend: { configure: [1] } }]);
  t.after(() => starting.manager.close());
  await assert.rejects(
    settle(starting.manager.start(makeSnapshot()), starting.clock),
    (error) => error?.code === "WORKER_IPC_SEND_FAILED"
      && !error.message.includes("sensitive send failure")
  );
  assert.equal(starting.clock.pending(), 0);

  const applying = createHarness([{ failSend: { configure: [2] } }]);
  t.after(() => applying.manager.close());
  await settle(applying.manager.start(makeSnapshot()), applying.clock);
  await assert.rejects(
    settle(applying.manager.applySnapshot(makeSnapshot(2)), applying.clock),
    (error) => error?.code === "WORKER_IPC_SEND_FAILED"
  );
  assert.equal(applying.clock.pending(), 0);
  assert.equal(applying.manager.getPublicState().generation, 1);

  const stopping = createHarness([{ failSend: { drain: [1] } }]);
  t.after(() => stopping.manager.close());
  await settle(stopping.manager.start(makeSnapshot()), stopping.clock);
  await assert.rejects(
    settle(stopping.manager.stop({ drainTimeoutMs: 100 }), stopping.clock),
    (error) => error?.code === "WORKER_IPC_SEND_FAILED"
  );
  assert.equal(stopping.clock.pending(), 0);
  assert.equal(stopping.manager.getPublicState().phase, "stopped");

  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  assert.deepEqual(unhandled, []);
});

test("configure acknowledgements arriving before the send callback are retained", async (t) => {
  const harness = createHarness([{ ackBeforeCallback: true }]);
  t.after(() => harness.manager.close());

  const started = await settle(harness.manager.start(makeSnapshot()), harness.clock);
  assert.equal(started.generation, 1);
  const applied = await settle(harness.manager.applySnapshot(makeSnapshot(2)), harness.clock);
  assert.equal(applied.generation, 2);
  assert.equal(harness.clock.pending(), 0);
});

test("a failed startup terminates the partial child and confirms fixed-port release", async (t) => {
  const harness = createHarness([], { healthOk: false });
  t.after(() => harness.manager.close());

  await assert.rejects(
    settle(harness.manager.start(makeSnapshot()), harness.clock),
    (error) => error?.code === "WORKER_HEALTH_FAILED"
  );

  assert.deepEqual(harness.children[0].killed, ["SIGTERM"]);
  assert.deepEqual(harness.portChecks, [{ host: "127.0.0.1", port: 15100 }]);
  assert.equal(harness.manager.getPublicState().phase, "stopped");
  assert.equal(harness.manager.getPublicState().pid, null);
});

test("a successful retry clears the prior startup acknowledgement timeout", async (t) => {
  const harness = createHarness([{ configure: false }, {}]);
  t.after(() => harness.manager.close());

  await assert.rejects(
    settle(harness.manager.start(makeSnapshot()), harness.clock),
    (error) => error?.code === "WORKER_ACK_TIMEOUT"
  );
  assert.deepEqual(harness.manager.getPublicState().error, {
    code: "WORKER_ACK_TIMEOUT",
    message: "Worker did not acknowledge the request in time."
  });

  const started = await settle(harness.manager.start(makeSnapshot(2)), harness.clock);

  assert.equal(started.phase, "running");
  assert.equal(started.generation, 2);
  assert.equal(started.error, null);
  assert.equal(harness.manager.getPublicState().error, null);
});

test("close terminates a live child, confirms port release, and removes child listeners", async () => {
  const harness = createHarness();
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  const child = harness.children[0];

  await settle(harness.manager.close(), harness.clock);

  assert.deepEqual(child.killed, ["SIGTERM"]);
  assert.deepEqual(harness.portChecks, [{ host: "127.0.0.1", port: 15100 }]);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(harness.manager.getPublicState().phase, "stopped");
});

test("a synchronous fork failure returns to stopped with a stable sanitized error", async (t) => {
  const harness = createHarness([], { forkError: true });
  t.after(() => harness.manager.close());

  await assert.rejects(
    harness.manager.start(makeSnapshot()),
    (error) => error?.code === "WORKER_START_FAILED"
      && !error.message.includes("sensitive fork cause")
  );

  const current = harness.manager.getPublicState();
  assert.equal(current.phase, "stopped");
  assert.equal(current.pid, null);
  assert.deepEqual(current.error, {
    code: "WORKER_START_FAILED",
    message: "Worker failed to start."
  });
});

test("a port-release failure cleans lifecycle resources and enters a stable failed state", async (t) => {
  const harness = createHarness([], { portError: true });
  t.after(() => harness.manager.close().catch(() => {}));
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  const child = harness.children[0];

  await assert.rejects(
    settle(harness.manager.stop({ drainTimeoutMs: 100 }), harness.clock),
    (error) => error?.code === "WORKER_PORT_BUSY"
      && !error.message.includes("sensitive port probe cause")
  );

  const current = harness.manager.getPublicState();
  assert.equal(current.phase, "failed");
  assert.equal(current.pid, null);
  assert.deepEqual(current.error, {
    code: "WORKER_PORT_BUSY",
    message: "The fixed proxy port is still in use."
  });
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("exit"), 0);
});

test("a malformed secret-bearing child message is sanitized and recovered as a protocol failure", async (t) => {
  const harness = createHarness();
  t.after(() => harness.manager.close());
  await settle(harness.manager.start(makeSnapshot()), harness.clock);
  const child = harness.children[0];

  child.emit("message", {
    version: 1,
    type: "status",
    requestId: "malformed-secret",
    state: { ...state(), apiKey: SECRET }
  });
  await flushUntil(
    () => harness.manager.getPublicState().phase === "backoff",
    "protocol-failure backoff"
  );

  const current = harness.manager.getPublicState();
  assert.deepEqual(child.killed, ["SIGTERM"]);
  assert.equal(current.error.code, "WORKER_PROTOCOL_INVALID");
  assert.equal(current.error.message, "Worker protocol message is invalid.");
  assert.equal(JSON.stringify(current).includes(SECRET), false);
});
