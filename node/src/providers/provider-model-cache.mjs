import { createHash, randomUUID } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { CrpError } from "../shared/errors.mjs";

export const MAX_PROVIDER_MODELS = 2_000;
export const MAX_MODEL_ID_LENGTH = 256;
export const MAX_MODEL_CACHE_ENTRIES = 512;
export const MAX_MODEL_CACHE_FILE_BYTES = 16 * 1024 * 1024;
export const MODEL_CACHE_FRESH_TTL_MS = 24 * 60 * 60 * 1_000;
export const MODEL_CACHE_STALE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const DOCUMENT_FIELDS = new Set(["schemaVersion", "entries"]);
const ENTRY_FIELDS = new Set([
  "providerId",
  "sourceFingerprint",
  "fetchedAt",
  "models"
]);
const MAX_PROVIDER_ID_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const PROVIDER_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const HEADER_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SOURCE_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const LOCK_CLEANUP_ATTEMPTS = 2;
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
};

function clone(value) {
  return structuredClone(value);
}

function emptyDocument() {
  return { schemaVersion: 1, entries: [] };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function hasBoundedCodePoints(value, maximum) {
  return value.length <= maximum * 2 && [...value].length <= maximum;
}

function isValidBoundedText(value, maximum, {
  allowEmpty = false,
  trim = false
} = {}) {
  return typeof value === "string"
    && (allowEmpty || value.length > 0)
    && hasBoundedCodePoints(value, maximum)
    && !CONTROL_CHARACTER_PATTERN.test(value)
    && (!trim || value.trim() === value);
}

function parseCanonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? timestamp : null;
}

function cacheInvalid(cause) {
  return new CrpError(
    "PROVIDER_MODEL_CACHE_INVALID",
    "The provider model cache is invalid.",
    "Back up the invalid cache, then remove it before refreshing provider models.",
    { status: 500, cause }
  );
}

function cacheReadFailed(cause) {
  return new CrpError(
    "PROVIDER_MODEL_CACHE_READ_FAILED",
    "The provider model cache could not be read.",
    "Check the cache file permissions and try again.",
    { status: 500, cause }
  );
}

function cacheInputInvalid(cause) {
  return new CrpError(
    "PROVIDER_MODEL_CACHE_INPUT_INVALID",
    "The provider model cache input is invalid.",
    "Provide bounded provider model metadata and try again.",
    { status: 400, cause }
  );
}

function cacheBusy(cause) {
  return new CrpError(
    "PROVIDER_MODEL_CACHE_BUSY",
    "The provider model cache is already being updated.",
    "Wait for the current cache update to finish and try again.",
    { status: 409, cause }
  );
}

function committedLockDegraded() {
  return new CrpError(
    "PROVIDER_MODEL_CACHE_COMMITTED_LOCK_DEGRADED",
    "The provider model cache was saved, but its lock could not be fully released.",
    "Stop CRP, explicitly repair the residual cache lock, then restart CRP.",
    { status: 500, details: { committed: true } }
  );
}

function cacheLockDegraded() {
  return new CrpError(
    "PROVIDER_MODEL_CACHE_LOCK_DEGRADED",
    "The provider model cache lock could not be safely recovered.",
    "Stop CRP, explicitly repair the residual cache lock, then restart CRP.",
    { status: 500, details: { committed: false } }
  );
}

function assertProviderId(providerId) {
  if (!isValidBoundedText(providerId, MAX_PROVIDER_ID_LENGTH, { trim: true })) {
    throw new Error("invalid provider id");
  }
}

function assertSourceFingerprint(sourceFingerprint) {
  if (typeof sourceFingerprint !== "string"
    || !SOURCE_FINGERPRINT_PATTERN.test(sourceFingerprint)) {
    throw new Error("invalid source fingerprint");
  }
}

function assertModelId(modelId) {
  if (!isValidBoundedText(modelId, MAX_MODEL_ID_LENGTH, { trim: true })) {
    throw new Error("invalid model id");
  }
}

function validateEntry(entry) {
  if (!hasExactFields(entry, ENTRY_FIELDS)) {
    throw new Error("invalid entry fields");
  }
  assertProviderId(entry.providerId);
  assertSourceFingerprint(entry.sourceFingerprint);
  if (parseCanonicalTimestamp(entry.fetchedAt) === null) {
    throw new Error("invalid fetched timestamp");
  }
  if (!Array.isArray(entry.models) || entry.models.length > MAX_PROVIDER_MODELS) {
    throw new Error("invalid model list");
  }
  const modelIds = new Set();
  for (const modelId of entry.models) {
    assertModelId(modelId);
    if (modelIds.has(modelId)) throw new Error("duplicate model id");
    modelIds.add(modelId);
  }
}

function validateDocument(document) {
  try {
    if (!hasExactFields(document, DOCUMENT_FIELDS)) {
      throw new Error("invalid document fields");
    }
    if (document.schemaVersion !== 1 || !Array.isArray(document.entries)
      || document.entries.length > MAX_MODEL_CACHE_ENTRIES) {
      throw new Error("invalid document shape");
    }
    const providerIds = new Set();
    for (const entry of document.entries) {
      validateEntry(entry);
      if (providerIds.has(entry.providerId)) {
        throw new Error("duplicate provider id");
      }
      providerIds.add(entry.providerId);
    }
  } catch (error) {
    if (error instanceof CrpError
      && error.code === "PROVIDER_MODEL_CACHE_INVALID") {
      throw error;
    }
    throw cacheInvalid(error);
  }
}

function validateInputEntry(entry) {
  try {
    validateEntry(entry);
  } catch (error) {
    throw cacheInputInvalid(error);
  }
}

function validateProviderIdInput(providerId) {
  try {
    assertProviderId(providerId);
  } catch (error) {
    throw cacheInputInvalid(error);
  }
}

function validateFingerprintInput(sourceFingerprint) {
  if (sourceFingerprint === undefined) return;
  try {
    assertSourceFingerprint(sourceFingerprint);
  } catch (error) {
    throw cacheInputInvalid(error);
  }
}

function parseDocument(bytes) {
  let document;
  try {
    document = JSON.parse(bytes);
  } catch (error) {
    throw cacheInvalid(error);
  }
  validateDocument(document);
  return document;
}

function serializeBoundedDocument(document) {
  if (document.entries.length === 0) {
    return "{\n  \"schemaVersion\": 1,\n  \"entries\": []\n}\n";
  }
  const prefix = "{\n  \"schemaVersion\": 1,\n  \"entries\": [\n";
  const suffix = "\n  ]\n}\n";
  const fragments = [];
  let byteLength = Buffer.byteLength(prefix, "utf8")
    + Buffer.byteLength(suffix, "utf8");
  for (const entry of document.entries) {
    const fragment = JSON.stringify(entry, null, 2)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    byteLength += Buffer.byteLength(fragment, "utf8")
      + (fragments.length === 0 ? 0 : 2);
    if (byteLength > MAX_MODEL_CACHE_FILE_BYTES) {
      throw cacheInputInvalid(new Error("cache file exceeds the size limit"));
    }
    fragments.push(fragment);
  }
  return `${prefix}${fragments.join(",\n")}${suffix}`;
}

function parseNow(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  throw new TypeError("ProviderModelCache now() must return a valid time.");
}

function missingProjection(providerId) {
  return {
    providerId,
    state: "missing",
    fetchedAt: null,
    expiresAt: null,
    models: []
  };
}

function projectEntry(entry, nowMs) {
  const fetchedAtMs = parseCanonicalTimestamp(entry.fetchedAt);
  const ageMs = nowMs - fetchedAtMs;
  if (ageMs < 0 || ageMs >= MODEL_CACHE_STALE_RETENTION_MS) {
    return missingProjection(entry.providerId);
  }
  return {
    providerId: entry.providerId,
    state: ageMs < MODEL_CACHE_FRESH_TTL_MS ? "fresh" : "stale",
    fetchedAt: entry.fetchedAt,
    expiresAt: new Date(fetchedAtMs + MODEL_CACHE_FRESH_TTL_MS).toISOString(),
    models: [...entry.models]
  };
}

function validateFingerprintSettings(profile) {
  if (!isPlainObject(profile)
    || typeof profile.baseUrl !== "string" || profile.baseUrl.length === 0
    || profile.baseUrl.trim() !== profile.baseUrl
    || PROVIDER_CONTROL_CHARACTER_PATTERN.test(profile.baseUrl)
    || typeof profile.authHeader !== "string" || profile.authHeader.length === 0
    || profile.authHeader.trim() !== profile.authHeader
    || !HEADER_TOKEN_PATTERN.test(profile.authHeader)
    || typeof profile.authScheme !== "string"
    || profile.authScheme.trim() !== profile.authScheme
    || (profile.authScheme.length > 0 && !HEADER_TOKEN_PATTERN.test(profile.authScheme))
    || typeof profile.modelsPath !== "string"
    || profile.modelsPath.length < 2
    || profile.modelsPath.trim() !== profile.modelsPath
    || !profile.modelsPath.startsWith("/")
    || PROVIDER_CONTROL_CHARACTER_PATTERN.test(profile.modelsPath)
    || !isPlainObject(profile.extraHeaders)) {
    throw cacheInputInvalid(new Error("invalid provider request settings"));
  }
  try {
    validateHeaderName(profile.authHeader);
  } catch (error) {
    throw cacheInputInvalid(error);
  }
  const headers = [];
  for (const [name, value] of Object.entries(profile.extraHeaders)) {
    if (typeof value !== "string") {
      throw cacheInputInvalid(new Error("invalid extra header"));
    }
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    } catch (error) {
      throw cacheInputInvalid(error);
    }
    headers.push([name, value]);
  }
  headers.sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  return {
    baseUrl: profile.baseUrl,
    modelsPath: profile.modelsPath,
    authHeader: profile.authHeader,
    authScheme: profile.authScheme,
    extraHeaders: headers
  };
}

export function createProviderSourceFingerprint(profile) {
  const settings = validateFingerprintSettings(profile);
  const digest = createHash("sha256")
    .update(JSON.stringify(settings), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export class ProviderModelCache {
  constructor({
    path,
    now = () => new Date().toISOString(),
    fileOperations
  }) {
    this.path = path;
    this.lockPath = `${path}.crp.lock`;
    this.now = now;
    this.fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...fileOperations };
    this.degradedLock = null;
  }

  #loadStrict() {
    let bytes;
    try {
      const stats = this.fileOperations.statSync(this.path);
      if (!Number.isFinite(stats?.size) || stats.size < 0
        || stats.size > MAX_MODEL_CACHE_FILE_BYTES) {
        throw cacheInvalid(new Error("cache file exceeds the size limit"));
      }
      bytes = this.fileOperations.readFileSync(this.path, "utf8");
      if (Buffer.byteLength(bytes, "utf8") > MAX_MODEL_CACHE_FILE_BYTES) {
        throw cacheInvalid(new Error("cache file exceeds the size limit"));
      }
    } catch (error) {
      if (error?.code === "ENOENT") return emptyDocument();
      if (error instanceof CrpError) throw error;
      throw cacheReadFailed(error);
    }
    return parseDocument(bytes);
  }

  #loadForRead() {
    try {
      return this.#loadStrict();
    } catch {
      return null;
    }
  }

  #acquireLock() {
    this.fileOperations.mkdirSync(dirname(this.path), { recursive: true });
    if (this.degradedLock !== null) throw cacheLockDegraded();

    let fileDescriptor;
    const token = `${randomUUID()}\n`;
    try {
      fileDescriptor = this.fileOperations.openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") throw cacheBusy(error);
      throw error;
    }

    const lock = { fileDescriptor, token };
    try {
      this.fileOperations.writeFileSync(fileDescriptor, token, "utf8");
      return lock;
    } catch (error) {
      const cleanup = this.#releaseLock(lock);
      if (cleanup.residualLock) this.degradedLock = { token };
      throw error;
    }
  }

  #closeLock(fileDescriptor) {
    let error = null;
    for (let attempt = 0; attempt < LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        this.fileOperations.closeSync(fileDescriptor);
        return { closed: true, error: null };
      } catch (caught) {
        if (attempt > 0 && caught?.code === "EBADF") {
          return { closed: true, error: null };
        }
        error = caught;
      }
    }
    return { closed: false, error };
  }

  #removeOwnedLock(token) {
    let error = null;
    for (let attempt = 0; attempt < LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
      let currentToken;
      try {
        currentToken = this.fileOperations.readFileSync(this.lockPath, "utf8");
      } catch (caught) {
        if (caught?.code === "ENOENT") {
          return { removed: true, residualLock: false, foreign: false, error: null };
        }
        error = caught;
        continue;
      }
      if (currentToken !== token) {
        return { removed: false, residualLock: true, foreign: true, error: null };
      }
      try {
        this.fileOperations.rmSync(this.lockPath, { force: true });
        return { removed: true, residualLock: false, foreign: false, error: null };
      } catch (caught) {
        error = caught;
      }
    }
    return {
      removed: false,
      residualLock: this.fileOperations.existsSync(this.lockPath),
      foreign: false,
      error
    };
  }

  #releaseLock(lock) {
    const close = this.#closeLock(lock.fileDescriptor);
    const removal = this.#removeOwnedLock(lock.token);
    return {
      ok: close.closed && removal.removed,
      closeError: close.error,
      removalError: removal.error,
      residualLock: removal.residualLock,
      foreignLock: removal.foreign
    };
  }

  #persist(document) {
    const bytes = serializeBoundedDocument(document);
    const parent = dirname(this.path);
    const tempPath = join(
      parent,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`
    );
    let fileDescriptor;

    this.fileOperations.mkdirSync(parent, { recursive: true });
    try {
      fileDescriptor = this.fileOperations.openSync(tempPath, "wx", 0o600);
      this.fileOperations.writeFileSync(fileDescriptor, bytes, "utf8");
      this.fileOperations.fsyncSync(fileDescriptor);
      this.fileOperations.closeSync(fileDescriptor);
      fileDescriptor = undefined;
      this.fileOperations.chmodSync(tempPath, 0o600);
      this.fileOperations.renameSync(tempPath, this.path);
    } catch (error) {
      if (fileDescriptor !== undefined) {
        try {
          this.fileOperations.closeSync(fileDescriptor);
        } catch {
          // Preserve the original persistence error.
        }
      }
      try {
        this.fileOperations.rmSync(tempPath, { force: true });
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    }
  }

  #commit(mutator) {
    let lock;
    let result;
    let primaryError;
    let committed = false;
    try {
      lock = this.#acquireLock();
      const candidate = clone(this.#loadStrict());
      const mutation = mutator(candidate);
      result = clone(mutation.result);
      if (mutation.changed) {
        validateDocument(candidate);
        this.#persist(candidate);
        committed = true;
      }
    } catch (error) {
      primaryError = error;
    }

    let cleanup = { ok: true, residualLock: false };
    if (lock !== undefined) {
      cleanup = this.#releaseLock(lock);
      if (cleanup.residualLock) {
        this.degradedLock = { token: lock.token };
      } else {
        this.degradedLock = null;
      }
    }

    if (primaryError !== undefined) throw primaryError;
    if (!cleanup.ok) {
      if (committed) throw committedLockDegraded();
      throw cacheLockDegraded();
    }
    return result;
  }

  get(providerId, sourceFingerprint) {
    validateProviderIdInput(providerId);
    validateFingerprintInput(sourceFingerprint);
    const document = this.#loadForRead();
    if (document === null) return missingProjection(providerId);
    const entry = document.entries.find((candidate) => candidate.providerId === providerId);
    if (entry === undefined
      || (sourceFingerprint !== undefined
        && entry.sourceFingerprint !== sourceFingerprint)) {
      return missingProjection(providerId);
    }
    return clone(projectEntry(entry, parseNow(this.now())));
  }

  put(entry) {
    validateInputEntry(entry);
    const stored = clone(entry);
    return this.#commit((document) => {
      const index = document.entries.findIndex((candidate) => (
        candidate.providerId === stored.providerId
      ));
      if (index === -1 && document.entries.length >= MAX_MODEL_CACHE_ENTRIES) {
        throw cacheInputInvalid(new Error("cache entry limit reached"));
      }
      if (index === -1) document.entries.push(stored);
      else document.entries[index] = stored;
      return {
        changed: true,
        result: projectEntry(stored, parseNow(this.now()))
      };
    });
  }

  delete(providerId) {
    validateProviderIdInput(providerId);
    return this.#commit((document) => {
      const index = document.entries.findIndex((entry) => entry.providerId === providerId);
      if (index === -1) return { changed: false, result: false };
      document.entries.splice(index, 1);
      return { changed: true, result: true };
    });
  }
}
