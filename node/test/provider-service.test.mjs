import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import { join } from "node:path";

import { ProviderRegistry } from "../src/providers/provider-registry.mjs";
import { CrpError } from "../src/shared/errors.mjs";
import { ProviderService } from "../src/supervisor/provider-service.mjs";

const NOW = "2026-07-13T02:00:00.000Z";

function makeSecret(label = "provider") {
  return `${label}-${crypto.randomUUID()}`;
}

function providerInput(name = "Primary", baseUrl = "https://provider.example/v1") {
  return { name, baseUrl };
}

class MemoryCredentials {
  constructor() {
    this.values = new Map();
    this.operations = [];
    this.setCalls = [];
  }

  async set(ref, secret, ...extraArguments) {
    this.operations.push(["set", ref]);
    this.setCalls.push([ref, secret, ...extraArguments]);
    this.values.set(ref, secret);
  }

  async get(ref) {
    this.operations.push(["get", ref]);
    if (!this.values.has(ref)) {
      const error = new Error("missing");
      error.code = "CREDENTIAL_NOT_FOUND";
      throw error;
    }
    return this.values.get(ref);
  }

  async has(ref) {
    this.operations.push(["has", ref]);
    return this.values.has(ref);
  }

  async delete(ref) {
    this.operations.push(["delete", ref]);
    return this.values.delete(ref);
  }
}

class MemoryActivity {
  constructor() {
    this.events = [];
  }

  append(event) {
    this.events.push(structuredClone(event));
  }
}

class FakeWorkerManager {
  constructor() {
    this.phase = "stopped";
    this.generation = 0;
    this.calls = [];
    this.failure = null;
  }

  getPublicState() {
    return {
      phase: this.phase,
      pid: this.phase === "running" ? 9001 : null,
      generation: this.generation,
      state: this.phase === "running" ? {
        phase: "running",
        configured: true,
        generation: this.generation,
        listening: true,
        listenHost: "127.0.0.1",
        listenPort: 15100,
        inFlight: 0
      } : null,
      restartCount: 0,
      startedAt: this.phase === "running" ? NOW : null,
      error: null
    };
  }

  async start(snapshot) {
    this.calls.push(["start", structuredClone(snapshot)]);
    if (this.failure) throw this.failure;
    this.phase = "running";
    this.generation = snapshot.generation;
    return this.getPublicState();
  }

  async applySnapshot(snapshot) {
    this.calls.push(["applySnapshot", structuredClone(snapshot)]);
    if (this.failure) throw this.failure;
    this.generation = snapshot.generation;
    return this.getPublicState();
  }

  async restart(snapshot) {
    this.calls.push(["restart", structuredClone(snapshot)]);
    if (this.failure) throw this.failure;
    this.phase = "running";
    this.generation = snapshot.generation;
    return this.getPublicState();
  }

  async stop() {
    this.calls.push(["stop"]);
    this.phase = "stopped";
    return this.getPublicState();
  }
}

function makeHarness(t, overrides = {}) {
  const root = mkdtempSync(join(os.tmpdir(), "crp-provider-service-"));
  const registry = new ProviderRegistry({
    path: join(root, "providers.json"),
    createId: (() => {
      let index = 0;
      return () => `provider-${++index}`;
    })(),
    now: () => NOW
  });
  const credentials = new MemoryCredentials();
  const activity = new MemoryActivity();
  const workerManager = new FakeWorkerManager();
  let credentialIndex = 0;
  const service = new ProviderService({
    registry,
    credentialStore: credentials,
    activityStore: activity,
    workerManager,
    now: () => NOW,
    createCredentialRef: () => `credential-${++credentialIndex}`,
    createTimeoutSignal: () => ({ aborted: false }),
    paths: {
      runtimeConfigPath: join(root, "node", "proxy-config.json"),
      capturePath: join(root, "traffic.sqlite3")
    },
    ...overrides
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, registry, credentials, activity, workerManager, service };
}

function compatibleResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { id: "resp-test", object: "response", output: [] };
    }
  };
}

function committedError(code) {
  return new CrpError(
    code,
    "Committed operation degraded.",
    "Repair the residual state.",
    { details: { committed: true } }
  );
}

function createGate() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("CRUD returns only public provider fields and removes inactive credentials", async (t) => {
  const secret = makeSecret();
  const { service, credentials, activity } = makeHarness(t);

  const created = await service.createProvider(providerInput(), secret);
  assert.equal(created.id, "provider-1");
  assert.equal(created.credentialConfigured, true);
  assert.equal("credentialRef" in created, false);
  assert.equal(JSON.stringify(created).includes(secret), false);
  assert.deepEqual(await service.listProviders(), [created]);

  const updated = await service.updateProvider(created.id, { name: "Primary Updated" });
  assert.equal(updated.name, "Primary Updated");
  assert.equal("credentialRef" in updated, false);
  const deleted = await service.deleteProvider(created.id);
  assert.equal(deleted.id, created.id);
  assert.equal("credentialRef" in deleted, false);
  assert.equal(credentials.values.size, 0);
  assert.deepEqual(activity.events.map((event) => event.action), ["create", "update", "delete"]);
  assert.equal(JSON.stringify(activity.events).includes(secret), false);
});

test("create does not forward a public fallback-consent option to credential storage", async (t) => {
  const secret = makeSecret("no-public-fallback");
  const { service, credentials } = makeHarness(t);

  await service.createProvider(providerInput(), secret, { fallbackConsent: true });

  assert.equal(credentials.setCalls.length, 1);
  assert.equal(credentials.setCalls[0].length, 2);
  assert.equal(credentials.setCalls[0][0], "credential-1");
  assert.equal(credentials.setCalls[0][1], secret);
});

test("CRUD compensates credential changes and rejects active delete before credential access", async (t) => {
  const oldSecret = makeSecret("old");
  const otherSecret = makeSecret("other");
  const replacementSecret = makeSecret("replacement");
  const { service, registry, credentials, activity } = makeHarness(t);
  const primary = await service.createProvider(providerInput("Primary"), oldSecret);
  const other = await service.createProvider(
    providerInput("Other", "https://other.example/v1"),
    otherSecret
  );

  await assert.rejects(
    () => service.createProvider(
      providerInput("primary", "https://duplicate.example/v1"),
      makeSecret("duplicate")
    ),
    (error) => error?.code === "PROVIDER_NAME_CONFLICT"
  );
  assert.equal(credentials.values.has("credential-3"), false);

  await assert.rejects(
    () => service.updateProvider(primary.id, { name: "OTHER" }, replacementSecret),
    (error) => error?.code === "PROVIDER_NAME_CONFLICT"
  );
  assert.equal(credentials.values.get("credential-1"), oldSecret);
  assert.equal(registry.get(primary.id).name, "Primary");

  const originalDelete = registry.delete.bind(registry);
  registry.delete = () => {
    throw new CrpError(
      "PROVIDER_REGISTRY_WRITE_FAILED",
      "Registry write failed.",
      "Retry the operation."
    );
  };
  await assert.rejects(
    () => service.deleteProvider(other.id),
    (error) => error?.code === "PROVIDER_REGISTRY_WRITE_FAILED"
  );
  assert.equal(credentials.values.get("credential-2"), otherSecret);
  registry.delete = originalDelete;

  registry.setActive(primary.id);
  credentials.operations.length = 0;
  await assert.rejects(
    () => service.deleteProvider(primary.id),
    (error) => error?.code === "PROVIDER_ACTIVE"
  );
  assert.deepEqual(credentials.operations, []);
  assert.deepEqual(
    activity.events.filter((entry) => entry.result === "failed")
      .map((entry) => [entry.action, entry.errorCode]),
    [
      ["create", "PROVIDER_NAME_CONFLICT"],
      ["update", "PROVIDER_NAME_CONFLICT"],
      ["delete", "PROVIDER_REGISTRY_WRITE_FAILED"],
      ["delete", "PROVIDER_ACTIVE"]
    ]
  );
  assert.equal(JSON.stringify(activity.events).includes(oldSecret), false);
  assert.equal(JSON.stringify(activity.events).includes(replacementSecret), false);
});

test("rejects active provider updates before credential or registry mutation", async (t) => {
  const { service, registry, credentials, activity } = makeHarness(t);
  const provider = await service.createProvider(providerInput(), makeSecret());
  registry.setActive(provider.id);
  credentials.operations.length = 0;
  let updateCalls = 0;
  let markTestCalls = 0;
  const originalUpdate = registry.update.bind(registry);
  const originalMarkTest = registry.markTest.bind(registry);
  registry.update = (...args) => {
    updateCalls += 1;
    return originalUpdate(...args);
  };
  registry.markTest = (...args) => {
    markTestCalls += 1;
    return originalMarkTest(...args);
  };

  await assert.rejects(
    () => service.updateProvider(provider.id, { name: "Must Not Change" }, makeSecret()),
    (error) => error?.code === "PROVIDER_ACTIVE" && error.status === 409
  );
  assert.deepEqual(credentials.operations, []);
  assert.equal(updateCalls, 0);
  assert.equal(markTestCalls, 0);
  assert.equal(registry.get(provider.id).name, "Primary");
  assert.equal(activity.events.at(-1).action, "update");
  assert.equal(activity.events.at(-1).errorCode, "PROVIDER_ACTIVE");
});

test("keeps a created provider and credential when registry create reports committed", async (t) => {
  const { service, registry, credentials, activity } = makeHarness(t);
  const originalCreate = registry.create.bind(registry);
  registry.create = (input) => {
    originalCreate(input);
    throw committedError("PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED");
  };

  await assert.rejects(
    () => service.createProvider(providerInput(), makeSecret()),
    (error) => error?.code === "PROVIDER_CREATE_COMMITTED_DEGRADED"
      && error.details.committed === true
  );
  assert.equal(registry.list().length, 1);
  assert.equal(credentials.values.has("credential-1"), true);
  assert.equal(activity.events.at(-1).result, "degraded");
  assert.equal(activity.events.at(-1).errorCode, "PROVIDER_CREATE_COMMITTED_DEGRADED");
});

test("keeps replacement secret and metadata when registry update reports committed", async (t) => {
  const { service, registry, credentials, activity } = makeHarness(t);
  const provider = await service.createProvider(providerInput(), makeSecret("old"));
  registry.markTest(provider.id, { status: "passed" });
  const replacement = makeSecret("replacement");
  const originalUpdate = registry.update.bind(registry);
  registry.update = (id, patch) => {
    originalUpdate(id, patch);
    throw committedError("PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED");
  };

  await assert.rejects(
    () => service.updateProvider(provider.id, { name: "Committed Name" }, replacement),
    (error) => error?.code === "PROVIDER_UPDATE_COMMITTED_DEGRADED"
      && error.details.committed === true
  );
  assert.equal(registry.get(provider.id).name, "Committed Name");
  assert.equal(registry.get(provider.id).lastTestStatus, "untested");
  assert.equal(credentials.values.get("credential-1"), replacement);
  assert.equal(activity.events.at(-1).result, "degraded");
});

test("does not restore a credential when registry delete reports committed", async (t) => {
  const { service, registry, credentials, activity } = makeHarness(t);
  const provider = await service.createProvider(providerInput(), makeSecret());
  const originalDelete = registry.delete.bind(registry);
  registry.delete = (id) => {
    originalDelete(id);
    throw committedError("PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED");
  };

  await assert.rejects(
    () => service.deleteProvider(provider.id),
    (error) => error?.code === "PROVIDER_DELETE_COMMITTED_DEGRADED"
      && error.details.committed === true
  );
  assert.deepEqual(registry.list(), []);
  assert.equal(credentials.values.has("credential-1"), false);
  assert.equal(activity.events.at(-1).result, "degraded");
});

test("reconciles committed credential create, replacement, and delete mutations", async (t) => {
  await t.test("credential create", async (t) => {
    const { service, registry, credentials } = makeHarness(t);
    const originalSet = credentials.set.bind(credentials);
    let injected = false;
    credentials.set = async (ref, secret, options) => {
      await originalSet(ref, secret, options);
      if (!injected) {
        injected = true;
        throw committedError("CREDENTIAL_STORE_COMMITTED_LOCK_DEGRADED");
      }
    };
    await assert.rejects(
      () => service.createProvider(providerInput(), makeSecret()),
      (error) => error?.code === "PROVIDER_CREATE_COMMITTED_DEGRADED"
    );
    assert.equal(registry.list().length, 1);
    assert.equal(credentials.values.has("credential-1"), true);
  });

  await t.test("credential replacement", async (t) => {
    const { service, registry, credentials } = makeHarness(t);
    const provider = await service.createProvider(providerInput(), makeSecret("old"));
    registry.markTest(provider.id, { status: "passed" });
    const replacement = makeSecret("new");
    const originalSet = credentials.set.bind(credentials);
    credentials.set = async (ref, secret, options) => {
      await originalSet(ref, secret, options);
      if (secret === replacement) {
        throw committedError("CREDENTIAL_STORE_COMMITTED_LOCK_DEGRADED");
      }
    };
    await assert.rejects(
      () => service.updateProvider(provider.id, { name: "New Name" }, replacement),
      (error) => error?.code === "PROVIDER_UPDATE_COMMITTED_DEGRADED"
    );
    assert.equal(registry.get(provider.id).name, "New Name");
    assert.equal(registry.get(provider.id).lastTestStatus, "untested");
    assert.equal(credentials.values.get("credential-1"), replacement);
  });

  await t.test("credential delete", async (t) => {
    const { service, registry, credentials } = makeHarness(t);
    const provider = await service.createProvider(providerInput(), makeSecret());
    const originalDelete = credentials.delete.bind(credentials);
    credentials.delete = async (ref) => {
      await originalDelete(ref);
      throw committedError("CREDENTIAL_STORE_COMMITTED_LOCK_DEGRADED");
    };
    await assert.rejects(
      () => service.deleteProvider(provider.id),
      (error) => error?.code === "PROVIDER_DELETE_COMMITTED_DEGRADED"
    );
    assert.deepEqual(registry.list(), []);
    assert.equal(credentials.values.has("credential-1"), false);
  });
});

test("keeps provider not ready when replacement-secret rollback cannot restore the old secret", async (t) => {
  const oldSecret = makeSecret("old");
  const replacement = makeSecret("replacement");
  const { service, registry, credentials, workerManager } = makeHarness(t);
  const primary = await service.createProvider(providerInput("Primary"), oldSecret);
  await service.createProvider(providerInput("Other", "https://other.example/v1"), makeSecret());
  registry.markTest(primary.id, { status: "passed" });
  const originalSet = credentials.set.bind(credentials);
  credentials.set = async (ref, secret, options) => {
    if (ref === "credential-1" && secret === oldSecret) {
      throw new Error("private old-secret restore failure");
    }
    return await originalSet(ref, secret, options);
  };

  await assert.rejects(
    () => service.updateProvider(primary.id, { name: "OTHER" }, replacement),
    (error) => error?.code === "PROVIDER_UPDATE_ROLLBACK_DEGRADED"
      && error.details.degraded === true
  );
  assert.equal(credentials.values.get("credential-1"), replacement);
  assert.notEqual(registry.get(primary.id).lastTestStatus, "passed");
  credentials.operations.length = 0;
  const workerCallCount = workerManager.calls.length;
  await assert.rejects(
    () => service.activate(primary.id),
    (error) => error?.code === "PROVIDER_NOT_READY"
  );
  assert.deepEqual(
    credentials.operations.filter(([operation]) => operation === "get"),
    []
  );
  assert.equal(workerManager.calls.length, workerCallCount);
});

test("testProvider sends the fixed Responses request and classifies stable failures", async (t) => {
  const secret = makeSecret();
  const requests = [];
  let nextFetch = async () => compatibleResponse();
  const { service, credentials } = makeHarness(t, {
    fetchImpl: async (...args) => {
      requests.push(args);
      return nextFetch(...args);
    }
  });
  const provider = await service.createProvider({
    ...providerInput(),
    authHeader: "x-provider-auth",
    authScheme: "Token",
    extraHeaders: { "x-region": "test" }
  }, secret);

  assert.deepEqual(await service.testProvider(provider.id, "model-test"), {
    ok: true,
    code: null
  });
  const [url, options] = requests.at(-1);
  assert.equal(url, "https://provider.example/v1/responses");
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "manual");
  assert.deepEqual(JSON.parse(options.body), {
    model: "model-test",
    stream: false,
    input: "Reply with OK."
  });
  assert.equal(options.headers["x-provider-auth"], `Token ${secret}`);
  assert.equal(options.headers["x-region"], "test");
  assert.ok(options.signal);

  const scenarios = [
    ["PROVIDER_TEST_DNS", async () => { const error = new Error("private dns"); error.code = "ENOTFOUND"; throw error; }],
    ["PROVIDER_TEST_TLS", async () => { const error = new Error("private tls"); error.code = "CERT_HAS_EXPIRED"; throw error; }],
    ["PROVIDER_TEST_TIMEOUT", async () => { const error = new Error("private timeout"); error.name = "TimeoutError"; throw error; }],
    ["PROVIDER_TEST_AUTH", async () => ({ ok: false, status: 401, json: async () => ({ private: secret }) })],
    ["PROVIDER_TEST_NOT_FOUND", async () => ({ ok: false, status: 404, json: async () => ({ private: secret }) })],
    ["PROVIDER_TEST_HTTP", async () => ({ ok: false, status: 503, json: async () => ({ private: secret }) })],
    ["PROVIDER_TEST_INVALID_JSON", async () => ({ ok: true, status: 200, json: async () => { throw new Error(secret); } })],
    ["PROVIDER_TEST_INVALID_RESPONSES", async () => ({ ok: true, status: 200, json: async () => ({ id: "wrong" }) })],
    ["PROVIDER_TEST_NETWORK", async () => { throw new Error(`private other ${secret}`); }]
  ];
  for (const [code, fetchScenario] of scenarios) {
    nextFetch = fetchScenario;
    assert.deepEqual(await service.testProvider(provider.id, "model-test"), {
      ok: false,
      code
    });
  }

  assert.deepEqual(
    credentials.operations.filter(([operation]) => operation === "get")
      .map(([, ref]) => ref),
    Array(scenarios.length + 1).fill("credential-1")
  );
  assert.equal(JSON.stringify(await service.listProviders()).includes(secret), false);
});

test("never follows a redirect or forwards custom authentication to a second origin", async (t) => {
  const secret = makeSecret("redirect");
  const secondRequests = [];
  const second = createServer((request, response) => {
    secondRequests.push({ url: request.url, headers: { ...request.headers } });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp", object: "response", output: [] }));
  });
  const secondPort = await listen(second);
  t.after(() => closeServer(second));
  const firstRequests = [];
  const first = createServer((request, response) => {
    firstRequests.push({ url: request.url, headers: { ...request.headers } });
    response.writeHead(302, {
      location: `http://127.0.0.1:${secondPort}/stolen`
    });
    response.end();
  });
  const firstPort = await listen(first);
  t.after(() => closeServer(first));
  const { service, activity } = makeHarness(t, {
    fetchImpl: globalThis.fetch,
    createTimeoutSignal: () => AbortSignal.timeout(1_000)
  });
  const provider = await service.createProvider({
    ...providerInput("Redirect", `http://127.0.0.1:${firstPort}/v1`),
    authHeader: "x-private-auth",
    authScheme: "Token"
  }, secret);

  assert.deepEqual(await service.testProvider(provider.id, "model-test"), {
    ok: false,
    code: "PROVIDER_TEST_REDIRECT"
  });
  assert.equal(firstRequests.length, 1);
  assert.equal(firstRequests[0].headers["x-private-auth"], `Token ${secret}`);
  assert.equal(secondRequests.length, 0);
  assert.equal(JSON.stringify(activity.events).includes(secret), false);
});

test("activate persists then confirms increasing generations and rolls back failures", async (t) => {
  const secretA = makeSecret("a");
  const secretB = makeSecret("b");
  const healthCalls = [];
  const harness = makeHarness(t, {
    verifyWorkerHealth: async (generation, state) => {
      healthCalls.push([generation, state.generation]);
      return true;
    }
  });
  const { service, registry, credentials, workerManager } = harness;
  const providerA = await service.createProvider(providerInput("A"), secretA);
  const providerB = await service.createProvider(
    providerInput("B", "https://b.example/v1"),
    secretB
  );

  await assert.rejects(
    () => service.activate(providerA.id),
    (error) => error?.code === "PROVIDER_NOT_READY" && error.status === 409
  );
  registry.markTest(providerA.id, { status: "passed" });
  const first = await service.activate(providerA.id);
  assert.equal(first.activeProviderId, providerA.id);
  assert.equal(first.generation, 1);
  assert.equal(registry.getDocument().activeProviderId, providerA.id);
  assert.equal(workerManager.calls[0][0], "start");
  assert.equal(workerManager.calls[0][1].generation, 1);
  assert.equal(workerManager.calls[0][1].settings.upstream.apiKey, secretA);
  assert.deepEqual(healthCalls, [[1, 1]]);

  registry.markTest(providerB.id, { status: "passed" });
  const originalApply = workerManager.applySnapshot.bind(workerManager);
  let failCandidate = true;
  workerManager.applySnapshot = async (snapshot) => {
    if (failCandidate) {
      failCandidate = false;
      workerManager.failure = Object.assign(new Error(`private worker ${secretB}`), {
        code: "WORKER_HEALTH_FAILED"
      });
      try {
        return await originalApply(snapshot);
      } finally {
        workerManager.failure = null;
      }
    }
    return await originalApply(snapshot);
  };
  await assert.rejects(
    () => service.activate(providerB.id),
    (error) => error?.code === "PROVIDER_ACTIVATION_FAILED"
      && !error.message.includes(secretB)
  );
  assert.equal(registry.getDocument().activeProviderId, providerA.id);
  assert.equal((await service.getStatus()).generation, 3);

  const second = await service.activate(providerB.id);
  assert.equal(second.generation, 4);
  assert.equal(second.activeProviderId, providerB.id);
  assert.equal(workerManager.calls.at(-1)[0], "applySnapshot");
  assert.equal(workerManager.calls.at(-1)[1].settings.upstream.apiKey, secretB);
  const credentialGets = credentials.operations
    .filter(([operation]) => operation === "get")
    .map(([, ref]) => ref);
  assert.deepEqual(credentialGets, ["credential-1", "credential-2", "credential-2"]);
  const status = await service.getStatus();
  assert.equal(JSON.stringify(status).includes(secretA), false);
  assert.equal(JSON.stringify(status).includes(secretB), false);
  assert.equal(JSON.stringify(status).includes("credential-"), false);
});

test("serializes concurrent activations before credential reads and worker changes", async (t) => {
  let releaseFirstStart;
  let firstStartEntered;
  const startEntered = new Promise((resolve) => { firstStartEntered = resolve; });
  const harness = makeHarness(t);
  const { service, registry, credentials, workerManager } = harness;
  const originalStart = workerManager.start.bind(workerManager);
  workerManager.start = async (snapshot) => {
    firstStartEntered();
    await new Promise((resolve) => { releaseFirstStart = resolve; });
    return await originalStart(snapshot);
  };
  const providerA = await service.createProvider(providerInput("A"), makeSecret("a"));
  const providerB = await service.createProvider(
    providerInput("B", "https://b.example/v1"),
    makeSecret("b")
  );
  registry.markTest(providerA.id, { status: "passed" });
  registry.markTest(providerB.id, { status: "passed" });
  credentials.operations.length = 0;

  const first = service.activate(providerA.id);
  const second = service.activate(providerB.id);
  await startEntered;
  await Promise.resolve();
  assert.deepEqual(
    credentials.operations.filter(([operation]) => operation === "get"),
    [["get", "credential-1"]]
  );
  assert.equal(workerManager.calls.length, 0);
  releaseFirstStart();
  await first;
  const secondResult = await second;

  assert.equal(secondResult.activeProviderId, providerB.id);
  assert.equal(secondResult.generation, 2);
  assert.deepEqual(workerManager.calls.map(([operation, snapshot]) => (
    [operation, snapshot?.generation ?? null]
  )), [["start", 1], ["applySnapshot", 2]]);
  assert.deepEqual(
    credentials.operations.filter(([operation]) => operation === "get"),
    [["get", "credential-1"], ["get", "credential-2"]]
  );
});

test("restores the confirmed worker snapshot when post-ack health fails", async (t) => {
  let failHealthGeneration = null;
  const harness = makeHarness(t, {
    verifyWorkerHealth: async (generation) => generation !== failHealthGeneration
  });
  const { service, registry, credentials, workerManager } = harness;
  const secretA = makeSecret("a");
  const secretB = makeSecret("b");
  const providerA = await service.createProvider(providerInput("A"), secretA);
  const providerB = await service.createProvider(
    providerInput("B", "https://b.example/v1"),
    secretB
  );
  registry.markTest(providerA.id, { status: "passed" });
  registry.markTest(providerB.id, { status: "passed" });
  await service.activate(providerA.id);
  credentials.operations.length = 0;
  failHealthGeneration = 2;

  await assert.rejects(
    () => service.activate(providerB.id),
    (error) => error?.code === "PROVIDER_ACTIVATION_FAILED"
  );
  assert.equal(registry.getDocument().activeProviderId, providerA.id);
  assert.equal((await service.getStatus()).generation, 3);
  assert.equal(workerManager.generation, 3);
  assert.deepEqual(workerManager.calls.slice(-2).map(([operation, snapshot]) => [
    operation,
    snapshot.generation,
    snapshot.settings.upstream.apiKey
  ]), [
    ["applySnapshot", 2, secretB],
    ["applySnapshot", 3, secretA]
  ]);
  assert.deepEqual(
    credentials.operations.filter(([operation]) => operation === "get"),
    [["get", "credential-2"]]
  );
});

test("reports degraded activation when a post-ack worker rollback cannot be confirmed", async (t) => {
  let failHealthGeneration = null;
  const harness = makeHarness(t, {
    verifyWorkerHealth: async (generation) => generation !== failHealthGeneration
  });
  const { service, registry, workerManager, activity } = harness;
  const providerA = await service.createProvider(providerInput("A"), makeSecret("a"));
  const providerB = await service.createProvider(
    providerInput("B", "https://b.example/v1"),
    makeSecret("b")
  );
  registry.markTest(providerA.id, { status: "passed" });
  registry.markTest(providerB.id, { status: "passed" });
  await service.activate(providerA.id);
  failHealthGeneration = 2;
  const originalApply = workerManager.applySnapshot.bind(workerManager);
  let applyCount = 0;
  workerManager.applySnapshot = async (snapshot) => {
    applyCount += 1;
    if (applyCount === 2) throw new Error("private rollback failure");
    return await originalApply(snapshot);
  };

  await assert.rejects(
    () => service.activate(providerB.id),
    (error) => error?.code === "PROVIDER_ACTIVATION_ROLLBACK_DEGRADED"
      && error.details.committed === false
      && error.details.degraded === true
  );
  assert.equal(registry.getDocument().activeProviderId, providerA.id);
  assert.equal((await service.getStatus()).generation, 1);
  assert.equal(workerManager.generation, 2);
  assert.deepEqual(activity.events.at(-1), {
    category: "provider",
    action: "activate",
    providerId: providerB.id,
    result: "failed",
    errorCode: "PROVIDER_ACTIVATION_ROLLBACK_DEGRADED",
    details: { generation: 2 }
  });
});

test("reconciles committed active persistence and continues the selected worker snapshot", async (t) => {
  const harness = makeHarness(t);
  const { service, registry, workerManager, activity } = harness;
  const providerA = await service.createProvider(providerInput("A"), makeSecret("a"));
  const secretB = makeSecret("b");
  const providerB = await service.createProvider(
    providerInput("B", "https://b.example/v1"),
    secretB
  );
  registry.markTest(providerA.id, { status: "passed" });
  registry.markTest(providerB.id, { status: "passed" });
  await service.activate(providerA.id);
  const originalSetActive = registry.setActive.bind(registry);
  let injected = false;
  registry.setActive = (id) => {
    const result = originalSetActive(id);
    if (id === providerB.id && !injected) {
      injected = true;
      throw committedError("PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED");
    }
    return result;
  };

  await assert.rejects(
    () => service.activate(providerB.id),
    (error) => error?.code === "PROVIDER_ACTIVATION_COMMITTED_DEGRADED"
      && error.details.committed === true
  );
  assert.equal(registry.getDocument().activeProviderId, providerB.id);
  assert.equal(workerManager.generation, 2);
  assert.equal(workerManager.calls.at(-1)[0], "applySnapshot");
  assert.equal(workerManager.calls.at(-1)[1].settings.upstream.apiKey, secretB);
  assert.equal((await service.getStatus()).generation, 2);
  assert.equal(activity.events.at(-1).result, "degraded");
  assert.equal(activity.events.at(-1).errorCode, "PROVIDER_ACTIVATION_COMMITTED_DEGRADED");
});

test("deterministically restores generation 3 after candidate apply commits but ACK is lost", async (t) => {
  const harness = makeHarness(t);
  const { service, registry, workerManager } = harness;
  const secretA = makeSecret("a");
  const secretB = makeSecret("b");
  const providerA = await service.createProvider(providerInput("A"), secretA);
  const providerB = await service.createProvider(
    providerInput("B", "https://b.example/v1"),
    secretB
  );
  registry.markTest(providerA.id, { status: "passed" });
  registry.markTest(providerB.id, { status: "passed" });
  await service.activate(providerA.id);
  const originalApply = workerManager.applySnapshot.bind(workerManager);
  workerManager.applySnapshot = async (snapshot) => {
    const state = await originalApply(snapshot);
    if (snapshot.generation === 2) {
      const error = new Error("private lost acknowledgement");
      error.code = "WORKER_ACK_TIMEOUT";
      throw error;
    }
    return state;
  };

  await assert.rejects(
    () => service.activate(providerB.id),
    (error) => error?.code === "PROVIDER_ACTIVATION_FAILED"
  );
  assert.equal(registry.getDocument().activeProviderId, providerA.id);
  assert.equal(workerManager.generation, 3);
  assert.equal((await service.getStatus()).generation, 3);
  assert.deepEqual(workerManager.calls.slice(-2).map(([operation, snapshot]) => [
    operation,
    snapshot.generation,
    snapshot.settings.upstream.apiKey
  ]), [
    ["applySnapshot", 2, secretB],
    ["applySnapshot", 3, secretA]
  ]);
});

test("reports rollback degraded when first activation may commit and bounded stop fails", async (t) => {
  const harness = makeHarness(t);
  const { service, registry, workerManager, activity } = harness;
  const provider = await service.createProvider(providerInput(), makeSecret());
  registry.markTest(provider.id, { status: "passed" });
  const originalStart = workerManager.start.bind(workerManager);
  workerManager.start = async (snapshot) => {
    await originalStart(snapshot);
    const error = new Error("private lost first acknowledgement");
    error.code = "WORKER_ACK_TIMEOUT";
    throw error;
  };
  workerManager.stop = async () => {
    throw new Error("private bounded stop failure");
  };

  await assert.rejects(
    () => service.activate(provider.id),
    (error) => error?.code === "PROVIDER_ACTIVATION_ROLLBACK_DEGRADED"
      && error.details.degraded === true
  );
  assert.equal(registry.getDocument().activeProviderId, null);
  assert.equal((await service.getStatus()).generation, 0);
  assert.equal(workerManager.generation, 1);
  assert.equal(activity.events.at(-1).errorCode, "PROVIDER_ACTIVATION_ROLLBACK_DEGRADED");
});

test("proxy lifecycle facade resolves only the active credential and advances confirmed generations", async (t) => {
  const harness = makeHarness(t);
  const { service, registry, credentials, workerManager, activity } = harness;
  const secretA = makeSecret("active");
  const secretB = makeSecret("inactive");
  const providerA = await service.createProvider(providerInput("A"), secretA);
  await service.createProvider(providerInput("B", "https://b.example/v1"), secretB);
  registry.markTest(providerA.id, { status: "passed" });
  await service.activate(providerA.id);

  credentials.operations.length = 0;
  workerManager.calls.length = 0;
  const stopped = await service.stopProxy();
  assert.equal(stopped.phase, "stopped");
  assert.deepEqual(credentials.operations, []);

  const started = await service.startProxy();
  assert.equal(started.phase, "running");
  assert.equal(started.generation, 2);
  assert.equal(workerManager.calls.at(-1)[0], "start");
  assert.equal(workerManager.calls.at(-1)[1].settings.upstream.apiKey, secretA);

  const restarted = await service.restartProxy();
  assert.equal(restarted.phase, "running");
  assert.equal(restarted.generation, 3);
  assert.equal(workerManager.calls.at(-1)[0], "restart");
  assert.equal(workerManager.calls.at(-1)[1].settings.upstream.apiKey, secretA);
  assert.deepEqual(
    credentials.operations.filter(([operation]) => operation === "get").map(([, ref]) => ref),
    ["credential-1", "credential-1"]
  );

  const serialized = JSON.stringify({ stopped, started, restarted, events: activity.events });
  for (const forbidden of [secretA, secretB, "credential-1", "credential-2", "apiKey"]) {
    assert.equal(serialized.includes(forbidden), false, `lifecycle output leaked ${forbidden}`);
  }
  assert.deepEqual(
    activity.events.slice(-3).map(({ category, action, result }) => ({ category, action, result })),
    [
      { category: "proxy", action: "stop", result: "success" },
      { category: "proxy", action: "start", result: "success" },
      { category: "proxy", action: "restart", result: "success" }
    ]
  );
});

test("shares each pending proxy lifecycle operation across concurrent commands", async (t) => {
  for (const leader of ["start", "stop", "restart"]) {
    await t.test(leader, async (t) => {
      const { service, registry, credentials, workerManager, activity } = makeHarness(t);
      const provider = await service.createProvider(providerInput(), makeSecret());
      registry.markTest(provider.id, { status: "passed" });
      registry.setActive(provider.id);
      if (leader === "stop") {
        workerManager.phase = "running";
      }
      credentials.operations.length = 0;
      workerManager.calls.length = 0;
      activity.events.length = 0;

      const gate = createGate();
      const method = `${leader}Proxy`;
      const original = workerManager[leader].bind(workerManager);
      let leaderCalls = 0;
      workerManager[leader] = (...args) => {
        leaderCalls += 1;
        return gate.promise.then(() => original(...args));
      };

      const current = service[method]();
      const concurrent = [
        service.startProxy(),
        service.stopProxy(),
        service.restartProxy()
      ];
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      const samePromises = concurrent.map((operation) => operation === current);
      gate.resolve();
      const [result, ...concurrentResults] = await Promise.all([current, ...concurrent]);

      assert.deepEqual(samePromises, [true, true, true]);
      assert.ok(concurrentResults.every((candidate) => candidate === result));
      assert.equal(leaderCalls, 1);
      assert.deepEqual(workerManager.calls.map(([operation]) => operation), [leader]);
      assert.equal(
        credentials.operations.filter(([operation]) => operation === "get").length,
        leader === "stop" ? 0 : 1
      );
      assert.deepEqual(
        activity.events.map(({ category, action, result }) => ({ category, action, result })),
        [{ category: "proxy", action: leader, result: "success" }]
      );
      assert.equal(result.generation, leader === "stop" ? 0 : 1);

      const later = service.restartProxy();
      assert.notEqual(later, current);
      const laterResult = await later;
      assert.equal(laterResult.generation, leader === "stop" ? 1 : 2);
      assert.equal(activity.events.length, 2);
    });
  }
});

test("proxy start and restart reject without an active provider while stop remains idempotent", async (t) => {
  const { service, credentials } = makeHarness(t);
  await assert.rejects(
    () => service.startProxy(),
    (error) => error instanceof CrpError
      && error.code === "PROXY_NOT_CONFIGURED"
      && error.status === 409
  );
  await assert.rejects(
    () => service.restartProxy(),
    (error) => error instanceof CrpError
      && error.code === "PROXY_NOT_CONFIGURED"
      && error.status === 409
  );
  assert.equal((await service.stopProxy()).phase, "stopped");
  assert.deepEqual(credentials.operations, []);
});
