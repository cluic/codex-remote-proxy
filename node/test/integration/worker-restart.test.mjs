import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerManager } from "../../src/supervisor/worker-manager.mjs";

const SECRET = "worker-restart-integration-secret";

function listen(server, port = 0) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise(server.address().port);
    });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

async function reservePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

function makeSnapshot({ generation, port, upstreamPort, dir }) {
  return {
    providerId: "provider-restart",
    generation,
    settings: {
      configPath: join(dir, "proxy-config.json"),
      server: { host: "127.0.0.1", port, logLevel: "info" },
      providers: [{
        id: "provider-restart",
        name: "Restart fixture",
        weight: 100,
        supportedModels: null,
        disabledModels: [],
        upstream: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: SECRET,
          timeoutMs: 5_000,
          verifySsl: true,
          authHeader: "x-provider-auth",
          authScheme: "Bearer",
          extraHeaders: {}
        },
        proxy: {
          overrideAuthorization: true,
          requestIdHeader: "x-client-request-id",
          modelMode: "passthrough",
          modelOverride: null,
          modelMappings: []
        }
      }],
      upstream: {
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: SECRET,
        timeoutMs: 5_000,
        verifySsl: true,
        authHeader: "x-provider-auth",
        authScheme: "Bearer",
        extraHeaders: {}
      },
      proxy: {
        overrideAuthorization: true,
        requestIdHeader: "x-client-request-id",
        modelMode: "passthrough",
        modelOverride: null,
        modelMappings: []
      },
      capture: { enabled: false, dbPath: join(dir, "traffic.sqlite3") },
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

test("real worker restart changes PID and restores matching health on the same fixed port", {
  timeout: 15_000
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "crp-worker-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const port = await reservePort();
  const manager = new WorkerManager({
    host: "127.0.0.1",
    port,
    readyTimeoutMs: 3_000,
    ackTimeoutMs: 3_000,
    healthTimeoutMs: 3_000,
    terminateTimeoutMs: 1_000,
    killTimeoutMs: 1_000,
    runRecoveryWhenReady: (operation) => operation()
  });
  t.after(() => manager.close());
  const snapshot = makeSnapshot({ generation: 1, port, upstreamPort, dir });

  const started = await manager.start(snapshot);
  const oldPid = started.pid;
  assert.equal(started.phase, "running");
  assert.equal(started.state.listenPort, port);

  const restarted = await manager.restart(snapshot, { drainTimeoutMs: 2_000 });
  assert.equal(restarted.phase, "running");
  assert.notEqual(restarted.pid, oldPid);
  assert.equal(restarted.state.listenPort, port);
  assert.equal(manager.getPublicState().phase, "running");

  const healthResponse = await fetch(`http://127.0.0.1:${port}/_proxy/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.configured, true);
  assert.equal(health.generation, 1);
  assert.equal(JSON.stringify(health).includes(SECRET), false);

  await manager.stop({ drainTimeoutMs: 2_000 });
  const exclusiveProbe = http.createServer();
  await listen(exclusiveProbe, port);
  await closeServer(exclusiveProbe);
});
