import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { join } from "node:path";

import { runCli } from "../../bin/crp.mjs";
import { getPaths } from "../../src/shared/paths.mjs";
import { createAdminServer } from "../../src/supervisor/admin-server.mjs";
import {
  discoverSupervisor,
  ensureSupervisor,
  readControlToken,
  readSupervisorState
} from "../../src/supervisor/supervisor-client.mjs";
import { SessionAuth } from "../../src/supervisor/session-auth.mjs";

const SUPERVISOR_PID = 61001;
const STARTED_AT = "2026-07-13T09:00:00.000Z";

async function choosePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function providerProfile(id, name, baseUrl, overrides = {}) {
  return {
    id,
    name,
    baseUrl,
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    modelMode: "passthrough",
    modelOverride: null,
    lastTestAt: null,
    lastTestStatus: "untested",
    lastTestCode: null,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    credentialConfigured: true,
    ...overrides
  };
}

function createServices() {
  const providers = [];
  let activeProviderId = null;
  let workerPid = null;
  let generation = 0;
  let nextWorkerPid = 62000;
  let codexConfigured = false;

  const worker = () => ({
    phase: workerPid === null ? "stopped" : "running",
    pid: workerPid,
    generation,
    state: workerPid === null ? null : {
      phase: "running",
      configured: true,
      generation,
      listening: true,
      listenHost: "127.0.0.1",
      listenPort: 15100,
      inFlight: 0
    },
    restartCount: 0,
    startedAt: workerPid === null ? null : STARTED_AT,
    error: null
  });

  return {
    providerService: {
      async listProviders() {
        return providers.map((provider) => structuredClone(provider));
      },
      async createProvider(input) {
        const provider = providerProfile(`provider-${providers.length + 1}`, input.name, input.baseUrl);
        providers.push(provider);
        return structuredClone(provider);
      },
      async deleteProvider(id) {
        const index = providers.findIndex((provider) => provider.id === id);
        return structuredClone(providers.splice(index, 1)[0]);
      },
      async testProvider(id, _model, { activateIfNone = false } = {}) {
        const provider = providers.find((candidate) => candidate.id === id);
        Object.assign(provider, {
          lastTestAt: STARTED_AT,
          lastTestStatus: "passed",
          updatedAt: STARTED_AT
        });
        let initialActivation = null;
        if (activateIfNone && activeProviderId === null && workerPid === null) {
          activeProviderId = id;
          initialActivation = {
            automatic: true,
            activeProviderId: id,
            workerStarted: false
          };
        }
        return { ok: true, code: null, initialActivation };
      },
      async activate(id) {
        activeProviderId = id;
        return {
          activeProviderId: id,
          activeProvider: providers.find((provider) => provider.id === id),
          generation,
          worker: worker()
        };
      },
      async startProxy() {
        generation += 1;
        workerPid = ++nextWorkerPid;
        return worker();
      },
      async stopProxy() {
        workerPid = null;
        return worker();
      },
      async restartProxy() {
        generation += 1;
        workerPid = ++nextWorkerPid;
        return worker();
      },
      async getStatus() {
        return {
          activeProviderId,
          activeProvider: providers.find((provider) => provider.id === activeProviderId) ?? null,
          generation,
          worker: worker()
        };
      }
    },
    activityStore: { list: () => [] },
    settingsService: {
      getSettings: async () => ({
        proxyHost: "127.0.0.1",
        proxyPort: 15100,
        adminHost: "127.0.0.1",
        adminPort: null,
        captureEnabled: false,
        credentialBackend: "injected"
      })
    },
    codexService: {
      async bootstrap() {
        codexConfigured = true;
        return { changed: true, backupPath: "/private/injected-backup" };
      },
      async getStatus() {
        return {
          configured: codexConfigured,
          modelProvider: "OpenAI",
          proxyUrl: "http://127.0.0.1:15100"
        };
      }
    },
    diagnosticsService: { exportDiagnostics: async () => ({ created: true }) },
    getWorkerPid: () => workerPid
  };
}

test("CLI manages one injected supervisor and replaceable worker through the real Admin client", async (t) => {
  const home = mkdtempSync(join(os.tmpdir(), "crp-cli-lifecycle-"));
  const paths = getPaths(home);
  const adminPort = await choosePort();
  const auth = new SessionAuth({ controlTokenPath: paths.controlTokenPath });
  const services = createServices();
  const admin = createAdminServer({
    auth,
    ...services,
    getSupervisorState: () => ({ pid: SUPERVISOR_PID, startedAt: STARTED_AT }),
    host: "127.0.0.1",
    port: adminPort
  });
  let supervisorAlive = false;
  let startPromise = null;
  let closePromise = null;
  t.after(async () => {
    await startPromise?.catch(() => {});
    await closePromise?.catch(() => {});
    await admin.close().catch(() => {});
    auth.close();
    rmSync(home, { recursive: true, force: true });
  });

  const writeState = async () => {
    const address = await admin.listen();
    mkdirSync(paths.globalHome, { recursive: true, mode: 0o700 });
    chmodSync(paths.globalHome, 0o700);
    writeFileSync(paths.statePath, `${JSON.stringify({
      schemaVersion: 1,
      supervisorPid: SUPERVISOR_PID,
      startedAt: STARTED_AT,
      admin: address,
      worker: {
        phase: "stopped",
        pid: null,
        generation: 0,
        state: null,
        restartCount: 0,
        startedAt: null,
        error: null
      }
    })}\n`, { mode: 0o600 });
    chmodSync(paths.statePath, 0o600);
    supervisorAlive = true;
  };
  const spawnSupervisor = () => {
    startPromise ??= writeState();
    return { pid: SUPERVISOR_PID };
  };
  const discoveryOptions = {
    paths,
    adminPort,
    isProcessAlive: () => supervisorAlive
  };
  const ensureSupervisorImpl = () => ensureSupervisor({
    ...discoveryOptions,
    spawnSupervisor,
    wait: async () => { await startPromise; }
  });
  const discoverSupervisorImpl = () => discoverSupervisor(discoveryOptions);
  const killProcess = (pid, signal) => {
    assert.equal(pid, SUPERVISOR_PID);
    assert.equal(signal, "SIGTERM");
    supervisorAlive = false;
    closePromise ??= admin.close().then(() => {
      rmSync(paths.statePath, { force: true });
    });
  };
  const dependencies = {
    paths,
    adminPort,
    ensureSupervisorImpl,
    discoverSupervisorImpl,
    readControlTokenImpl: () => readControlToken({ path: paths.controlTokenPath }),
    openManagementUrlImpl: () => assert.fail("--no-open must not launch a browser"),
    killProcess,
    isProcessAlive: () => supervisorAlive,
    wait: async () => { await closePromise; },
    now: () => 0
  };
  const outputs = [];
  const invoke = async (args) => {
    const stdout = [];
    const stderr = [];
    const status = await runCli(args, {
      ...dependencies,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text)
    });
    const result = { status, stdout: stdout.join(""), stderr: stderr.join("") };
    outputs.push(result);
    assert.equal(status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const ui = await invoke(["ui", "--no-open", "--json"]);
  assert.equal(ui.supervisorPid, SUPERVISOR_PID);
  assert.equal(supervisorAlive, true);

  const secret = "integration-provider-complete-secret";
  const added = await invoke([
    "provider", "add",
    "--name", "Primary",
    "--base-url", "https://provider.example/v1",
    "--api-key", secret,
    "--json"
  ]);
  assert.equal(added.provider.id, "provider-1");
  assert.equal((await invoke(["provider", "list", "--json"])).providers.length, 1);
  const tested = await invoke([
    "provider", "test", "--id", "provider-1", "--model", "test-model", "--json"
  ]);
  assert.equal(tested.result.ok, true);
  assert.deepEqual(tested.result.initialActivation, {
    automatic: true,
    activeProviderId: "provider-1",
    workerStarted: false
  });

  const started = await invoke(["start", "--json"]);
  const firstWorkerPid = started.worker.pid;
  assert.equal(Number.isSafeInteger(firstWorkerPid), true);
  assert.equal((await invoke([
    "provider", "activate", "--id", "provider-1", "--json"
  ])).activation.activeProviderId, "provider-1");
  const restarted = await invoke(["restart", "--json"]);
  assert.notEqual(restarted.worker.pid, firstWorkerPid);
  const statusAfterRestart = await invoke(["status", "--json"]);
  assert.equal(statusAfterRestart.supervisor.pid, SUPERVISOR_PID);
  assert.equal(statusAfterRestart.worker.pid, restarted.worker.pid);

  const stopped = await invoke(["stop", "--json"]);
  assert.equal(stopped.worker.phase, "stopped");
  assert.equal(supervisorAlive, true);
  assert.equal((await invoke(["status", "--json"])).running, true);

  const shutdown = await invoke(["shutdown", "--json"]);
  assert.equal(shutdown.supervisorPid, SUPERVISOR_PID);
  assert.equal(supervisorAlive, false);
  assert.equal(existsSync(paths.statePath), false);
  assert.equal(outputs.some(({ stdout, stderr }) => `${stdout}\n${stderr}`.includes(secret)), false);
  assert.equal(services.getWorkerPid(), null);
});
