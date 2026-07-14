import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { CrpError } from "../shared/errors.mjs";

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
const REQUEST_OPTIONS_FIELDS = new Set(["requestTimeoutMs"]);
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync
};
const pendingEnsures = new Map();

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

function readPrivateFile({ path, fileOperations, platform, maxBytes }) {
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
    return Buffer.from(bytes);
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
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

export function readSupervisorState({
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
    const bytes = readPrivateFile({
      path,
      fileOperations,
      platform,
      maxBytes: MAX_STATE_BYTES
    });
    const state = JSON.parse(bytes.toString("utf8"));
    return validateSupervisorState(state, adminPort) ? structuredClone(state) : null;
  } catch {
    return null;
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
    if (options !== undefined) {
      if (!hasExactFields(options, REQUEST_OPTIONS_FIELDS)
        || !Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
        throw clientError("SUPERVISOR_CLIENT_INPUT_INVALID", { status: 400 });
      }
      requestTimeoutMs = options.requestTimeoutMs;
    }
    return this.#performRequest(method, path, body, requestTimeoutMs);
  }

  async #performRequest(method, path, body, requestTimeoutMs) {
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
  try {
    logDescriptor = fileOperations.openSync(paths.logPath, "a", 0o600);
    try { fileOperations.fchmodSync(logDescriptor, 0o600); } catch {}
    const child = spawnImpl(process.execPath, [SUPERVISOR_ENTRY], {
      cwd: resolve(PACKAGE_ROOT),
      env: { ...process.env, CRP_HOME: home },
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
      shell: false
    });
    child.once?.("error", () => {});
    child.unref();
    return child;
  } catch {
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

  let spawnedChild;
  try {
    spawnedChild = spawnSupervisor({ paths, home });
  } catch {
    throw clientError("SUPERVISOR_START_FAILED");
  }

  try {
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      const discovered = await discoverSupervisor(discoveryOptions);
      if (discovered) return { ...discovered, spawned: true };
      if (now() >= deadline) break;
      await wait(Math.min(pollIntervalMs, deadline - now()));
    }
    throw clientError("SUPERVISOR_START_TIMEOUT");
  } catch (error) {
    try {
      if (typeof spawnedChild?.kill === "function") spawnedChild.kill("SIGTERM");
    } catch {
      // Preserve the readiness/discovery error when cleanup is unavailable.
    }
    throw error;
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
