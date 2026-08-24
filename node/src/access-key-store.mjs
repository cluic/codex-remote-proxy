import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CrpError } from "./shared/errors.mjs";

export const ACCESS_KEY_HEADER = "x-crp-api-key";
export const LOCAL_ACCESS_HEADER = "x-crp-local-token";
export const MAX_ACCESS_KEY_REQUEST_LIMIT = 1_000_000_000_000;

const SCHEMA_VERSION = 1;
const MAX_NAME_CODE_POINTS = 100;
const MIN_SECRET_BYTES = 16;
const MAX_SECRET_BYTES = 512;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const ACCESS_SECRET_PATTERN = /^[\x21-\x7e]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UPDATE_FIELDS = new Set(["name", "enabled", "expiresAt", "requestLimit"]);
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync
};

function accessError(code, { status = 400, cause } = {}) {
  const contracts = {
    ACCESS_KEY_INPUT_INVALID: [
      "The API key settings are invalid.",
      "Review the key name, expiration, and request limit before trying again."
    ],
    ACCESS_KEY_NOT_FOUND: [
      "The API key does not exist.",
      "Refresh the API key list and try again."
    ],
    ACCESS_KEY_CONFLICT: [
      "The API key already exists.",
      "Use a different key value or update the existing key."
    ],
    ACCESS_KEY_STORE_INVALID: [
      "The API key store is invalid.",
      "Stop CRP and repair the private API key store before restarting."
    ]
  };
  const [message, action] = contracts[code] ?? contracts.ACCESS_KEY_STORE_INVALID;
  return new CrpError(code, message, action, { status, cause });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, allowed, { requireAll = false } = {}) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0
    && keys.every((key) => allowed.has(key))
    && (!requireAll || keys.length === allowed.size);
}

function normalizeName(value) {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || [...value].length > MAX_NAME_CODE_POINTS
    || Buffer.byteLength(value, "utf8") > MAX_NAME_CODE_POINTS * 4
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw accessError("ACCESS_KEY_INPUT_INVALID");
  }
  return value;
}

function normalizeSecret(value) {
  if (typeof value !== "string"
    || value.trim() !== value
    || !ACCESS_SECRET_PATTERN.test(value)) {
    throw accessError("ACCESS_KEY_INPUT_INVALID");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES) {
    throw accessError("ACCESS_KEY_INPUT_INVALID");
  }
  return value;
}

function normalizeExpiresAt(value, nowMs, { future = true } = {}) {
  if (value === null) return null;
  if (typeof value !== "string") throw accessError("ACCESS_KEY_INPUT_INVALID");
  let normalized;
  try {
    normalized = new Date(value).toISOString();
  } catch {
    throw accessError("ACCESS_KEY_INPUT_INVALID");
  }
  if (normalized !== value || (future && Date.parse(normalized) <= nowMs)) {
    throw accessError("ACCESS_KEY_INPUT_INVALID");
  }
  return normalized;
}

function normalizeRequestLimit(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)
    || value < 1
    || value > MAX_ACCESS_KEY_REQUEST_LIMIT) {
    throw accessError("ACCESS_KEY_INPUT_INVALID");
  }
  return value;
}

function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function isUniqueConstraint(error) {
  return error?.code === "ERR_SQLITE_CONSTRAINT_UNIQUE"
    || (error?.code === "ERR_SQLITE_ERROR"
      && typeof error?.message === "string"
      && error.message.startsWith("UNIQUE constraint failed: access_keys."));
}

function keyHint(secret) {
  const characters = [...secret];
  const start = characters.slice(0, 4).join("");
  const end = characters.slice(-4).join("");
  return `${start}\u2026${end}`;
}

function safeTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== "string") throw accessError("ACCESS_KEY_STORE_INVALID", { status: 500 });
  try {
    if (new Date(value).toISOString() !== value) throw new Error("invalid timestamp");
  } catch (cause) {
    throw accessError("ACCESS_KEY_STORE_INVALID", { status: 500, cause });
  }
  return value;
}

function publicRow(row) {
  if (!row || typeof row !== "object"
    || typeof row.id !== "string" || row.id.length === 0
    || typeof row.name !== "string" || row.name.length === 0
    || typeof row.key_hint !== "string" || row.key_hint.length === 0
    || (row.enabled !== 0 && row.enabled !== 1)
    || !Number.isSafeInteger(row.request_count) || row.request_count < 0
    || (row.request_limit !== null
      && (!Number.isSafeInteger(row.request_limit)
        || row.request_limit < 1
        || row.request_limit > MAX_ACCESS_KEY_REQUEST_LIMIT))) {
    throw accessError("ACCESS_KEY_STORE_INVALID", { status: 500 });
  }
  return {
    id: row.id,
    name: row.name,
    keyHint: row.key_hint,
    enabled: row.enabled === 1,
    expiresAt: safeTimestamp(row.expires_at),
    requestLimit: row.request_limit,
    requestCount: row.request_count,
    createdAt: safeTimestamp(row.created_at),
    updatedAt: safeTimestamp(row.updated_at),
    lastUsedAt: safeTimestamp(row.last_used_at)
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function ensurePrivateDatabasePath(path, fileOperations, platform) {
  const parent = dirname(path);
  fileOperations.mkdirSync(parent, { recursive: true, mode: 0o700 });
  let parentStats = fileOperations.lstatSync(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new TypeError("API key store parent is unsafe");
  }
  if (platform !== "win32") {
    fileOperations.chmodSync(parent, 0o700);
    parentStats = fileOperations.lstatSync(parent);
    if ((parentStats.mode & 0o777) !== 0o700) {
      throw new TypeError("API key store parent is not private");
    }
  }

  let before;
  try {
    before = fileOperations.lstatSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    let descriptor;
    try {
      descriptor = fileOperations.openSync(path, "wx", 0o600);
      fileOperations.fchmodSync(descriptor, 0o600);
    } catch (createError) {
      if (createError?.code !== "EEXIST") throw createError;
    } finally {
      if (descriptor !== undefined) fileOperations.closeSync(descriptor);
    }
    before = fileOperations.lstatSync(path);
  }
  if (!before.isFile() || before.isSymbolicLink()
    || (platform !== "win32" && (before.mode & 0o777) !== 0o600)) {
    throw new TypeError("API key store path is unsafe");
  }
  const noFollow = typeof fileOperations.constants.O_NOFOLLOW === "number"
    ? fileOperations.constants.O_NOFOLLOW
    : 0;
  const descriptor = fileOperations.openSync(
    path,
    fileOperations.constants.O_RDWR | noFollow
  );
  try {
    const opened = fileOperations.fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new TypeError("API key store identity changed");
    }
  } finally {
    fileOperations.closeSync(descriptor);
  }
}

function initializeDatabase(db) {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (version === 0) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE access_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        secret_hash TEXT NOT NULL UNIQUE,
        key_hint TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        expires_at TEXT,
        request_limit INTEGER,
        request_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        CHECK (request_limit IS NULL OR (request_limit >= 1 AND request_limit <= ${MAX_ACCESS_KEY_REQUEST_LIMIT})),
        CHECK (request_count >= 0)
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `);
    return;
  }
  if (version !== SCHEMA_VERSION) {
    throw new TypeError("unsupported API key store schema");
  }
  const columns = db.prepare("PRAGMA table_info(access_keys)").all();
  const expected = new Set([
    "id", "name", "secret_hash", "key_hint", "enabled", "expires_at",
    "request_limit", "request_count", "created_at", "updated_at", "last_used_at"
  ]);
  if (columns.length !== expected.size || columns.some((column) => !expected.has(column.name))) {
    throw new TypeError("invalid API key store schema");
  }
}

export class AccessKeyStore {
  #db;
  #now;
  #createId;

  constructor({
    path,
    now = () => Date.now(),
    createId = randomUUID,
    databaseFactory = (databasePath) => new DatabaseSync(databasePath),
    fileOperations = DEFAULT_FILE_OPERATIONS,
    platform = process.platform
  } = {}) {
    if (typeof path !== "string" || path.length === 0
      || typeof now !== "function" || typeof createId !== "function"
      || typeof databaseFactory !== "function") {
      throw accessError("ACCESS_KEY_STORE_INVALID", { status: 500 });
    }
    try {
      ensurePrivateDatabasePath(path, fileOperations, platform);
      this.#db = databaseFactory(path);
      initializeDatabase(this.#db);
      this.#now = now;
      this.#createId = createId;
    } catch (cause) {
      try { this.#db?.close(); } catch {}
      throw accessError("ACCESS_KEY_STORE_INVALID", { status: 500, cause });
    }
  }

  close() {
    this.#db?.close();
    this.#db = null;
  }

  list() {
    try {
      return this.#db.prepare(`
        SELECT id, name, key_hint, enabled, expires_at, request_limit,
               request_count, created_at, updated_at, last_used_at
        FROM access_keys
        ORDER BY created_at DESC, id DESC
      `).all().map(publicRow);
    } catch (error) {
      if (error instanceof CrpError) throw error;
      throw accessError("ACCESS_KEY_STORE_INVALID", { status: 500, cause: error });
    }
  }

  create(input) {
    const allowed = new Set(["name", "secret", "expiresAt", "requestLimit"]);
    if (!exactFields(input, allowed, { requireAll: true })) {
      throw accessError("ACCESS_KEY_INPUT_INVALID");
    }
    const nowMs = this.#now();
    const name = normalizeName(input.name);
    const secret = normalizeSecret(input.secret);
    const expiresAt = normalizeExpiresAt(input.expiresAt, nowMs);
    const requestLimit = normalizeRequestLimit(input.requestLimit);
    const timestamp = new Date(nowMs).toISOString();
    const id = this.#createId();
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw accessError("ACCESS_KEY_STORE_INVALID", { status: 500 });
    }
    try {
      this.#db.prepare(`
        INSERT INTO access_keys (
          id, name, secret_hash, key_hint, enabled, expires_at, request_limit,
          request_count, created_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?, ?, NULL)
      `).run(id, name, hashSecret(secret), keyHint(secret), expiresAt, requestLimit, timestamp, timestamp);
    } catch (cause) {
      if (isUniqueConstraint(cause)) {
        throw accessError("ACCESS_KEY_CONFLICT", { status: 409, cause });
      }
      throw accessError("ACCESS_KEY_STORE_INVALID", { status: 500, cause });
    }
    return this.get(id);
  }

  get(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw accessError("ACCESS_KEY_NOT_FOUND", { status: 404 });
    }
    let row;
    try {
      row = this.#db.prepare(`
        SELECT id, name, key_hint, enabled, expires_at, request_limit,
               request_count, created_at, updated_at, last_used_at
        FROM access_keys WHERE id = ?
      `).get(id);
    } catch (cause) {
      throw accessError("ACCESS_KEY_STORE_INVALID", { status: 500, cause });
    }
    if (!row) throw accessError("ACCESS_KEY_NOT_FOUND", { status: 404 });
    return publicRow(row);
  }

  update(id, patch) {
    if (!exactFields(patch, UPDATE_FIELDS)) throw accessError("ACCESS_KEY_INPUT_INVALID");
    const current = this.get(id);
    const nowMs = this.#now();
    const next = {
      name: Object.hasOwn(patch, "name") ? normalizeName(patch.name) : current.name,
      enabled: Object.hasOwn(patch, "enabled") ? patch.enabled : current.enabled,
      expiresAt: Object.hasOwn(patch, "expiresAt")
        ? normalizeExpiresAt(patch.expiresAt, nowMs)
        : current.expiresAt,
      requestLimit: Object.hasOwn(patch, "requestLimit")
        ? normalizeRequestLimit(patch.requestLimit)
        : current.requestLimit
    };
    if (typeof next.enabled !== "boolean") throw accessError("ACCESS_KEY_INPUT_INVALID");
    const timestamp = new Date(nowMs).toISOString();
    try {
      this.#db.prepare(`
        UPDATE access_keys
        SET name = ?, enabled = ?, expires_at = ?, request_limit = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.name,
        next.enabled ? 1 : 0,
        next.expiresAt,
        next.requestLimit,
        timestamp,
        id
      );
    } catch (cause) {
      if (isUniqueConstraint(cause)) {
        throw accessError("ACCESS_KEY_CONFLICT", { status: 409, cause });
      }
      throw accessError("ACCESS_KEY_STORE_INVALID", { status: 500, cause });
    }
    return this.get(id);
  }

  delete(id) {
    const current = this.get(id);
    try {
      this.#db.prepare("DELETE FROM access_keys WHERE id = ?").run(id);
    } catch (cause) {
      throw accessError("ACCESS_KEY_STORE_INVALID", { status: 500, cause });
    }
    return current;
  }

  authorize(secret) {
    if (typeof secret !== "string"
      || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES
      || Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES
      || !ACCESS_SECRET_PATTERN.test(secret)) {
      return { ok: false, code: "API_KEY_INVALID", status: 401 };
    }
    const secretHash = hashSecret(secret);
    if (!HASH_PATTERN.test(secretHash)) {
      return { ok: false, code: "API_KEY_INVALID", status: 401 };
    }
    const nowIso = new Date(this.#now()).toISOString();
    try {
      const authorized = this.#db.prepare(`
        UPDATE access_keys
        SET request_count = request_count + 1, last_used_at = ?
        WHERE secret_hash = ?
          AND enabled = 1
          AND (expires_at IS NULL OR expires_at > ?)
          AND (request_limit IS NULL OR request_count < request_limit)
        RETURNING id, request_count, request_limit
      `).get(nowIso, secretHash, nowIso);
      if (authorized) {
        return {
          ok: true,
          keyId: authorized.id,
          requestCount: authorized.request_count,
          requestLimit: authorized.request_limit
        };
      }
      const rejected = this.#db.prepare(`
        SELECT enabled, expires_at, request_limit, request_count
        FROM access_keys WHERE secret_hash = ?
      `).get(secretHash);
      if (!rejected) return { ok: false, code: "API_KEY_INVALID", status: 401 };
      if (rejected.enabled !== 1) {
        return { ok: false, code: "API_KEY_DISABLED", status: 403 };
      }
      if (rejected.expires_at !== null && rejected.expires_at <= nowIso) {
        return { ok: false, code: "API_KEY_EXPIRED", status: 403 };
      }
      return { ok: false, code: "API_KEY_LIMIT_EXCEEDED", status: 429 };
    } catch {
      return { ok: false, code: "API_KEY_STORE_UNAVAILABLE", status: 503 };
    }
  }
}
