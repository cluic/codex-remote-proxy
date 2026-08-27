import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import { join } from "node:path";

import { ProviderRegistry } from "../src/providers/provider-registry.mjs";
import { CrpError, toPublicError } from "../src/shared/errors.mjs";
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

class MemoryModelCache {
  constructor() {
    this.entries = new Map();
    this.getCalls = [];
    this.putCalls = [];
    this.deleteCalls = [];
  }

  get(providerId, sourceFingerprint) {
    this.getCalls.push([providerId, sourceFingerprint]);
    const entry = this.entries.get(providerId);
    if (!entry || entry.sourceFingerprint !== sourceFingerprint) {
      return {
        providerId,
        state: "missing",
        fetchedAt: null,
        expiresAt: null,
        models: []
      };
    }
    const { sourceFingerprint: _privateFingerprint, ...catalog } = entry;
    return structuredClone(catalog);
  }

  put(entry) {
    this.putCalls.push(structuredClone(entry));
    const catalog = {
      providerId: entry.providerId,
      state: "fresh",
      fetchedAt: entry.fetchedAt,
      expiresAt: new Date(Date.parse(entry.fetchedAt) + 24 * 60 * 60 * 1_000).toISOString(),
      models: [...entry.models]
    };
    this.entries.set(entry.providerId, {
      ...structuredClone(catalog),
      sourceFingerprint: entry.sourceFingerprint
    });
    return structuredClone(catalog);
  }

  delete(providerId) {
    this.deleteCalls.push(providerId);
    return this.entries.delete(providerId);
  }

  seed(entry) {
    this.entries.set(entry.providerId, structuredClone(entry));
  }
}

class FakeWorkerManager {
  constructor() {
    this.phase = "stopped";
    this.generation = 0;
    this.calls = [];
    this.failure = null;
    this.preview = null;
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
    if (this.failure) {
      const failure = this.failure;
      if (this.failureOnce) this.failure = null;
      throw failure;
    }
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

  async previewRoute(model) {
    this.calls.push(["previewRoute", model]);
    if (this.preview) return structuredClone(this.preview);
    const error = new Error("not running");
    error.code = "WORKER_NOT_RUNNING";
    throw error;
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
  const activity = overrides.activityStore ?? new MemoryActivity();
  const workerManager = new FakeWorkerManager();
  const modelCache = overrides.modelCache ?? new MemoryModelCache();
  let credentialIndex = 0;
  const service = new ProviderService({
    registry,
    credentialStore: credentials,
    activityStore: activity,
    workerManager,
    modelCache,
    now: () => NOW,
    createCredentialRef: () => `credential-${++credentialIndex}`,
    createTimeoutSignal: () => ({ aborted: false }),
    paths: {
      runtimeConfigPath: join(root, "node", "proxy-config.json"),
      capturePath: join(root, "traffic.sqlite3"),
      accessKeyDbPath: join(root, "access-keys.sqlite3")
    },
    localAccessToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ...overrides
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, registry, credentials, activity, workerManager, modelCache, service };
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

function modelListResponse(models, { status = 200, payload } = {}) {
  return new Response(JSON.stringify(payload ?? {
    object: "list",
    data: models.map((id) => ({ id, object: "model", owned_by: "test" }))
  }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function expectedModelCatalog(providerId, {
  state = "missing",
  fetchedAt = null,
  expiresAt = null,
  mode = "auto",
  configuredModels = [],
  modelsPath = "/models",
  customModels = [],
  discoveredModels = []
} = {}) {
  const defaultEnabled = mode === "auto";
  const configured = new Set(configuredModels);
  const discovered = new Set(discoveredModels);
  const custom = new Set(customModels);
  const ids = [...new Set([...configuredModels, ...customModels, ...discoveredModels])];
  const entries = ids.map((id) => ({
    id,
    discovered: discovered.has(id),
    custom: custom.has(id),
    enabled: configured.has(id) ? !defaultEnabled : defaultEnabled
  }));
  return {
    providerId,
    state,
    fetchedAt,
    expiresAt,
    models: entries.filter((entry) => entry.enabled).map((entry) => entry.id),
    mode,
    configuredModels,
    modelsPath,
    defaultEnabled,
    customModels,
    discoveredModels,
    entries
  };
}

function committedError(code, action = "Repair the residual state.") {
  return new CrpError(
    code,
    "Committed operation degraded.",
    action,
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

test("model mapping groups project usage and resolve exact rules into Worker snapshots", async (t) => {
  const { registry, activity, workerManager, service } = makeHarness(t);
  const group = await service.createModelMappingGroup({
    name: "OpenRouter",
    rules: [{ sourceModel: "gpt-5", targetModel: "openai/gpt-5" }]
  });
  const provider = await service.createProvider({
    ...providerInput(),
    modelMappingGroupId: group.id
  }, makeSecret("mapping"));
  assert.deepEqual(service.listModelMappingGroups()[0].providerIds, [provider.id]);

  registry.markTest(provider.id, { status: "passed" });
  await service.activate(provider.id);
  assert.deepEqual(workerManager.calls.at(-1)[1].settings.proxy.modelMappings, [
    { sourceModel: "gpt-5", targetModel: "openai/gpt-5" }
  ]);
  const updated = await service.updateModelMappingGroup(group.id, {
    name: "OpenRouter exact",
    rules: [{ sourceModel: "gpt-5", targetModel: "openai/gpt-5.1" }]
  });
  assert.deepEqual(updated.providerIds, [provider.id]);
  assert.equal(workerManager.calls.at(-1)[0], "applySnapshot");
  assert.deepEqual(workerManager.calls.at(-1)[1].settings.proxy.modelMappings, [
    { sourceModel: "gpt-5", targetModel: "openai/gpt-5.1" }
  ]);
  await assert.rejects(
    () => service.deleteModelMappingGroup(group.id),
    (error) => error?.code === "MODEL_MAPPING_IN_USE" && error.status === 409
  );

  await service.updateProvider(provider.id, { modelMappingGroupId: null });
  assert.equal(await service.deleteModelMappingGroup(group.id).then(({ id }) => id), group.id);
  assert.deepEqual(
    activity.events
      .filter(({ action }) => action.startsWith("model-mapping-"))
      .map(({ action, result }) => ({ action, result })),
    [
      { action: "model-mapping-create", result: "success" },
      { action: "model-mapping-update", result: "success" },
      { action: "model-mapping-delete", result: "failed" },
      { action: "model-mapping-delete", result: "success" }
    ]
  );
});

test("reports committed model mapping mutations as degraded without rolling them back", async (t) => {
  await t.test("registry create", async (t) => {
    const { registry, activity, service } = makeHarness(t);
    const originalCreate = registry.createModelMappingGroup.bind(registry);
    registry.createModelMappingGroup = (input) => {
      originalCreate(input);
      throw committedError("PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED");
    };
    await assert.rejects(
      () => service.createModelMappingGroup({
        name: "Committed create",
        rules: [{ sourceModel: "gpt-5", targetModel: "openai/gpt-5" }]
      }),
      (error) => error?.code === "MODEL_MAPPING_CREATE_COMMITTED_DEGRADED"
        && error.details.committed === true
    );
    assert.equal(registry.listModelMappingGroups().length, 1);
    assert.equal(activity.events.at(-1).result, "degraded");
  });

  await t.test("registry update and delete", async (t) => {
    const { registry, service } = makeHarness(t);
    const group = await service.createModelMappingGroup({
      name: "Mutable",
      rules: [{ sourceModel: "gpt-5", targetModel: "openai/gpt-5" }]
    });
    const originalUpdate = registry.updateModelMappingGroup.bind(registry);
    registry.updateModelMappingGroup = (id, input) => {
      originalUpdate(id, input);
      throw committedError("PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED");
    };
    await assert.rejects(
      () => service.updateModelMappingGroup(group.id, {
        name: "Mutable",
        rules: [{ sourceModel: "gpt-5", targetModel: "openai/gpt-5.1" }]
      }),
      (error) => error?.code === "MODEL_MAPPING_UPDATE_COMMITTED_DEGRADED"
        && error.details.committed === true
    );
    assert.equal(registry.getModelMappingGroup(group.id).rules[0].targetModel, "openai/gpt-5.1");

    const originalDelete = registry.deleteModelMappingGroup.bind(registry);
    registry.deleteModelMappingGroup = (id) => {
      originalDelete(id);
      throw committedError("PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED");
    };
    await assert.rejects(
      () => service.deleteModelMappingGroup(group.id),
      (error) => error?.code === "MODEL_MAPPING_DELETE_COMMITTED_DEGRADED"
        && error.details.committed === true
    );
    assert.deepEqual(registry.listModelMappingGroups(), []);
  });

  await t.test("Activity failure after commit", async (t) => {
    class OneShotFailingActivity extends MemoryActivity {
      failed = false;

      append(event) {
        if (!this.failed && event.action === "model-mapping-create" && event.result === "success") {
          this.failed = true;
          throw new Error("injected activity failure");
        }
        super.append(event);
      }
    }
    const activity = new OneShotFailingActivity();
    const { registry, service } = makeHarness(t, { activityStore: activity });
    await assert.rejects(
      () => service.createModelMappingGroup({
        name: "Activity committed",
        rules: [{ sourceModel: "gpt-5", targetModel: "openai/gpt-5" }]
      }),
      (error) => error?.code === "MODEL_MAPPING_CREATE_COMMITTED_DEGRADED"
        && error.details.committed === true
    );
    assert.equal(registry.listModelMappingGroups().length, 1);
    assert.equal(activity.events.at(-1).result, "degraded");
    assert.equal(activity.events.at(-1).errorCode, "MODEL_MAPPING_CREATE_COMMITTED_DEGRADED");
  });
});

test("running provider pools hot-apply provider edits and protect the final tested route", async (t) => {
  const secret = makeSecret("pool-member");
  const { service, registry, credentials, workerManager } = makeHarness(t);
  const provider = await service.createProvider(providerInput("Pool member"), secret);

  await assert.rejects(
    () => service.updateProvider(provider.id, { weight: 250 }),
    (error) => error?.code === "PROVIDER_WEIGHT_ENDPOINT_REQUIRED"
  );
  assert.equal(registry.get(provider.id).weight, 100);

  registry.markTest(provider.id, { status: "passed" });
  await service.activate(provider.id);
  const replacement = makeSecret("replacement");
  const updated = await service.updateProvider(
    provider.id,
    { name: "Live mutation" },
    replacement
  );
  assert.equal(updated.name, "Live mutation");
  assert.equal(registry.get(provider.id).lastTestStatus, "passed");
  assert.equal(credentials.values.get("credential-1"), replacement);
  assert.equal(workerManager.calls.at(-1)[0], "applySnapshot");
  await assert.rejects(
    () => service.deleteProvider(provider.id),
    (error) => error?.code === "PROVIDER_POOL_EMPTY"
  );
  assert.equal(registry.get(provider.id).name, "Live mutation");
  assert.equal(credentials.values.get("credential-1"), replacement);
});

test("multi-model routing rules, model controls, and active-provider deletion hot-apply together", async (t) => {
  const { service, registry, credentials, workerManager } = makeHarness(t);
  const providerA = await service.createProvider(
    providerInput("Provider A"),
    makeSecret("provider-a")
  );
  const providerB = await service.createProvider(
    providerInput("Provider B", "https://provider-b.example/v1"),
    makeSecret("provider-b")
  );
  registry.markTest(providerA.id, { status: "passed" });
  registry.markTest(providerB.id, { status: "passed" });
  await service.activate(providerA.id);

  const group = await service.createRoutingRuleGroup({
    name: "Five-model split",
    rules: [
      { models: ["M1", "M3", "M5"], providerIds: [providerA.id, providerB.id] },
      { models: ["M2", "M4"], providerIds: [providerB.id, providerA.id] }
    ]
  });
  await service.setActiveRoutingRuleGroup(group.id);
  assert.deepEqual(
    workerManager.calls.at(-1)[1].settings.routing.providerPriorityRules,
    [
      { model: "M1", providerIds: [providerA.id, providerB.id] },
      { model: "M3", providerIds: [providerA.id, providerB.id] },
      { model: "M5", providerIds: [providerA.id, providerB.id] },
      { model: "M2", providerIds: [providerB.id, providerA.id] },
      { model: "M4", providerIds: [providerB.id, providerA.id] }
    ]
  );

  const catalog = await service.setProviderSupportedModels(providerB.id, {
    mode: "custom",
    models: ["M2", "M4"],
    modelsPath: "/catalog/models",
    customModels: ["M2", "M4"]
  });
  assert.equal(catalog.mode, "custom");
  assert.deepEqual(catalog.configuredModels, ["M2", "M4"]);
  assert.equal(catalog.modelsPath, "/catalog/models");
  const providerBSnapshot = workerManager.calls.at(-1)[1].settings.providers.find(
    (candidate) => candidate.id === providerB.id
  );
  assert.deepEqual(providerBSnapshot.supportedModels, ["M2", "M4"]);
  assert.deepEqual(providerBSnapshot.disabledModels, []);

  await service.setProviderSupportedModels(providerA.id, {
    mode: "auto",
    models: ["M3"],
    modelsPath: "/models",
    customModels: ["M5"]
  });
  const providerASnapshot = workerManager.calls.at(-1)[1].settings.providers.find(
    (candidate) => candidate.id === providerA.id
  );
  assert.equal(providerASnapshot.supportedModels, null);
  assert.deepEqual(providerASnapshot.disabledModels, ["M3"]);

  const deleted = await service.deleteProvider(providerA.id);
  assert.equal(deleted.id, providerA.id);
  assert.equal(credentials.values.has("credential-1"), false);
  assert.equal(registry.getDocument().activeProviderId, providerB.id);
  assert.deepEqual(
    workerManager.calls.at(-1)[1].settings.providers.map(({ id }) => id),
    [providerB.id]
  );
  assert.deepEqual(registry.getRoutingRuleGroup(group.id).rules, [
    { models: ["M1", "M3", "M5"], providerIds: [providerB.id] },
    { models: ["M2", "M4"], providerIds: [providerB.id] }
  ]);
});

test("route previews explain configured and live routing with group metadata", async (t) => {
  const { service, registry, workerManager } = makeHarness(t);
  const providerA = await service.createProvider(
    providerInput("Provider A"),
    makeSecret("preview-a")
  );
  const providerB = await service.createProvider(
    providerInput("Provider B", "https://provider-b.example/v1"),
    makeSecret("preview-b")
  );
  registry.markTest(providerA.id, { status: "passed" });
  registry.markTest(providerB.id, { status: "passed" });
  const mappingGroup = await service.createModelMappingGroup({
    name: "Provider B aliases",
    rules: [{ sourceModel: "model-a", targetModel: "vendor/model-a" }]
  });
  await service.updateProvider(providerB.id, { modelMappingGroupId: mappingGroup.id });
  await service.setProviderSupportedModels(providerB.id, {
    mode: "custom",
    models: ["vendor/model-a"],
    modelsPath: "/models",
    customModels: ["vendor/model-a"]
  });
  registry.markTest(providerB.id, { status: "passed" });
  const routingGroup = await service.createRoutingRuleGroup({
    name: "Interactive traffic",
    rules: [{ models: ["model-a"], providerIds: [providerB.id, providerA.id] }]
  });
  await service.setActiveRoutingRuleGroup(routingGroup.id);

  const configured = await service.previewRoute("model-a");
  assert.equal(configured.source, "configured");
  assert.equal(configured.route, "custom");
  assert.equal(configured.customPrimaryProviderId, providerB.id);
  assert.deepEqual(configured.routingRule, {
    groupId: routingGroup.id,
    groupName: "Interactive traffic",
    providerIds: [providerB.id, providerA.id]
  });
  assert.deepEqual(configured.candidates[0].mappingGroup, {
    id: mappingGroup.id,
    name: "Provider B aliases"
  });
  assert.equal(configured.candidates[0].targetModel, "vendor/model-a");

  workerManager.phase = "running";
  workerManager.generation = 7;
  workerManager.preview = {
    source: "live",
    generation: 7,
    evaluatedAt: "2030-01-01T00:00:00.000Z",
    route: "custom",
    reason: "custom_only",
    account: {
      enabled: false,
      selected: false,
      reason: "custom_only",
      fallbackAvailable: true
    },
    matchedPriorityRule: true,
    customPrimaryProviderId: providerB.id,
    candidates: [{
      providerId: providerB.id,
      providerName: "Provider B",
      weight: 100,
      targetModel: "vendor/model-a",
      transformation: "mapping",
      availability: "ready",
      coolingUntil: null,
      order: 1
    }]
  };
  const live = await service.previewRoute("model-a");
  assert.equal(live.source, "live");
  assert.equal(live.generation, 7);
  assert.equal(live.routingRule.groupName, "Interactive traffic");
  assert.equal(live.candidates[0].mappingGroup.name, "Provider B aliases");
  assert.deepEqual(workerManager.calls.at(-1), ["previewRoute", "model-a"]);

  const sentinel = "route-preview-secret-sentinel";
  await assert.rejects(
    service.previewRoute(` ${sentinel}`),
    (error) => {
      assert.equal(String(error?.message).includes(sentinel), false);
      return error?.code === "ROUTE_PREVIEW_INPUT_INVALID" && error.status === 400;
    }
  );
});

test("a failed live compatibility probe does not invalidate the running provider snapshot", async (t) => {
  const { service, registry, workerManager } = makeHarness(t, {
    fetchImpl: async () => ({ ok: false, status: 503 })
  });
  const provider = await service.createProvider(
    providerInput("Running provider"),
    makeSecret("running-provider")
  );
  registry.markTest(provider.id, { status: "passed" });
  workerManager.phase = "running";

  const result = await service.testProvider(provider.id, "model-test");
  assert.deepEqual(result, {
    ok: false,
    code: "PROVIDER_TEST_HTTP",
    initialActivation: null
  });
  assert.equal(registry.get(provider.id).lastTestStatus, "passed");
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

test("CRUD compensates credential changes and permits stopped active-provider deletion", async (t) => {
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
  const deletedPrimary = await service.deleteProvider(primary.id);
  assert.equal(deletedPrimary.id, primary.id);
  assert.equal(registry.getDocument().activeProviderId, null);
  assert.equal(credentials.values.has("credential-1"), false);
  assert.ok(credentials.operations.some(([action]) => action === "delete"));
  assert.deepEqual(
    activity.events.filter((entry) => entry.result === "failed")
      .map((entry) => [entry.action, entry.errorCode]),
    [
      ["create", "PROVIDER_NAME_CONFLICT"],
      ["update", "PROVIDER_NAME_CONFLICT"],
      ["delete", "PROVIDER_REGISTRY_WRITE_FAILED"]
    ]
  );
  assert.equal(JSON.stringify(activity.events).includes(oldSecret), false);
  assert.equal(JSON.stringify(activity.events).includes(replacementSecret), false);
});

test("updates a stopped active provider without starting the Worker", async (t) => {
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

  const updated = await service.updateProvider(
    provider.id,
    { name: "Changed safely" },
    makeSecret()
  );
  assert.equal(updated.name, "Changed safely");
  assert.ok(credentials.operations.length > 0);
  assert.equal(updateCalls, 1);
  assert.equal(markTestCalls, 1);
  assert.equal(registry.get(provider.id).name, "Changed safely");
  assert.equal(activity.events.at(-1).action, "update");
  assert.equal(activity.events.at(-1).result, "success");
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
  const { service, registry, credentials, workerManager } = makeHarness(t, {
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
    code: null,
    initialActivation: null
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
  assert.equal(registry.getDocument().activeProviderId, null);
  assert.deepEqual(workerManager.calls, []);

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
      code,
      initialActivation: null
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
    code: "PROVIDER_TEST_REDIRECT",
    initialActivation: null
  });
  assert.equal(firstRequests.length, 1);
  assert.equal(firstRequests[0].headers["x-private-auth"], `Token ${secret}`);
  assert.equal(secondRequests.length, 0);
  assert.equal(JSON.stringify(activity.events).includes(secret), false);
});

test("model discovery reads cache and refreshes a bounded authenticated catalog without lifecycle changes", async (t) => {
  const secret = makeSecret("models");
  const requests = [];
  const harness = makeHarness(t, {
    fetchImpl: async (...args) => {
      requests.push(args);
      return modelListResponse(["model-b", "model-a", "model-b"], { status: 206 });
    }
  });
  const { service, registry, workerManager, modelCache } = harness;
  const provider = await service.createProvider({
    ...providerInput("Models", "https://provider.example/root/v1"),
    authHeader: "x-provider-auth",
    authScheme: "Token",
    extraHeaders: { "x-region": "test" }
  }, secret);
  await service.setProviderSupportedModels(provider.id, {
    mode: "auto",
    models: [],
    modelsPath: "/catalog/list",
    customModels: []
  });
  const before = registry.getDocument();

  assert.deepEqual(
    await service.getProviderModels(provider.id),
    expectedModelCatalog(provider.id, { modelsPath: "/catalog/list" })
  );
  const refreshed = await service.refreshProviderModels(provider.id);
  assert.deepEqual(refreshed, expectedModelCatalog(provider.id, {
    state: "fresh",
    fetchedAt: NOW,
    expiresAt: "2026-07-14T02:00:00.000Z",
    modelsPath: "/catalog/list",
    discoveredModels: ["model-b", "model-a"]
  }));
  assert.deepEqual(await service.getProviderModels(provider.id), refreshed);

  const [url, options] = requests[0];
  assert.equal(url, "https://provider.example/root/v1/catalog/list");
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "manual");
  assert.equal(options.body, undefined);
  assert.equal(options.headers["x-provider-auth"], `Token ${secret}`);
  assert.equal(options.headers["x-region"], "test");
  assert.ok(options.signal);
  assert.equal(modelCache.putCalls.length, 1);
  assert.equal(typeof modelCache.putCalls[0].sourceFingerprint, "string");
  assert.notEqual(modelCache.putCalls[0].sourceFingerprint.length, 0);
  assert.equal(modelCache.putCalls[0].sourceFingerprint.includes(secret), false);
  assert.deepEqual(modelCache.putCalls[0].models, ["model-b", "model-a"]);
  assert.deepEqual(registry.getDocument(), before);
  assert.deepEqual(workerManager.calls, []);
});

test("model refresh classifies failures, enforces bounds, and preserves the last good cache", async (t) => {
  const secret = makeSecret("models-failure");
  let nextFetch;
  const harness = makeHarness(t, {
    fetchImpl: async () => await nextFetch()
  });
  const { service, registry, workerManager, modelCache } = harness;
  const provider = await service.createProvider(providerInput(), secret);
  await service.getProviderModels(provider.id);
  const sourceFingerprint = modelCache.getCalls.at(-1)[1];
  const stale = {
    providerId: provider.id,
    sourceFingerprint,
    state: "stale",
    fetchedAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2026-07-12T00:00:00.000Z",
    models: ["last-good-model"]
  };
  modelCache.seed(stale);
  const before = registry.getDocument();
  const tooMany = Array.from({ length: 2_001 }, (_, index) => `model-${index}`);
  const tooLong = "m".repeat(257);
  const oversizedBody = JSON.stringify({
    object: "list",
    data: [{ id: "m".repeat(1_048_576), object: "model" }]
  });
  const scenarios = [
    ["PROVIDER_MODELS_REDIRECT", async () => new Response(null, { status: 302 })],
    ["PROVIDER_MODELS_AUTH", async () => new Response(null, { status: 401 })],
    ["PROVIDER_MODELS_NOT_FOUND", async () => new Response(null, { status: 404 })],
    ["PROVIDER_MODELS_HTTP", async () => new Response(null, { status: 503 })],
    ["PROVIDER_MODELS_INVALID_JSON", async () => new Response("{", { status: 200 })],
    ["PROVIDER_MODELS_INVALID_RESPONSE", async () => modelListResponse([], {
      payload: { object: "list", data: [{ object: "model" }] }
    })],
    ["PROVIDER_MODELS_INVALID_RESPONSE", async () => modelListResponse([tooLong])],
    ["PROVIDER_MODELS_INVALID_RESPONSE", async () => modelListResponse(tooMany)],
    ["PROVIDER_MODELS_RESPONSE_TOO_LARGE", async () => new Response(oversizedBody, { status: 200 })],
    ["PROVIDER_MODELS_DNS", async () => { const error = new Error(secret); error.code = "ENOTFOUND"; throw error; }],
    ["PROVIDER_MODELS_TLS", async () => { const error = new Error(secret); error.code = "CERT_HAS_EXPIRED"; throw error; }],
    ["PROVIDER_MODELS_TIMEOUT", async () => { const error = new Error(secret); error.name = "TimeoutError"; throw error; }],
    ["PROVIDER_MODELS_NETWORK", async () => { throw new Error(secret); }]
  ];

  for (const [code, fetchScenario] of scenarios) {
    nextFetch = fetchScenario;
    await assert.rejects(
      () => service.refreshProviderModels(provider.id),
      (error) => error?.code === code
    );
    const cached = await service.getProviderModels(provider.id);
    assert.deepEqual(cached, expectedModelCatalog(provider.id, {
      state: "stale",
      fetchedAt: stale.fetchedAt,
      expiresAt: stale.expiresAt,
      discoveredModels: stale.models
    }));
  }
  assert.equal(modelCache.putCalls.length, 0);
  assert.deepEqual(registry.getDocument(), before);
  assert.deepEqual(workerManager.calls, []);
});

test("model refresh reports committed degradation when Activity fails after the cache commit", async (t) => {
  let fetchCalls = 0;
  const { service, activity, modelCache } = makeHarness(t, {
    fetchImpl: async () => {
      fetchCalls += 1;
      return modelListResponse(["model-a", "model-b"]);
    }
  });
  const provider = await service.createProvider(
    providerInput(),
    makeSecret("models-committed")
  );
  const originalAppend = activity.append.bind(activity);
  activity.append = () => {
    throw new Error("forced Activity append failure after model cache commit");
  };

  const failure = await service.refreshProviderModels(provider.id).then(
    () => null,
    (error) => error
  );

  assert.notEqual(failure?.code, "PROVIDER_MODELS_NETWORK");
  assert.equal(failure?.code, "PROVIDER_MODELS_COMMITTED_DEGRADED");
  assert.deepEqual(failure?.details, { committed: true, degraded: true });
  assert.equal(modelCache.putCalls.length, 1);
  assert.deepEqual(await service.getProviderModels(provider.id), expectedModelCatalog(provider.id, {
    state: "fresh",
    fetchedAt: NOW,
    expiresAt: "2026-07-14T02:00:00.000Z",
    discoveredModels: ["model-a", "model-b"]
  }));
  assert.equal(fetchCalls, 1);
  await service.getProviderModels(provider.id);
  assert.equal(fetchCalls, 1);
  activity.append = originalAppend;
});

test("model refresh preserves cache-lock repair guidance after a committed cache put", async (t) => {
  const cacheRepairAction = "Stop CRP, repair the residual model-cache lock, then restart CRP.";
  const { service, modelCache } = makeHarness(t, {
    fetchImpl: async () => modelListResponse(["model-a"])
  });
  const provider = await service.createProvider(
    providerInput(),
    makeSecret("models-cache-lock")
  );
  const originalPut = modelCache.put.bind(modelCache);
  modelCache.put = (entry) => {
    originalPut(entry);
    throw committedError(
      "PROVIDER_MODEL_CACHE_COMMITTED_LOCK_DEGRADED",
      cacheRepairAction
    );
  };

  const failure = await service.refreshProviderModels(provider.id).then(
    () => null,
    (error) => error
  );

  assert.equal(failure?.code, "PROVIDER_MODELS_COMMITTED_DEGRADED");
  assert.deepEqual(failure?.details, { committed: true, degraded: true });
  assert.equal(failure?.action, cacheRepairAction);
  assert.doesNotMatch(failure?.action ?? "", /Activity/i);
  assert.deepEqual(await service.getProviderModels(provider.id), expectedModelCatalog(provider.id, {
    state: "fresh",
    fetchedAt: NOW,
    expiresAt: "2026-07-14T02:00:00.000Z",
    discoveredModels: ["model-a"]
  }));
});

test("model discovery rejects credential-bearing model ids before any public or cached projection", async (t) => {
  const secret = makeSecret("models-id-credential");
  const { service, registry, activity, modelCache } = makeHarness(t, {
    fetchImpl: async () => modelListResponse([`prefix-${secret}-suffix`])
  });
  const provider = await service.createProvider(providerInput(), secret);
  await service.getProviderModels(provider.id);
  const sourceFingerprint = modelCache.getCalls.at(-1)[1];
  const previous = {
    providerId: provider.id,
    sourceFingerprint,
    state: "stale",
    fetchedAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2026-07-12T00:00:00.000Z",
    models: ["last-good-model"]
  };
  modelCache.seed(previous);

  const failure = await service.refreshProviderModels(provider.id).then(
    () => null,
    (error) => error
  );
  const cached = await service.getProviderModels(provider.id);
  const publicError = failure === null ? null : toPublicError(failure, "request-models-safe");
  const publicProviders = await service.listProviders();
  const publicStatus = await service.getStatus();
  const reachable = JSON.stringify({
    publicError,
    cached,
    publicProviders,
    publicStatus,
    activity: activity.events
  });

  assert.equal(reachable.includes(secret), false);
  assert.equal(failure?.message?.includes(secret) ?? false, false);
  assert.equal(failure?.action?.includes(secret) ?? false, false);
  assert.equal(failure?.cause?.message?.includes(secret) ?? false, false);
  assert.equal(failure?.code, "PROVIDER_MODELS_INVALID_RESPONSE");
  assert.deepEqual(cached, expectedModelCatalog(provider.id, {
    state: "stale",
    fetchedAt: previous.fetchedAt,
    expiresAt: previous.expiresAt,
    discoveredModels: previous.models
  }));
  assert.equal(modelCache.putCalls.length, 0);
  assert.equal(registry.getDocument().activeProviderId, null);
});

test("successful opt-in tests select the first provider without starting the Worker", async (t) => {
  const secret = makeSecret("initial-activation");
  const { service, registry, workerManager } = makeHarness(t, {
    fetchImpl: async () => compatibleResponse()
  });
  const provider = await service.createProvider(providerInput(), secret);

  const before = workerManager.getPublicState();
  const result = await service.testProvider(provider.id, "model-test", {
    activateIfNone: true
  });

  assert.deepEqual(result, {
    ok: true,
    code: null,
    initialActivation: {
      automatic: true,
      activeProviderId: provider.id,
      workerStarted: false
    }
  });
  assert.equal(registry.get(provider.id).lastTestStatus, "passed");
  assert.equal(registry.getDocument().activeProviderId, provider.id);
  assert.deepEqual(workerManager.calls, []);
  assert.equal(workerManager.getPublicState().phase, "stopped");
  assert.equal(workerManager.getPublicState().generation, before.generation);
});

test("legacy controlled model overrides remain startable after initial selection", async (t) => {
  const { root, service, registry, workerManager } = makeHarness(t, {
    fetchImpl: async () => compatibleResponse()
  });
  const provider = await service.createProvider({
    ...providerInput(),
    modelMode: "override",
    modelOverride: "legacy-model"
  }, makeSecret("legacy-model"));
  const registryPath = join(root, "providers.json");
  const document = JSON.parse(readFileSync(registryPath, "utf8"));
  document.providers[0].modelOverride = "legacy\tmodel";
  writeFileSync(registryPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });

  const tested = await service.testProvider(provider.id, "model-test", { activateIfNone: true });
  assert.equal(tested.ok, true);
  assert.equal(registry.getDocument().activeProviderId, provider.id);
  assert.equal(workerManager.getPublicState().phase, "stopped");

  await service.startProxy();
  assert.equal(workerManager.calls.at(-1)[0], "start");
  assert.equal(workerManager.calls.at(-1)[1].settings.proxy.modelOverride, "legacy\tmodel");
  assert.deepEqual(workerManager.calls.at(-1)[1].settings.routing, {
    mode: "custom_only",
    accountRevision: 1,
    account: {
      authMode: null,
      quotaStatus: "unknown",
      blockedUntil: null,
      updatedAt: null
    },
    providerPriorityRules: []
  });

  await service.restartProxy();
  assert.equal(workerManager.calls.at(-1)[0], "restart");
  assert.equal(workerManager.calls.at(-1)[1].settings.proxy.modelOverride, "legacy\tmodel");
});

test("provider test reports committed degradation when Activity fails after markTest", async (t) => {
  let fetchCalls = 0;
  const { service, registry, activity, workerManager } = makeHarness(t, {
    fetchImpl: async () => {
      fetchCalls += 1;
      return compatibleResponse();
    }
  });
  const provider = await service.createProvider(
    providerInput(),
    makeSecret("test-committed")
  );
  const originalAppend = activity.append.bind(activity);
  activity.append = () => {
    throw new Error("forced Activity append failure after provider test commit");
  };

  const failure = await service.testProvider(provider.id, "model-test", {
    activateIfNone: true
  }).then(
    () => null,
    (error) => error
  );

  assert.equal(failure?.code, "PROVIDER_TEST_COMMITTED_DEGRADED");
  assert.deepEqual(failure?.details, { committed: true, degraded: true });
  assert.equal(registry.get(provider.id).lastTestStatus, "passed");
  assert.equal(registry.get(provider.id).lastTestCode, null);
  assert.equal(registry.getDocument().activeProviderId, null);
  assert.deepEqual(workerManager.calls, []);

  activity.append = originalAppend;
  const retried = await service.testProvider(provider.id, "model-test", {
    activateIfNone: true
  });
  assert.deepEqual(retried.initialActivation, {
    automatic: true,
    activeProviderId: provider.id,
    workerStarted: false
  });
  assert.equal(registry.getDocument().activeProviderId, provider.id);
  assert.deepEqual(workerManager.calls, []);
  assert.equal(fetchCalls, 2);
});

test("provider test preserves registry-lock repair guidance after a committed markTest", async (t) => {
  const registryRepairAction = "Stop CRP, repair the residual provider-registry lock, then restart CRP.";
  const { service, registry, workerManager } = makeHarness(t, {
    fetchImpl: async () => compatibleResponse()
  });
  const provider = await service.createProvider(
    providerInput(),
    makeSecret("test-registry-lock")
  );
  const originalMarkTest = registry.markTest.bind(registry);
  registry.markTest = (id, result) => {
    originalMarkTest(id, result);
    throw committedError(
      "PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED",
      registryRepairAction
    );
  };

  const failure = await service.testProvider(provider.id, "model-test", {
    activateIfNone: true
  }).then(
    () => null,
    (error) => error
  );

  assert.equal(failure?.code, "PROVIDER_TEST_COMMITTED_DEGRADED");
  assert.deepEqual(failure?.details, { committed: true, degraded: true });
  assert.equal(failure?.action, registryRepairAction);
  assert.doesNotMatch(failure?.action ?? "", /Activity/i);
  assert.equal(registry.get(provider.id).lastTestStatus, "passed");
  assert.equal(registry.get(provider.id).lastTestCode, null);
  assert.equal(registry.getDocument().activeProviderId, null);
  assert.deepEqual(workerManager.calls, []);
});

test("committed initial selection survives a simultaneous Activity append failure", async (t) => {
  const registryRepairAction = "Stop CRP, repair the residual provider-registry lock, then restart CRP.";
  const { service, registry, activity, workerManager } = makeHarness(t, {
    fetchImpl: async () => compatibleResponse()
  });
  const provider = await service.createProvider(
    providerInput(),
    makeSecret("initial-selection-double-failure")
  );
  const originalSetActiveIfNull = registry.setActiveIfNull.bind(registry);
  registry.setActiveIfNull = (id) => {
    originalSetActiveIfNull(id);
    throw committedError(
      "PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED",
      registryRepairAction
    );
  };
  const originalAppend = activity.append.bind(activity);
  activity.append = (event) => {
    if (event.action === "activate") {
      throw new Error("forced Activity append failure after committed initial selection");
    }
    return originalAppend(event);
  };

  const failure = await service.testProvider(provider.id, "model-test", {
    activateIfNone: true
  }).then(
    () => null,
    (error) => error
  );

  assert.equal(failure?.code, "PROVIDER_ACTIVATION_COMMITTED_DEGRADED");
  assert.deepEqual(failure?.details, { committed: true, degraded: true });
  assert.equal(failure?.action, registryRepairAction);
  assert.equal(registry.getDocument().activeProviderId, provider.id);
  assert.equal(registry.get(provider.id).lastTestStatus, "passed");
  assert.deepEqual(workerManager.calls, []);
  assert.equal(activity.events.some((event) => event.action === "activate"), false);
  assert.equal(activity.events.at(-1).action, "test");
});

test("opt-in tests never replace an existing active provider", async (t) => {
  const { service, registry, workerManager } = makeHarness(t, {
    fetchImpl: async () => compatibleResponse()
  });
  const active = await service.createProvider(providerInput("Active"), makeSecret("active"));
  const candidate = await service.createProvider(
    providerInput("Candidate", "https://candidate.example/v1"),
    makeSecret("candidate")
  );
  registry.setActive(active.id);

  assert.deepEqual(
    await service.testProvider(candidate.id, "model-test", { activateIfNone: true }),
    { ok: true, code: null, initialActivation: null }
  );
  assert.equal(registry.getDocument().activeProviderId, active.id);
  assert.equal(registry.get(candidate.id).lastTestStatus, "passed");
  assert.deepEqual(workerManager.calls, []);
});

test("failed opt-in tests do not select a provider", async (t) => {
  const { service, registry, workerManager } = makeHarness(t, {
    fetchImpl: async () => ({ ok: false, status: 401 })
  });
  const provider = await service.createProvider(providerInput(), makeSecret("failed"));

  assert.deepEqual(
    await service.testProvider(provider.id, "model-test", { activateIfNone: true }),
    { ok: false, code: "PROVIDER_TEST_AUTH", initialActivation: null }
  );
  assert.equal(registry.get(provider.id).lastTestStatus, "failed");
  assert.equal(registry.getDocument().activeProviderId, null);
  assert.deepEqual(workerManager.calls, []);
});

test("opt-in tests reject an active-null state with a non-stopped Worker before I/O", async (t) => {
  let fetchCalls = 0;
  const { service, registry, credentials, workerManager } = makeHarness(t, {
    fetchImpl: async () => {
      fetchCalls += 1;
      return compatibleResponse();
    }
  });
  const provider = await service.createProvider(providerInput(), makeSecret("unsafe"));
  credentials.operations.length = 0;
  workerManager.phase = "running";
  workerManager.generation = 7;

  await assert.rejects(
    () => service.testProvider(provider.id, "model-test", { activateIfNone: true }),
    (error) => error?.code === "PROVIDER_INITIAL_ACTIVATION_UNSAFE"
      && error.status === 409
  );
  assert.equal(fetchCalls, 0);
  assert.deepEqual(credentials.operations, []);
  assert.equal(registry.get(provider.id).lastTestStatus, "untested");
  assert.equal(registry.getDocument().activeProviderId, null);
  assert.deepEqual(workerManager.calls, []);
  assert.equal(workerManager.getPublicState().generation, 7);
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
    {
      ...providerInput("B", "https://b.example/v1"),
      modelMode: "override",
      modelOverride: "model-b"
    },
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
  assert.equal(workerManager.calls[0][1].providerId, providerA.id);
  assert.equal(workerManager.calls[0][1].generation, 1);
  assert.equal(workerManager.calls[0][1].settings.upstream.apiKey, secretA);
  assert.deepEqual(workerManager.calls[0][1].settings.proxy, {
    overrideAuthorization: true,
    requestIdHeader: "x-client-request-id",
    modelMode: "passthrough",
    modelOverride: null,
    modelMappings: []
  });
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
  assert.equal(workerManager.calls.at(-1)[1].providerId, providerB.id);
  assert.equal(workerManager.calls.at(-1)[1].settings.upstream.apiKey, secretB);
  assert.equal(workerManager.calls.at(-1)[1].settings.proxy.modelMode, "override");
  assert.equal(workerManager.calls.at(-1)[1].settings.proxy.modelOverride, "model-b");
  const credentialGets = credentials.operations
    .filter(([operation]) => operation === "get")
    .map(([, ref]) => ref);
  assert.deepEqual(credentialGets, [
    "credential-1",
    "credential-2",
    "credential-1",
    "credential-2",
    "credential-1"
  ]);
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
    [["get", "credential-1"], ["get", "credential-2"]]
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
    [
      ["get", "credential-1"],
      ["get", "credential-2"],
      ["get", "credential-2"],
      ["get", "credential-1"]
    ]
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
    snapshot.providerId,
    snapshot.generation,
    snapshot.settings.upstream.apiKey
  ]), [
    ["applySnapshot", providerB.id, 2, secretB],
    ["applySnapshot", providerA.id, 3, secretA]
  ]);
  assert.deepEqual(
    credentials.operations.filter(([operation]) => operation === "get"),
    [["get", "credential-2"], ["get", "credential-1"]]
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
  assert.equal(workerManager.calls.at(-1)[1].providerId, providerA.id);
  assert.equal(workerManager.calls.at(-1)[1].settings.upstream.apiKey, secretA);

  const restarted = await service.restartProxy();
  assert.equal(restarted.phase, "running");
  assert.equal(restarted.generation, 3);
  assert.equal(workerManager.calls.at(-1)[0], "restart");
  assert.equal(workerManager.calls.at(-1)[1].providerId, providerA.id);
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

test("routing mode persists without starting a stopped Worker", async (t) => {
  const { service, registry, workerManager, activity } = makeHarness(t);

  const result = await service.setRoutingMode("account_first");

  assert.equal(result.routingMode, "account_first");
  assert.equal(result.worker.phase, "stopped");
  assert.equal(registry.getDocument().settings.routingMode, "account_first");
  assert.deepEqual(workerManager.calls, []);
  assert.deepEqual(
    activity.events.map(({ category, action, result: eventResult }) => ({
      category,
      action,
      result: eventResult
    })),
    [{ category: "settings", action: "routing-mode", result: "success" }]
  );
});

test("routing mode hot-applies an increasing Worker generation", async (t) => {
  const { root, service, registry, workerManager } = makeHarness(t);
  const provider = await service.createProvider(providerInput(), makeSecret("routing-hot"));
  registry.markTest(provider.id, { status: "passed" });
  registry.setActive(provider.id);
  await service.startProxy();
  workerManager.calls.length = 0;

  const result = await service.setRoutingMode("account_first");

  assert.equal(result.routingMode, "account_first");
  assert.equal(result.generation, 2);
  assert.deepEqual(workerManager.calls.map(([operation]) => operation), ["applySnapshot"]);
  assert.equal(workerManager.calls[0][1].settings.routing.mode, "account_first");
  assert.equal(workerManager.calls[0][1].generation, 2);
  assert.equal(registry.getDocument().settings.routingMode, "account_first");
});

test("routing mode restores persisted and Worker state after an uncertain apply failure", async (t) => {
  const { service, registry, workerManager } = makeHarness(t);
  const provider = await service.createProvider(providerInput(), makeSecret("routing-rollback"));
  registry.markTest(provider.id, { status: "passed" });
  registry.setActive(provider.id);
  await service.startProxy();
  workerManager.calls.length = 0;
  const apply = workerManager.applySnapshot.bind(workerManager);
  let attempts = 0;
  workerManager.applySnapshot = async (snapshot) => {
    attempts += 1;
    const state = await apply(snapshot);
    if (attempts === 1) throw new Error("candidate acknowledgement lost");
    return state;
  };

  await assert.rejects(
    () => service.setRoutingMode("account_first"),
    (error) => error?.code === "ROUTING_MODE_UPDATE_FAILED"
  );

  assert.equal(registry.getDocument().settings.routingMode, "custom_only");
  assert.equal(workerManager.generation, 3);
  assert.deepEqual(
    workerManager.calls.map(([operation, snapshot]) => [
      operation,
      snapshot.settings.routing.mode,
      snapshot.generation
    ]),
    [
      ["applySnapshot", "account_first", 2],
      ["applySnapshot", "custom_only", 3]
    ]
  );
});

test("provider weights order the runtime pool and hot-apply without changing the preferred provider", async (t) => {
  const { service, registry, workerManager, activity } = makeHarness(t);
  const providerA = await service.createProvider(
    { ...providerInput("Preferred"), weight: 100 },
    makeSecret("preferred")
  );
  const providerB = await service.createProvider(
    { ...providerInput("Higher", "https://higher.example/v1"), weight: 300 },
    makeSecret("higher")
  );
  registry.markTest(providerA.id, { status: "passed" });
  registry.markTest(providerB.id, { status: "passed" });
  registry.setActive(providerA.id);

  await service.startProxy();
  assert.equal(registry.getDocument().activeProviderId, providerA.id);
  assert.equal(workerManager.calls.at(-1)[1].providerId, providerB.id);
  assert.deepEqual(
    workerManager.calls.at(-1)[1].settings.providers.map(({ id, weight }) => ({ id, weight })),
    [
      { id: providerB.id, weight: 300 },
      { id: providerA.id, weight: 100 }
    ]
  );
  workerManager.calls.length = 0;

  const updated = await service.setProviderWeight(providerA.id, 500);
  assert.equal(updated.weight, 500);
  assert.equal(registry.getDocument().activeProviderId, providerA.id);
  assert.equal(registry.get(providerA.id).weight, 500);
  assert.deepEqual(workerManager.calls.map(([operation]) => operation), ["applySnapshot"]);
  assert.equal(workerManager.calls[0][1].generation, 2);
  assert.equal(workerManager.calls[0][1].providerId, providerA.id);
  assert.deepEqual(
    workerManager.calls[0][1].settings.providers.map(({ id, weight }) => ({ id, weight })),
    [
      { id: providerA.id, weight: 500 },
      { id: providerB.id, weight: 300 }
    ]
  );
  assert.deepEqual(activity.events.at(-1), {
    category: "provider",
    action: "weight",
    providerId: providerA.id,
    result: "success",
    errorCode: null,
    details: { weight: 500, generation: 2 }
  });
});

test("reports a committed provider-weight update without rolling back durable state", async (t) => {
  const { service, registry, workerManager, activity } = makeHarness(t);
  const provider = await service.createProvider(providerInput(), makeSecret("weight"));
  const update = registry.setProviderWeightIfCurrent.bind(registry);
  registry.setProviderWeightIfCurrent = (...argumentsList) => {
    const result = update(...argumentsList);
    throw new CrpError(
      "PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED",
      "Saved with a residual lock.",
      "Repair the registry lock.",
      { status: 500, details: { committed: true } }
    );
  };

  await assert.rejects(
    () => service.setProviderWeight(provider.id, 250),
    (error) => error?.code === "PROVIDER_WEIGHT_COMMITTED_DEGRADED"
      && error.details.committed === true
      && error.details.degraded === true
  );
  assert.equal(registry.get(provider.id).weight, 250);
  assert.deepEqual(workerManager.calls, []);
  assert.deepEqual(activity.events.at(-1), {
    category: "provider",
    action: "weight",
    providerId: provider.id,
    result: "degraded",
    errorCode: "PROVIDER_WEIGHT_COMMITTED_DEGRADED",
    details: { weight: 250, generation: 0 }
  });
});

test("Capture setting persists while stopped and hot-applies to a running Worker", async (t) => {
  const { service, registry, workerManager, activity } = makeHarness(t);
  const stopped = await service.setCaptureEnabled(true);
  assert.equal(stopped.captureEnabled, true);
  assert.equal(registry.getDocument().settings.captureEnabled, true);
  assert.deepEqual(workerManager.calls, []);
  const detailStopped = await service.setCaptureDetailsEnabled(true);
  assert.equal(detailStopped.captureDetailsEnabled, true);
  assert.equal(registry.getDocument().settings.captureDetailsEnabled, true);

  const provider = await service.createProvider(providerInput(), makeSecret("capture"));
  registry.markTest(provider.id, { status: "passed" });
  registry.setActive(provider.id);
  await service.startProxy();
  workerManager.calls.length = 0;

  const running = await service.setCaptureEnabled(false);
  assert.equal(running.captureEnabled, false);
  assert.equal(running.generation, 2);
  assert.equal(registry.getDocument().settings.captureEnabled, false);
  assert.deepEqual(workerManager.calls.map(([operation]) => operation), ["applySnapshot"]);
  assert.equal(workerManager.calls[0][1].settings.capture.enabled, false);
  assert.equal(workerManager.calls[0][1].settings.capture.detailsEnabled, false);
  assert.equal(registry.getDocument().settings.captureDetailsEnabled, false);
  assert.deepEqual(
    activity.events.filter(({ category, action }) => category === "settings" && action === "capture")
      .map(({ result, details }) => ({ result, details })),
    [
      { result: "success", details: { enabled: true, generation: 0 } },
      { result: "success", details: { enabled: false, generation: 2 } }
    ]
  );
});

test("Capture disable rollback restores details and Worker snapshot atomically", async (t) => {
  const { service, registry, workerManager } = makeHarness(t);
  await service.setCaptureEnabled(true);
  await service.setCaptureDetailsEnabled(true);
  const provider = await service.createProvider(providerInput(), makeSecret("capture-rollback"));
  registry.markTest(provider.id, { status: "passed" });
  registry.setActive(provider.id);
  await service.startProxy();
  workerManager.failure = new Error("injected capture apply failure");
  workerManager.failureOnce = true;
  await assert.rejects(() => service.setCaptureEnabled(false), {
    code: "CAPTURE_SETTING_UPDATE_FAILED"
  });
  assert.equal(registry.getDocument().settings.captureEnabled, true);
  assert.equal(registry.getDocument().settings.captureDetailsEnabled, true);
  const rollback = workerManager.calls.at(-1)[1];
  assert.equal(rollback.settings.capture.enabled, true);
  assert.equal(rollback.settings.capture.detailsEnabled, true);
});

test("Capture details hot-applies while running", async (t) => {
  const { service, registry, workerManager, activity } = makeHarness(t);
  await service.setCaptureEnabled(true);
  const provider = await service.createProvider(providerInput(), makeSecret("capture-details"));
  registry.markTest(provider.id, { status: "passed" });
  registry.setActive(provider.id);
  await service.startProxy();
  workerManager.calls.length = 0;

  const result = await service.setCaptureDetailsEnabled(true);
  assert.equal(result.captureDetailsEnabled, true);
  assert.equal(result.generation, 2);
  assert.equal(registry.getDocument().settings.captureDetailsEnabled, true);
  assert.deepEqual(workerManager.calls.map(([operation]) => operation), ["applySnapshot"]);
  assert.equal(workerManager.calls[0][1].settings.capture.enabled, true);
  assert.equal(workerManager.calls[0][1].settings.capture.detailsEnabled, true);
  assert.deepEqual(activity.events.at(-1), {
    category: "settings",
    action: "capture-details",
    providerId: null,
    result: "success",
    errorCode: null,
    details: { enabled: true, generation: 2 }
  });
});

test("Capture details rollback preserves an unrelated concurrent Registry update", async (t) => {
  const { service, registry, workerManager, activity } = makeHarness(t);
  await service.setCaptureEnabled(true);
  const provider = await service.createProvider(providerInput(), makeSecret("capture-details-cas"));
  registry.markTest(provider.id, { status: "passed" });
  registry.setActive(provider.id);
  await service.startProxy();
  workerManager.calls.length = 0;
  const applySnapshot = workerManager.applySnapshot.bind(workerManager);
  let attempts = 0;
  workerManager.applySnapshot = async (snapshot) => {
    attempts += 1;
    if (attempts === 1) {
      workerManager.calls.push(["applySnapshot", structuredClone(snapshot)]);
      registry.setRoutingMode("account_first");
      throw new Error("injected Capture details apply failure");
    }
    return await applySnapshot(snapshot);
  };

  await assert.rejects(() => service.setCaptureDetailsEnabled(true), {
    code: "CAPTURE_DETAILS_SETTING_UPDATE_FAILED"
  });
  const settings = registry.getDocument().settings;
  assert.equal(settings.captureDetailsEnabled, false);
  assert.equal(settings.routingMode, "account_first");
  assert.equal(workerManager.calls.length, 2);
  assert.equal(workerManager.calls.at(-1)[1].settings.capture.detailsEnabled, false);
  assert.equal(workerManager.calls.at(-1)[1].settings.routing.mode, "account_first");
  assert.equal(activity.events.at(-1).errorCode, "CAPTURE_DETAILS_SETTING_UPDATE_FAILED");
});

test("Capture details wraps pre-commit failure and reports committed degradation", async (t) => {
  await t.test("pre-commit failure", async (t) => {
    const { service, registry, activity } = makeHarness(t);
    await service.setCaptureEnabled(true);
    registry.setCaptureDetailsEnabled = () => {
      throw new Error("injected Registry write failure");
    };

    await assert.rejects(() => service.setCaptureDetailsEnabled(true), {
      code: "CAPTURE_DETAILS_SETTING_UPDATE_FAILED"
    });
    assert.equal(registry.getDocument().settings.captureDetailsEnabled, false);
    assert.equal(activity.events.at(-1).errorCode, "CAPTURE_DETAILS_SETTING_UPDATE_FAILED");
  });

  await t.test("committed cleanup degradation", async (t) => {
    const { service, registry, activity } = makeHarness(t);
    await service.setCaptureEnabled(true);
    const setCaptureDetailsEnabled = registry.setCaptureDetailsEnabled.bind(registry);
    registry.setCaptureDetailsEnabled = (enabled) => {
      setCaptureDetailsEnabled(enabled);
      throw new CrpError(
        "PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED",
        "Saved with a residual lock.",
        "Repair the registry lock.",
        { status: 500, details: { committed: true } }
      );
    };

    await assert.rejects(
      () => service.setCaptureDetailsEnabled(true),
      (error) => error?.code === "CAPTURE_DETAILS_SETTING_COMMITTED_DEGRADED"
        && error.details.committed === true
        && error.details.degraded === true
    );
    assert.equal(registry.getDocument().settings.captureDetailsEnabled, true);
    assert.deepEqual(activity.events.at(-1), {
      category: "settings",
      action: "capture-details",
      providerId: null,
      result: "degraded",
      errorCode: "CAPTURE_DETAILS_SETTING_COMMITTED_DEGRADED",
      details: { enabled: true, generation: 0 }
    });
  });
});

test("API key authentication hot-applies while listen-address changes require a stopped Worker", async (t) => {
  const { root, service, registry, workerManager } = makeHarness(t);
  const provider = await service.createProvider(providerInput(), makeSecret("access-control"));
  registry.markTest(provider.id, { status: "passed" });
  registry.setActive(provider.id);
  await service.startProxy();
  workerManager.calls.length = 0;

  const enabled = await service.setApiKeyAuthEnabled(true);
  assert.equal(enabled.apiKeyAuthEnabled, true);
  assert.equal(enabled.generation, 2);
  assert.equal(registry.getDocument().settings.apiKeyAuthEnabled, true);
  assert.equal(workerManager.calls[0][0], "applySnapshot");
  assert.deepEqual(workerManager.calls[0][1].settings.access, {
    enabled: true,
    dbPath: join(root, "access-keys.sqlite3"),
    localToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  });

  await assert.rejects(() => service.setProxyHost("0.0.0.0"), {
    code: "PROXY_HOST_UPDATE_FAILED"
  });
  await service.stopProxy();
  const host = await service.setProxyHost("0.0.0.0");
  assert.deepEqual(host, { proxyHost: "0.0.0.0", apiKeyAuthEnabled: true });
  await assert.rejects(() => service.setApiKeyAuthEnabled(false), {
    code: "API_KEY_AUTH_REQUIRED"
  });
});

test("access-control commits report persistence and Activity degradation without reverting state", async (t) => {
  await t.test("Activity failure after commit", async (t) => {
    class OneShotAccessActivity extends MemoryActivity {
      failedActions = new Set();

      append(event) {
        if (["api-key-auth", "proxy-host"].includes(event.action)
          && event.result === "success"
          && !this.failedActions.has(event.action)) {
          this.failedActions.add(event.action);
          throw new Error("injected access-control Activity failure");
        }
        super.append(event);
      }
    }
    const activity = new OneShotAccessActivity();
    const { service, registry } = makeHarness(t, { activityStore: activity });

    await assert.rejects(
      () => service.setApiKeyAuthEnabled(true),
      (error) => error?.code === "API_KEY_AUTH_COMMITTED_DEGRADED"
        && error.details.committed === true
        && error.details.degraded === true
    );
    assert.equal(registry.getDocument().settings.apiKeyAuthEnabled, true);

    await assert.rejects(
      () => service.setProxyHost("0.0.0.0"),
      (error) => error?.code === "PROXY_HOST_COMMITTED_DEGRADED"
        && error.details.committed === true
        && error.details.degraded === true
    );
    assert.equal(registry.getDocument().settings.proxyHost, "0.0.0.0");
    assert.equal(registry.getDocument().settings.apiKeyAuthEnabled, true);
    assert.deepEqual(
      activity.events.map(({ action, result, errorCode }) => ({ action, result, errorCode })),
      [
        {
          action: "api-key-auth",
          result: "degraded",
          errorCode: "API_KEY_AUTH_COMMITTED_DEGRADED"
        },
        {
          action: "proxy-host",
          result: "degraded",
          errorCode: "PROXY_HOST_COMMITTED_DEGRADED"
        }
      ]
    );
  });

  await t.test("registry cleanup failure after commit", async (t) => {
    const { service, registry, activity } = makeHarness(t);
    const originalSetAuth = registry.setApiKeyAuthEnabled.bind(registry);
    registry.setApiKeyAuthEnabled = (enabled) => {
      originalSetAuth(enabled);
      throw committedError("PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED");
    };
    await assert.rejects(
      () => service.setApiKeyAuthEnabled(true),
      (error) => error?.code === "API_KEY_AUTH_COMMITTED_DEGRADED"
        && error.details.committed === true
    );
    assert.equal(registry.getDocument().settings.apiKeyAuthEnabled, true);

    const originalSetHost = registry.setProxyHost.bind(registry);
    registry.setProxyHost = (host) => {
      originalSetHost(host);
      throw committedError("PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED");
    };
    await assert.rejects(
      () => service.setProxyHost("0.0.0.0"),
      (error) => error?.code === "PROXY_HOST_COMMITTED_DEGRADED"
        && error.details.committed === true
    );
    assert.equal(registry.getDocument().settings.proxyHost, "0.0.0.0");
    assert.deepEqual(
      activity.events.map(({ action, result }) => ({ action, result })),
      [
        { action: "api-key-auth", result: "degraded" },
        { action: "proxy-host", result: "degraded" }
      ]
    );
  });
});
