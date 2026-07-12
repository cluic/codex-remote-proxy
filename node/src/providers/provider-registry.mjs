import { randomUUID } from "node:crypto";
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
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { CrpError } from "../shared/errors.mjs";
import {
  normalizeProvider,
  validateProviderInput,
  validateStoredProvider
} from "./provider-schema.mjs";

const DEFAULT_SETTINGS = Object.freeze({
  proxyHost: "127.0.0.1",
  proxyPort: 15100,
  adminHost: "127.0.0.1",
  adminPort: 15101,
  captureEnabled: false
});
const DOCUMENT_FIELDS = new Set([
  "schemaVersion",
  "activeProviderId",
  "providers",
  "settings"
]);
const SETTINGS_FIELDS = new Set(Object.keys(DEFAULT_SETTINGS));
const EDITABLE_FIELDS = new Set([
  "name",
  "baseUrl",
  "authHeader",
  "authScheme",
  "extraHeaders",
  "modelMode",
  "modelOverride"
]);
const IMMUTABLE_FIELDS = new Set(["id", "createdAt", "credentialRef"]);
const TEST_INVALIDATING_FIELDS = [
  "baseUrl",
  "authHeader",
  "authScheme",
  "extraHeaders",
  "modelMode",
  "modelOverride"
];
const TEST_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
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
  writeFileSync
};

function clone(value) {
  return structuredClone(value);
}

function emptyDocument() {
  return {
    schemaVersion: 2,
    activeProviderId: null,
    providers: [],
    settings: { ...DEFAULT_SETTINGS }
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function registryInvalid(cause) {
  return new CrpError(
    "PROVIDER_REGISTRY_INVALID",
    "The provider registry is invalid.",
    "Restore a valid provider registry or remove it after making a backup.",
    { status: 500, cause }
  );
}

function inputError(code, message, action, status = 400) {
  return new CrpError(code, message, action, { status });
}

function normalizedName(name) {
  return name.toLowerCase();
}

function validateExactFields(value, fields) {
  return isPlainObject(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

function validateDocument(document) {
  try {
    if (!validateExactFields(document, DOCUMENT_FIELDS)) {
      throw new Error("invalid document fields");
    }
    if (document.schemaVersion !== 2) {
      throw new Error("unsupported schema version");
    }
    if (!Array.isArray(document.providers)) {
      throw new Error("providers must be an array");
    }
    if (!validateExactFields(document.settings, SETTINGS_FIELDS)) {
      throw new Error("invalid settings fields");
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (document.settings[key] !== value) {
        throw new Error("fixed settings changed");
      }
    }
    if (document.activeProviderId !== null && typeof document.activeProviderId !== "string") {
      throw new Error("invalid active provider id");
    }

    const ids = new Set();
    const names = new Set();
    for (const profile of document.providers) {
      validateStoredProvider(profile);
      if (ids.has(profile.id)) {
        throw new Error("duplicate provider id");
      }
      const nameKey = normalizedName(profile.name);
      if (names.has(nameKey)) {
        throw new Error("duplicate provider name");
      }
      ids.add(profile.id);
      names.add(nameKey);
    }
    if (document.activeProviderId !== null && !ids.has(document.activeProviderId)) {
      throw new Error("active provider does not exist");
    }
    return true;
  } catch (error) {
    if (error instanceof CrpError && error.code === "PROVIDER_REGISTRY_INVALID") {
      throw error;
    }
    throw registryInvalid(error);
  }
}

function parseDocument(bytes) {
  let document;
  try {
    document = JSON.parse(bytes);
  } catch (error) {
    throw registryInvalid(error);
  }
  validateDocument(document);
  return document;
}

function providerNotFound() {
  return inputError(
    "PROVIDER_NOT_FOUND",
    "The provider does not exist.",
    "Refresh the provider list and try again.",
    404
  );
}

function registryBusy(cause) {
  return new CrpError(
    "PROVIDER_REGISTRY_BUSY",
    "The provider registry is already being updated.",
    "Wait for the current registry update to finish and try again.",
    { status: 409, cause }
  );
}

function committedLockDegraded() {
  return new CrpError(
    "PROVIDER_REGISTRY_COMMITTED_LOCK_DEGRADED",
    "The provider change was saved, but its registry lock could not be fully released.",
    "Stop CRP, explicitly repair the residual registry lock, then restart CRP.",
    { status: 500, details: { committed: true } }
  );
}

function registryLockDegraded() {
  return new CrpError(
    "PROVIDER_REGISTRY_LOCK_DEGRADED",
    "The provider registry lock could not be safely recovered.",
    "Stop CRP, explicitly repair the residual registry lock, then restart CRP.",
    { status: 500, details: { committed: false } }
  );
}

function assertPatch(patch) {
  if (!isPlainObject(patch)) {
    throw inputError(
      "PROVIDER_INPUT_INVALID",
      "Provider settings are invalid.",
      "Submit a provider settings object and try again."
    );
  }
  for (const key of Object.keys(patch)) {
    if (IMMUTABLE_FIELDS.has(key)) {
      throw inputError(
        "PROVIDER_IMMUTABLE_FIELD",
        "An immutable provider field cannot be changed.",
        "Create a new provider when its identity or credential reference must change."
      );
    }
    if (!EDITABLE_FIELDS.has(key)) {
      throw inputError(
        "PROVIDER_INPUT_INVALID",
        "Provider settings are invalid.",
        "Remove system-managed fields and try again."
      );
    }
    if (patch[key] === undefined) {
      throw inputError(
        "PROVIDER_INPUT_INVALID",
        "Provider settings are invalid.",
        "Provide an explicit value for every updated field."
      );
    }
  }
}

export class ProviderRegistry {
  constructor({
    path,
    createId = randomUUID,
    now = () => new Date().toISOString(),
    fileOperations
  }) {
    this.path = path;
    this.lockPath = `${path}.crp.lock`;
    this.createId = createId;
    this.now = now;
    this.fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...fileOperations };
    this.degradedLock = null;
    this.document = this.#load();
  }

  #load() {
    if (!this.fileOperations.existsSync(this.path)) {
      return emptyDocument();
    }
    let bytes;
    try {
      bytes = this.fileOperations.readFileSync(this.path, "utf8");
    } catch (error) {
      throw new CrpError(
        "PROVIDER_REGISTRY_READ_FAILED",
        "The provider registry could not be read.",
        "Check the registry file permissions and try again.",
        { status: 500, cause: error }
      );
    }
    return parseDocument(bytes);
  }

  #findIndex(document, id) {
    return document.providers.findIndex((profile) => profile.id === id);
  }

  #refresh() {
    const document = this.#load();
    this.document = document;
    return document;
  }

  #acquireLock() {
    this.fileOperations.mkdirSync(dirname(this.path), { recursive: true });
    if (this.degradedLock !== null) {
      throw registryLockDegraded();
    }

    let fileDescriptor;
    const token = `${randomUUID()}\n`;
    try {
      fileDescriptor = this.fileOperations.openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw registryBusy(error);
      }
      throw error;
    }

    const lock = { fileDescriptor, token };
    try {
      this.fileOperations.writeFileSync(fileDescriptor, token, "utf8");
      return lock;
    } catch (error) {
      const cleanup = this.#releaseLock(lock);
      if (cleanup.residualLock) {
        this.degradedLock = { token };
      }
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

  #recordCleanupState(lock, cleanup) {
    if (cleanup.residualLock) {
      this.degradedLock = { token: lock.token };
    } else {
      this.degradedLock = null;
    }
  }

  #getIndex(document, id) {
    const index = this.#findIndex(document, id);
    if (index === -1) {
      throw providerNotFound();
    }
    return index;
  }

  #assertUniqueName(document, name, excludedId = null) {
    const nameKey = normalizedName(name);
    if (document.providers.some((profile) => (
      profile.id !== excludedId && normalizedName(profile.name) === nameKey
    ))) {
      throw inputError(
        "PROVIDER_NAME_CONFLICT",
        "A provider with this name already exists.",
        "Choose a different provider name.",
        409
      );
    }
  }

  #persist(document) {
    const bytes = `${JSON.stringify(document, null, 2)}\n`;
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
      const candidate = clone(this.#load());
      const mutationResult = mutator(candidate);
      validateDocument(candidate);
      result = clone(mutationResult);
      this.#persist(candidate);
      this.document = candidate;
      committed = true;
    } catch (error) {
      primaryError = error;
    }

    let cleanup = { ok: true, residualLock: false };
    if (lock !== undefined) {
      cleanup = this.#releaseLock(lock);
      this.#recordCleanupState(lock, cleanup);
    }

    if (primaryError !== undefined) {
      throw primaryError;
    }
    if (!cleanup.ok) {
      if (committed) {
        throw committedLockDegraded();
      }
      throw registryLockDegraded();
    }
    return result;
  }

  list() {
    return clone(this.#refresh().providers);
  }

  get(id) {
    const document = this.#refresh();
    const index = this.#getIndex(document, id);
    return clone(document.providers[index]);
  }

  create(input) {
    validateProviderInput(input);
    const id = this.createId();
    const profile = normalizeProvider(input, { id, now: this.now() });
    return this.#commit((document) => {
      if (this.#findIndex(document, profile.id) !== -1) {
        throw inputError(
          "PROVIDER_ID_CONFLICT",
          "A provider identity conflict occurred.",
          "Retry creating the provider.",
          409
        );
      }
      this.#assertUniqueName(document, profile.name);
      document.providers.push(profile);
      return profile;
    });
  }

  update(id, patch) {
    assertPatch(patch);
    const timestamp = this.now();

    return this.#commit((document) => {
      const index = this.#getIndex(document, id);
      const current = document.providers[index];
      const normalized = normalizeProvider({
        name: current.name,
        baseUrl: current.baseUrl,
        credentialRef: current.credentialRef,
        authHeader: current.authHeader,
        authScheme: current.authScheme,
        extraHeaders: current.extraHeaders,
        modelMode: current.modelMode,
        modelOverride: current.modelOverride,
        ...patch
      }, { id: current.id, now: timestamp });
      this.#assertUniqueName(document, normalized.name, id);
      const invalidatesTest = TEST_INVALIDATING_FIELDS.some((field) => (
        !isDeepStrictEqual(current[field], normalized[field])
      ));
      const updated = {
        ...normalized,
        credentialRef: current.credentialRef,
        lastTestAt: invalidatesTest ? null : current.lastTestAt,
        lastTestStatus: invalidatesTest ? "untested" : current.lastTestStatus,
        lastTestCode: invalidatesTest ? null : current.lastTestCode,
        createdAt: current.createdAt,
        updatedAt: timestamp
      };
      document.providers[index] = updated;
      return updated;
    });
  }

  delete(id) {
    return this.#commit((document) => {
      const index = this.#getIndex(document, id);
      if (document.activeProviderId === id) {
        throw inputError(
          "PROVIDER_ACTIVE",
          "The active provider cannot be deleted.",
          "Activate another provider or stop the proxy first.",
          409
        );
      }
      const [deleted] = document.providers.splice(index, 1);
      return deleted;
    });
  }

  markTest(id, { status, code = null } = {}) {
    if (status !== "untested" && status !== "passed" && status !== "failed") {
      throw inputError(
        "PROVIDER_TEST_RESULT_INVALID",
        "The provider test result is invalid.",
        "Record an untested, passed, or failed compatibility test result."
      );
    }
    if (status === "untested" && code !== null) {
      throw inputError(
        "PROVIDER_TEST_RESULT_INVALID",
        "The provider test result is invalid.",
        "Do not include an error code when resetting the test result."
      );
    }
    if (status === "passed" && code !== null) {
      throw inputError(
        "PROVIDER_TEST_RESULT_INVALID",
        "The provider test result is invalid.",
        "Do not include an error code for a passed test."
      );
    }
    if (status === "failed" && (
      typeof code !== "string" || !TEST_CODE_PATTERN.test(code)
    )) {
      throw inputError(
        "PROVIDER_TEST_RESULT_INVALID",
        "The provider test result is invalid.",
        "Record a stable error code for a failed test."
      );
    }
    const timestamp = this.now();
    return this.#commit((document) => {
      const index = this.#getIndex(document, id);
      const updated = {
        ...document.providers[index],
        lastTestAt: status === "untested" ? null : timestamp,
        lastTestStatus: status,
        lastTestCode: status === "untested" ? null : code,
        updatedAt: timestamp
      };
      document.providers[index] = updated;
      return updated;
    });
  }

  setActive(id) {
    if (id === null) {
      return this.#commit((document) => {
        document.activeProviderId = null;
        return null;
      });
    }
    return this.#commit((document) => {
      const index = this.#getIndex(document, id);
      document.activeProviderId = id;
      return document.providers[index];
    });
  }

  getActive() {
    const document = this.#refresh();
    if (document.activeProviderId === null) {
      return null;
    }
    const index = this.#getIndex(document, document.activeProviderId);
    return clone(document.providers[index]);
  }

  getDocument() {
    return clone(this.#refresh());
  }
}
