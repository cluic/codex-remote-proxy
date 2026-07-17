import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { CrpError, parseStartupFailureMessage } from "../shared/errors.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SUPERVISOR_ENTRY = fileURLToPath(new URL("./supervisor-entry.mjs", import.meta.url));
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_STATE_BYTES = 64 * 1_024;
const MAX_RESPONSE_BYTES = 1024 * 1_024;
const SAFE_ERROR_DETAIL_FIELDS = new Set([
  "field",
  "reason",
  "committed",
  "degraded",
  "pending",
  "generation",
  "httpStatus"
]);
const STATE_FIELDS = new Set([
  "schemaVersion",
  "supervisorPid",
  "startedAt",
  "admin",
  "worker"
]);
const ADMIN_FIELDS = new Set(["host", "port", "authority", "origin"]);
const WORKER_FIELDS = new Set([
  "phase",
  "pid",
  "generation",
  "state",
  "restartCount",
  "startedAt",
  "error"
]);
const CHILD_STATE_FIELDS = new Set([
  "phase",
  "configured",
  "generation",
  "listening",
  "listenHost",
  "listenPort",
  "inFlight"
]);
const WORKER_ERROR_FIELDS = new Set(["code", "message"]);
const REQUEST_OPTIONS_FIELDS = new Set(["requestTimeoutMs", "expectedStatus"]);
const STALE_STATE_REMOVAL_REASONS = Object.freeze({
  INVALID_INPUT: "invalid_input",
  PROCESS_RUNNING: "process_running",
  STATE_MISSING: "state_missing",
  STATE_CHANGED: "state_changed",
  CLAIM_CONFLICT: "claim_conflict",
  CLAIM_CHANGED: "claim_changed",
  CLEANUP_FAILED: "cleanup_failed",
  REMOVED: "removed"
});
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync
};
const pendingEnsures = new Map();
const supervisorStateSnapshots = new WeakMap();

function clientError(code, { status = 500 } = {}) {
  const contracts = {
    SUPERVISOR_CLIENT_INPUT_INVALID: [
      "The supervisor client input is invalid.",
      "Use the fixed local supervisor address and a documented Admin path."
    ],
    SUPERVISOR_TOKEN_INVALID: [
      "The local control token is invalid.",
      "Stop CRP, repair the private control token file, and restart CRP."
    ],
    SUPERVISOR_UNAVAILABLE: [
      "The local supervisor is unavailable.",
      "Start the local supervisor and try again."
    ],
    SUPERVISOR_RESPONSE_INVALID: [
      "The local supervisor returned an invalid response.",
      "Restart CRP and try again."
    ],
    SUPERVISOR_START_FAILED: [
      "The local supervisor could not be started.",
      "Review the supervisor log and try again."
    ],
    SUPERVISOR_START_TIMEOUT: [
      "The local supervisor did not become ready in time.",
      "Review the supervisor log and try again."
    ]
  };
  const [message, action] = contracts[code] ?? contracts.SUPERVISOR_UNAVAILABLE;
  return new CrpError(code, message, action, { status });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  return isPlainObject(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((field) => fields.has(field));
}

function hasOnlyFields(value, fields) {
  return isPlainObject(value)
    && Object.keys(value).length > 0
    && Object.keys(value).every((field) => fields.has(field));
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isSafePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNullableSafeInteger(value, { min = 0 } = {}) {
  return value === null || (Number.isSafeInteger(value) && value >= min);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPrivateMode(stats, platform) {
  return platform === "win32" || (stats.mode & 0o777) === 0o600;
}

function readPrivateFileSnapshot({ path, fileOperations, platform, maxBytes }) {
  const parent = fileOperations.lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || platform !== "win32" && (parent.mode & 0o777) !== 0o700) {
    throw new TypeError("private file parent is unsafe");
  }
  const before = fileOperations.lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || !isPrivateMode(before, platform)
    || before.size < 1 || before.size > maxBytes) {
    throw new TypeError("private file path is unsafe");
  }

  let descriptor;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = fileOperations.openSync(path, constants.O_RDONLY | noFollow);
    const opened = fileOperations.fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened) || !isPrivateMode(opened, platform)
      || opened.size < 1 || opened.size > maxBytes) {
      throw new TypeError("private file identity changed");
    }
    const bytes = fileOperations.readFileSync(descriptor);
    const after = fileOperations.lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after)) {
      throw new TypeError("private file identity changed");
    }
    return {
      bytes: Buffer.from(bytes),
      identity: { dev: opened.dev, ino: opened.ino }
    };
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
}

function readPrivateFile(options) {
  return readPrivateFileSnapshot(options).bytes;
}

function validChildState(state) {
  return hasExactFields(state, CHILD_STATE_FIELDS)
    && typeof state.phase === "string" && state.phase.length > 0
    && typeof state.configured === "boolean"
    && Number.isSafeInteger(state.generation) && state.generation >= 0
    && typeof state.listening === "boolean"
    && (state.listenHost === null || typeof state.listenHost === "string")
    && isNullableSafeInteger(state.listenPort)
    && Number.isSafeInteger(state.inFlight) && state.inFlight >= 0;
}

function validWorkerError(error) {
  return hasExactFields(error, WORKER_ERROR_FIELDS)
    && typeof error.code === "string" && ERROR_CODE_PATTERN.test(error.code)
    && typeof error.message === "string" && error.message.length > 0;
}

function validWorkerState(worker) {
  return hasExactFields(worker, WORKER_FIELDS)
    && typeof worker.phase === "string" && worker.phase.length > 0
    && isNullableSafeInteger(worker.pid, { min: 1 })
    && Number.isSafeInteger(worker.generation) && worker.generation >= 0
    && (worker.state === null || validChildState(worker.state))
    && Number.isSafeInteger(worker.restartCount) && worker.restartCount >= 0
    && (worker.startedAt === null || isIsoTimestamp(worker.startedAt))
    && (worker.error === null || validWorkerError(worker.error));
}

function expectedAdmin(adminPort) {
  return {
    host: "127.0.0.1",
    port: adminPort,
    authority: `127.0.0.1:${adminPort}`,
    origin: `http://127.0.0.1:${adminPort}`
  };
}

function validateSupervisorState(state, adminPort) {
  const admin = expectedAdmin(adminPort);
  return hasExactFields(state, STATE_FIELDS)
    && state.schemaVersion === 1
    && isSafePid(state.supervisorPid)
    && isIsoTimestamp(state.startedAt)
    && hasExactFields(state.admin, ADMIN_FIELDS)
    && Object.keys(admin).every((field) => state.admin[field] === admin[field])
    && validWorkerState(state.worker);
}

export function readSupervisorStateSnapshot({
  path,
  adminPort = 15101,
  fileOperations = DEFAULT_FILE_OPERATIONS,
  platform = process.platform
} = {}) {
  if (typeof path !== "string" || path.length === 0
    || !Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65_535) {
    return null;
  }
  try {
    const resolvedPath = resolve(path);
    const snapshot = readPrivateFileSnapshot({
      path: resolvedPath,
      fileOperations,
      platform,
      maxBytes: MAX_STATE_BYTES
    });
    const state = JSON.parse(snapshot.bytes.toString("utf8"));
    if (!validateSupervisorState(state, adminPort)) return null;
    const opaqueSnapshot = Object.freeze(Object.create(null));
    supervisorStateSnapshots.set(opaqueSnapshot, {
      path: resolvedPath,
      state: structuredClone(state),
      identity: { ...snapshot.identity },
      bytes: Buffer.from(snapshot.bytes),
      adminPort
    });
    return opaqueSnapshot;
  } catch {
    return null;
  }
}

export function readSupervisorState(options) {
  const snapshot = readSupervisorStateSnapshot(options);
  const owned = snapshot === null ? null : supervisorStateSnapshots.get(snapshot);
  return owned ? structuredClone(owned.state) : null;
}

function matchesExpectedStateSnapshot(snapshot, expectedSnapshot) {
  const current = snapshot === null ? null : supervisorStateSnapshots.get(snapshot);
  return current !== null && current !== undefined
    && sameIdentity(current.identity, expectedSnapshot.identity)
    && current.bytes.equals(expectedSnapshot.bytes)
    && current.state.supervisorPid === expectedSnapshot.state.supervisorPid
    && current.state.startedAt === expectedSnapshot.state.startedAt
    && Object.keys(current.state.admin).every(
      (field) => current.state.admin[field] === expectedSnapshot.state.admin[field]
    );
}

function pathExists(path, fileOperations) {
  try {
    fileOperations.lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function restoreClaimWithoutReplacement(claimPath, statePath, fileOperations) {
  try {
    fileOperations.linkSync(claimPath, statePath);
    fileOperations.rmSync(claimPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function staleStateClaimPath(statePath) {
  return resolve(dirname(statePath), `${basename(statePath)}.stale`);
}

function expectedManagedProcessAlive(expected, isProcessAlive) {
  const workerPid = expected.state.worker.pid;
  return isProcessAlive(expected.state.supervisorPid)
    || workerPid !== null && isProcessAlive(workerPid);
}

export function removeStaleSupervisorState({
  path,
  expectedSnapshot,
  adminPort = 15101,
  fileOperations = DEFAULT_FILE_OPERATIONS,
  platform = process.platform,
  isProcessAlive = defaultIsProcessAlive
} = {}) {
  if (typeof path !== "string" || path.length === 0
    || !Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65_535
    || typeof isProcessAlive !== "function") {
    return { removed: false, reason: STALE_STATE_REMOVAL_REASONS.INVALID_INPUT };
  }
  const statePath = resolve(path);
  const claimPath = staleStateClaimPath(statePath);
  const expected = supervisorStateSnapshots.get(expectedSnapshot);
  if (!expected
    || expected.path !== statePath && expected.path !== claimPath
    || expected.adminPort !== adminPort) {
    return { removed: false, reason: STALE_STATE_REMOVAL_REASONS.INVALID_INPUT };
  }

  try {
    if (expectedManagedProcessAlive(expected, isProcessAlive)) {
      return { removed: false, reason: STALE_STATE_REMOVAL_REASONS.PROCESS_RUNNING };
    }
    const canonicalExists = pathExists(statePath, fileOperations);
    const claimExists = pathExists(claimPath, fileOperations);
    let claimedByThisCall = false;

    if (canonicalExists) {
      const current = readSupervisorStateSnapshot({
        path: statePath,
        adminPort,
        fileOperations,
        platform
      });
      if (!matchesExpectedStateSnapshot(current, expected)) {
        return { removed: false, reason: STALE_STATE_REMOVAL_REASONS.STATE_CHANGED };
      }
      if (claimExists) {
        const residualClaim = readSupervisorStateSnapshot({
          path: claimPath,
          adminPort,
          fileOperations,
          platform
        });
        if (!matchesExpectedStateSnapshot(residualClaim, expected)) {
          return { removed: false, reason: STALE_STATE_REMOVAL_REASONS.CLAIM_CONFLICT };
        }
        if (expectedManagedProcessAlive(expected, isProcessAlive)) {
          return { removed: false, reason: STALE_STATE_REMOVAL_REASONS.PROCESS_RUNNING };
        }
        fileOperations.rmSync(claimPath);
      }
      fileOperations.renameSync(statePath, claimPath);
      claimedByThisCall = true;
    } else if (!claimExists) {
      return { removed: false, reason: STALE_STATE_REMOVAL_REASONS.STATE_MISSING };
    }

    const claimed = readSupervisorStateSnapshot({
      path: claimPath,
      adminPort,
      fileOperations,
      platform
    });
    if (!matchesExpectedStateSnapshot(claimed, expected)) {
      if (claimedByThisCall) {
        restoreClaimWithoutReplacement(claimPath, statePath, fileOperations);
      }
      return { removed: false, reason: STALE_STATE_REMOVAL_REASONS.CLAIM_CHANGED };
    }
    if (expectedManagedProcessAlive(expected, isProcessAlive)) {
      if (claimedByThisCall) {
        restoreClaimWithoutReplacement(claimPath, statePath, fileOperations);
      }
      return { removed: false, reason: STALE_STATE_REMOVAL_REASONS.PROCESS_RUNNING };
    }

    const confirmed = readSupervisorStateSnapshot({
      path: claimPath,
      adminPort,
      fileOperations,
      platform
    });
    if (!matchesExpectedStateSnapshot(confirmed, expected)) {
      return { removed: false, reason: STALE_STATE_REMOVAL_REASONS.CLAIM_CHANGED };
    }
    fileOperations.rmSync(claimPath);
    return { removed: true, reason: STALE_STATE_REMOVAL_REASONS.REMOVED };
  } catch {
    return { removed: false, reason: STALE_STATE_REMOVAL_REASONS.CLEANUP_FAILED };
  }
}

export function readControlToken({
  path,
  fileOperations = DEFAULT_FILE_OPERATIONS,
  platform = process.platform
} = {}) {
  try {
    if (typeof path !== "string" || path.length === 0) throw new TypeError("token path is invalid");
    const text = readPrivateFile({ path, fileOperations, platform, maxBytes: 44 }).toString("utf8");
    const token = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (!TOKEN_PATTERN.test(token) || text !== token && text !== `${token}\n`) {
      throw new TypeError("token format is invalid");
    }
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== token) {
      throw new TypeError("token encoding is invalid");
    }
    return token;
  } catch (error) {
    if (error instanceof CrpError) throw error;
    throw clientError("SUPERVISOR_TOKEN_INVALID");
  }
}

function validateOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1"
      || !url.port || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
      throw new TypeError("origin is unsafe");
    }
    return url.origin;
  } catch {
    throw clientError("SUPERVISOR_CLIENT_INPUT_INVALID", { status: 400 });
  }
}

function validateRequest(method, path) {
  if (!["GET", "POST", "PATCH", "DELETE"].includes(method)
    || typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")
    || /[\\\u0000-\u001f\u007f]/.test(path)) {
    throw clientError("SUPERVISOR_CLIENT_INPUT_INVALID", { status: 400 });
  }
}

function sanitizeErrorDetails(details) {
  if (!isPlainObject(details)) return {};
  const projected = {};
  for (const [key, value] of Object.entries(details)) {
    if (SAFE_ERROR_DETAIL_FIELDS.has(key) || value === "[REDACTED]") {
      projected[key] = structuredClone(value);
    }
  }
  return projected;
}

function publicResponseError(payload, status) {
  const error = payload?.error;
  if (!isPlainObject(error)
    || typeof error.code !== "string" || !ERROR_CODE_PATTERN.test(error.code)
    || typeof error.message !== "string" || error.message.length === 0
    || typeof error.action !== "string" || error.action.length === 0) {
    return clientError("SUPERVISOR_RESPONSE_INVALID");
  }
  const projected = new CrpError(error.code, error.message, error.action, {
    status,
    details: sanitizeErrorDetails(error.details)
  });
  if (typeof error.requestId === "string" && error.requestId.length > 0) {
    projected.requestId = error.requestId;
  }
  return projected;
}

export class SupervisorClient {
  #origin;
  #controlToken;
  #fetch;
  #requestTimeoutMs;

  constructor({
    origin,
    controlTokenPath,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 8_000,
    fileOperations = DEFAULT_FILE_OPERATIONS,
    platform = process.platform
  } = {}) {
    if (typeof fetchImpl !== "function"
      || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw clientError("SUPERVISOR_CLIENT_INPUT_INVALID", { status: 400 });
    }
    this.#origin = validateOrigin(origin);
    this.#controlToken = readControlToken({
      path: controlTokenPath,
      fileOperations,
      platform
    });
    this.#fetch = fetchImpl;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  request(method, path, body, options) {
    validateRequest(method, path);
    let requestTimeoutMs = this.#requestTimeoutMs;
    let expectedStatus = null;
    if (options !== undefined) {
      if (!hasOnlyFields(options, REQUEST_OPTIONS_FIELDS)
        || "requestTimeoutMs" in options
          && (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1)
        || "expectedStatus" in options
          && (!Number.isInteger(options.expectedStatus)
            || options.expectedStatus < 100 || options.expectedStatus > 599)) {
        throw clientError("SUPERVISOR_CLIENT_INPUT_INVALID", { status: 400 });
      }
      if ("requestTimeoutMs" in options) requestTimeoutMs = options.requestTimeoutMs;
      if ("expectedStatus" in options) expectedStatus = options.expectedStatus;
    }
    return this.#performRequest(method, path, body, requestTimeoutMs, expectedStatus);
  }

  async #performRequest(method, path, body, requestTimeoutMs, expectedStatus) {
    const headers = { authorization: `Bearer ${this.#controlToken}` };
    const options = {
      method,
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs)
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
      options.body = JSON.stringify(body);
      if (Buffer.byteLength(options.body, "utf8") > 64 * 1_024) {
        throw clientError("SUPERVISOR_CLIENT_INPUT_INVALID", { status: 400 });
      }
    }

    let response;
    try {
      response = await this.#fetch(`${this.#origin}/api/v1${path}`, options);
    } catch {
      throw clientError("SUPERVISOR_UNAVAILABLE");
    }
    let text;
    try {
      text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("response too large");
    } catch {
      throw clientError("SUPERVISOR_RESPONSE_INVALID");
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw clientError("SUPERVISOR_RESPONSE_INVALID");
    }
    if (!response.ok) throw publicResponseError(payload, response.status);
    if (expectedStatus !== null && response.status !== expectedStatus) {
      throw clientError("SUPERVISOR_RESPONSE_INVALID");
    }
    if (!isPlainObject(payload)) throw clientError("SUPERVISOR_RESPONSE_INVALID");
    return payload;
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ignoreLateChildError() {}

function observeStartupFailure(child) {
  if (!child || typeof child.on !== "function" || typeof child.once !== "function") {
    return { failure: null, dispose() {} };
  }
  let resolveFailure;
  let disposed = false;
  let closeFallback = null;
  const failure = new Promise((resolvePromise) => { resolveFailure = resolvePromise; });
  const removeListeners = () => {
    child.off?.("message", onMessage);
    child.off?.("error", onError);
    child.off?.("close", onClose);
    if (closeFallback !== null) {
      clearImmediate(closeFallback);
      closeFallback = null;
    }
    child.on("error", ignoreLateChildError);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    removeListeners();
    if (child.connected === true && typeof child.disconnect === "function") {
      try { child.disconnect(); } catch {}
    }
  };
  const fail = (error) => {
    if (disposed) return;
    dispose();
    resolveFailure(error);
  };
  const onMessage = (message) => {
    fail(parseStartupFailureMessage(message) ?? clientError("SUPERVISOR_START_FAILED"));
  };
  const onError = () => { fail(clientError("SUPERVISOR_START_FAILED")); };
  const onClose = () => {
    if (closeFallback !== null) return;
    closeFallback = setImmediate(() => {
      closeFallback = null;
      fail(clientError("SUPERVISOR_START_FAILED"));
    });
  };
  child.on("message", onMessage);
  child.once("error", onError);
  child.once("close", onClose);
  child.channel?.unref?.();
  return { failure, dispose };
}

async function raceStartupFailure(operation, startupOutcome) {
  const observedOperation = Promise.resolve(operation).then(
    (value) => ({ type: "operation", value }),
    (error) => ({ type: "operation-error", error })
  );
  if (startupOutcome === null) {
    const outcome = await observedOperation;
    if (outcome.type === "operation-error") throw outcome.error;
    return outcome.value;
  }
  const outcome = await Promise.race([observedOperation, startupOutcome]);
  if (outcome.type === "startup-error" || outcome.type === "operation-error") {
    throw outcome.error;
  }
  return outcome.value;
}

export function spawnDetachedSupervisor({
  paths,
  home = dirname(paths?.globalHome ?? ""),
  spawnImpl = spawn,
  fileOperations = DEFAULT_FILE_OPERATIONS
} = {}) {
  if (!paths || typeof paths.globalHome !== "string" || typeof paths.logPath !== "string"
    || typeof home !== "string" || home.length === 0 || typeof spawnImpl !== "function") {
    throw clientError("SUPERVISOR_START_FAILED");
  }
  fileOperations.mkdirSync(paths.globalHome, { recursive: true, mode: 0o700 });
  try { fileOperations.chmodSync(paths.globalHome, 0o700); } catch {}
  let logDescriptor;
  let child;
  let monitor;
  try {
    logDescriptor = fileOperations.openSync(paths.logPath, "a", 0o600);
    try { fileOperations.fchmodSync(logDescriptor, 0o600); } catch {}
    child = spawnImpl(process.execPath, [SUPERVISOR_ENTRY], {
      cwd: resolve(PACKAGE_ROOT),
      env: { ...process.env, CRP_HOME: home },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logDescriptor, logDescriptor, "ipc"],
      serialization: "json",
      shell: false
    });
    monitor = observeStartupFailure(child);
    Object.defineProperties(child, {
      startupFailure: { value: monitor.failure, configurable: true },
      disposeStartupMonitor: { value: monitor.dispose, configurable: true }
    });
    child.unref();
    return child;
  } catch {
    try { monitor?.dispose(); } catch {}
    try {
      if (child?.listenerCount?.("error") === 0) child.on("error", ignoreLateChildError);
    } catch {}
    try { child?.kill?.("SIGTERM"); } catch {}
    if (child?.connected === true && typeof child.disconnect === "function") {
      try { child.disconnect(); } catch {}
    }
    throw clientError("SUPERVISOR_START_FAILED");
  } finally {
    if (logDescriptor !== undefined) fileOperations.closeSync(logDescriptor);
  }
}

export async function discoverSupervisor({
  paths,
  adminPort = 15101,
  fetchImpl = globalThis.fetch,
  fileOperations = DEFAULT_FILE_OPERATIONS,
  platform = process.platform,
  isProcessAlive = defaultIsProcessAlive,
  probeTimeoutMs = 2_000,
  requestTimeoutMs = 30_000
} = {}) {
  const state = readSupervisorState({
    path: paths?.statePath,
    adminPort,
    fileOperations,
    platform
  });
  if (!state || !isProcessAlive(state.supervisorPid)) return null;
  const client = new SupervisorClient({
    origin: state.admin.origin,
    controlTokenPath: paths.controlTokenPath,
    fetchImpl,
    requestTimeoutMs,
    fileOperations,
    platform
  });
  let status;
  try {
    status = await client.request("GET", "/status", undefined, {
      requestTimeoutMs: probeTimeoutMs
    });
  } catch (error) {
    if (error?.code === "SUPERVISOR_UNAVAILABLE") return null;
    throw error;
  }
  if (!isPlainObject(status.supervisor)
    || status.supervisor.pid !== state.supervisorPid
    || status.supervisor.startedAt !== state.startedAt) {
    return null;
  }
  return {
    origin: state.admin.origin,
    state,
    status,
    client,
    spawned: false
  };
}

async function ensureSupervisorInternal({
  paths,
  adminPort,
  spawnSupervisor,
  fetchImpl,
  fileOperations,
  platform,
  isProcessAlive,
  probeTimeoutMs,
  requestTimeoutMs,
  timeoutMs,
  pollIntervalMs,
  now,
  wait,
  home
}) {
  const discoveryOptions = {
    paths,
    adminPort,
    fetchImpl,
    fileOperations,
    platform,
    isProcessAlive,
    probeTimeoutMs,
    requestTimeoutMs
  };
  const existing = await discoverSupervisor(discoveryOptions);
  if (existing) return existing;

  try {
    const statePath = resolve(paths.statePath);
    const claimPath = staleStateClaimPath(statePath);
    if (pathExists(claimPath, fileOperations)) {
      if (pathExists(statePath, fileOperations)) throw new Error("state and claim coexist");
      const expectedSnapshot = readSupervisorStateSnapshot({
        path: claimPath,
        adminPort,
        fileOperations,
        platform
      });
      if (expectedSnapshot === null) throw new Error("claim is invalid");
      const cleanup = removeStaleSupervisorState({
        path: statePath,
        expectedSnapshot,
        adminPort,
        fileOperations,
        platform,
        isProcessAlive
      });
      if (cleanup.removed !== true && cleanup.reason !== STALE_STATE_REMOVAL_REASONS.STATE_MISSING) {
        throw new Error("claim could not be recovered");
      }
    }
  } catch {
    throw clientError("SUPERVISOR_START_FAILED");
  }

  let spawnedChild;
  try {
    spawnedChild = spawnSupervisor({ paths, home });
  } catch {
    throw clientError("SUPERVISOR_START_FAILED");
  }

  const startupOutcome = spawnedChild?.startupFailure
    && typeof spawnedChild.startupFailure.then === "function"
    ? Promise.resolve(spawnedChild.startupFailure).then(
      (error) => ({
        type: "startup-error",
        error: error instanceof CrpError ? error : clientError("SUPERVISOR_START_FAILED")
      }),
      () => ({ type: "startup-error", error: clientError("SUPERVISOR_START_FAILED") })
    )
    : null;
  try {
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      const discovered = await raceStartupFailure(
        discoverSupervisor(discoveryOptions),
        startupOutcome
      );
      if (discovered) return { ...discovered, spawned: true };
      if (now() >= deadline) break;
      await raceStartupFailure(
        wait(Math.min(pollIntervalMs, deadline - now())),
        startupOutcome
      );
    }
    throw clientError("SUPERVISOR_START_TIMEOUT");
  } catch (error) {
    try {
      if (typeof spawnedChild?.kill === "function") spawnedChild.kill("SIGTERM");
    } catch {
      // Preserve the readiness/discovery error when cleanup is unavailable.
    }
    throw error;
  } finally {
    try { spawnedChild?.disposeStartupMonitor?.(); } catch {}
  }
}

export function ensureSupervisor({
  paths,
  adminPort = 15101,
  spawnSupervisor = (options) => spawnDetachedSupervisor(options),
  fetchImpl = globalThis.fetch,
  fileOperations = DEFAULT_FILE_OPERATIONS,
  platform = process.platform,
  isProcessAlive = defaultIsProcessAlive,
  probeTimeoutMs = 2_000,
  requestTimeoutMs = 30_000,
  timeoutMs = 8_000,
  pollIntervalMs = 100,
  now = () => Date.now(),
  wait = (milliseconds) => delay(milliseconds),
  home = dirname(paths?.globalHome ?? "")
} = {}) {
  if (!paths || typeof paths.statePath !== "string" || typeof paths.controlTokenPath !== "string"
    || typeof paths.globalHome !== "string" || typeof paths.logPath !== "string"
    || !Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65_535
    || typeof spawnSupervisor !== "function" || typeof fetchImpl !== "function"
    || typeof isProcessAlive !== "function" || typeof now !== "function" || typeof wait !== "function"
    || !Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    return Promise.reject(clientError("SUPERVISOR_CLIENT_INPUT_INVALID", { status: 400 }));
  }
  const key = `${resolve(paths.statePath)}\u0000${adminPort}`;
  if (pendingEnsures.has(key)) return pendingEnsures.get(key);
  const operation = ensureSupervisorInternal({
    paths,
    adminPort,
    spawnSupervisor,
    fetchImpl,
    fileOperations,
    platform,
    isProcessAlive,
    probeTimeoutMs,
    requestTimeoutMs,
    timeoutMs,
    pollIntervalMs,
    now,
    wait,
    home
  });
  pendingEnsures.set(key, operation);
  const clear = () => {
    if (pendingEnsures.get(key) === operation) pendingEnsures.delete(key);
  };
  void operation.then(clear, clear);
  return operation;
}
