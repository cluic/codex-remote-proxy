import test from "node:test";
import assert from "node:assert/strict";
import * as realFileOperations from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";

import { ProviderRegistry } from "../src/providers/provider-registry.mjs";
import {
  TEST_STATUSES,
  normalizeProvider,
  toPublicProvider,
  validateProviderInput
} from "../src/providers/provider-schema.mjs";
import { CrpError, toPublicError } from "../src/shared/errors.mjs";

const FIXED_NOW = "2026-07-10T00:00:00.000Z";
const LATER_NOW = "2026-07-10T01:00:00.000Z";
const DEFAULT_SETTINGS = {
  proxyHost: "127.0.0.1",
  proxyPort: 15100,
  adminHost: "127.0.0.1",
  adminPort: 15101,
  captureEnabled: false
};

function makeTempRegistry(t, prefix = "crp-provider-registry-") {
  const tempDir = mkdtempSync(join(os.tmpdir(), prefix));
  const registryPath = join(tempDir, "providers.json");
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  return { tempDir, registryPath };
}

function makeIds(...ids) {
  let index = 0;
  return () => ids[index++] ?? `provider-${index}`;
}

function makeClock(...timestamps) {
  let index = 0;
  return () => timestamps[index++] ?? timestamps.at(-1) ?? FIXED_NOW;
}

function validInput(overrides = {}) {
  return {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialRef: "provider-1",
    ...overrides
  };
}

function assertCrpError(expectedCode, expectedStatus) {
  return (error) => {
    assert.ok(error instanceof CrpError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.status, expectedStatus);
    assert.equal(typeof error.action, "string");
    assert.notEqual(error.action.length, 0);
    return true;
  };
}

function listTempFiles(tempDir, registryPath) {
  const registryName = basename(registryPath);
  return readdirSync(tempDir).filter((name) => (
    name.startsWith(`.${registryName}.`) && name.endsWith(".tmp")
  ));
}

function makeFileError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

test("creates, lists, gets, and updates normalized providers", (t) => {
  const { registryPath } = makeTempRegistry(t);
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: makeClock(FIXED_NOW, LATER_NOW)
  });

  assert.deepEqual(registry.getDocument(), {
    schemaVersion: 2,
    activeProviderId: null,
    providers: [],
    settings: DEFAULT_SETTINGS
  });

  const created = registry.create(validInput({ name: "  OpenRouter  " }));
  assert.deepEqual(created, {
    id: "provider-1",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialRef: "provider-1",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    modelMode: "passthrough",
    modelOverride: null,
    lastTestAt: null,
    lastTestStatus: "untested",
    lastTestCode: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW
  });
  assert.deepEqual(registry.list(), [created]);
  assert.deepEqual(registry.get("provider-1"), created);

  const updated = registry.update("provider-1", {
    name: "Router Primary",
    authHeader: "x-provider-auth",
    authScheme: "Token",
    extraHeaders: { "x-region": "us-east" },
    modelMode: "override",
    modelOverride: "gpt-compatible"
  });
  assert.equal(updated.id, "provider-1");
  assert.equal(updated.credentialRef, "provider-1");
  assert.equal(updated.createdAt, FIXED_NOW);
  assert.equal(updated.updatedAt, LATER_NOW);
  assert.equal(updated.name, "Router Primary");
  assert.equal(updated.modelMode, "override");
  assert.equal(updated.modelOverride, "gpt-compatible");
  assert.deepEqual(updated.extraHeaders, { "x-region": "us-east" });
});

test("requires and trims names and rejects case-insensitive duplicates", (t) => {
  const { registryPath } = makeTempRegistry(t);
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: makeIds("provider-1", "provider-2", "provider-3"),
    now: () => FIXED_NOW
  });

  assert.throws(
    () => registry.create(validInput({ name: "   " })),
    assertCrpError("PROVIDER_INPUT_INVALID", 400)
  );
  registry.create(validInput());
  assert.throws(
    () => registry.create(validInput({
      name: "  openrouter  ",
      credentialRef: "provider-2"
    })),
    assertCrpError("PROVIDER_NAME_CONFLICT", 409)
  );

  registry.create(validInput({
    name: "Backup",
    baseUrl: "https://backup.example/v1",
    credentialRef: "provider-3"
  }));
  assert.throws(
    () => registry.update("provider-3", { name: "OPENROUTER" }),
    assertCrpError("PROVIDER_NAME_CONFLICT", 409)
  );
});

test("serializes multi-instance mutations and refreshes existing readers", (t) => {
  const { registryPath } = makeTempRegistry(t, "crp-provider-multi-instance-");
  const first = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW
  });
  const second = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-2",
    now: () => FIXED_NOW
  });
  const staleDuplicate = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-3",
    now: () => FIXED_NOW
  });

  first.create(validInput({ name: "Primary" }));
  second.create(validInput({
    name: "Backup",
    baseUrl: "https://backup.example/v1",
    credentialRef: "provider-2"
  }));

  assert.deepEqual(
    first.list().map(({ id, name }) => ({ id, name })),
    [
      { id: "provider-1", name: "Primary" },
      { id: "provider-2", name: "Backup" }
    ]
  );
  assert.equal(first.get("provider-2").name, "Backup");
  assert.throws(
    () => staleDuplicate.create(validInput({
      name: "  PRIMARY  ",
      credentialRef: "provider-3"
    })),
    assertCrpError("PROVIDER_NAME_CONFLICT", 409)
  );
  assert.equal(first.getDocument().providers.length, 2);
});

test("rejects a foreign registry lock without removing it", (t) => {
  const { tempDir, registryPath } = makeTempRegistry(t, "crp-provider-foreign-lock-");
  const lockPath = `${registryPath}.crp.lock`;
  const foreignLockBytes = Buffer.from("foreign-owner\n", "utf8");
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW
  });
  writeFileSync(lockPath, foreignLockBytes, { mode: 0o600 });

  assert.throws(
    () => registry.create(validInput()),
    assertCrpError("PROVIDER_REGISTRY_BUSY", 409)
  );
  assert.deepEqual(readFileSync(lockPath), foreignLockBytes);
  assert.equal(existsSync(registryPath), false);
  assert.deepEqual(listTempFiles(tempDir, registryPath), []);
});

test("rejects missing providers and immutable profile fields", (t) => {
  const { registryPath } = makeTempRegistry(t);
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW
  });

  assert.throws(
    () => registry.get("missing"),
    assertCrpError("PROVIDER_NOT_FOUND", 404)
  );
  assert.throws(
    () => registry.update("missing", { name: "Missing" }),
    assertCrpError("PROVIDER_NOT_FOUND", 404)
  );
  assert.throws(
    () => registry.delete("missing"),
    assertCrpError("PROVIDER_NOT_FOUND", 404)
  );
  assert.throws(
    () => registry.setActive("missing"),
    assertCrpError("PROVIDER_NOT_FOUND", 404)
  );

  registry.create(validInput());
  for (const patch of [
    { id: "provider-2" },
    { createdAt: LATER_NOW },
    { credentialRef: "provider-2" }
  ]) {
    assert.throws(
      () => registry.update("provider-1", patch),
      assertCrpError("PROVIDER_IMMUTABLE_FIELD", 400)
    );
  }
});

test("accepts, rejects, and canonically persists provider URLs", (t) => {
  for (const baseUrl of [
    "https://provider.example/v1",
    "https://provider.example/v1/@scope",
    "https://provider.example/v1?contact=user@example.com",
    "http://localhost:8080/v1",
    "http://127.0.0.1:8080/v1",
    "http://127.42.0.9/v1",
    "http://[::1]:8080/v1"
  ]) {
    assert.doesNotThrow(() => validateProviderInput(validInput({ baseUrl })));
  }

  for (const baseUrl of [
    "ftp://provider.example/v1",
    "http://provider.example/v1",
    "http://localhost.example/v1",
    "http://128.0.0.1/v1",
    "https://user:password@provider.example/v1",
    "https://@provider.example/v1",
    "https://:@provider.example/v1",
    "https://provider.example/v1\rignored",
    "https://provider.example/v1\nignored",
    "https://provider.example/v1\0ignored",
    "https://provider.example/v1\x7fignored",
    "not a url"
  ]) {
    assert.throws(
      () => validateProviderInput(validInput({ baseUrl })),
      assertCrpError("PROVIDER_INPUT_INVALID", 400)
    );
  }

  const { registryPath } = makeTempRegistry(t, "crp-provider-canonical-url-");
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW
  });
  const created = registry.create(validInput({
    baseUrl: "HTTPS://Provider.Example:443/a/../v1"
  }));
  assert.equal(created.baseUrl, "https://provider.example/v1");
  assert.equal(
    JSON.parse(readFileSync(registryPath, "utf8")).providers[0].baseUrl,
    "https://provider.example/v1"
  );
});

test("requires extraHeaders to be a string map with non-sensitive names", () => {
  for (const extraHeaders of [
    [],
    { "x-region": 1 },
    { authorization: "hidden" },
    { "Proxy-Authorization": "hidden" },
    { COOKIE: "hidden" },
    { "Set-Cookie": "hidden" },
    { "x-auth-token": "hidden" },
    { "client-secret-mode": "hidden" },
    { "X-API-KEY": "hidden" },
    { "x-api_key": "ordinary-value" },
    { "x-apikey": "ordinary-value" },
    { "x-authorization": "ordinary-value" },
    { "X_AuThOrIzAtIoN": "ordinary-value" },
    { "x-region": "line\rbreak" },
    { "x-region": "line\nbreak" },
    { "x-region": "value\0break" },
    { "x-region": "value\x7fbreak" }
  ]) {
    assert.throws(
      () => validateProviderInput(validInput({ extraHeaders })),
      assertCrpError("PROVIDER_INPUT_INVALID", 400)
    );
  }

  const sensitivePlaceholder = "sensitive-placeholder";
  let error;
  try {
    validateProviderInput(validInput({
      extraHeaders: { "x-client-secret": sensitivePlaceholder }
    }));
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CrpError);
  assert.doesNotMatch(
    JSON.stringify(toPublicError(error, "request-1")),
    new RegExp(sensitivePlaceholder)
  );
});

test("allows an empty auth scheme and requires non-empty schemes to be HTTP tokens", () => {
  assert.equal(
    normalizeProvider(validInput({ authScheme: "" }), {
      id: "provider-1",
      now: FIXED_NOW
    }).authScheme,
    ""
  );
  for (const authScheme of ["Bearer value", "Bearer/Token", "Bearer,Token", "Bearer\n"]) {
    assert.throws(
      () => validateProviderInput(validInput({ authScheme })),
      assertCrpError("PROVIDER_INPUT_INVALID", 400)
    );
  }
});

test("validates passthrough and override model modes", () => {
  assert.doesNotThrow(() => validateProviderInput(validInput({
    modelMode: "passthrough",
    modelOverride: null
  })));
  assert.doesNotThrow(() => validateProviderInput(validInput({
    modelMode: "override",
    modelOverride: " compatible-model "
  })));
  assert.throws(
    () => validateProviderInput(validInput({ modelMode: "unknown" })),
    assertCrpError("PROVIDER_INPUT_INVALID", 400)
  );
  assert.throws(
    () => validateProviderInput(validInput({
      modelMode: "override",
      modelOverride: "   "
    })),
    assertCrpError("PROVIDER_INPUT_INVALID", 400)
  );

  assert.deepEqual(TEST_STATUSES, new Set(["untested", "passed", "failed"]));
  assert.deepEqual(
    normalizeProvider(validInput({
      authHeader: undefined,
      authScheme: undefined,
      extraHeaders: undefined,
      modelMode: undefined,
      modelOverride: undefined
    }), { id: "provider-1", now: FIXED_NOW }),
    {
      id: "provider-1",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      credentialRef: "provider-1",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      modelMode: "passthrough",
      modelOverride: null,
      lastTestAt: null,
      lastTestStatus: "untested",
      lastTestCode: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW
    }
  );
});

test("marks passed and failed tests and manages active deletion", (t) => {
  const { registryPath } = makeTempRegistry(t);
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: makeIds("provider-1", "provider-2"),
    now: makeClock(FIXED_NOW, FIXED_NOW, LATER_NOW, LATER_NOW, LATER_NOW, LATER_NOW)
  });

  registry.create(validInput());
  registry.create(validInput({
    name: "Backup",
    baseUrl: "https://backup.example/v1",
    credentialRef: "provider-2"
  }));

  const passed = registry.markTest("provider-1", { status: "passed", code: null });
  assert.equal(passed.lastTestAt, LATER_NOW);
  assert.equal(passed.lastTestStatus, "passed");
  assert.equal(passed.lastTestCode, null);

  const failed = registry.markTest("provider-2", {
    status: "failed",
    code: "UPSTREAM_AUTH_FAILED"
  });
  assert.equal(failed.lastTestStatus, "failed");
  assert.equal(failed.lastTestCode, "UPSTREAM_AUTH_FAILED");
  const reset = registry.markTest("provider-2", { status: "untested", code: null });
  assert.equal(reset.lastTestAt, null);
  assert.equal(reset.lastTestStatus, "untested");
  assert.equal(reset.lastTestCode, null);

  const activated = registry.setActive("provider-1");
  assert.equal(activated.id, "provider-1");
  assert.equal(registry.getActive().id, "provider-1");
  assert.equal(registry.getDocument().activeProviderId, "provider-1");
  assert.throws(
    () => registry.delete("provider-1"),
    assertCrpError("PROVIDER_ACTIVE", 409)
  );

  const deleted = registry.delete("provider-2");
  assert.equal(deleted.id, "provider-2");
  assert.equal(registry.list().length, 1);
});

test("compare-and-set active operations change state only when their predicates match", (t) => {
  const { registryPath } = makeTempRegistry(t, "crp-provider-active-cas-");
  const lockPath = `${registryPath}.crp.lock`;
  let persistenceOpenCount = 0;
  let registryRenameCount = 0;
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: makeIds("provider-1", "provider-2"),
    now: () => FIXED_NOW,
    fileOperations: {
      ...realFileOperations,
      openSync(path, flags, mode) {
        if (path !== lockPath) persistenceOpenCount += 1;
        return realFileOperations.openSync(path, flags, mode);
      },
      renameSync(source, destination) {
        if (destination === registryPath) registryRenameCount += 1;
        return realFileOperations.renameSync(source, destination);
      }
    }
  });
  registry.create(validInput({ name: "Primary" }));
  registry.create(validInput({
    name: "Backup",
    baseUrl: "https://backup.example/v1",
    credentialRef: "provider-2"
  }));

  assert.equal(registry.setActiveIfNull("provider-1"), true);
  let diskBytes = readFileSync(registryPath);
  let persistenceOpens = persistenceOpenCount;
  let registryRenames = registryRenameCount;
  assert.equal(registry.setActiveIfNull("provider-1"), false);
  assert.equal(registry.setActiveIfNull("provider-2"), false);
  assert.equal(persistenceOpenCount, persistenceOpens);
  assert.equal(registryRenameCount, registryRenames);
  assert.deepEqual(readFileSync(registryPath), diskBytes);
  assert.equal(registry.getDocument().activeProviderId, "provider-1");

  assert.equal(registry.clearActiveIf("provider-2"), false);
  assert.equal(persistenceOpenCount, persistenceOpens);
  assert.equal(registryRenameCount, registryRenames);
  assert.deepEqual(readFileSync(registryPath), diskBytes);
  assert.equal(registry.getDocument().activeProviderId, "provider-1");
  assert.equal(registry.clearActiveIf("provider-1"), true);
  diskBytes = readFileSync(registryPath);
  persistenceOpens = persistenceOpenCount;
  registryRenames = registryRenameCount;
  assert.equal(registry.clearActiveIf("provider-1"), false);
  assert.equal(persistenceOpenCount, persistenceOpens);
  assert.equal(registryRenameCount, registryRenames);
  assert.deepEqual(readFileSync(registryPath), diskBytes);
  assert.equal(registry.getDocument().activeProviderId, null);

  assert.throws(
    () => registry.setActiveIfNull("missing"),
    assertCrpError("PROVIDER_NOT_FOUND", 404)
  );
  assert.throws(
    () => registry.clearActiveIf("missing"),
    assertCrpError("PROVIDER_NOT_FOUND", 404)
  );
});

test("multi-instance initial activation compare-and-set is first-wins", (t) => {
  const { registryPath } = makeTempRegistry(t, "crp-provider-active-first-wins-");
  let staleInstanceRegistryRenames = 0;
  const first = new ProviderRegistry({
    path: registryPath,
    createId: makeIds("provider-1", "provider-2"),
    now: () => FIXED_NOW
  });
  const staleSecond = new ProviderRegistry({
    path: registryPath,
    now: () => FIXED_NOW,
    fileOperations: {
      ...realFileOperations,
      renameSync(source, destination) {
        if (destination === registryPath) staleInstanceRegistryRenames += 1;
        return realFileOperations.renameSync(source, destination);
      }
    }
  });
  first.create(validInput({ name: "Primary" }));
  first.create(validInput({
    name: "Backup",
    baseUrl: "https://backup.example/v1",
    credentialRef: "provider-2"
  }));

  assert.equal(first.setActiveIfNull("provider-1"), true);
  const firstWinnerBytes = readFileSync(registryPath);
  assert.equal(staleSecond.setActiveIfNull("provider-2"), false);
  assert.equal(staleInstanceRegistryRenames, 0);
  assert.deepEqual(readFileSync(registryPath), firstWinnerBytes);
  assert.equal(staleSecond.getDocument().activeProviderId, "provider-1");

  assert.equal(staleSecond.clearActiveIf("provider-2"), false);
  assert.equal(staleInstanceRegistryRenames, 0);
  assert.deepEqual(readFileSync(registryPath), firstWinnerBytes);
  assert.equal(first.clearActiveIf("provider-1"), true);
  assert.equal(staleSecond.setActiveIfNull("provider-2"), true);
  assert.equal(first.getDocument().activeProviderId, "provider-2");
});

test("preserves tests for name edits and invalidates them for operational changes", (t) => {
  const { registryPath } = makeTempRegistry(t, "crp-provider-test-invalidation-");
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW
  });
  registry.create(validInput());
  registry.markTest("provider-1", { status: "passed", code: null });

  const renamed = registry.update("provider-1", { name: "Primary" });
  assert.equal(renamed.lastTestAt, FIXED_NOW);
  assert.equal(renamed.lastTestStatus, "passed");
  assert.equal(renamed.lastTestCode, null);

  const operationalPatches = [
    { baseUrl: "https://alternate.example/v1" },
    { authHeader: "x-provider-auth" },
    { authScheme: "Token" },
    { extraHeaders: { "x-region": "eu-west" } },
    { modelMode: "override", modelOverride: "compatible-model-a" },
    { modelOverride: "compatible-model-b" }
  ];
  for (const patch of operationalPatches) {
    registry.markTest("provider-1", { status: "passed", code: null });
    const updated = registry.update("provider-1", patch);
    assert.equal(updated.lastTestAt, null);
    assert.equal(updated.lastTestStatus, "untested");
    assert.equal(updated.lastTestCode, null);
  }
});

test("reloads the complete persisted document", (t) => {
  const { registryPath } = makeTempRegistry(t);
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: makeClock(FIXED_NOW, LATER_NOW, LATER_NOW, LATER_NOW)
  });

  registry.create(validInput({
    extraHeaders: { "x-region": "eu-west" },
    modelMode: "override",
    modelOverride: "provider-model"
  }));
  registry.markTest("provider-1", { status: "passed", code: null });
  registry.setActive("provider-1");
  const beforeReload = registry.getDocument();

  const reloaded = new ProviderRegistry({ path: registryPath });
  assert.deepEqual(reloaded.getDocument(), beforeReload);
  assert.deepEqual(reloaded.getActive(), beforeReload.providers[0]);
});

test("rejects malformed JSON and invalid schema-version-2 documents", (t) => {
  const { tempDir } = makeTempRegistry(t, "crp-provider-invalid-");
  const documents = [
    "{ malformed",
    `${JSON.stringify({ schemaVersion: 1, activeProviderId: null, providers: [], settings: DEFAULT_SETTINGS })}\n`,
    `${JSON.stringify({ schemaVersion: 2, activeProviderId: null, providers: {}, settings: DEFAULT_SETTINGS })}\n`,
    `${JSON.stringify({ schemaVersion: 2, activeProviderId: "missing", providers: [], settings: DEFAULT_SETTINGS })}\n`,
    `${JSON.stringify({
      schemaVersion: 2,
      activeProviderId: null,
      providers: [],
      settings: { ...DEFAULT_SETTINGS, proxyPort: 15102 }
    })}\n`,
    `${JSON.stringify({
      schemaVersion: 2,
      activeProviderId: null,
      providers: [{
        ...normalizeProvider(validInput(), { id: "provider-1", now: FIXED_NOW }),
        lastTestStatus: "unknown"
      }],
      settings: DEFAULT_SETTINGS
    })}\n`,
    `${JSON.stringify({
      schemaVersion: 2,
      activeProviderId: null,
      providers: [{
        ...normalizeProvider(validInput(), { id: "provider-1", now: FIXED_NOW }),
        lastTestAt: "2026-07-09T23:59:59.000Z",
        lastTestStatus: "passed"
      }],
      settings: DEFAULT_SETTINGS
    })}\n`,
    `${JSON.stringify({
      schemaVersion: 2,
      activeProviderId: null,
      providers: [{
        ...normalizeProvider(validInput(), { id: "provider-1", now: FIXED_NOW }),
        lastTestAt: LATER_NOW,
        lastTestStatus: "passed"
      }],
      settings: DEFAULT_SETTINGS
    })}\n`
  ];

  for (const [index, bytes] of documents.entries()) {
    const registryPath = join(tempDir, `providers-${index}.json`);
    writeFileSync(registryPath, bytes, "utf8");
    assert.throws(
      () => new ProviderRegistry({ path: registryPath }),
      assertCrpError("PROVIDER_REGISTRY_INVALID", 500)
    );
    assert.equal(readFileSync(registryPath, "utf8"), bytes);
  }
});

test("persists through a same-directory fsynced rename with mode 0600", (t) => {
  const { tempDir, registryPath } = makeTempRegistry(t, "crp-provider-atomic-");
  const lockPath = `${registryPath}.crp.lock`;
  const operations = [];
  const fileOperations = {
    ...realFileOperations,
    openSync(path, flags, mode) {
      operations.push(["open", path, flags, mode]);
      return realFileOperations.openSync(path, flags, mode);
    },
    fsyncSync(fd) {
      operations.push(["fsync", fd]);
      return realFileOperations.fsyncSync(fd);
    },
    chmodSync(path, mode) {
      operations.push(["chmod", path, mode]);
      return realFileOperations.chmodSync(path, mode);
    },
    renameSync(source, destination) {
      operations.push(["rename", source, destination]);
      return realFileOperations.renameSync(source, destination);
    },
    rmSync(path, options) {
      operations.push(["rm", path]);
      return realFileOperations.rmSync(path, options);
    }
  };
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW,
    fileOperations
  });

  registry.create(validInput());

  const lockOpenIndex = operations.findIndex(([name, path]) => (
    name === "open" && path === lockPath
  ));
  const tempOpenIndex = operations.findIndex(([name, path]) => (
    name === "open" && path !== lockPath
  ));
  const fsyncIndex = operations.findIndex(([name]) => name === "fsync");
  const renameIndex = operations.findIndex(([name]) => name === "rename");
  const lockRemovalIndex = operations.findIndex(([name, path]) => (
    name === "rm" && path === lockPath
  ));
  const lockOpen = operations[lockOpenIndex];
  const open = operations[tempOpenIndex];
  const rename = operations[renameIndex];
  assert.ok(lockOpenIndex > -1);
  assert.equal(lockOpen[2], "wx");
  assert.equal(lockOpen[3], 0o600);
  assert.equal(dirname(open[1]), tempDir);
  assert.equal(open[2], "wx");
  assert.equal(open[3], 0o600);
  assert.equal(dirname(rename[1]), tempDir);
  assert.equal(rename[2], registryPath);
  assert.ok(lockOpenIndex < tempOpenIndex);
  assert.ok(tempOpenIndex < fsyncIndex && fsyncIndex < renameIndex);
  assert.ok(renameIndex < lockRemovalIndex);
  if (process.platform !== "win32") {
    assert.equal(statSync(registryPath).mode & 0o777, 0o600);
  } else {
    assert.doesNotThrow(() => readFileSync(registryPath));
  }
  assert.deepEqual(listTempFiles(tempDir, registryPath), []);
  assert.equal(existsSync(lockPath), false);
});

test("returns a durable result after a one-shot registry lock close failure", (t) => {
  const { registryPath } = makeTempRegistry(t, "crp-provider-lock-close-retry-");
  const lockPath = `${registryPath}.crp.lock`;
  let lockFileDescriptor;
  let lockCloseAttempts = 0;
  let registryRenameCount = 0;
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW,
    fileOperations: {
      ...realFileOperations,
      openSync(path, flags, mode) {
        const fileDescriptor = realFileOperations.openSync(path, flags, mode);
        if (path === lockPath) {
          lockFileDescriptor = fileDescriptor;
        }
        return fileDescriptor;
      },
      closeSync(fileDescriptor) {
        if (fileDescriptor === lockFileDescriptor) {
          lockCloseAttempts += 1;
          if (lockCloseAttempts === 1) {
            realFileOperations.closeSync(fileDescriptor);
            throw makeFileError("forced one-shot lock close failure", "EIO");
          }
        }
        return realFileOperations.closeSync(fileDescriptor);
      },
      renameSync(source, destination) {
        if (destination === registryPath) {
          registryRenameCount += 1;
        }
        return realFileOperations.renameSync(source, destination);
      }
    }
  });

  const created = registry.create(validInput());

  assert.equal(created.id, "provider-1");
  assert.equal(lockCloseAttempts, 2);
  assert.equal(registryRenameCount, 1);
  assert.equal(registry.document.providers.length, 1);
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).providers.length, 1);
  assert.equal(existsSync(lockPath), false);
});

test("returns a durable result after a one-shot registry lock removal failure", (t) => {
  const { registryPath } = makeTempRegistry(t, "crp-provider-lock-rm-retry-");
  const lockPath = `${registryPath}.crp.lock`;
  let lockRemovalAttempts = 0;
  let registryRenameCount = 0;
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW,
    fileOperations: {
      ...realFileOperations,
      rmSync(path, options) {
        if (path === lockPath) {
          lockRemovalAttempts += 1;
          if (lockRemovalAttempts === 1) {
            throw makeFileError("forced one-shot lock removal failure", "EBUSY");
          }
        }
        return realFileOperations.rmSync(path, options);
      },
      renameSync(source, destination) {
        if (destination === registryPath) {
          registryRenameCount += 1;
        }
        return realFileOperations.renameSync(source, destination);
      }
    }
  });

  const created = registry.create(validInput());

  assert.equal(created.id, "provider-1");
  assert.equal(lockRemovalAttempts, 2);
  assert.equal(registryRenameCount, 1);
  assert.equal(registry.document.providers.length, 1);
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).providers.length, 1);
  assert.equal(existsSync(lockPath), false);
});

test("preserves a primary persistence error when lock cleanup transiently fails", (t) => {
  const { tempDir, registryPath } = makeTempRegistry(t, "crp-provider-primary-error-");
  const lockPath = `${registryPath}.crp.lock`;
  const initial = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW
  });
  initial.create(validInput());
  const originalBytes = readFileSync(registryPath);
  const renameError = makeFileError("forced primary rename failure", "EIO");
  let lockRemovalAttempts = 0;
  const registry = new ProviderRegistry({
    path: registryPath,
    now: () => LATER_NOW,
    fileOperations: {
      ...realFileOperations,
      renameSync() {
        throw renameError;
      },
      rmSync(path, options) {
        if (path === lockPath) {
          lockRemovalAttempts += 1;
          if (lockRemovalAttempts === 1) {
            throw makeFileError("forced transient cleanup failure", "EBUSY");
          }
        }
        return realFileOperations.rmSync(path, options);
      }
    }
  });
  const originalDocument = structuredClone(registry.document);

  assert.throws(
    () => registry.update("provider-1", { name: "Updated" }),
    (error) => error === renameError
  );
  assert.equal(lockRemovalAttempts, 2);
  assert.deepEqual(readFileSync(registryPath), originalBytes);
  assert.deepEqual(registry.document, originalDocument);
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(listTempFiles(tempDir, registryPath), []);
});

test("reports a durable mutation with a permanently degraded owned lock", (t) => {
  const { registryPath } = makeTempRegistry(t, "crp-provider-lock-degraded-");
  const lockPath = `${registryPath}.crp.lock`;
  let lockRemovalAttempts = 0;
  let lockReadAttempts = 0;
  let rejectLockRemoval = true;
  let lockOpenAttempts = 0;
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW,
    fileOperations: {
      ...realFileOperations,
      openSync(path, flags, mode) {
        if (path === lockPath) {
          lockOpenAttempts += 1;
        }
        return realFileOperations.openSync(path, flags, mode);
      },
      readFileSync(path, ...args) {
        if (path === lockPath) {
          lockReadAttempts += 1;
        }
        return realFileOperations.readFileSync(path, ...args);
      },
      rmSync(path, options) {
        if (path === lockPath) {
          lockRemovalAttempts += 1;
          if (rejectLockRemoval) {
            throw makeFileError("forced permanent lock removal failure", "EACCES");
          }
        }
        return realFileOperations.rmSync(path, options);
      }
    }
  });

  assert.throws(
    () => registry.create(validInput()),
    (error) => {
      assert.ok(error instanceof CrpError);
      assert.equal(error.code, "PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED");
      assert.equal(error.status, 500);
      assert.deepEqual(error.details, { committed: true });
      assert.doesNotMatch(error.action, /retry|try again/i);
      return true;
    }
  );
  assert.equal(registry.document.providers.length, 1);
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).providers.length, 1);
  assert.equal(existsSync(lockPath), true);

  const foreignLockBytes = Buffer.from("foreign-owner\n", "utf8");
  writeFileSync(lockPath, foreignLockBytes);
  rejectLockRemoval = false;
  const lockReadAttemptsBeforeRetry = lockReadAttempts;
  const lockRemovalAttemptsBeforeRetry = lockRemovalAttempts;
  const lockOpenAttemptsBeforeRetry = lockOpenAttempts;
  assert.throws(
    () => registry.update("provider-1", { name: "Updated" }),
    assertCrpError("PROVIDER_REGISTRY_LOCK_DEGRADED", 500)
  );
  assert.equal(lockReadAttempts, lockReadAttemptsBeforeRetry);
  assert.equal(lockRemovalAttempts, lockRemovalAttemptsBeforeRetry);
  assert.equal(lockOpenAttempts, lockOpenAttemptsBeforeRetry);
  assert.deepEqual(readFileSync(lockPath), foreignLockBytes);
  assert.equal(lockOpenAttempts, 1);
  assert.equal(registry.document.providers[0].name, "OpenRouter");
});

test("validation failures preserve disk bytes and in-memory state", (t) => {
  const { tempDir, registryPath } = makeTempRegistry(t, "crp-provider-validation-rollback-");
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: makeIds("provider-1", "provider-2"),
    now: () => FIXED_NOW
  });
  registry.create(validInput());
  const originalBytes = readFileSync(registryPath);
  const originalDocument = registry.getDocument();
  const originalDocumentBytes = JSON.stringify(originalDocument);

  assert.throws(
    () => registry.create(validInput({
      name: "OPENROUTER",
      credentialRef: "provider-2"
    })),
    assertCrpError("PROVIDER_NAME_CONFLICT", 409)
  );
  assert.deepEqual(readFileSync(registryPath), originalBytes);
  assert.deepEqual(registry.getDocument(), originalDocument);
  assert.equal(JSON.stringify(registry.getDocument()), originalDocumentBytes);
  assert.deepEqual(listTempFiles(tempDir, registryPath), []);
});

test("rename failures preserve disk bytes and in-memory state and clean the temp file", (t) => {
  const { tempDir, registryPath } = makeTempRegistry(t, "crp-provider-rename-rollback-");
  const initial = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW
  });
  initial.create(validInput());
  const originalBytes = readFileSync(registryPath);
  const renameError = new Error("forced provider registry rename failure");
  const registry = new ProviderRegistry({
    path: registryPath,
    now: () => LATER_NOW,
    fileOperations: {
      ...realFileOperations,
      renameSync() {
        throw renameError;
      }
    }
  });
  const originalDocument = registry.getDocument();

  assert.throws(
    () => registry.update("provider-1", { name: "Updated" }),
    (error) => error === renameError
  );
  assert.deepEqual(readFileSync(registryPath), originalBytes);
  assert.deepEqual(registry.getDocument(), originalDocument);
  assert.deepEqual(listTempFiles(tempDir, registryPath), []);
});

test("list, get, getActive, and getDocument return defensive copies", (t) => {
  const { registryPath } = makeTempRegistry(t);
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW
  });
  registry.create(validInput({ extraHeaders: { "x-region": "original" } }));
  registry.setActive("provider-1");

  const listed = registry.list();
  listed[0].name = "Mutated";
  listed[0].extraHeaders["x-region"] = "mutated";
  listed.push({ id: "injected" });

  const fetched = registry.get("provider-1");
  fetched.name = "Mutated again";
  fetched.extraHeaders.injected = "value";

  const active = registry.getActive();
  active.name = "Mutated active";

  const document = registry.getDocument();
  document.activeProviderId = null;
  document.providers.length = 0;
  document.settings.proxyPort = 9999;

  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("provider-1").name, "OpenRouter");
  assert.deepEqual(registry.get("provider-1").extraHeaders, { "x-region": "original" });
  assert.equal(registry.getActive().id, "provider-1");
  assert.equal(registry.getDocument().activeProviderId, "provider-1");
  assert.equal(registry.getDocument().settings.proxyPort, 15100);
});

test("toPublicProvider returns an exact allowlisted shape with a boolean credential flag", () => {
  const credentialReference = "credential-reference";
  const futureSensitiveValue = "future-sensitive-placeholder";
  const profile = {
    ...normalizeProvider(validInput({ credentialRef: credentialReference }), {
      id: "provider-1",
      now: FIXED_NOW
    }),
    futureSecretField: futureSensitiveValue,
    futureInternalState: { value: futureSensitiveValue }
  };

  const publicProvider = toPublicProvider(profile, true);
  const serialized = JSON.stringify(publicProvider);
  assert.deepEqual(Object.keys(publicProvider), [
    "id",
    "name",
    "baseUrl",
    "authHeader",
    "authScheme",
    "extraHeaders",
    "modelMode",
    "modelOverride",
    "lastTestAt",
    "lastTestStatus",
    "lastTestCode",
    "createdAt",
    "updatedAt",
    "credentialConfigured"
  ]);
  assert.equal(Object.hasOwn(publicProvider, "credentialRef"), false);
  assert.equal(publicProvider.credentialConfigured, true);
  assert.doesNotMatch(serialized, new RegExp(credentialReference));
  assert.doesNotMatch(serialized, new RegExp(futureSensitiveValue));
  assert.throws(
    () => toPublicProvider(profile, "true"),
    assertCrpError("PROVIDER_INPUT_INVALID", 400)
  );
});

test("an absent registry file stays absent until the first successful mutation", (t) => {
  const { registryPath } = makeTempRegistry(t, "crp-provider-lazy-create-");
  const registry = new ProviderRegistry({
    path: registryPath,
    createId: () => "provider-1",
    now: () => FIXED_NOW
  });

  assert.equal(realFileOperations.existsSync(registryPath), false);
  assert.deepEqual(registry.list(), []);
  assert.equal(realFileOperations.existsSync(registryPath), false);

  assert.throws(
    () => registry.create(validInput({ baseUrl: "http://remote.example/v1" })),
    assertCrpError("PROVIDER_INPUT_INVALID", 400)
  );
  assert.equal(realFileOperations.existsSync(registryPath), false);

  registry.create(validInput());
  assert.equal(realFileOperations.existsSync(registryPath), true);
});
