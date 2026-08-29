import test from "node:test";
import assert from "node:assert/strict";
import * as realFileOperations from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

import { migrateLegacyConfiguration } from "../src/supervisor/migration.mjs";
import { ProviderRegistry } from "../src/providers/provider-registry.mjs";
import { CrpError } from "../src/shared/errors.mjs";

const NOW = "2026-07-13T01:00:00.000Z";

function makeSecret() {
  return `migration-test-${crypto.randomUUID()}`;
}

function makeHarness(t, legacyDocument) {
  const root = mkdtempSync(join(os.tmpdir(), "crp-migration-"));
  const globalHome = join(root, ".codex-remote-proxy");
  const legacyConfigPath = join(globalHome, "config.json");
  const runtimeConfigPath = join(globalHome, "node", "proxy-config.json");
  const registryPath = join(globalHome, "providers.json");
  const legacyBytes = Buffer.from(`${JSON.stringify(legacyDocument, null, 2)}\n`, "utf8");
  mkdirSync(globalHome, { recursive: true, mode: 0o700 });
  writeFileSync(legacyConfigPath, legacyBytes, { mode: 0o600 });
  chmodSync(legacyConfigPath, 0o600);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    globalHome,
    legacyConfigPath,
    runtimeConfigPath,
    registryPath,
    legacyBytes,
    paths: { globalHome, legacyConfigPath, runtimeConfigPath, registryPath }
  };
}

function writeRuntime(harness, document) {
  mkdirSync(join(harness.globalHome, "node"), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  writeFileSync(harness.runtimeConfigPath, bytes, { mode: 0o600 });
  chmodSync(harness.runtimeConfigPath, 0o600);
  return bytes;
}

class MemoryCredentialStore {
  constructor({ failSet = false, failDelete = false } = {}) {
    this.values = new Map();
    this.failSet = failSet;
    this.failDelete = failDelete;
    this.deleted = [];
  }

  async set(ref, secret) {
    if (this.failSet) throw new Error(`private credential failure ${secret}`);
    this.values.set(ref, secret);
  }

  async delete(ref) {
    this.deleted.push(ref);
    if (this.failDelete) throw new Error("private delete failure");
    return this.values.delete(ref);
  }
}

test("transactionally migrates legacy config to one untested inactive Default provider", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret,
    captureEnabled: false
  });
  const credentials = new MemoryCredentialStore();

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    now: () => NOW,
    createProviderId: () => "provider-default",
    createCredentialRef: () => "credential-opaque"
  });

  assert.deepEqual(result, { migrated: true, providerId: "provider-default" });
  assert.equal(credentials.values.get("credential-opaque"), secret);
  const registry = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.equal(registry.schemaVersion, 9);
  assert.deepEqual(registry.modelMappingGroups, []);
  assert.deepEqual(registry.routingRuleGroups, []);
  assert.equal(registry.settings.routingRuleGroupId, null);
  assert.equal(registry.providers[0].supportedModelsMode, "auto");
  assert.deepEqual(registry.providers[0].supportedModels, []);
  assert.equal(registry.providers[0].modelsPath, "/models");
  assert.deepEqual(registry.providers[0].customModels, []);
  assert.equal(registry.providers[0].modelMappingGroupId, null);
  assert.equal(registry.settings.routingMode, "custom_only");
  assert.equal(registry.activeProviderId, null);
  assert.equal(registry.providers.length, 1);
  assert.equal(registry.providers[0].name, "Default");
  assert.equal(registry.providers[0].credentialRef, "credential-opaque");
  assert.equal(registry.providers[0].weight, 100);
  assert.equal(registry.providers[0].lastTestStatus, "untested");
  assert.equal(registry.providers[0].lastTestAt, null);
  assert.equal(registry.providers[0].lastTestCode, null);
  assert.equal(readFileSync(harness.registryPath, "utf8").includes(secret), false);

  const scrubbed = JSON.parse(readFileSync(harness.legacyConfigPath, "utf8"));
  assert.equal("apiKey" in scrubbed, false);
  assert.equal(scrubbed.upstreamBaseUrl, "https://legacy.example/v1");
  const backups = readdirSync(harness.globalHome)
    .filter((name) => name.startsWith("config.json.") && name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.deepEqual(readFileSync(join(harness.globalHome, backups[0])), harness.legacyBytes);
  if (process.platform !== "win32") {
    assert.equal(lstatSync(join(harness.globalHome, backups[0])).mode & 0o777, 0o600);
  }
  const serializedResult = JSON.stringify(result);
  assert.equal(serializedResult.includes(secret), false);
  assert.equal(serializedResult.includes(backups[0]), false);
});

test("restores original bytes and removes new state when credential persistence fails", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const credentials = new MemoryCredentialStore({ failSet: true });

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      now: () => NOW,
      createProviderId: () => "provider-default",
      createCredentialRef: () => "credential-opaque"
    }),
    (error) => error?.code === "MIGRATION_FAILED"
      && !error.message.includes(secret)
      && !JSON.stringify(error.details).includes(secret)
  );

  assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
  assert.equal(existsSync(harness.registryPath), false);
  assert.deepEqual(credentials.deleted, ["credential-opaque"]);
  const backups = readdirSync(harness.globalHome)
    .filter((name) => name.startsWith("config.json.") && name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.deepEqual(readFileSync(join(harness.globalHome, backups[0])), harness.legacyBytes);
});

test("migrates the runtime flat config and scrubs every backed-up secret source", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, { captureEnabled: true });
  const runtimeBytes = writeRuntime(harness, {
    baseUrl: "https://runtime.example/v1",
    apiKey: secret,
    authHeader: "x-runtime-auth",
    authScheme: "Token",
    extraHeaders: { "x-region": "test" }
  });
  const credentials = new MemoryCredentialStore();

  await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    now: () => NOW,
    createProviderId: () => "provider-runtime",
    createCredentialRef: () => "credential-runtime"
  });

  const provider = JSON.parse(readFileSync(harness.registryPath, "utf8")).providers[0];
  assert.equal(provider.baseUrl, "https://runtime.example/v1");
  assert.equal(provider.authHeader, "x-runtime-auth");
  assert.equal(provider.authScheme, "Token");
  assert.deepEqual(provider.extraHeaders, { "x-region": "test" });
  assert.equal(provider.lastTestStatus, "untested");
  assert.equal(JSON.stringify(JSON.parse(readFileSync(harness.runtimeConfigPath))).includes(secret), false);
  assert.equal(JSON.stringify(JSON.parse(readFileSync(harness.legacyConfigPath))).includes(secret), false);
  const runtimeBackups = readdirSync(join(harness.globalHome, "node"))
    .filter((name) => name.startsWith("proxy-config.json.") && name.endsWith(".bak"));
  assert.equal(runtimeBackups.length, 1);
  assert.deepEqual(
    readFileSync(join(harness.globalHome, "node", runtimeBackups[0])),
    runtimeBytes
  );
});

test("imports divergent saved and runtime credentials as separate inactive recovery providers", async (t) => {
  const legacySecret = makeSecret();
  const runtimeSecret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://saved.example/v1",
    apiKey: legacySecret,
    captureEnabled: false
  });
  const runtimeBytes = writeRuntime(harness, {
    upstream: {
      baseUrl: "https://runtime.example/v1",
      apiKey: runtimeSecret
    }
  });
  const activity = [];
  const credentials = new MemoryCredentialStore();
  const providerIds = ["provider-runtime", "provider-saved"];
  const credentialRefs = ["credential-runtime", "credential-saved"];
  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    activityStore: {
      async append(event) { activity.push(structuredClone(event)); }
    },
    now: () => NOW,
    createProviderId: () => providerIds.shift(),
    createCredentialRef: () => credentialRefs.shift()
  });

  const registry = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  const serializedPublicState = JSON.stringify({ result, activity });
  assert.equal(serializedPublicState.includes(legacySecret), false);
  assert.equal(serializedPublicState.includes(runtimeSecret), false);
  assert.equal(serializedPublicState.includes("https://saved.example/v1"), false);
  assert.equal(serializedPublicState.includes("https://runtime.example/v1"), false);
  assert.deepEqual(result, {
    migrated: true,
    providerIds: ["provider-runtime", "provider-saved"]
  });
  assert.equal(registry.activeProviderId, null);
  assert.deepEqual(registry.providers.map(({ id, name, baseUrl, credentialRef, lastTestStatus }) => ({
    id, name, baseUrl, credentialRef, lastTestStatus
  })), [
    {
      id: "provider-runtime",
      name: "Recovered runtime",
      baseUrl: "https://runtime.example/v1",
      credentialRef: "credential-runtime",
      lastTestStatus: "untested"
    },
    {
      id: "provider-saved",
      name: "Recovered saved",
      baseUrl: "https://saved.example/v1",
      credentialRef: "credential-saved",
      lastTestStatus: "untested"
    }
  ]);
  assert.equal(credentials.values.get("credential-runtime"), runtimeSecret);
  assert.equal(credentials.values.get("credential-saved"), legacySecret);
  assert.deepEqual(activity, [{
    category: "migration",
    action: "legacy-config",
    providerId: null,
    result: "success",
    errorCode: null,
    details: {
      selectedSource: null,
      importedSources: ["runtime", "saved"],
      conflict: true,
      invalidSourceCount: 0,
      sourceCount: 2
    }
  }]);
  assert.equal(existsSync(`${harness.registryPath}.migration.lock`), false);
  assert.equal(readFileSync(harness.legacyConfigPath, "utf8").includes(legacySecret), false);
  assert.equal(readFileSync(harness.runtimeConfigPath, "utf8").includes(runtimeSecret), false);
  assert.ok(readdirSync(harness.globalHome).some((name) => name.endsWith(".bak")));
  assert.ok(readdirSync(join(harness.globalHome, "node")).some((name) => name.endsWith(".bak")));
  assert.equal(runtimeBytes.includes(runtimeSecret), true);
});

test("uses a complete runtime source while preserving malformed saved bytes", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {});
  const malformed = Buffer.from("{malformed-saved\n", "utf8");
  writeFileSync(harness.legacyConfigPath, malformed, { mode: 0o600 });
  const runtimeBytes = writeRuntime(harness, {
    upstream: {
      baseUrl: "https://runtime.example/v1",
      apiKey: secret,
      authHeader: "x-runtime-auth",
      authScheme: "Token",
      extraHeaders: { "x-region": "recovery" }
    }
  });
  const credentials = new MemoryCredentialStore();
  const activity = [];

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    activityStore: { append: async (event) => { activity.push(structuredClone(event)); } },
    now: () => NOW,
    createProviderId: () => "provider-runtime",
    createCredentialRef: () => "credential-runtime"
  });

  const registry = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  const serialized = JSON.stringify({ result, activity });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("https://runtime.example/v1"), false);
  assert.deepEqual(result, { migrated: true, providerId: "provider-runtime" });
  assert.equal(registry.providers[0].baseUrl, "https://runtime.example/v1");
  assert.equal(registry.providers[0].authHeader, "x-runtime-auth");
  assert.equal(credentials.values.get("credential-runtime"), secret);
  assert.deepEqual(readFileSync(harness.legacyConfigPath), malformed);
  assert.equal(readFileSync(harness.runtimeConfigPath, "utf8").includes(secret), false);
  assert.equal(
    readdirSync(harness.globalHome).some((name) => name.startsWith("config.json.") && name.endsWith(".bak")),
    false
  );
  assert.ok(readdirSync(join(harness.globalHome, "node"))
    .some((name) => name.startsWith("proxy-config.json.") && name.endsWith(".bak")));
  assert.equal(runtimeBytes.includes(secret), true);
  assert.deepEqual(activity[0].details, {
    selectedSource: "runtime",
    importedSources: ["runtime"],
    conflict: false,
    invalidSourceCount: 1,
    sourceCount: 2
  });
});

test("uses a complete saved source while preserving malformed runtime bytes", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://saved.example/v1",
    apiKey: secret
  });
  mkdirSync(dirname(harness.runtimeConfigPath), { recursive: true, mode: 0o700 });
  const malformed = Buffer.from("[malformed-runtime\n", "utf8");
  writeFileSync(harness.runtimeConfigPath, malformed, { mode: 0o600 });
  const credentials = new MemoryCredentialStore();

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    now: () => NOW,
    createProviderId: () => "provider-saved",
    createCredentialRef: () => "credential-saved"
  });

  assert.deepEqual(result, { migrated: true, providerId: "provider-saved" });
  assert.equal(credentials.values.get("credential-saved"), secret);
  assert.equal(readFileSync(harness.legacyConfigPath, "utf8").includes(secret), false);
  assert.deepEqual(readFileSync(harness.runtimeConfigPath), malformed);
  assert.equal(
    readdirSync(dirname(harness.runtimeConfigPath))
      .some((name) => name.startsWith("proxy-config.json.") && name.endsWith(".bak")),
    false
  );
});

test("deduplicates the same URL and credential while preserving explicit runtime auth", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://same.example/v1",
    apiKey: secret
  });
  writeRuntime(harness, {
    upstream: {
      baseUrl: "https://same.example/v1/",
      apiKey: secret,
      authHeader: "x-runtime-auth",
      authScheme: "Token",
      extraHeaders: { "x-region": "same" }
    }
  });
  const credentials = new MemoryCredentialStore();

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    now: () => NOW,
    createProviderId: () => "provider-default",
    createCredentialRef: () => "credential-default"
  });

  const registry = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.deepEqual(result, { migrated: true, providerId: "provider-default" });
  assert.equal(registry.providers.length, 1);
  assert.equal(registry.providers[0].name, "Default");
  assert.equal(registry.providers[0].authHeader, "x-runtime-auth");
  assert.equal(registry.providers[0].authScheme, "Token");
  assert.deepEqual(registry.providers[0].extraHeaders, { "x-region": "same" });
});

test("keeps explicit auth conflicts as two recovery providers", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    baseUrl: "https://same.example/v1",
    apiKey: secret,
    authHeader: "x-saved-auth",
    authScheme: "Saved"
  });
  writeRuntime(harness, {
    baseUrl: "https://same.example/v1",
    apiKey: secret,
    authHeader: "x-runtime-auth",
    authScheme: "Runtime"
  });
  const credentials = new MemoryCredentialStore();
  const providerIds = ["provider-runtime", "provider-saved"];
  const credentialRefs = ["credential-runtime", "credential-saved"];

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    now: () => NOW,
    createProviderId: () => providerIds.shift(),
    createCredentialRef: () => credentialRefs.shift()
  });

  const registry = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.deepEqual(result.providerIds, ["provider-runtime", "provider-saved"]);
  assert.deepEqual(
    registry.providers.map(({ name, authHeader, authScheme }) => ({ name, authHeader, authScheme })),
    [
      { name: "Recovered runtime", authHeader: "x-runtime-auth", authScheme: "Runtime" },
      { name: "Recovered saved", authHeader: "x-saved-auth", authScheme: "Saved" }
    ]
  );
});

test("enters fresh Setup without combining incomplete legacy sources", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, { upstreamBaseUrl: "https://saved.example/v1" });
  const runtimeBytes = writeRuntime(harness, { apiKey: secret });
  const credentials = new MemoryCredentialStore();

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials
  });

  const publicResult = JSON.stringify(result);
  assert.equal(publicResult.includes(secret), false);
  assert.deepEqual(result, { migrated: false, reason: "legacy-config-requires-setup" });
  assert.equal(existsSync(harness.registryPath), false);
  assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
  assert.deepEqual(readFileSync(harness.runtimeConfigPath), runtimeBytes);
  assert.equal(credentials.values.size, 0);
  assert.equal(readdirSync(harness.globalHome).some((name) => name.endsWith(".bak")), false);
  assert.equal(readdirSync(dirname(harness.runtimeConfigPath)).some((name) => name.endsWith(".bak")), false);
  const emptyRegistry = new ProviderRegistry({ path: harness.registryPath });
  assert.equal(emptyRegistry.getDocument().schemaVersion, 9);
  assert.deepEqual(emptyRegistry.list(), []);
  assert.equal(emptyRegistry.getActive(), null);
});

test("enters fresh Setup when one source has conflicting credential aliases", async (t) => {
  const firstSecret = makeSecret();
  const secondSecret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://saved.example/v1",
    apiKey: firstSecret,
    upstreamApiKey: secondSecret
  });
  const credentials = new MemoryCredentialStore();

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials
  });

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(firstSecret), false);
  assert.equal(serialized.includes(secondSecret), false);
  assert.deepEqual(result, { migrated: false, reason: "legacy-config-requires-setup" });
  assert.equal(existsSync(harness.registryPath), false);
  assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
});

test("rejects every present but empty or non-string legacy alias without exposing it", async (t) => {
  const secret = makeSecret();
  const cases = [
    { upstreamApiKey: 123 },
    { upstreamApiKey: "" },
    { upstream_base_url: 123 },
    { upstream_base_url: "" },
    { authHeader: 123 },
    { authHeader: "" },
    { authScheme: 123 },
    { authScheme: "" }
  ];
  for (const [index, invalid] of cases.entries()) {
    const harness = makeHarness(t, {
      upstreamBaseUrl: `https://invalid-${index}.example/v1`,
      apiKey: secret,
      ...invalid
    });
    const credentials = new MemoryCredentialStore();
    const result = await migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.deepEqual(result, { migrated: false, reason: "legacy-config-requires-setup" });
    assert.equal(existsSync(harness.registryPath), false);
    assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
  }
});

test("accepts matching root and nested aliases but rejects an internal conflict", async (t) => {
  const matchingSecret = makeSecret();
  const matching = makeHarness(t, {});
  writeRuntime(matching, {
    baseUrl: "https://matching.example/v1",
    apiKey: matchingSecret,
    upstream: {
      upstream_base_url: "https://matching.example/v1/",
      upstream_api_key: matchingSecret
    }
  });
  const matchingCredentials = new MemoryCredentialStore();
  const migrated = await migrateLegacyConfiguration({
    paths: matching.paths,
    credentialStore: matchingCredentials,
    now: () => NOW,
    createProviderId: () => "provider-matching",
    createCredentialRef: () => "credential-matching"
  });
  assert.deepEqual(migrated, { migrated: true, providerId: "provider-matching" });
  assert.equal(matchingCredentials.values.get("credential-matching"), matchingSecret);

  const conflictingSecret = makeSecret();
  const conflicting = makeHarness(t, {});
  const conflictingBytes = writeRuntime(conflicting, {
    baseUrl: "https://root.example/v1",
    apiKey: conflictingSecret,
    upstream: {
      baseUrl: "https://nested.example/v1",
      apiKey: conflictingSecret
    }
  });
  const conflictResult = await migrateLegacyConfiguration({
    paths: conflicting.paths,
    credentialStore: new MemoryCredentialStore()
  });
  assert.equal(JSON.stringify(conflictResult).includes(conflictingSecret), false);
  assert.deepEqual(conflictResult, {
    migrated: false,
    reason: "legacy-config-requires-setup"
  });
  assert.equal(existsSync(conflicting.registryPath), false);
  assert.deepEqual(readFileSync(conflicting.runtimeConfigPath), conflictingBytes);
});

test("scrubs an incomplete parseable source when another source migrates", async (t) => {
  const savedSecret = makeSecret();
  const incompleteSecret = makeSecret();
  const harness = makeHarness(t, {
    upstream_base_url: "https://saved.example/v1",
    upstream_api_key: savedSecret
  });
  const runtimeBytes = writeRuntime(harness, {
    upstream: { upstreamApiKey: incompleteSecret }
  });
  const credentials = new MemoryCredentialStore();

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    now: () => NOW,
    createProviderId: () => "provider-saved",
    createCredentialRef: () => "credential-saved"
  });

  const publicResult = JSON.stringify(result);
  assert.equal(publicResult.includes(savedSecret), false);
  assert.equal(publicResult.includes(incompleteSecret), false);
  assert.deepEqual(result, { migrated: true, providerId: "provider-saved" });
  assert.equal(readFileSync(harness.legacyConfigPath, "utf8").includes(savedSecret), false);
  assert.equal(readFileSync(harness.runtimeConfigPath, "utf8").includes(incompleteSecret), false);
  const scrubbedRuntime = JSON.parse(readFileSync(harness.runtimeConfigPath, "utf8"));
  assert.equal("upstreamApiKey" in scrubbedRuntime.upstream, false);
  assert.ok(readdirSync(dirname(harness.runtimeConfigPath))
    .some((name) => name.startsWith("proxy-config.json.") && name.endsWith(".bak")));
  assert.equal(runtimeBytes.includes(incompleteSecret), true);
});

test("deduplicates different alias forms for the same canonical connection", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstream_base_url: "https://aliases.example/v1",
    upstream_api_key: secret
  });
  writeRuntime(harness, {
    upstream: {
      baseUrl: "https://aliases.example/v1/",
      apiKey: secret
    }
  });
  const credentials = new MemoryCredentialStore();

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    now: () => NOW,
    createProviderId: () => "provider-aliases",
    createCredentialRef: () => "credential-aliases"
  });

  const registry = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.deepEqual(result, { migrated: true, providerId: "provider-aliases" });
  assert.equal(registry.providers.length, 1);
  assert.equal(registry.providers[0].name, "Default");
});

test("rolls back every attempted credential when the second recovery credential fails", async (t) => {
  const savedSecret = makeSecret();
  const runtimeSecret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://saved.example/v1",
    apiKey: savedSecret
  });
  writeRuntime(harness, {
    upstream: { baseUrl: "https://runtime.example/v1", apiKey: runtimeSecret }
  });
  const values = new Map();
  const deleted = [];
  let setCount = 0;
  const credentials = {
    async set(ref, value) {
      setCount += 1;
      if (setCount === 2) throw new Error("private second credential failure");
      values.set(ref, value);
    },
    async delete(ref) {
      deleted.push(ref);
      values.delete(ref);
    }
  };
  const providerIds = ["provider-runtime", "provider-saved"];
  const credentialRefs = ["credential-runtime", "credential-saved"];

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      createProviderId: () => providerIds.shift(),
      createCredentialRef: () => credentialRefs.shift()
    }),
    (error) => error?.code === "MIGRATION_FAILED"
      && !error.message.includes(savedSecret)
      && !error.message.includes(runtimeSecret)
  );

  assert.deepEqual(deleted, ["credential-saved", "credential-runtime"]);
  assert.equal(values.size, 0);
  assert.equal(existsSync(harness.registryPath), false);
  assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
});

test("retains canonical migration blockers when multi-credential cleanup degrades", async (t) => {
  const savedSecret = makeSecret();
  const runtimeSecret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://saved.example/v1",
    apiKey: savedSecret
  });
  writeRuntime(harness, {
    upstream: { baseUrl: "https://runtime.example/v1", apiKey: runtimeSecret }
  });
  let setCount = 0;
  const credentials = {
    async set() {
      setCount += 1;
      if (setCount === 2) throw new Error("private second credential failure");
    },
    async delete(ref) {
      if (ref === "credential-runtime") throw new Error("private credential cleanup failure");
    }
  };
  const providerIds = ["provider-runtime", "provider-saved"];
  const credentialRefs = ["credential-runtime", "credential-saved"];

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      createProviderId: () => providerIds.shift(),
      createCredentialRef: () => credentialRefs.shift()
    }),
    (error) => error?.code === "MIGRATION_ROLLBACK_DEGRADED"
      && error.details.committed === false
      && error.details.degraded === true
      && !error.message.includes(savedSecret)
      && !error.message.includes(runtimeSecret)
  );

  assert.equal(existsSync(`${harness.registryPath}.migration.lock`), true);
  assert.equal(existsSync(`${harness.registryPath}.crp.lock`), true);
  assert.equal(existsSync(harness.registryPath), false);
  assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
});

test("compensates both credentials when the second set commits with warning before registry failure", async (t) => {
  const savedSecret = makeSecret();
  const runtimeSecret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://saved.example/v1",
    apiKey: savedSecret
  });
  writeRuntime(harness, {
    upstream: { baseUrl: "https://runtime.example/v1", apiKey: runtimeSecret }
  });
  const values = new Map();
  const deleted = [];
  let setCount = 0;
  const credentials = {
    async set(ref, value) {
      setCount += 1;
      values.set(ref, value);
      if (setCount === 2) {
        throw new CrpError(
          "CREDENTIAL_WRITE_COMMITTED_DEGRADED",
          "Credential write committed with degraded cleanup.",
          "Repair the credential backend.",
          { status: 500, details: { committed: true } }
        );
      }
    },
    async delete(ref) {
      deleted.push(ref);
      values.delete(ref);
    }
  };
  const providerIds = ["provider-runtime", "provider-saved"];
  const credentialRefs = ["credential-runtime", "credential-saved"];

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      createProviderId: () => providerIds.shift(),
      createCredentialRef: () => credentialRefs.shift(),
      fileOperations: {
        ...realFileOperations,
        openSync(path, flags, mode) {
          if (path === harness.registryPath && flags === "wx") {
            const error = new Error("private registry publication failure");
            error.code = "EIO";
            throw error;
          }
          return realFileOperations.openSync(path, flags, mode);
        }
      }
    }),
    (error) => error?.code === "MIGRATION_FAILED"
      && !error.message.includes(savedSecret)
      && !error.message.includes(runtimeSecret)
  );

  assert.deepEqual(deleted, ["credential-saved", "credential-runtime"]);
  assert.equal(values.size, 0);
  assert.equal(existsSync(harness.registryPath), false);
  assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
});

test("does not overwrite an exclusive backup collision and is idempotent after schema 3", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const collisionPath = `${harness.legacyConfigPath}.collision.bak`;
  const collisionBytes = Buffer.from("foreign-backup\n", "utf8");
  writeFileSync(collisionPath, collisionBytes, { mode: 0o600 });
  const backupIds = ["collision", "unique"];
  const credentials = new MemoryCredentialStore();

  const first = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    now: () => NOW,
    createProviderId: () => "provider-default",
    createCredentialRef: () => "credential-opaque",
    createBackupId: () => backupIds.shift() ?? "unexpected"
  });
  assert.deepEqual(first, { migrated: true, providerId: "provider-default" });
  assert.deepEqual(readFileSync(collisionPath), collisionBytes);
  const beforeRegistry = readFileSync(harness.registryPath);
  const beforeBackups = readdirSync(harness.globalHome).filter((name) => name.endsWith(".bak"));

  const second = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: {
      async set() { throw new Error("must not write a second credential"); },
      async delete() { throw new Error("must not delete the existing credential"); }
    },
    createProviderId: () => { throw new Error("must not create a second provider"); },
    createCredentialRef: () => { throw new Error("must not create a second reference"); }
  });
  assert.deepEqual(second, { migrated: false, reason: "already-current" });
  assert.deepEqual(readFileSync(harness.registryPath), beforeRegistry);
  assert.deepEqual(
    readdirSync(harness.globalHome).filter((name) => name.endsWith(".bak")),
    beforeBackups
  );
});

test("backs up and atomically upgrades a schema 2 registry to schema 9", async (t) => {
  const harness = makeHarness(t, { upstreamBaseUrl: "https://legacy.example/v1" });
  const schema2 = {
    schemaVersion: 2,
    activeProviderId: null,
    providers: [],
    settings: {
      proxyHost: "127.0.0.1",
      proxyPort: 15100,
      adminHost: "127.0.0.1",
      adminPort: 15101,
      captureEnabled: false
    }
  };
  const originalBytes = Buffer.from(`${JSON.stringify(schema2, null, 2)}\n`, "utf8");
  writeFileSync(harness.registryPath, originalBytes, { mode: 0o600 });
  const events = [];
  const credentials = new MemoryCredentialStore();

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    createBackupId: () => "schema-2",
    activityStore: { append: async (event) => events.push(event) }
  });

  assert.deepEqual(result, { migrated: true, reason: "provider-registry-schema-9" });
  const upgraded = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.equal(upgraded.schemaVersion, 9);
  assert.deepEqual(upgraded.modelMappingGroups, []);
  assert.deepEqual(upgraded.routingRuleGroups, []);
  assert.equal(upgraded.settings.routingRuleGroupId, null);
  assert.equal(upgraded.settings.routingMode, "custom_only");
  assert.deepEqual(readFileSync(`${harness.registryPath}.schema-2.bak`), originalBytes);
  assert.equal(credentials.values.size, 0);
  assert.equal("apiKey" in JSON.parse(readFileSync(harness.legacyConfigPath, "utf8")), false);
  assert.deepEqual(events.map(({ action }) => action), ["provider-registry-schema-9"]);

  const second = await migrateLegacyConfiguration({ paths: harness.paths, credentialStore: credentials });
  assert.deepEqual(second, { migrated: false, reason: "already-current" });
});

test("upgrades schema 3 providers with default weights without changing routing or Capture", async (t) => {
  const harness = makeHarness(t, {});
  const schema3 = {
    schemaVersion: 3,
    activeProviderId: "provider-existing",
    providers: [{
      id: "provider-existing",
      name: "Existing",
      baseUrl: "https://existing.example/v1",
      credentialRef: "credential-existing",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      modelMode: "passthrough",
      modelOverride: null,
      lastTestAt: NOW,
      lastTestStatus: "passed",
      lastTestCode: null,
      createdAt: NOW,
      updatedAt: NOW
    }],
    settings: {
      proxyHost: "127.0.0.1",
      proxyPort: 15100,
      adminHost: "127.0.0.1",
      adminPort: 15101,
      captureEnabled: true,
      routingMode: "account_first"
    }
  };
  const originalBytes = Buffer.from(`${JSON.stringify(schema3, null, 2)}\n`, "utf8");
  writeFileSync(harness.registryPath, originalBytes, { mode: 0o600 });
  const credentials = new MemoryCredentialStore();

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    createBackupId: () => "schema-3"
  });

  assert.deepEqual(result, { migrated: true, reason: "provider-registry-schema-9" });
  const upgraded = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.equal(upgraded.schemaVersion, 9);
  assert.deepEqual(upgraded.modelMappingGroups, []);
  assert.deepEqual(upgraded.routingRuleGroups, []);
  assert.equal(upgraded.settings.routingRuleGroupId, null);
  assert.equal(upgraded.providers[0].supportedModelsMode, "auto");
  assert.deepEqual(upgraded.providers[0].supportedModels, []);
  assert.equal(upgraded.providers[0].modelsPath, "/models");
  assert.deepEqual(upgraded.providers[0].customModels, []);
  assert.equal(upgraded.providers[0].modelMappingGroupId, null);
  assert.equal(upgraded.activeProviderId, "provider-existing");
  assert.equal(upgraded.providers[0].weight, 100);
  assert.equal(upgraded.settings.captureEnabled, true);
  assert.equal(upgraded.settings.routingMode, "account_first");
  assert.deepEqual(readFileSync(`${harness.registryPath}.schema-3.bak`), originalBytes);
  assert.equal(credentials.values.size, 0);
});

test("upgrades schema 4 providers with null mapping assignments and an empty group catalog", async (t) => {
  const harness = makeHarness(t, {});
  const schema4 = {
    schemaVersion: 4,
    activeProviderId: "provider-existing",
    providers: [{
      id: "provider-existing",
      name: "Existing",
      baseUrl: "https://existing.example/v1",
      credentialRef: "credential-existing",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      weight: 275,
      modelMode: "passthrough",
      modelOverride: null,
      lastTestAt: NOW,
      lastTestStatus: "passed",
      lastTestCode: null,
      createdAt: NOW,
      updatedAt: NOW
    }],
    settings: {
      proxyHost: "127.0.0.1",
      proxyPort: 15100,
      adminHost: "127.0.0.1",
      adminPort: 15101,
      captureEnabled: true,
      routingMode: "account_first"
    }
  };
  const originalBytes = Buffer.from(`${JSON.stringify(schema4, null, 2)}\n`, "utf8");
  writeFileSync(harness.registryPath, originalBytes, { mode: 0o600 });
  const events = [];

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: new MemoryCredentialStore(),
    createBackupId: () => "schema-4",
    activityStore: { append: async (event) => events.push(event) }
  });

  assert.deepEqual(result, { migrated: true, reason: "provider-registry-schema-9" });
  const upgraded = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.equal(upgraded.schemaVersion, 9);
  assert.equal(upgraded.providers[0].weight, 275);
  assert.equal(upgraded.providers[0].modelMappingGroupId, null);
  assert.deepEqual(upgraded.modelMappingGroups, []);
  assert.deepEqual(upgraded.routingRuleGroups, []);
  assert.equal(upgraded.settings.routingRuleGroupId, null);
  assert.equal(upgraded.providers[0].supportedModelsMode, "auto");
  assert.deepEqual(upgraded.providers[0].supportedModels, []);
  assert.equal(upgraded.providers[0].modelsPath, "/models");
  assert.deepEqual(upgraded.providers[0].customModels, []);
  assert.deepEqual(readFileSync(`${harness.registryPath}.schema-4.bak`), originalBytes);
  assert.deepEqual(events.map(({ action }) => action), ["provider-registry-schema-9"]);
});

test("upgrades schema 5 without changing provider mappings or routing settings", async (t) => {
  const harness = makeHarness(t, {});
  const schema5 = {
    schemaVersion: 5,
    activeProviderId: "provider-existing",
    providers: [{
      id: "provider-existing",
      name: "Existing",
      baseUrl: "https://existing.example/v1",
      credentialRef: "credential-existing",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      weight: 275,
      modelMode: "passthrough",
      modelOverride: null,
      modelMappingGroupId: "mapping-existing",
      lastTestAt: NOW,
      lastTestStatus: "passed",
      lastTestCode: null,
      createdAt: NOW,
      updatedAt: NOW
    }],
    modelMappingGroups: [{
      id: "mapping-existing",
      name: "Existing mapping",
      rules: [{ sourceModel: "gpt-5.6-sol", targetModel: "vendor/sol" }],
      createdAt: NOW,
      updatedAt: NOW
    }],
    settings: {
      proxyHost: "127.0.0.1",
      proxyPort: 15100,
      adminHost: "127.0.0.1",
      adminPort: 15101,
      captureEnabled: true,
      routingMode: "account_first"
    }
  };
  const originalBytes = Buffer.from(`${JSON.stringify(schema5, null, 2)}\n`, "utf8");
  writeFileSync(harness.registryPath, originalBytes, { mode: 0o600 });

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: new MemoryCredentialStore(),
    createBackupId: () => "schema-5"
  });

  assert.deepEqual(result, { migrated: true, reason: "provider-registry-schema-9" });
  const upgraded = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.equal(upgraded.schemaVersion, 9);
  assert.equal(upgraded.providers[0].modelMappingGroupId, "mapping-existing");
  assert.equal(upgraded.providers[0].supportedModelsMode, "auto");
  assert.deepEqual(upgraded.providers[0].supportedModels, []);
  assert.equal(upgraded.providers[0].modelsPath, "/models");
  assert.deepEqual(upgraded.providers[0].customModels, []);
  assert.deepEqual(upgraded.modelMappingGroups, schema5.modelMappingGroups);
  assert.deepEqual(upgraded.routingRuleGroups, []);
  assert.equal(upgraded.settings.routingMode, "account_first");
  assert.equal(upgraded.settings.routingRuleGroupId, null);
  assert.deepEqual(readFileSync(`${harness.registryPath}.schema-5.bak`), originalBytes);
});

test("upgrades schema 6 model controls and single-model rules without changing behavior", async (t) => {
  const harness = makeHarness(t, {});
  const schema6 = {
    schemaVersion: 6,
    activeProviderId: "provider-existing",
    providers: [{
      id: "provider-existing",
      name: "Existing",
      baseUrl: "https://existing.example/v1",
      credentialRef: "credential-existing",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      weight: 275,
      modelMode: "passthrough",
      modelOverride: null,
      modelMappingGroupId: null,
      supportedModelsMode: "custom",
      supportedModels: ["M1", "M3", "M5"],
      lastTestAt: NOW,
      lastTestStatus: "passed",
      lastTestCode: null,
      createdAt: NOW,
      updatedAt: NOW
    }],
    modelMappingGroups: [],
    routingRuleGroups: [{
      id: "routing-existing",
      name: "Existing routing",
      rules: [
        { model: "M1", providerIds: ["provider-existing"] },
        { model: "M3", providerIds: ["provider-existing"] }
      ],
      createdAt: NOW,
      updatedAt: NOW
    }],
    settings: {
      proxyHost: "127.0.0.1",
      proxyPort: 15100,
      adminHost: "127.0.0.1",
      adminPort: 15101,
      captureEnabled: true,
      routingMode: "custom_only",
      routingRuleGroupId: "routing-existing"
    }
  };
  const originalBytes = Buffer.from(`${JSON.stringify(schema6, null, 2)}\n`, "utf8");
  writeFileSync(harness.registryPath, originalBytes, { mode: 0o600 });

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: new MemoryCredentialStore(),
    createBackupId: () => "schema-6"
  });

  assert.deepEqual(result, { migrated: true, reason: "provider-registry-schema-9" });
  const upgraded = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.equal(upgraded.schemaVersion, 9);
  assert.equal(upgraded.providers[0].supportedModelsMode, "custom");
  assert.deepEqual(upgraded.providers[0].supportedModels, ["M1", "M3", "M5"]);
  assert.equal(upgraded.providers[0].modelsPath, "/models");
  assert.deepEqual(upgraded.providers[0].customModels, ["M1", "M3", "M5"]);
  assert.deepEqual(upgraded.routingRuleGroups[0].rules, [
    { providerIds: ["provider-existing"], models: ["M1"] },
    { providerIds: ["provider-existing"], models: ["M3"] }
  ]);
  assert.equal(upgraded.settings.routingRuleGroupId, "routing-existing");
  assert.deepEqual(readFileSync(`${harness.registryPath}.schema-6.bak`), originalBytes);
});

test("upgrades schema 7 with loopback keyless access as the compatibility default", async (t) => {
  const harness = makeHarness(t, {});
  const schema7 = {
    schemaVersion: 7,
    activeProviderId: null,
    providers: [],
    modelMappingGroups: [],
    routingRuleGroups: [],
    settings: {
      proxyHost: "127.0.0.1",
      proxyPort: 15100,
      adminHost: "127.0.0.1",
      adminPort: 15101,
      captureEnabled: false,
      routingMode: "custom_only",
      routingRuleGroupId: null
    }
  };
  const originalBytes = Buffer.from(`${JSON.stringify(schema7, null, 2)}\n`, "utf8");
  writeFileSync(harness.registryPath, originalBytes, { mode: 0o600 });

  const result = await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: new MemoryCredentialStore(),
    createBackupId: () => "schema-7"
  });
  assert.deepEqual(result, { migrated: true, reason: "provider-registry-schema-9" });
  const upgraded = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.equal(upgraded.schemaVersion, 9);
  assert.equal(upgraded.settings.proxyHost, "127.0.0.1");
  assert.equal(upgraded.settings.apiKeyAuthEnabled, false);
  assert.deepEqual(readFileSync(`${harness.registryPath}.schema-7.bak`), originalBytes);
});

test("keeps committed schema 9 when post-upgrade activity recording fails", async (t) => {
  const harness = makeHarness(t, {});
  const originalBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    activeProviderId: null,
    providers: [],
    settings: {
      proxyHost: "127.0.0.1",
      proxyPort: 15100,
      adminHost: "127.0.0.1",
      adminPort: 15101,
      captureEnabled: false
    }
  }, null, 2)}\n`, "utf8");
  writeFileSync(harness.registryPath, originalBytes, { mode: 0o600 });

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: new MemoryCredentialStore(),
      createBackupId: () => "schema-2-rollback",
      activityStore: { append: async () => { throw new Error("private activity failure"); } }
    }),
    (error) => error?.code === "MIGRATION_COMMITTED_DEGRADED"
      && error.details.committed === true
      && error.details.degraded === true
  );

  const committed = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.equal(committed.schemaVersion, 9);
  assert.deepEqual(committed.providers, []);
  assert.deepEqual(
    readFileSync(`${harness.registryPath}.schema-2-rollback.bak`),
    originalBytes
  );
});

test("rolls back scrubbed files, registry, and credential when a later scrub fails", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const runtimeBytes = writeRuntime(harness, {
    upstream: { baseUrl: "https://legacy.example/v1", apiKey: secret }
  });
  const credentials = new MemoryCredentialStore();

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      now: () => NOW,
      createProviderId: () => "provider-default",
      createCredentialRef: () => "credential-opaque",
      fileOperations: {
        ...realFileOperations,
        renameSync(from, to) {
          if (to === harness.runtimeConfigPath && from.endsWith(".tmp")) {
            const error = new Error("private runtime scrub failure");
            error.code = "EIO";
            throw error;
          }
          return realFileOperations.renameSync(from, to);
        }
      }
    }),
    (error) => error?.code === "MIGRATION_FAILED" && error.details.committed === false
  );

  assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
  assert.deepEqual(readFileSync(harness.runtimeConfigPath), runtimeBytes);
  assert.equal(existsSync(harness.registryPath), false);
  assert.equal(credentials.values.size, 0);
  assert.deepEqual(credentials.deleted, ["credential-opaque"]);
});

test("rolls back a source replacement when parent fsync fails after rename", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const credentials = new MemoryCredentialStore();
  const descriptorPaths = new Map();
  let sourceRenamed = false;
  let failed = false;

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      now: () => NOW,
      createProviderId: () => "provider-default",
      createCredentialRef: () => "credential-opaque",
      fileOperations: {
        ...realFileOperations,
        openSync(path, flags, mode) {
          const descriptor = realFileOperations.openSync(path, flags, mode);
          descriptorPaths.set(descriptor, path);
          return descriptor;
        },
        closeSync(descriptor) {
          descriptorPaths.delete(descriptor);
          return realFileOperations.closeSync(descriptor);
        },
        renameSync(from, to) {
          const result = realFileOperations.renameSync(from, to);
          if (to === harness.legacyConfigPath) sourceRenamed = true;
          return result;
        },
        fsyncSync(descriptor) {
          if (sourceRenamed && !failed
            && descriptorPaths.get(descriptor) === dirname(harness.legacyConfigPath)) {
            failed = true;
            const error = new Error("source parent fsync failed");
            error.code = "EIO";
            throw error;
          }
          return realFileOperations.fsyncSync(descriptor);
        }
      }
    }),
    (error) => error?.code === "MIGRATION_FAILED"
  );
  assert.equal(failed, true);
  assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
  assert.equal(existsSync(harness.registryPath), false);
  assert.equal(credentials.values.size, 0);
});

test("reports stable degraded rollback state and retains backups when compensation fails", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  writeRuntime(harness, {
    upstream: { baseUrl: "https://legacy.example/v1", apiKey: secret }
  });
  const credentials = new MemoryCredentialStore({ failDelete: true });

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      now: () => NOW,
      createProviderId: () => "provider-default",
      createCredentialRef: () => "credential-opaque",
      fileOperations: {
        ...realFileOperations,
        renameSync(from, to) {
          if (to === harness.runtimeConfigPath && from.endsWith(".tmp")) {
            const error = new Error("private runtime scrub failure");
            error.code = "EIO";
            throw error;
          }
          return realFileOperations.renameSync(from, to);
        }
      }
    }),
    (error) => error?.code === "MIGRATION_ROLLBACK_DEGRADED"
      && error.details.committed === false
      && error.details.degraded === true
      && !error.message.includes(secret)
  );

  assert.ok(readdirSync(harness.globalHome).some((name) => name.endsWith(".bak")));
  assert.ok(readdirSync(join(harness.globalHome, "node")).some((name) => name.endsWith(".bak")));
  assert.equal(existsSync(`${harness.registryPath}.migration.lock`), true);
  assert.equal(existsSync(`${harness.registryPath}.crp.lock`), true);
});

test("serializes migration transactions with an exclusive preserved lock", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  let releaseSet;
  const credentials = new MemoryCredentialStore();
  credentials.set = async (ref, value) => {
    await new Promise((resolve) => { releaseSet = resolve; });
    credentials.values.set(ref, value);
  };

  const first = migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    now: () => NOW,
    createProviderId: () => "provider-default",
    createCredentialRef: () => "credential-opaque"
  });
  while (!releaseSet) await Promise.resolve();
  const lockPath = `${harness.registryPath}.migration.lock`;
  const lockBytes = readFileSync(lockPath);
  await assert.rejects(
    () => migrateLegacyConfiguration({ paths: harness.paths, credentialStore: credentials }),
    (error) => error?.code === "MIGRATION_BUSY"
  );
  assert.deepEqual(readFileSync(lockPath), lockBytes);
  releaseSet();
  await first;
  assert.equal(existsSync(lockPath), false);
});

test("schema inspection cannot race a ProviderRegistry writer lock", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const registryLockPath = `${harness.registryPath}.crp.lock`;
  writeFileSync(registryLockPath, "foreign-registry-writer\n", { mode: 0o600 });
  const credentials = new MemoryCredentialStore();

  await assert.rejects(
    () => migrateLegacyConfiguration({ paths: harness.paths, credentialStore: credentials }),
    (error) => error?.code === "MIGRATION_BUSY"
  );
  assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
  assert.deepEqual(readFileSync(registryLockPath, "utf8"), "foreign-registry-writer\n");
  assert.equal(existsSync(`${harness.registryPath}.migration.lock`), false);
  assert.equal(credentials.values.size, 0);
});

test("legacy migration keeps the ProviderRegistry writer gate through final publication", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const credentials = new MemoryCredentialStore();
  let writerError = null;
  credentials.set = async (ref, value) => {
    const writer = new ProviderRegistry({ path: harness.registryPath });
    try {
      writer.create({
        name: "Racing writer",
        baseUrl: "https://racing.example/v1",
        credentialRef: "racing-credential",
        modelMode: "passthrough",
        modelOverride: null
      });
    } catch (error) {
      writerError = error;
    }
    credentials.values.set(ref, value);
  };

  await migrateLegacyConfiguration({
    paths: harness.paths,
    credentialStore: credentials,
    now: () => NOW,
    createProviderId: () => "provider-default",
    createCredentialRef: () => "credential-opaque"
  });
  assert.equal(writerError?.code, "PROVIDER_REGISTRY_BUSY");
  const registry = new ProviderRegistry({ path: harness.registryPath });
  assert.deepEqual(registry.list().map(({ id }) => id), ["provider-default"]);
});

test("reports rollback degraded when a failed transaction lock cannot be released", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const credentials = new MemoryCredentialStore({ failSet: true });
  const lockPath = `${harness.registryPath}.migration.lock`;

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      fileOperations: {
        ...realFileOperations,
        renameSync(from, to) {
          if (from === lockPath && to.endsWith(".release")) {
            const error = new Error("private lock release failure");
            error.code = "EIO";
            throw error;
          }
          return realFileOperations.renameSync(from, to);
        }
      }
    }),
    (error) => error?.code === "MIGRATION_ROLLBACK_DEGRADED"
      && error.details.committed === false
      && error.details.degraded === true
      && !error.message.includes(secret)
  );
  assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
  assert.equal(existsSync(harness.registryPath), false);
  assert.equal(existsSync(lockPath), true);
});

test("rejects symlink legacy and registry paths without reading or replacing their targets", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation requires Developer Mode or elevated privilege");
    return;
  }
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const legacyTarget = join(harness.root, "legacy-target.json");
  const legacyTargetBytes = readFileSync(harness.legacyConfigPath);
  writeFileSync(legacyTarget, legacyTargetBytes, { mode: 0o600 });
  rmSync(harness.legacyConfigPath);
  symlinkSync(legacyTarget, harness.legacyConfigPath);
  const credentials = new MemoryCredentialStore();

  await assert.rejects(
    () => migrateLegacyConfiguration({ paths: harness.paths, credentialStore: credentials }),
    (error) => error?.code === "MIGRATION_INPUT_INVALID"
  );
  assert.equal(lstatSync(harness.legacyConfigPath).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(legacyTarget), legacyTargetBytes);
  assert.deepEqual(credentials.values.size, 0);

  rmSync(harness.legacyConfigPath);
  writeFileSync(harness.legacyConfigPath, legacyTargetBytes, { mode: 0o600 });
  const registryTarget = join(harness.root, "registry-target.json");
  const registryTargetBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    activeProviderId: null,
    providers: [],
    settings: {
      proxyHost: "127.0.0.1",
      proxyPort: 15100,
      adminHost: "127.0.0.1",
      adminPort: 15101,
      captureEnabled: false
    }
  }), "utf8");
  writeFileSync(registryTarget, registryTargetBytes, { mode: 0o600 });
  symlinkSync(registryTarget, harness.registryPath);
  await assert.rejects(
    () => migrateLegacyConfiguration({ paths: harness.paths, credentialStore: credentials }),
    (error) => error?.code === "MIGRATION_INPUT_INVALID"
  );
  assert.equal(lstatSync(harness.registryPath).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(registryTarget), registryTargetBytes);
});

test("post-commit Activity failure preserves a foreign registry replacement without false rollback", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const foreignRegistry = Buffer.from("foreign-registry-bytes\n", "utf8");
  const displacedRegistry = `${harness.registryPath}.owned-displaced`;
  const credentials = new MemoryCredentialStore();
  const activityStore = {
    append() {
      renameSync(harness.registryPath, displacedRegistry);
      writeFileSync(harness.registryPath, foreignRegistry, { mode: 0o600 });
      throw new Error("private activity failure");
    }
  };

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      activityStore,
      now: () => NOW,
      createProviderId: () => "provider-default",
      createCredentialRef: () => "credential-opaque"
    }),
    (error) => error?.code === "MIGRATION_COMMITTED_DEGRADED"
      && error.details.committed === true
      && error.details.degraded === true
  );
  assert.deepEqual(readFileSync(harness.registryPath), foreignRegistry);
  const displaced = JSON.parse(readFileSync(displacedRegistry, "utf8"));
  assert.equal(displaced.schemaVersion, 9);
  assert.equal(displaced.providers.length, 1);
  assert.equal(readFileSync(harness.legacyConfigPath, "utf8").includes(secret), false);
  assert.equal(credentials.values.get("credential-opaque"), secret);
});

test("lock initialization failure preserves a foreign canonical replacement and blocks retry", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const lockPath = `${harness.registryPath}.migration.lock`;
  const displacedLock = `${lockPath}.owned-displaced`;
  const foreign = Buffer.from("foreign-migration-owner\n", "utf8");
  let swapped = false;
  const credentials = new MemoryCredentialStore();

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      fileOperations: {
        ...realFileOperations,
        writeFileSync(target, bytes, options) {
          if (!swapped && typeof target === "number") {
            swapped = true;
            realFileOperations.renameSync(lockPath, displacedLock);
            realFileOperations.writeFileSync(lockPath, foreign, { mode: 0o600 });
            const error = new Error("private lock init failure");
            error.code = "EIO";
            throw error;
          }
          return realFileOperations.writeFileSync(target, bytes, options);
        }
      }
    }),
    (error) => error?.code === "MIGRATION_ROLLBACK_DEGRADED"
      && error.details.committed === false
  );
  assert.deepEqual(readFileSync(lockPath), foreign);
  await assert.rejects(
    () => migrateLegacyConfiguration({ paths: harness.paths, credentialStore: credentials }),
    (error) => error?.code === "MIGRATION_BUSY"
  );
  assert.deepEqual(readFileSync(lockPath), foreign);
});

test("release token mismatch restores a canonical blocker before the next transaction", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const lockPath = `${harness.registryPath}.migration.lock`;
  const credentials = new MemoryCredentialStore();
  const releaseDescriptors = new Set();

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      now: () => NOW,
      createProviderId: () => "provider-default",
      createCredentialRef: () => "credential-opaque",
      fileOperations: {
        ...realFileOperations,
        openSync(path, flags, mode) {
          const descriptor = realFileOperations.openSync(path, flags, mode);
          if (typeof path === "string"
            && path.includes(".migration.lock.")
            && path.endsWith(".release")) {
            releaseDescriptors.add(descriptor);
          }
          return descriptor;
        },
        readFileSync(target, options) {
          if (releaseDescriptors.has(target)) {
            return "foreign-claim-token\n";
          }
          return realFileOperations.readFileSync(target, options);
        }
      }
    }),
    (error) => error?.code === "MIGRATION_COMMITTED_LOCK_DEGRADED"
      && error.details.committed === true
  );
  assert.equal(existsSync(lockPath), true);
  await assert.rejects(
    () => migrateLegacyConfiguration({ paths: harness.paths, credentialStore: credentials }),
    (error) => error?.code === "MIGRATION_BUSY"
  );
});

test("keeps committed schema 9 and credential when the shared registry lock degrades", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const credentials = new MemoryCredentialStore();
  const registryLockPath = `${harness.registryPath}.crp.lock`;

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      now: () => NOW,
      createProviderId: () => "provider-default",
      createCredentialRef: () => "credential-opaque",
      fileOperations: {
        ...realFileOperations,
        renameSync(from, to) {
          if (from === registryLockPath && to.endsWith(".release")) {
            const error = new Error("private registry lock cleanup failure");
            error.code = "EACCES";
            throw error;
          }
          return realFileOperations.renameSync(from, to);
        }
      }
    }),
    (error) => error?.code === "MIGRATION_COMMITTED_LOCK_DEGRADED"
      && error.details.committed === true
  );

  const registry = JSON.parse(readFileSync(harness.registryPath, "utf8"));
  assert.equal(registry.providers[0].id, "provider-default");
  assert.equal(credentials.values.get("credential-opaque"), secret);
  assert.equal("apiKey" in JSON.parse(readFileSync(harness.legacyConfigPath, "utf8")), false);
  assert.equal(existsSync(registryLockPath), true);
});

test("exclusive registry creation preserves a foreign schema 2 created during credential set", async (t) => {
  const secret = makeSecret();
  const harness = makeHarness(t, {
    upstreamBaseUrl: "https://legacy.example/v1",
    apiKey: secret
  });
  const foreignBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    activeProviderId: null,
    providers: [],
    settings: {
      proxyHost: "127.0.0.1",
      proxyPort: 15100,
      adminHost: "127.0.0.1",
      adminPort: 15101,
      captureEnabled: false
    }
  }, null, 2)}\n`, "utf8");
  const credentials = new MemoryCredentialStore();
  const originalSet = credentials.set.bind(credentials);
  let foreignIdentity;
  credentials.set = async (ref, value) => {
    await originalSet(ref, value);
    writeFileSync(harness.registryPath, foreignBytes, { flag: "wx", mode: 0o600 });
    const stats = lstatSync(harness.registryPath);
    foreignIdentity = { dev: stats.dev, ino: stats.ino };
  };

  await assert.rejects(
    () => migrateLegacyConfiguration({
      paths: harness.paths,
      credentialStore: credentials,
      now: () => NOW,
      createProviderId: () => "provider-default",
      createCredentialRef: () => "credential-opaque"
    }),
    (error) => error?.code === "MIGRATION_REGISTRY_CONFLICT"
      && error.status === 409
  );

  const after = lstatSync(harness.registryPath);
  assert.deepEqual({ dev: after.dev, ino: after.ino }, foreignIdentity);
  assert.deepEqual(readFileSync(harness.registryPath), foreignBytes);
  assert.deepEqual(readFileSync(harness.legacyConfigPath), harness.legacyBytes);
  assert.equal(credentials.values.size, 0);
  assert.deepEqual(credentials.deleted, ["credential-opaque"]);
});
