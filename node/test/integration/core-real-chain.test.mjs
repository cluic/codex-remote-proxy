import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import { join } from "node:path";

import { runCli } from "../../bin/crp.mjs";
import { createSupervisor } from "../../src/supervisor/supervisor.mjs";
import {
  discoverSupervisor,
  ensureSupervisor
} from "../../src/supervisor/supervisor-client.mjs";

const PROXY_PORT = 15100;
const ADMIN_PORT = 15101;
const SECRET_A = "crp-core-chain-provider-a-complete-secret-sentinel";
const SECRET_B = "crp-core-chain-provider-b-complete-secret-sentinel";
const SECRETS = [SECRET_A, SECRET_B];
const EXPECTED_CONFIG = [
  'model_provider = "OpenAI"',
  "",
  "[model_providers.OpenAI]",
  'name = "OpenAI"',
  'base_url = "http://127.0.0.1:15100"',
  'wire_api = "responses"',
  "requires_openai_auth = true",
  ""
].join("\n");

class MemoryCredentialStore {
  backend = "memory";
  values = new Map();

  async set(ref, secret) {
    this.values.set(ref, secret);
  }

  async get(ref) {
    return this.values.get(ref) ?? null;
  }

  async has(ref) {
    return this.values.has(ref);
  }

  async delete(ref) {
    return this.values.delete(ref);
  }

  clear() {
    this.values.clear();
  }
}

function createGate() {
  let releasePromise;
  let released = false;
  const promise = new Promise((resolve) => {
    releasePromise = resolve;
  });
  return {
    promise,
    release() {
      if (released) return;
      released = true;
      releasePromise();
    }
  };
}

function createSignal() {
  let resolveSignal;
  const promise = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  return { promise, resolve: resolveSignal };
}

async function withDeadline(promise, label, timeoutMs = 8_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function confirmPortIdle(port) {
  const probe = createNetServer();
  probe.unref();
  await listen(probe, port);
  await closeServer(probe);
}

function assertSecretsAbsent(label, text) {
  const inspected = String(text);
  for (const secret of SECRETS) {
    assert.equal(inspected.includes(secret), false, `${label} contains a complete provider secret`);
  }
}

function readTree(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      if (entry.isFile()) files.push([path, readFileSync(path, "utf8")]);
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function createResponsesFixture({ label, secret, heldInput = null, holdGate = null }) {
  const observations = [];
  const heldReceived = createSignal();
  let sequence = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      try {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const body = JSON.parse(bodyText);
        const observation = {
          method: request.method,
          url: request.url,
          headers: { ...request.headers },
          body
        };
        observations.push(observation);
        if (body.input === heldInput) {
          heldReceived.resolve(observation);
          await holdGate.promise;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: `response-${label}-${++sequence}`,
          object: "response",
          output: [],
          provider: label,
          input: body.input
        }));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid fixture request" }));
      }
    });
  });
  return { server, observations, heldReceived, label, secret };
}

async function postResponses(input) {
  const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer client-only-value",
      "content-type": "application/json"
    },
    body: JSON.stringify({ model: "client-model", input }),
    signal: AbortSignal.timeout(8_000)
  });
  const body = await response.json();
  return { status: response.status, body };
}

function observationForInput(fixture, input) {
  return fixture.observations.find((observation) => observation.body.input === input);
}

test("real CLI core chain switches in-flight traffic and restarts on the fixed port", {
  timeout: 30_000
}, async (t) => {
  const home = mkdtempSync(join(os.tmpdir(), "crp-core-real-chain-"));
  const credentials = new MemoryCredentialStore();
  const holdA = createGate();
  const fixtureA = createResponsesFixture({
    label: "A",
    secret: SECRET_A,
    heldInput: "held-A",
    holdGate: holdA
  });
  const fixtureB = createResponsesFixture({ label: "B", secret: SECRET_B });
  const outputs = [];
  let supervisor = null;
  let supervisorAlive = false;
  let supervisorClosePromise = null;

  t.after(async () => {
    holdA.release();
    await supervisorClosePromise?.catch(() => {});
    await supervisor?.close().catch(() => {});
    await closeServer(fixtureA.server).catch(() => {});
    await closeServer(fixtureB.server).catch(() => {});
    credentials.clear();
    fixtureA.observations.length = 0;
    fixtureB.observations.length = 0;
    rmSync(home, { recursive: true, force: true });
  });

  await Promise.all([
    confirmPortIdle(PROXY_PORT),
    confirmPortIdle(ADMIN_PORT)
  ]);

  const [portA, portB] = await Promise.all([
    listen(fixtureA.server),
    listen(fixtureB.server)
  ]);
  supervisor = await createSupervisor({
    home,
    credentialStoreFactory: () => credentials
  });
  const address = await supervisor.listen();
  supervisorAlive = true;
  const paths = supervisor.paths;
  const codexDir = join(home, ".codex");
  const configPath = join(codexDir, "config.toml");

  assert.equal(address.port, ADMIN_PORT);
  assert.equal(existsSync(codexDir), false);

  // D1 proves the production component chain with an injected credential adapter.
  // D2 owns detached Supervisor entry, native keyring, and OS signal evidence.
  const isProcessAlive = (pid) => supervisorAlive && pid === process.pid;
  const ensureSupervisorImpl = (options) => ensureSupervisor({
    ...options,
    home,
    isProcessAlive,
    requestTimeoutMs: 10_000,
    spawnSupervisor: () => assert.fail("the in-process Supervisor state was not discovered")
  });
  const discoverSupervisorImpl = (options) => discoverSupervisor({
    ...options,
    isProcessAlive,
    requestTimeoutMs: 10_000
  });
  const invoke = async (args) => {
    const stdout = [];
    const stderr = [];
    const status = await runCli(args, {
      paths,
      adminPort: ADMIN_PORT,
      ensureSupervisorImpl,
      discoverSupervisorImpl,
      killProcess(pid, signal) {
        assert.equal(pid, process.pid);
        assert.equal(signal, "SIGTERM");
        supervisorClosePromise ??= supervisor.close().finally(() => {
          supervisorAlive = false;
        });
      },
      isProcessAlive,
      wait: async () => {
        if (supervisorClosePromise) await supervisorClosePromise;
      },
      shutdownTimeoutMs: 10_000,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text)
    });
    const result = { args: [...args], status, stdout: stdout.join(""), stderr: stderr.join("") };
    outputs.push({ status, stdout: result.stdout, stderr: result.stderr });
    assertSecretsAbsent("CLI output", `${result.stdout}\n${result.stderr}`);
    assert.equal(status, 0, `CLI command failed: ${args.slice(0, 2).join(" ")}`);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  };

  const addedA = await invoke([
    "provider", "add",
    "--name", "Provider A",
    "--base-url", `http://127.0.0.1:${portA}/v1`,
    "--api-key", SECRET_A,
    "--json"
  ]);
  const addedB = await invoke([
    "provider", "add",
    "--name", "Provider B",
    "--base-url", `http://127.0.0.1:${portB}/v1`,
    "--api-key", SECRET_B,
    "--json"
  ]);
  const providerAId = addedA.provider.id;
  const providerBId = addedB.provider.id;
  assert.equal(typeof providerAId, "string");
  assert.equal(typeof providerBId, "string");
  assert.notEqual(providerAId, providerBId);

  const listed = await invoke(["provider", "list", "--json"]);
  assert.deepEqual(
    listed.providers.map(({ id, name }) => ({ id, name })),
    [
      { id: providerAId, name: "Provider A" },
      { id: providerBId, name: "Provider B" }
    ]
  );
  assert.equal((await invoke([
    "provider", "test", "--id", providerAId, "--model", "fixture-model", "--json"
  ])).result.ok, true);
  assert.equal((await invoke([
    "provider", "test", "--id", providerBId, "--model", "fixture-model", "--json"
  ])).result.ok, true);

  const activatedA = await invoke([
    "provider", "activate", "--id", providerAId, "--json"
  ]);
  assert.equal(activatedA.activation.activeProviderId, providerAId);
  assert.equal(activatedA.activation.worker.phase, "running");
  assert.equal(activatedA.activation.worker.state.listenPort, PROXY_PORT);

  const started = await invoke(["start", "--json"]);
  const firstWorkerPid = started.worker.pid;
  assert.equal(started.supervisorPid, process.pid);
  assert.equal(Number.isSafeInteger(firstWorkerPid), true);
  assert.deepEqual(started.codexBootstrap, {
    changed: true,
    backupCreated: false
  });
  assert.equal(started.proxyUrl, `http://127.0.0.1:${PROXY_PORT}`);
  assert.equal(readFileSync(configPath, "utf8"), EXPECTED_CONFIG);
  assert.deepEqual(
    readdirSync(codexDir).filter((name) => name.endsWith(".bak")),
    []
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(codexDir).mode & 0o777, 0o700);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  }

  let heldASettled = false;
  const heldAResponse = postResponses("held-A").finally(() => {
    heldASettled = true;
  });
  t.after(() => heldAResponse.catch(() => {}));
  await withDeadline(fixtureA.heldReceived.promise, "provider A receiving the held request");

  const activatedB = await invoke([
    "provider", "activate", "--id", providerBId, "--json"
  ]);
  assert.equal(activatedB.activation.activeProviderId, providerBId);
  assert.equal(activatedB.activation.worker.pid, firstWorkerPid);
  assert.equal(activatedB.activation.worker.state.listenPort, PROXY_PORT);

  const responseB = await postResponses("new-B");
  assert.deepEqual(responseB, {
    status: 200,
    body: {
      id: "response-B-2",
      object: "response",
      output: [],
      provider: "B",
      input: "new-B"
    }
  });
  assert.equal(heldASettled, false);
  holdA.release();
  const responseA = await withDeadline(heldAResponse, "held provider A response");
  assert.deepEqual(responseA, {
    status: 200,
    body: {
      id: "response-A-2",
      object: "response",
      output: [],
      provider: "A",
      input: "held-A"
    }
  });

  const compatibilityA = observationForInput(fixtureA, "Reply with OK.");
  const compatibilityB = observationForInput(fixtureB, "Reply with OK.");
  const proxiedA = observationForInput(fixtureA, "held-A");
  const proxiedB = observationForInput(fixtureB, "new-B");
  for (const [observation, secret] of [
    [compatibilityA, SECRET_A],
    [compatibilityB, SECRET_B],
    [proxiedA, SECRET_A],
    [proxiedB, SECRET_B]
  ]) {
    assert.equal(observation.method, "POST");
    assert.equal(observation.url, "/v1/responses");
    assert.equal(observation.headers.authorization === `Bearer ${secret}`, true);
  }
  assert.deepEqual(compatibilityA.body, {
    model: "fixture-model",
    stream: false,
    input: "Reply with OK."
  });
  assert.deepEqual(compatibilityB.body, compatibilityA.body);
  assert.deepEqual(proxiedA.body, { model: "client-model", input: "held-A" });
  assert.deepEqual(proxiedB.body, { model: "client-model", input: "new-B" });

  const restarted = await invoke(["restart", "--json"]);
  assert.equal(restarted.supervisorPid, process.pid);
  assert.equal(restarted.worker.phase, "running");
  assert.notEqual(restarted.worker.pid, firstWorkerPid);
  assert.equal(restarted.worker.state.listenPort, PROXY_PORT);
  const healthResponse = await fetch(`http://127.0.0.1:${PROXY_PORT}/_proxy/health`, {
    signal: AbortSignal.timeout(8_000)
  });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.configured, true);
  assert.equal(health.generation, restarted.worker.generation);
  assertSecretsAbsent("proxy health", JSON.stringify(health));

  const afterRestart = await invoke(["status", "--json"]);
  assert.equal(afterRestart.running, true);
  assert.equal(afterRestart.supervisor.pid, process.pid);
  assert.equal(afterRestart.worker.pid, restarted.worker.pid);
  assert.equal(afterRestart.activeProviderId, providerBId);

  const stopped = await invoke(["stop", "--json"]);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.worker.phase, "stopped");
  assert.equal(stopped.worker.pid, null);
  await confirmPortIdle(PROXY_PORT);
  const stoppedStatus = await invoke(["status", "--json"]);
  assert.equal(stoppedStatus.running, true);
  assert.equal(stoppedStatus.supervisor.pid, process.pid);
  assert.equal(stoppedStatus.worker.phase, "stopped");

  const retainedSurfaces = [
    ["CLI outputs", JSON.stringify(outputs)],
    ["provider registry", readFileSync(paths.registryPath, "utf8")],
    ["supervisor state", readFileSync(paths.statePath, "utf8")],
    ["activity store", readFileSync(paths.activityPath, "utf8")],
    ["Codex config", readFileSync(configPath, "utf8")],
    ...readdirSync(codexDir)
      .filter((name) => name.endsWith(".bak"))
      .map((name) => ["Codex backup", readFileSync(join(codexDir, name), "utf8")])
  ];
  for (const [label, text] of retainedSurfaces) assertSecretsAbsent(label, text);

  const shutdown = await invoke(["shutdown", "--json"]);
  assert.equal(shutdown.shutdown, true);
  assert.equal(shutdown.supervisorPid, process.pid);
  await supervisorClosePromise;
  assert.equal(supervisorAlive, false);
  assert.equal(existsSync(paths.statePath), false);
  await Promise.all([
    confirmPortIdle(PROXY_PORT),
    confirmPortIdle(ADMIN_PORT)
  ]);

  for (const [path, text] of readTree(home)) assertSecretsAbsent(path, text);
  assert.equal(credentials.values.size, SECRETS.length);
  assert.equal(
    SECRETS.every((secret) => [...credentials.values.values()].includes(secret)),
    true
  );
  credentials.clear();
  assert.equal(credentials.values.size, 0);
  fixtureA.observations.length = 0;
  fixtureB.observations.length = 0;
  rmSync(home, { recursive: true, force: true });
  assert.equal(existsSync(home), false);
});
