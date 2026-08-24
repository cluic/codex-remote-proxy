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

import {
  MAX_MODEL_ID_LENGTH,
  MAX_PROVIDER_MODELS,
  ProviderModelCache,
  createProviderSourceFingerprint
} from "../src/providers/provider-model-cache.mjs";
import { normalizeProvider } from "../src/providers/provider-schema.mjs";
import { CrpError } from "../src/shared/errors.mjs";

const FETCHED_AT = "2026-07-16T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const MAX_CACHE_ENTRIES = 512;
const MAX_CACHE_FILE_BYTES = 16 * 1024 * 1024;

function makeTempCache(t, prefix = "crp-provider-model-cache-") {
  const tempDir = mkdtempSync(join(os.tmpdir(), prefix));
  const cachePath = join(tempDir, "provider-model-cache.json");
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  return { tempDir, cachePath };
}

function validEntry(overrides = {}) {
  return {
    providerId: "provider-1",
    sourceFingerprint: FINGERPRINT,
    fetchedAt: FETCHED_AT,
    models: ["gpt-alpha", "gpt-beta"],
    ...overrides
  };
}

function validEntries(count, entry = {}) {
  return Array.from({ length: count }, (_, index) => validEntry({
    providerId: `provider-${index + 1}`,
    models: [`model-${index + 1}`],
    ...entry
  }));
}

function missing(providerId = "provider-1") {
  return {
    providerId,
    state: "missing",
    fetchedAt: null,
    expiresAt: null,
    models: []
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

function listTempFiles(tempDir, cachePath) {
  const cacheName = basename(cachePath);
  return readdirSync(tempDir).filter((name) => (
    name.startsWith(`.${cacheName}.`) && name.endsWith(".tmp")
  ));
}

function makeFileError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

test("keeps an absent cache lazy and returns the exact missing projection", (t) => {
  const { cachePath } = makeTempCache(t);
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT
  });

  assert.deepEqual(cache.get("provider-1", FINGERPRINT), missing());
  assert.deepEqual(Object.keys(cache.get("provider-1")), [
    "providerId",
    "state",
    "fetchedAt",
    "expiresAt",
    "models"
  ]);
  assert.equal(existsSync(cachePath), false);
});

test("persists schema 1 entries and returns fresh defensive public projections", (t) => {
  const { cachePath } = makeTempCache(t);
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT
  });

  const stored = cache.put(validEntry());
  assert.deepEqual(stored, {
    providerId: "provider-1",
    state: "fresh",
    fetchedAt: FETCHED_AT,
    expiresAt: "2026-07-17T00:00:00.000Z",
    models: ["gpt-alpha", "gpt-beta"]
  });
  const document = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.deepEqual(document, {
    schemaVersion: 1,
    entries: [validEntry()]
  });
  if (process.platform !== "win32") {
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  }

  const first = cache.get("provider-1", FINGERPRINT);
  first.models.push("mutated");
  assert.deepEqual(cache.get("provider-1", FINGERPRINT).models, [
    "gpt-alpha",
    "gpt-beta"
  ]);
  assert.equal(Object.hasOwn(first, "sourceFingerprint"), false);
});

test("fingerprints only canonical non-credential request settings", () => {
  const firstCredential = "first-credential-placeholder";
  const secondCredential = "second-credential-placeholder";
  const first = createProviderSourceFingerprint({
    baseUrl: "https://example.test/v1",
    modelsPath: "/models",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: { "x-region": "east", "x-tenant": "one" },
    credentialRef: firstCredential,
    apiKey: firstCredential,
    modelMode: "passthrough"
  });
  const reordered = createProviderSourceFingerprint({
    baseUrl: "https://example.test/v1",
    modelsPath: "/models",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: { "x-tenant": "one", "x-region": "east" },
    credentialRef: secondCredential,
    apiKey: secondCredential,
    modelMode: "override",
    modelOverride: "ignored-model"
  });

  assert.doesNotMatch(first, new RegExp(firstCredential));
  assert.doesNotMatch(reordered, new RegExp(secondCredential));
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, reordered);
  assert.notEqual(first, createProviderSourceFingerprint({
    baseUrl: "https://other.example.test/v1",
    modelsPath: "/models",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: { "x-region": "east", "x-tenant": "one" }
  }));
  assert.notEqual(first, createProviderSourceFingerprint({
    baseUrl: "https://example.test/v1",
    modelsPath: "/catalog/models",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: { "x-region": "east", "x-tenant": "one" }
  }));
});

test("fingerprints provider-valid empty auth schemes and header values", () => {
  assert.match(createProviderSourceFingerprint({
    baseUrl: "https://example.test/v1",
    modelsPath: "/models",
    authHeader: "x-api-key",
    authScheme: "",
    extraHeaders: { "x-optional-context": "" }
  }), /^sha256:[a-f0-9]{64}$/);
});

test("fingerprints every provider-schema-valid request setting without private length caps", () => {
  const longHeaderName = `x-${"h".repeat(300)}`;
  const profile = normalizeProvider({
    name: "Long but valid request settings",
    baseUrl: `https://example.test/${"p".repeat(3_000)}`,
    credentialRef: "credential-1",
    authHeader: `x-${"a".repeat(300)}`,
    authScheme: "S".repeat(300),
    extraHeaders: {
      [longHeaderName]: "v".repeat(3_000)
    }
  }, {
    id: "provider-1",
    now: FETCHED_AT
  });

  assert.match(createProviderSourceFingerprint(profile), /^sha256:[a-f0-9]{64}$/);
});

test("fingerprints provider-schema-valid Latin-1 obs-text header values", () => {
  const obsText = "\u0080\u0085\u009f\u00ff";
  const profile = normalizeProvider({
    name: "Latin-1 header",
    baseUrl: "https://example.test/v1",
    credentialRef: "credential-1",
    extraHeaders: { "x-legacy-context": obsText }
  }, {
    id: "provider-1",
    now: FETCHED_AT
  });

  assert.equal(profile.extraHeaders["x-legacy-context"], obsText);
  assert.match(createProviderSourceFingerprint(profile), /^sha256:[a-f0-9]{64}$/);
});

test("classifies 24-hour fresh and 30-day stale retention boundaries", (t) => {
  const { cachePath } = makeTempCache(t);
  let nowMs = Date.parse(FETCHED_AT);
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => new Date(nowMs).toISOString()
  });
  cache.put(validEntry());

  nowMs = Date.parse(FETCHED_AT) + DAY_MS - 1;
  assert.equal(cache.get("provider-1", FINGERPRINT).state, "fresh");
  nowMs = Date.parse(FETCHED_AT) + DAY_MS;
  assert.equal(cache.get("provider-1", FINGERPRINT).state, "stale");
  nowMs = Date.parse(FETCHED_AT) + (30 * DAY_MS) - 1;
  assert.equal(cache.get("provider-1", FINGERPRINT).state, "stale");
  nowMs = Date.parse(FETCHED_AT) + (30 * DAY_MS);
  assert.deepEqual(cache.get("provider-1", FINGERPRINT), missing());
});

test("treats a source mismatch or future entry as missing", (t) => {
  const { cachePath } = makeTempCache(t);
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT
  });
  cache.put(validEntry());

  assert.deepEqual(
    cache.get("provider-1", `sha256:${"b".repeat(64)}`),
    missing()
  );
  cache.put(validEntry({
    providerId: "provider-future",
    fetchedAt: "2026-07-16T00:00:00.001Z"
  }));
  assert.deepEqual(
    cache.get("provider-future", FINGERPRINT),
    missing("provider-future")
  );
});

test("updates entries, deletes them durably, and avoids creating on no-op delete", (t) => {
  const { cachePath } = makeTempCache(t);
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT
  });

  assert.equal(cache.delete("provider-1"), false);
  assert.equal(existsSync(cachePath), false);
  cache.put(validEntry());
  cache.put(validEntry({ models: ["replacement"] }));
  assert.deepEqual(cache.get("provider-1", FINGERPRINT).models, ["replacement"]);
  assert.equal(cache.delete("provider-1"), true);
  assert.deepEqual(cache.get("provider-1", FINGERPRINT), missing());
  assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), {
    schemaVersion: 1,
    entries: []
  });
});

test("enforces exact documents, exact entries, unique providers, and model bounds", (t) => {
  const { tempDir } = makeTempCache(t, "crp-provider-model-cache-invalid-");
  const tooManyModels = Array.from(
    { length: MAX_PROVIDER_MODELS + 1 },
    (_, index) => `model-${index}`
  );
  const invalidDocuments = [
    { schemaVersion: 2, entries: [] },
    { schemaVersion: 1, entries: [], extra: true },
    { schemaVersion: 1, entries: {} },
    { schemaVersion: 1, entries: [{ ...validEntry(), extra: true }] },
    { schemaVersion: 1, entries: [validEntry(), validEntry()] },
    { schemaVersion: 1, entries: [validEntry({ providerId: "" })] },
    { schemaVersion: 1, entries: [validEntry({ sourceFingerprint: "not-a-hash" })] },
    { schemaVersion: 1, entries: [validEntry({ fetchedAt: "not-a-date" })] },
    { schemaVersion: 1, entries: [validEntry({ models: "gpt-alpha" })] },
    { schemaVersion: 1, entries: [validEntry({ models: tooManyModels })] },
    { schemaVersion: 1, entries: [validEntry({ models: [""] })] },
    { schemaVersion: 1, entries: [validEntry({ models: [" padded"] })] },
    { schemaVersion: 1, entries: [validEntry({ models: ["bad\nmodel"] })] },
    {
      schemaVersion: 1,
      entries: [validEntry({ models: ["m".repeat(MAX_MODEL_ID_LENGTH + 1)] })]
    },
    { schemaVersion: 1, entries: [validEntry({ models: ["duplicate", "duplicate"] })] },
    { schemaVersion: 1, entries: validEntries(MAX_CACHE_ENTRIES + 1) }
  ];

  for (const [index, document] of invalidDocuments.entries()) {
    const cachePath = join(tempDir, `invalid-${index}.json`);
    const bytes = `${JSON.stringify(document)}\n`;
    writeFileSync(cachePath, bytes, "utf8");
    const cache = new ProviderModelCache({
      path: cachePath,
      now: () => FETCHED_AT
    });
    assert.deepEqual(cache.get("provider-1", FINGERPRINT), missing());
    assert.equal(readFileSync(cachePath, "utf8"), bytes);
  }
});

test("refuses a 513th cache entry without changing durable bytes", (t) => {
  const { cachePath } = makeTempCache(t, "crp-model-cache-entry-bound-");
  const originalBytes = `${JSON.stringify({
    schemaVersion: 1,
    entries: validEntries(MAX_CACHE_ENTRIES)
  }, null, 2)}\n`;
  writeFileSync(cachePath, originalBytes, "utf8");
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT
  });

  assert.throws(
    () => cache.put(validEntry({
      providerId: `provider-${MAX_CACHE_ENTRIES + 1}`,
      models: ["model-over-limit"]
    })),
    assertCrpError("PROVIDER_MODEL_CACHE_INPUT_INVALID", 400)
  );
  assert.equal(readFileSync(cachePath, "utf8"), originalBytes);
});

test("uses file metadata to reject oversized cache state before reading or parsing it", (t) => {
  const { cachePath } = makeTempCache(t, "crp-model-cache-file-bound-read-");
  const originalBytes = `${JSON.stringify({
    schemaVersion: 1,
    entries: [validEntry()]
  })}\n`;
  writeFileSync(cachePath, originalBytes, "utf8");
  let cacheStatCalls = 0;
  let cacheReadCalls = 0;
  let cacheRenames = 0;
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT,
    fileOperations: {
      ...realFileOperations,
      statSync(path, options) {
        if (path === cachePath) {
          cacheStatCalls += 1;
          const stats = realFileOperations.statSync(path, options);
          stats.size = MAX_CACHE_FILE_BYTES + 1;
          return stats;
        }
        return realFileOperations.statSync(path, options);
      },
      readFileSync(path, ...args) {
        if (path === cachePath) cacheReadCalls += 1;
        return realFileOperations.readFileSync(path, ...args);
      },
      renameSync(source, destination) {
        if (destination === cachePath) cacheRenames += 1;
        return realFileOperations.renameSync(source, destination);
      }
    }
  });

  assert.deepEqual(cache.get("provider-1", FINGERPRINT), missing());
  assert.equal(cacheStatCalls, 1);
  assert.equal(cacheReadCalls, 0);
  assert.throws(
    () => cache.put(validEntry({ models: ["must-not-overwrite"] })),
    assertCrpError("PROVIDER_MODEL_CACHE_INVALID", 500)
  );
  assert.equal(cacheReadCalls, 0);
  assert.equal(cacheRenames, 0);
  assert.equal(readFileSync(cachePath, "utf8"), originalBytes);
});

test("rejects an over-16-MiB put candidate before writing and preserves prior bytes", (t) => {
  const { cachePath } = makeTempCache(t, "crp-model-cache-file-bound-put-");
  const largeEntries = [];
  let rejectedEntry = null;
  for (let entryIndex = 0; entryIndex < MAX_CACHE_ENTRIES; entryIndex += 1) {
    const models = Array.from({ length: MAX_PROVIDER_MODELS }, (_, modelIndex) => {
      const prefix = `${entryIndex}-${modelIndex}-`;
      return `${prefix}${"\u{1f4be}".repeat(MAX_MODEL_ID_LENGTH - [...prefix].length)}`;
    });
    const candidate = validEntry({
      providerId: `large-provider-${entryIndex}`,
      models
    });
    const candidateBytes = `${JSON.stringify({
      schemaVersion: 1,
      entries: [...largeEntries, candidate]
    }, null, 2)}\n`;
    if (Buffer.byteLength(candidateBytes, "utf8") > MAX_CACHE_FILE_BYTES) {
      rejectedEntry = candidate;
      break;
    }
    largeEntries.push(candidate);
  }
  assert.notEqual(rejectedEntry, null);
  const originalBytes = `${JSON.stringify({
    schemaVersion: 1,
    entries: largeEntries
  }, null, 2)}\n`;
  assert.ok(Buffer.byteLength(originalBytes, "utf8") <= MAX_CACHE_FILE_BYTES);
  writeFileSync(cachePath, originalBytes, "utf8");
  let cacheTempOpens = 0;
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT,
    fileOperations: {
      ...realFileOperations,
      openSync(path, ...args) {
        if (path !== `${cachePath}.crp.lock`) cacheTempOpens += 1;
        return realFileOperations.openSync(path, ...args);
      }
    }
  });

  assert.throws(
    () => cache.put(rejectedEntry),
    assertCrpError("PROVIDER_MODEL_CACHE_INPUT_INVALID", 400)
  );
  assert.equal(cacheTempOpens, 0);
  assert.equal(readFileSync(cachePath, "utf8"), originalBytes);
});

test("rejects invalid put inputs before creating persistent state", (t) => {
  const { cachePath } = makeTempCache(t);
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT
  });

  assert.throws(
    () => cache.put({ ...validEntry(), extra: true }),
    assertCrpError("PROVIDER_MODEL_CACHE_INPUT_INVALID", 400)
  );
  assert.throws(
    () => cache.put(validEntry({ models: ["duplicate", "duplicate"] })),
    assertCrpError("PROVIDER_MODEL_CACHE_INPUT_INVALID", 400)
  );
  assert.equal(existsSync(cachePath), false);
});

test("isolates corrupt state on reads but refuses to overwrite or delete it", (t) => {
  const { cachePath } = makeTempCache(t);
  const corruptBytes = "{ definitely-not-json\n";
  writeFileSync(cachePath, corruptBytes, "utf8");
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT
  });

  assert.deepEqual(cache.get("provider-1", FINGERPRINT), missing());
  assert.equal(readFileSync(cachePath, "utf8"), corruptBytes);
  assert.throws(
    () => cache.put(validEntry()),
    assertCrpError("PROVIDER_MODEL_CACHE_INVALID", 500)
  );
  assert.throws(
    () => cache.delete("provider-1"),
    assertCrpError("PROVIDER_MODEL_CACHE_INVALID", 500)
  );
  assert.equal(readFileSync(cachePath, "utf8"), corruptBytes);
});

test("persists with an exclusive owned lock and same-directory fsynced rename", (t) => {
  const { tempDir, cachePath } = makeTempCache(t, "crp-model-cache-atomic-");
  const lockPath = `${cachePath}.crp.lock`;
  const operations = [];
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT,
    fileOperations: {
      ...realFileOperations,
      openSync(path, flags, mode) {
        operations.push(["open", path, flags, mode]);
        return realFileOperations.openSync(path, flags, mode);
      },
      fsyncSync(fileDescriptor) {
        operations.push(["fsync", fileDescriptor]);
        return realFileOperations.fsyncSync(fileDescriptor);
      },
      renameSync(source, destination) {
        operations.push(["rename", source, destination]);
        return realFileOperations.renameSync(source, destination);
      },
      rmSync(path, options) {
        operations.push(["rm", path]);
        return realFileOperations.rmSync(path, options);
      }
    }
  });

  cache.put(validEntry());

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
  const tempOpen = operations[tempOpenIndex];
  const rename = operations[renameIndex];

  assert.equal(lockOpen[2], "wx");
  assert.equal(lockOpen[3], 0o600);
  assert.equal(dirname(tempOpen[1]), tempDir);
  assert.equal(tempOpen[2], "wx");
  assert.equal(tempOpen[3], 0o600);
  assert.equal(dirname(rename[1]), tempDir);
  assert.equal(rename[2], cachePath);
  assert.ok(lockOpenIndex < tempOpenIndex);
  assert.ok(tempOpenIndex < fsyncIndex && fsyncIndex < renameIndex);
  assert.ok(renameIndex < lockRemovalIndex);
  assert.deepEqual(listTempFiles(tempDir, cachePath), []);
  assert.equal(existsSync(lockPath), false);
});

test("does not disturb a foreign lock or create cache state", (t) => {
  const { cachePath } = makeTempCache(t, "crp-model-cache-foreign-lock-");
  const lockPath = `${cachePath}.crp.lock`;
  const foreignBytes = "foreign-owner\n";
  writeFileSync(lockPath, foreignBytes, { mode: 0o600 });
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT
  });

  assert.throws(
    () => cache.put(validEntry()),
    assertCrpError("PROVIDER_MODEL_CACHE_BUSY", 409)
  );
  assert.equal(readFileSync(lockPath, "utf8"), foreignBytes);
  assert.equal(existsSync(cachePath), false);
});

test("preserves durable bytes and cleans temporary state on rename failure", (t) => {
  const { tempDir, cachePath } = makeTempCache(t, "crp-model-cache-rollback-");
  const initial = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT
  });
  initial.put(validEntry());
  const originalBytes = readFileSync(cachePath);
  const renameError = makeFileError("forced cache rename failure", "EIO");
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT,
    fileOperations: {
      ...realFileOperations,
      renameSync() {
        throw renameError;
      }
    }
  });

  assert.throws(
    () => cache.put(validEntry({ models: ["replacement"] })),
    (error) => error === renameError
  );
  assert.deepEqual(readFileSync(cachePath), originalBytes);
  assert.deepEqual(listTempFiles(tempDir, cachePath), []);
  assert.equal(existsSync(`${cachePath}.crp.lock`), false);
});

test("retries transient owned-lock cleanup without repeating a mutation", (t) => {
  const { cachePath } = makeTempCache(t, "crp-model-cache-lock-retry-");
  const lockPath = `${cachePath}.crp.lock`;
  let removalAttempts = 0;
  let renameCount = 0;
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT,
    fileOperations: {
      ...realFileOperations,
      rmSync(path, options) {
        if (path === lockPath) {
          removalAttempts += 1;
          if (removalAttempts === 1) {
            throw makeFileError("forced transient removal failure", "EBUSY");
          }
        }
        return realFileOperations.rmSync(path, options);
      },
      renameSync(source, destination) {
        if (destination === cachePath) renameCount += 1;
        return realFileOperations.renameSync(source, destination);
      }
    }
  });

  assert.equal(cache.put(validEntry()).state, "fresh");
  assert.equal(removalAttempts, 2);
  assert.equal(renameCount, 1);
  assert.equal(existsSync(lockPath), false);
});

test("isolates read failures while mutations surface them without creating state", (t) => {
  const { cachePath } = makeTempCache(t, "crp-model-cache-read-failure-");
  writeFileSync(cachePath, `${JSON.stringify({
    schemaVersion: 1,
    entries: [validEntry()]
  })}\n`, "utf8");
  const cache = new ProviderModelCache({
    path: cachePath,
    now: () => FETCHED_AT,
    fileOperations: {
      ...realFileOperations,
      readFileSync(path, ...args) {
        if (path === cachePath) {
          throw makeFileError("forced cache read failure", "EACCES");
        }
        return realFileOperations.readFileSync(path, ...args);
      }
    }
  });

  assert.deepEqual(cache.get("provider-1", FINGERPRINT), missing());
  assert.throws(
    () => cache.put(validEntry()),
    assertCrpError("PROVIDER_MODEL_CACHE_READ_FAILED", 500)
  );
});
