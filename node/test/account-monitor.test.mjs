import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  AccountMonitor,
  normalizeAccountRateLimits
} from "../src/supervisor/account-monitor.mjs";

const NOW = "2026-08-20T00:00:00.000Z";

function fakeAppServer(onRequest) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  let buffered = "";
  child.stdin.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) onRequest(JSON.parse(line), child);
    }
  });
  return child;
}

function respond(child, id, result) {
  queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id, result })}\n`));
}

function createMonitor(onRequest, options = {}) {
  const child = fakeAppServer(onRequest);
  return {
    child,
    monitor: new AccountMonitor({
      spawnImpl: () => child,
      now: () => NOW,
      autoPoll: false,
      requestTimeoutMs: 500,
      ...options
    })
  };
}

test("reads ChatGPT auth and canonical Codex limits without exposing account fields", async (t) => {
  const requests = [];
  const { monitor } = createMonitor((message, child) => {
    requests.push(message);
    if (message.method === "initialize") respond(child, message.id, { userAgent: "codex" });
    if (message.method === "account/read") {
      respond(child, message.id, {
        account: {
          type: "chatgpt",
          email: "private@example.test",
          accountId: "account-private",
          planType: "plus"
        },
        requiresOpenaiAuth: true
      });
    }
    if (message.method === "account/rateLimits/read") {
      respond(child, message.id, {
        rateLimits: {
          limitId: "legacy",
          primary: { usedPercent: 99, windowDurationMins: 60, resetsAt: 1_800_000_000 }
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1_800_000_100 },
            secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: 1_800_000_200 },
            rateLimitReachedType: null
          }
        }
      });
    }
  });
  t.after(() => monitor.close());

  const state = await monitor.refresh();

  assert.deepEqual(state, {
    phase: "ready",
    authMode: "chatgpt",
    planType: "plus",
    quotaSupported: true,
    quota: {
      status: "available",
      limitId: "codex",
      windows: [
        {
          kind: "primary",
          usedPercent: 35,
          remainingPercent: 65,
          windowDurationMins: 300,
          resetsAt: 1_800_000_100
        },
        {
          kind: "secondary",
          usedPercent: 62,
          remainingPercent: 38,
          windowDurationMins: 10_080,
          resetsAt: 1_800_000_200
        }
      ],
      rateLimitReachedType: null,
      spendControlReached: null,
      spendControlResetsAt: null,
      updatedAt: NOW
    },
    updatedAt: NOW,
    errorCode: null
  });
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes("private@example.test"), false);
  assert.equal(serialized.includes("account-private"), false);
  assert.deepEqual(requests.map(({ method }) => method), [
    "initialize",
    "initialized",
    "account/read",
    "account/rateLimits/read"
  ]);
});

test("skips quota reads for API-key auth", async (t) => {
  const methods = [];
  const { monitor } = createMonitor((message, child) => {
    methods.push(message.method);
    if (message.method === "initialize") respond(child, message.id, {});
    if (message.method === "account/read") {
      respond(child, message.id, { account: { type: "apiKey" }, requiresOpenaiAuth: true });
    }
  });
  t.after(() => monitor.close());

  const state = await monitor.refresh();
  assert.equal(state.authMode, "apikey");
  assert.equal(state.quota, null);
  assert.equal(state.quotaSupported, null);
  assert.equal(methods.includes("account/rateLimits/read"), false);
});

test("degrades when an older app-server lacks the quota method", async (t) => {
  const { monitor } = createMonitor((message, child) => {
    if (message.method === "initialize") respond(child, message.id, {});
    if (message.method === "account/read") {
      respond(child, message.id, {
        account: { type: "chatgpt", planType: "pro" },
        requiresOpenaiAuth: true
      });
    }
    if (message.method === "account/rateLimits/read") {
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({
        id: message.id,
        error: { code: -32601, message: "Method not found" }
      })}\n`));
    }
  });
  t.after(() => monitor.close());

  const state = await monitor.refresh();
  assert.equal(state.phase, "ready");
  assert.equal(state.authMode, "chatgpt");
  assert.equal(state.quotaSupported, false);
  assert.equal(state.quota, null);
  assert.equal(state.errorCode, "ACCOUNT_QUOTA_UNSUPPORTED");
});

test("normalizes exhausted limits and rejects unsafe numeric fields", () => {
  assert.deepEqual(normalizeAccountRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 101, windowDurationMins: -1, resetsAt: -1 },
      spendControlReached: false
    }
  }, NOW), {
    status: "exhausted",
    limitId: "codex",
    windows: [{
      kind: "primary",
      usedPercent: 100,
      remainingPercent: 0,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000
    }],
    rateLimitReachedType: null,
    spendControlReached: false,
    spendControlResetsAt: null,
    updatedAt: NOW
  });
});

test("normalizes the current individual spend-control limit without exposing amounts", () => {
  const normalized = normalizeAccountRateLimits({
    rateLimits: {
      limitId: "codex",
      individualLimit: {
        limit: "private-limit",
        used: "private-used",
        remainingPercent: 0,
        resetsAt: 1_800_000_300
      }
    }
  }, NOW);
  assert.deepEqual(normalized, {
    status: "exhausted",
    limitId: "codex",
    windows: [],
    rateLimitReachedType: null,
    spendControlReached: true,
    spendControlResetsAt: 1_800_000_300,
    updatedAt: NOW
  });
  assert.equal(JSON.stringify(normalized).includes("private"), false);
});

test("accepts bounded rolling notifications and publishes defensive snapshots", async (t) => {
  const { child, monitor } = createMonitor((message, server) => {
    if (message.method === "initialize") respond(server, message.id, {});
    if (message.method === "account/read") {
      respond(server, message.id, {
        account: { type: "chatgpt", planType: "plus" },
        requiresOpenaiAuth: true
      });
    }
    if (message.method === "account/rateLimits/read") {
      respond(server, message.id, {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_000_500 }
        }
      });
    }
  });
  t.after(() => monitor.close());
  const observed = [];
  monitor.subscribe((state) => observed.push(state));
  await monitor.refresh();

  child.stdout.write(`${JSON.stringify({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        rateLimitReachedType: "rate_limit_reached"
      }
    }
  })}\n`);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  const state = monitor.getState();
  assert.equal(state.authMode, "chatgpt");
  assert.equal(state.planType, "plus");
  assert.equal(state.quota.status, "exhausted");
  assert.equal(state.quota.windows.length, 2);
  assert.equal(state.quota.windows[1].usedPercent, 40);
  observed.at(-1).quota.windows[0].usedPercent = 0;
  assert.equal(monitor.getState().quota.windows[0].usedPercent, 100);
});

test("projects account update notifications without private fields", async (t) => {
  const { child, monitor } = createMonitor((message, server) => {
    if (message.method === "initialize") respond(server, message.id, {});
    if (message.method === "account/read") {
      respond(server, message.id, { account: null, requiresOpenaiAuth: true });
    }
  });
  t.after(() => monitor.close());
  await monitor.refresh();
  child.stdout.write(`${JSON.stringify({
    method: "account/updated",
    params: { authMode: "chatgptAuthTokens", planType: "business", email: "ignored" }
  })}\n`);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  const state = monitor.getState();
  assert.equal(state.authMode, "chatgptAuthTokens");
  assert.equal(state.planType, "business");
  assert.equal(JSON.stringify(state).includes("ignored"), false);

  child.stdout.write(`${JSON.stringify({
    method: "account/updated",
    params: { authMode: "headers", planType: null }
  })}\n`);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(monitor.getState().authMode, "headers");
  assert.equal(monitor.getState().planType, null);
});

test("coalesces concurrent refreshes into one account query", async (t) => {
  let accountReads = 0;
  const { monitor } = createMonitor((message, child) => {
    if (message.method === "initialize") respond(child, message.id, {});
    if (message.method === "account/read") {
      accountReads += 1;
      setImmediate(() => respond(child, message.id, { account: null, requiresOpenaiAuth: true }));
    }
  });
  t.after(() => monitor.close());

  const [first, second] = await Promise.all([monitor.refresh(), monitor.refresh()]);
  assert.deepEqual(first, second);
  assert.equal(accountReads, 1);
});

test("fails closed on unavailable or oversized app-server output", async (t) => {
  const unavailable = new AccountMonitor({
    spawnImpl: () => {
      const error = new Error("missing executable secret detail");
      error.code = "ENOENT";
      throw error;
    },
    now: () => NOW,
    autoPoll: false
  });
  assert.equal((await unavailable.refresh()).errorCode, "ACCOUNT_MONITOR_UNAVAILABLE");
  await unavailable.close();

  const { child, monitor } = createMonitor(() => {}, { maxLineBytes: 8 });
  t.after(() => monitor.close());
  const starting = monitor.start().catch(() => null);
  child.stdout.write("0123456789");
  await starting;
  assert.equal(monitor.getState().errorCode, "ACCOUNT_MONITOR_PROTOCOL_ERROR");
});

test("isolates replaced app-server events and contains stdin failures", async (t) => {
  const first = fakeAppServer(() => {});
  first.kill = (signal) => {
    first.signalCode = signal;
    return true;
  };
  const second = fakeAppServer((message, child) => {
    if (message.method === "initialize") respond(child, message.id, {});
  });
  const children = [first, second];
  const monitor = new AccountMonitor({
    spawnImpl: () => children.shift(),
    now: () => NOW,
    autoPoll: false,
    requestTimeoutMs: 500,
    maxLineBytes: 128
  });
  t.after(() => monitor.close());

  const failedStart = monitor.start().catch(() => null);
  first.stdout.write("x".repeat(129));
  await failedStart;
  assert.equal(monitor.getState().phase, "unavailable");

  await monitor.start();
  assert.equal(monitor.getState().phase, "ready");
  first.emit("exit", null, "SIGTERM");
  first.stdout.write("not-json\n");
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(monitor.getState().phase, "ready");

  second.stdin.emit("error", new Error("private pipe failure"));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(monitor.getState().phase, "unavailable");
  assert.equal(monitor.getState().errorCode, "ACCOUNT_MONITOR_UNAVAILABLE");
  assert.equal(JSON.stringify(monitor.getState()).includes("private"), false);
});

test("retires a timed-out child and keeps close as the terminal state", async () => {
  const timedOutChild = fakeAppServer((message, child) => {
    if (message.method === "initialize") respond(child, message.id, {});
  });
  const timedOutMonitor = new AccountMonitor({
    spawnImpl: () => timedOutChild,
    now: () => NOW,
    autoPoll: false,
    requestTimeoutMs: 10
  });
  const unavailable = await timedOutMonitor.refresh();
  assert.equal(unavailable.phase, "unavailable");
  assert.equal(timedOutChild.signalCode, "SIGTERM");
  await timedOutMonitor.close();

  const closingChild = fakeAppServer((message, child) => {
    if (message.method === "initialize") respond(child, message.id, {});
  });
  const closingMonitor = new AccountMonitor({
    spawnImpl: () => closingChild,
    now: () => NOW,
    autoPoll: false,
    requestTimeoutMs: 500
  });
  const refreshing = closingMonitor.refresh();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await closingMonitor.close();
  await refreshing;
  assert.equal(closingMonitor.getState().phase, "closed");
});
