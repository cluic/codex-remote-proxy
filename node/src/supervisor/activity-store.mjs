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
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { CrpError } from "../shared/errors.mjs";

const REDACTED = "[REDACTED]";
const UNSERIALIZABLE = "[UNSERIALIZABLE]";
const CIRCULAR = "[CIRCULAR]";
const SENSITIVE_TERMS = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "apikey",
  "credentialref",
  "requestbody",
  "responsebody",
  "cause",
  "stack",
  "headers",
  "backuppath"
];
const EVENT_FIELDS = new Set([
  "timestamp",
  "category",
  "action",
  "providerId",
  "result",
  "errorCode",
  "details"
]);
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
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

function activityError(code, message, action, status = 500, details = {}) {
  return new CrpError(code, message, action, { status, details });
}

function invalidActivity() {
  return activityError(
    "ACTIVITY_EVENT_INVALID",
    "The activity event is invalid.",
    "Record only supported lifecycle activity fields.",
    400
  );
}

function storeError(code = "ACTIVITY_STORE_WRITE_FAILED", details = {}) {
  const messages = {
    ACTIVITY_STORE_BUSY: [
      "The activity store is already being updated.",
      "Wait for the current activity update to finish and try again."
    ],
    ACTIVITY_STORE_INVALID: [
      "The activity store is invalid.",
      "Restore a valid activity file or remove it after making a backup."
    ],
    ACTIVITY_STORE_WRITE_FAILED: [
      "The activity event could not be saved.",
      "Check local storage permissions and try again."
    ],
    ACTIVITY_STORE_COMMITTED_LOCK_DEGRADED: [
      "The activity event was saved, but its lock could not be fully released.",
      "Stop CRP, explicitly repair the residual activity lock, then restart CRP."
    ],
    ACTIVITY_STORE_LOCK_DEGRADED: [
      "The activity store lock could not be safely recovered.",
      "Stop CRP, explicitly repair the residual activity lock, then restart CRP."
    ]
  };
  const [message, action] = messages[code] ?? messages.ACTIVITY_STORE_WRITE_FAILED;
  return activityError(code, message, action, code === "ACTIVITY_STORE_BUSY" ? 409 : 500, details);
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function normalizeString(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw invalidActivity();
  return value;
}

function isSensitiveKey(key) {
  const compact = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_TERMS.some((term) => compact.includes(term));
}

function sanitizeValue(value, seen) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : UNSERIALIZABLE;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return UNSERIALIZABLE;
  }
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? UNSERIALIZABLE : value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, seen));
    }

    const sanitized = {};
    if (value instanceof Error) sanitized.name = String(value.name || "Error");
    for (const key of Object.keys(value)) {
      if (isSensitiveKey(key)) {
        sanitized[key] = REDACTED;
        continue;
      }
      let property;
      try {
        property = value[key];
      } catch {
        property = UNSERIALIZABLE;
      }
      sanitized[key] = property === UNSERIALIZABLE
        ? UNSERIALIZABLE
        : sanitizeValue(property, seen);
    }
    return sanitized;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeActivityValue(value) {
  return sanitizeValue(value, new WeakSet());
}

function normalizeEvent(event, now) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw invalidActivity();
  }
  const timestamp = event.timestamp ?? now();
  if (!isIsoTimestamp(timestamp)) throw invalidActivity();
  const errorCode = event.errorCode ?? null;
  if (errorCode !== null && !/^[A-Z][A-Z0-9_]*$/.test(errorCode)) {
    throw invalidActivity();
  }
  return {
    timestamp,
    category: normalizeString(event.category),
    action: normalizeString(event.action),
    providerId: normalizeString(event.providerId ?? null, { nullable: true }),
    result: normalizeString(event.result),
    errorCode,
    details: sanitizeActivityValue(event.details ?? {})
  };
}

function validateStoredEvent(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)
    || Object.keys(event).length !== EVENT_FIELDS.size
    || Object.keys(event).some((key) => !EVENT_FIELDS.has(key))) {
    throw storeError("ACTIVITY_STORE_INVALID");
  }
  const normalized = normalizeEvent(event, () => event.timestamp);
  if (JSON.stringify(normalized) !== JSON.stringify(event)) {
    throw storeError("ACTIVITY_STORE_INVALID");
  }
  return normalized;
}

export class ActivityStore {
  constructor({
    path,
    now = () => new Date().toISOString(),
    maxEvents = DEFAULT_MAX_EVENTS,
    retentionMs = DEFAULT_RETENTION_MS,
    fileOperations = DEFAULT_FILE_OPERATIONS,
    createId = randomUUID
  }) {
    if (typeof path !== "string" || path.length === 0
      || !Number.isSafeInteger(maxEvents) || maxEvents < 1
      || !Number.isSafeInteger(retentionMs) || retentionMs < 1) {
      throw invalidActivity();
    }
    this.path = path;
    this.lockPath = `${path}.crp.lock`;
    this.now = now;
    this.maxEvents = maxEvents;
    this.retentionMs = retentionMs;
    this.fileOperations = fileOperations;
    this.createId = createId;
    this.degraded = false;
  }

  append(event) {
    const normalized = normalizeEvent(event, this.now);
    this.#ensureParent();
    if (this.degraded) throw storeError("ACTIVITY_STORE_LOCK_DEGRADED");
    const lock = this.#acquireLock();
    let primaryError;
    let committed = false;
    try {
      const events = this.#load();
      events.push(normalized);
      const nowMs = new Date(this.now()).getTime();
      const cutoff = nowMs - this.retentionMs;
      const retained = events
        .filter((entry) => new Date(entry.timestamp).getTime() >= cutoff)
        .slice(-this.maxEvents);
      this.#persist(retained);
      committed = true;
    } catch (error) {
      primaryError = error instanceof CrpError
        ? error
        : storeError("ACTIVITY_STORE_WRITE_FAILED");
    }

    const released = this.#releaseLock(lock);
    if (!released) this.degraded = true;
    if (primaryError) throw primaryError;
    if (!released) {
      throw storeError("ACTIVITY_STORE_COMMITTED_LOCK_DEGRADED", { committed });
    }
    return structuredClone(normalized);
  }

  list({ limit = this.maxEvents } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxEvents) {
      throw invalidActivity();
    }
    this.#ensureParent();
    return this.#load().slice(-limit).reverse().map((event) => structuredClone(event));
  }

  #ensureParent() {
    const parent = dirname(this.path);
    this.fileOperations.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try {
      this.fileOperations.chmodSync(parent, 0o700);
    } catch {
      // Windows ACL verification remains an L3 platform gate.
    }
  }

  #load() {
    if (!this.fileOperations.existsSync(this.path)) return [];
    let text;
    try {
      text = this.fileOperations.readFileSync(this.path, "utf8");
    } catch {
      throw storeError("ACTIVITY_STORE_INVALID");
    }
    if (text.length === 0) return [];
    try {
      return text.trimEnd().split("\n").map((line) => validateStoredEvent(JSON.parse(line)));
    } catch (error) {
      if (error instanceof CrpError && error.code === "ACTIVITY_STORE_INVALID") throw error;
      throw storeError("ACTIVITY_STORE_INVALID");
    }
  }

  #acquireLock() {
    const token = `${this.createId()}\n`;
    let descriptor;
    let owned = false;
    let closed = false;
    try {
      descriptor = this.fileOperations.openSync(this.lockPath, "wx", 0o600);
      owned = true;
      this.fileOperations.writeFileSync(descriptor, token, "utf8");
      this.fileOperations.fsyncSync(descriptor);
      this.fileOperations.closeSync(descriptor);
      closed = true;
      descriptor = undefined;
      this.fileOperations.chmodSync(this.lockPath, 0o600);
      return token;
    } catch (error) {
      if (!owned) {
        if (error?.code === "EEXIST") throw storeError("ACTIVITY_STORE_BUSY");
        throw storeError("ACTIVITY_STORE_WRITE_FAILED");
      }
      if (!closed && descriptor !== undefined) {
        try {
          this.fileOperations.closeSync(descriptor);
          closed = true;
        } catch {}
      }
      const cleaned = closed ? this.#releaseLock(token) : false;
      if (!closed || !cleaned) {
        this.degraded = true;
        throw storeError("ACTIVITY_STORE_LOCK_DEGRADED", { committed: false });
      }
      throw storeError("ACTIVITY_STORE_WRITE_FAILED");
    }
  }

  #releaseLock(token) {
    const claimPath = join(
      dirname(this.lockPath),
      `.${basename(this.lockPath)}.${this.createId()}.release`
    );
    let claimed = false;
    try {
      this.fileOperations.renameSync(this.lockPath, claimPath);
      claimed = true;
      if (this.fileOperations.readFileSync(claimPath, "utf8") !== token) {
        this.#restoreClaim(claimPath);
        return false;
      }
      this.fileOperations.rmSync(claimPath);
      return true;
    } catch {
      if (claimed) this.#restoreClaim(claimPath);
      return false;
    }
  }

  #restoreClaim(claimPath) {
    try {
      this.fileOperations.renameSync(claimPath, this.lockPath);
    } catch {
      // A foreign canonical lock is already a blocker; never remove it.
    }
  }

  #persist(events) {
    const tempPath = join(
      dirname(this.path),
      `.${basename(this.path)}.${this.createId()}.tmp`
    );
    const bytes = events.length === 0
      ? ""
      : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    let descriptor;
    try {
      descriptor = this.fileOperations.openSync(tempPath, "wx", 0o600);
      this.fileOperations.writeFileSync(descriptor, bytes, "utf8");
      this.fileOperations.fsyncSync(descriptor);
      this.fileOperations.closeSync(descriptor);
      descriptor = undefined;
      this.fileOperations.chmodSync(tempPath, 0o600);
      this.fileOperations.renameSync(tempPath, this.path);
    } catch {
      if (descriptor !== undefined) {
        try { this.fileOperations.closeSync(descriptor); } catch {}
      }
      try { this.fileOperations.rmSync(tempPath, { force: true }); } catch {}
      throw storeError("ACTIVITY_STORE_WRITE_FAILED");
    }
  }
}
