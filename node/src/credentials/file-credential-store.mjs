import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { CrpError } from "../shared/errors.mjs";

const DOCUMENT_FIELDS = new Set(["schemaVersion", "credentials"]);
const FORBIDDEN_REFS = new Set(["__proto__", "constructor", "prototype"]);
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const LOCK_CLEANUP_ATTEMPTS = 2;
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync
};

function emptyDocument() {
  return { schemaVersion: 1, credentials: {} };
}

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidRef(ref) {
  return typeof ref === "string"
    && REF_PATTERN.test(ref)
    && !FORBIDDEN_REFS.has(ref);
}

function credentialInputInvalid() {
  return new CrpError(
    "CREDENTIAL_INPUT_INVALID",
    "The credential input is invalid.",
    "Use a valid credential reference and a non-empty secret.",
    { status: 400 }
  );
}

function credentialNotFound() {
  return new CrpError(
    "CREDENTIAL_NOT_FOUND",
    "The credential does not exist.",
    "Save the provider credential and try again.",
    { status: 404 }
  );
}

function credentialFileInvalid(cause) {
  return new CrpError(
    "CREDENTIAL_FILE_INVALID",
    "The credential fallback file is invalid.",
    "Restore a valid credential fallback file or remove it after making a backup.",
    { status: 500, cause }
  );
}

function credentialFileInsecure(cause) {
  return new CrpError(
    "CREDENTIAL_FILE_INSECURE",
    "The credential fallback file is not secure.",
    "Replace it with a regular private file and try again.",
    { status: 500, cause }
  );
}

function backendUnavailable(cause) {
  return new CrpError(
    "CREDENTIAL_BACKEND_UNAVAILABLE",
    "The credential backend is unavailable.",
    "Check local file permissions and try again.",
    { status: 500, cause }
  );
}

function credentialStoreBusy(cause) {
  return new CrpError(
    "CREDENTIAL_STORE_BUSY",
    "The credential fallback is already being updated.",
    "Wait for the current credential update to finish and try again.",
    { status: 409, cause }
  );
}

function committedLockDegraded() {
  return new CrpError(
    "CREDENTIAL_STORE_COMMITTED_LOCK_DEGRADED",
    "The credential change was saved, but its lock could not be fully released.",
    "Stop CRP, explicitly repair the residual credential lock, then restart CRP.",
    { status: 500, details: { committed: true } }
  );
}

function credentialLockDegraded() {
  return new CrpError(
    "CREDENTIAL_STORE_LOCK_DEGRADED",
    "The credential fallback lock could not be safely recovered.",
    "Stop CRP, explicitly repair the residual credential lock, then restart CRP.",
    { status: 500, details: { committed: false } }
  );
}

function credentialTempDegraded(cause) {
  return new CrpError(
    "CREDENTIAL_STORE_TEMP_DEGRADED",
    "A credential temporary file could not be safely removed.",
    "Stop CRP, explicitly remove the residual credential temporary file, then restart CRP.",
    { status: 500, details: { committed: false }, cause }
  );
}

function assertRef(ref) {
  if (!isValidRef(ref)) throw credentialInputInvalid();
}

function assertSecret(secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw credentialInputInvalid();
  }
}

function validateDocument(document) {
  try {
    if (
      !isPlainObject(document)
      || Object.keys(document).length !== DOCUMENT_FIELDS.size
      || !Object.keys(document).every((key) => DOCUMENT_FIELDS.has(key))
      || document.schemaVersion !== 1
      || !isPlainObject(document.credentials)
    ) {
      throw new Error("invalid credential document");
    }
    for (const [ref, secret] of Object.entries(document.credentials)) {
      if (!isValidRef(ref) || typeof secret !== "string" || secret.length === 0) {
        throw new Error("invalid credential entry");
      }
    }
    return document;
  } catch (error) {
    if (error instanceof CrpError && error.code === "CREDENTIAL_FILE_INVALID") {
      throw error;
    }
    throw credentialFileInvalid(error);
  }
}

function parseDocument(bytes) {
  let document;
  try {
    document = JSON.parse(bytes);
  } catch (error) {
    throw credentialFileInvalid(error);
  }
  return validateDocument(document);
}

function safeFileError(error) {
  return error instanceof CrpError ? error : backendUnavailable(error);
}

function sameFileIdentity(first, second) {
  for (const field of ["dev", "ino"]) {
    if (first[field] !== undefined && second[field] !== undefined) {
      if (first[field] !== second[field]) return false;
    }
  }
  return true;
}

export class FileCredentialStore {
  #document;
  #degradedLock = null;
  #degradedTemp = null;

  constructor({ path, fileOperations, platform = process.platform } = {}) {
    if (typeof path !== "string" || path.length === 0) {
      throw credentialInputInvalid();
    }
    this.backend = "file";
    this.path = path;
    this.lockPath = `${path}.crp.lock`;
    this.gatePath = `${this.lockPath}.gate`;
    this.platform = platform;
    this.fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...fileOperations };
    this.#document = this.#load();
  }

  #load() {
    const parent = dirname(this.path);
    const parentStats = this.#inspectParent(parent);
    if (parentStats === null) return emptyDocument();

    let pathStats;
    try {
      pathStats = this.fileOperations.lstatSync(this.path);
    } catch (error) {
      if (error?.code === "ENOENT") return emptyDocument();
      throw backendUnavailable(error);
    }
    this.#assertCredentialFile(pathStats);

    const noFollow = this.platform !== "win32"
      && typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW
      : 0;
    const flags = fsConstants.O_RDONLY | noFollow;
    let fileDescriptor;
    let bytes;
    let primaryError;
    try {
      fileDescriptor = this.fileOperations.openSync(this.path, flags);
      const openedStats = this.fileOperations.fstatSync(fileDescriptor);
      this.#assertCredentialFile(openedStats);
      if (!sameFileIdentity(pathStats, openedStats)) {
        throw credentialFileInsecure(new Error("Credential file identity changed"));
      }
      const finalPathStats = this.fileOperations.lstatSync(this.path);
      this.#assertCredentialFile(finalPathStats);
      if (!sameFileIdentity(openedStats, finalPathStats)) {
        throw credentialFileInsecure(new Error("Credential file identity changed"));
      }
      bytes = this.fileOperations.readFileSync(fileDescriptor, "utf8");
    } catch (error) {
      primaryError = error?.code === "ELOOP" || error?.code === "ENOENT"
        ? credentialFileInsecure(error)
        : safeFileError(error);
    }
    let closeError;
    if (fileDescriptor !== undefined) {
      try {
        this.fileOperations.closeSync(fileDescriptor);
      } catch (error) {
        closeError = error;
      }
    }
    if (primaryError !== undefined) throw primaryError;
    if (closeError !== undefined) throw backendUnavailable(closeError);
    return parseDocument(bytes);
  }

  #inspectParent(parent) {
    let stats;
    try {
      stats = this.fileOperations.lstatSync(parent);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw backendUnavailable(error);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw credentialFileInsecure(new Error("Credential parent is not a real directory"));
    }
    if (this.platform !== "win32" && (stats.mode & 0o777) !== 0o700) {
      throw credentialFileInsecure(new Error("Credential parent permissions are not private"));
    }
    return stats;
  }

  #assertCredentialFile(stats) {
    if (stats.isSymbolicLink?.() || !stats.isFile()) {
      throw credentialFileInsecure(new Error("Credential path is not a regular file"));
    }
    if (this.platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
      throw credentialFileInsecure(new Error("Credential file permissions are not private"));
    }
  }

  #refresh() {
    const document = this.#load();
    this.#document = document;
    return document;
  }

  #prepareParent() {
    const parent = dirname(this.path);
    if (this.#inspectParent(parent) !== null) return;
    const created = this.fileOperations.mkdirSync(parent, {
      recursive: true,
      mode: 0o700
    });
    if (this.platform !== "win32" && created !== undefined) {
      this.fileOperations.chmodSync(parent, 0o700);
    }
    this.#inspectParent(parent);
  }

  #acquireGate() {
    try {
      this.fileOperations.mkdirSync(this.gatePath, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") throw credentialStoreBusy(error);
      throw error;
    }

    let stats;
    try {
      stats = this.fileOperations.lstatSync(this.gatePath);
    } catch {
      this.#degradedLock = { path: this.gatePath };
      throw credentialLockDegraded();
    }
    if (
      stats.isSymbolicLink()
      || !stats.isDirectory()
      || (this.platform !== "win32" && (stats.mode & 0o777) !== 0o700)
    ) {
      this.#degradedLock = { path: this.gatePath };
      throw credentialLockDegraded();
    }
    return { active: true, stats };
  }

  #releaseGate(gate) {
    if (!gate?.active) {
      return {
        ok: true,
        primaryReleaseSafe: true,
        residualGate: false,
        foreign: false,
        path: null
      };
    }
    gate.active = false;
    const claimPath = join(
      dirname(this.gatePath),
      `.${basename(this.gatePath)}.${process.pid}.${randomUUID()}.claim`
    );
    try {
      this.fileOperations.renameSync(this.gatePath, claimPath);
    } catch (error) {
      const blocked = this.#ensureGateBlocked();
      return {
        ok: false,
        primaryReleaseSafe: blocked,
        residualGate: true,
        foreign: false,
        path: this.gatePath
      };
    }

    let claimed;
    try {
      claimed = this.fileOperations.lstatSync(claimPath);
    } catch {
      const blocked = this.#ensureGateBlocked();
      return {
        ok: false,
        primaryReleaseSafe: blocked,
        residualGate: true,
        foreign: false,
        path: blocked ? this.gatePath : claimPath
      };
    }
    if (
      claimed.isSymbolicLink()
      || !claimed.isDirectory()
      || !sameFileIdentity(gate.stats, claimed)
    ) {
      const blocked = this.#ensureGateBlocked();
      return {
        ok: false,
        primaryReleaseSafe: blocked,
        residualGate: true,
        foreign: true,
        path: claimPath
      };
    }
    for (let attempt = 0; attempt < LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        this.fileOperations.rmdirSync(claimPath);
        return {
          ok: true,
          primaryReleaseSafe: true,
          residualGate: false,
          foreign: false,
          path: null
        };
      } catch (error) {
        if (error?.code === "ENOENT") {
          return {
            ok: true,
            primaryReleaseSafe: true,
            residualGate: false,
            foreign: false,
            path: null
          };
        }
      }
    }
    return {
      ok: false,
      primaryReleaseSafe: true,
      residualGate: this.fileOperations.existsSync(claimPath),
      foreign: false,
      path: claimPath
    };
  }

  #ensureGateBlocked() {
    try {
      this.fileOperations.mkdirSync(this.gatePath, { mode: 0o700 });
      return true;
    } catch (error) {
      return error?.code === "EEXIST";
    }
  }

  #acquireLock() {
    if (this.#degradedTemp !== null) {
      throw credentialTempDegraded();
    }
    if (this.#degradedLock !== null) {
      throw credentialLockDegraded();
    }
    this.#prepareParent();
    const gate = this.#acquireGate();
    const token = `${randomUUID()}\n`;
    let fileDescriptor;
    try {
      fileDescriptor = this.fileOperations.openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      const gateCleanup = this.#releaseGate(gate);
      if (!gateCleanup.ok) {
        this.#degradedLock = { path: gateCleanup.path };
      }
      if (error?.code === "EEXIST") throw credentialStoreBusy(error);
      throw error;
    }

    const lock = { fileDescriptor, token, gate, active: true };
    try {
      this.fileOperations.writeFileSync(fileDescriptor, token, "utf8");
      return lock;
    } catch (error) {
      const cleanup = this.#releaseLock(lock);
      if (cleanup.residualLock) this.#degradedLock = { token };
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
    let releasePath;
    let error = null;
    for (let attempt = 0; attempt < LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
      releasePath = join(
        dirname(this.lockPath),
        `.${basename(this.lockPath)}.${process.pid}.${randomUUID()}.release`
      );
      try {
        this.fileOperations.renameSync(this.lockPath, releasePath);
        error = null;
        break;
      } catch (caught) {
        if (caught?.code === "ENOENT") {
          return {
            removed: true,
            residualLock: false,
            foreign: false,
            error: null,
            residualPath: null
          };
        }
        error = caught;
      }
    }
    if (error !== null) {
      let residualLock = true;
      try {
        residualLock = this.fileOperations.existsSync(this.lockPath);
      } catch {
        // Uncertain claim state is treated as a permanent residual lock.
      }
      return {
        removed: false,
        residualLock,
        foreign: false,
        error,
        residualPath: residualLock ? this.lockPath : null
      };
    }

    let currentToken;
    try {
      currentToken = this.fileOperations.readFileSync(releasePath, "utf8");
    } catch (caught) {
      return {
        removed: false,
        residualLock: true,
        foreign: false,
        error: caught,
        residualPath: releasePath
      };
    }
    if (currentToken !== token) {
      return {
        removed: false,
        residualLock: true,
        foreign: true,
        error: null,
        residualPath: releasePath
      };
    }

    for (let attempt = 0; attempt < LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        this.fileOperations.rmSync(releasePath, { force: true });
        return {
          removed: true,
          residualLock: false,
          foreign: false,
          error: null,
          residualPath: null
        };
      } catch (caught) {
        if (caught?.code === "ENOENT") {
          return {
            removed: true,
            residualLock: false,
            foreign: false,
            error: null,
            residualPath: null
          };
        }
        error = caught;
      }
    }
    let residualLock = true;
    try {
      residualLock = this.fileOperations.existsSync(releasePath);
    } catch {
      // Uncertain ownership state is treated as a permanent residual lock.
    }
    return {
      removed: false,
      residualLock,
      foreign: false,
      error,
      residualPath: residualLock ? releasePath : null
    };
  }

  #canonicalState() {
    try {
      const stats = this.fileOperations.lstatSync(this.lockPath);
      return {
        known: true,
        blocking: stats.isFile() ? stats.size > 0 : true
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { known: true, blocking: false };
      return { known: false, blocking: false };
    }
  }

  #ensureCanonicalBlocked(residualPath) {
    const initial = this.#canonicalState();
    if (initial.blocking) return true;
    if (!initial.known) return false;

    if (residualPath !== null && residualPath !== this.lockPath) {
      try {
        this.fileOperations.linkSync(residualPath, this.lockPath);
        return this.#canonicalState().blocking;
      } catch (error) {
        if (error?.code === "EEXIST") {
          return this.#canonicalState().blocking;
        }
      }
    }

    const marker = `blocked-${randomUUID()}\n`;
    let fileDescriptor;
    try {
      fileDescriptor = this.fileOperations.openSync(this.lockPath, "wx", 0o600);
      this.fileOperations.writeFileSync(fileDescriptor, marker, "utf8");
      this.fileOperations.fsyncSync(fileDescriptor);
      this.fileOperations.closeSync(fileDescriptor);
      fileDescriptor = undefined;
      return this.#canonicalState().blocking;
    } catch (error) {
      if (fileDescriptor !== undefined) {
        try {
          this.fileOperations.closeSync(fileDescriptor);
        } catch {
          // Retain the gate when canonical occupancy cannot be proven.
        }
      }
      if (error?.code === "EEXIST") return this.#canonicalState().blocking;
      return false;
    }
  }

  #releaseLock(lock) {
    if (!lock?.active) {
      return { ok: true, residualLock: false, foreignLock: false };
    }
    lock.active = false;
    const gate = this.#releaseGate(lock.gate);
    const close = this.#closeLock(lock.fileDescriptor);
    const removal = gate.primaryReleaseSafe
      ? this.#removeOwnedLock(lock.token)
      : {
          removed: false,
          residualLock: true,
          foreign: false,
          error: null,
          residualPath: this.lockPath
        };
    const canonicalBlocked = !removal.residualLock
      || this.#ensureCanonicalBlocked(removal.residualPath);
    return {
      ok: close.closed && removal.removed && canonicalBlocked && gate.ok,
      closeError: close.error,
      removalError: removal.error,
      residualLock: removal.residualLock || gate.residualGate,
      foreignLock: removal.foreign || gate.foreign,
      residualPath: gate.residualGate ? gate.path : removal.residualPath
    };
  }

  #recordCleanupState(lock, cleanup) {
    this.#degradedLock = cleanup.residualLock
      ? { token: lock.token, path: cleanup.residualPath }
      : null;
  }

  #persist(document) {
    const bytes = `${JSON.stringify(document, null, 2)}\n`;
    const parent = dirname(this.path);
    const tempPath = join(
      parent,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`
    );
    let fileDescriptor;
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
        this.#closeTemporary(fileDescriptor);
      }
      const cleanup = this.#removeTemporary(tempPath);
      if (!cleanup.removed) {
        this.#degradedTemp = { path: tempPath };
        throw credentialTempDegraded(error);
      }
      throw error;
    }
  }

  #closeTemporary(fileDescriptor) {
    for (let attempt = 0; attempt < LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        this.fileOperations.closeSync(fileDescriptor);
        return true;
      } catch (error) {
        if (attempt > 0 && error?.code === "EBADF") return true;
      }
    }
    return false;
  }

  #removeTemporary(tempPath) {
    for (let attempt = 0; attempt < LOCK_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        this.fileOperations.rmSync(tempPath, { force: true });
        return { removed: true, residual: false };
      } catch (error) {
        if (error?.code === "ENOENT") {
          return { removed: true, residual: false };
        }
      }
    }
    let residual = true;
    try {
      residual = this.fileOperations.existsSync(tempPath);
    } catch {
      // Uncertain cleanup state is treated as a residual secret-bearing file.
    }
    return { removed: !residual, residual };
  }

  #commit(mutator) {
    let lock;
    let result;
    let primaryError;
    let committed = false;
    try {
      lock = this.#acquireLock();
      const candidate = clone(this.#load());
      result = mutator(candidate);
      validateDocument(candidate);
      this.#persist(candidate);
      this.#document = candidate;
      committed = true;
    } catch (error) {
      primaryError = error;
    }

    let cleanup = { ok: true, residualLock: false };
    if (lock !== undefined) {
      cleanup = this.#releaseLock(lock);
      this.#recordCleanupState(lock, cleanup);
    }
    if (primaryError !== undefined) throw safeFileError(primaryError);
    if (!cleanup.ok) {
      if (committed) throw committedLockDegraded();
      throw credentialLockDegraded();
    }
    return result;
  }

  async set(ref, secret) {
    assertRef(ref);
    assertSecret(secret);
    this.#commit((document) => {
      document.credentials[ref] = secret;
    });
  }

  async get(ref) {
    assertRef(ref);
    const document = this.#refresh();
    if (!Object.hasOwn(document.credentials, ref)) throw credentialNotFound();
    return document.credentials[ref];
  }

  async has(ref) {
    assertRef(ref);
    return Object.hasOwn(this.#refresh().credentials, ref);
  }

  async delete(ref) {
    assertRef(ref);
    return this.#commit((document) => {
      if (!Object.hasOwn(document.credentials, ref)) return false;
      delete document.credentials[ref];
      return true;
    });
  }
}
