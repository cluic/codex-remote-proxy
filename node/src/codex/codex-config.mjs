import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  hasPendingCodexHistoryRepair,
  inspectPendingCodexHistoryRepair,
  patchCodexProviderConfigText,
  planCodexProviderTransition,
  runCodexHistoryRepairTransition
} from "./codex-history-repair.mjs";

const STABLE_CONFIG_ERROR_CODES = new Set([
  "CODEX_CONFIG_PARENT_UNSAFE",
  "CODEX_CONFIG_BUSY",
  "CODEX_CONFIG_CHANGED",
  "CODEX_CONFIG_COMMITTED_DEGRADED",
  "CODEX_CONFIG_READ_FAILED",
  "CODEX_CONFIG_WRITE_FAILED",
  "CODEX_HISTORY_REPAIR_INVALID",
  "CODEX_HISTORY_REPAIR_CONFLICT",
  "CODEX_HISTORY_REPAIR_FAILED",
  "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED"
]);
const TARGET_PROVIDER = "OpenAI";
const CONFIG_LOCK_SCHEMA_VERSION = 1;
const CONFIG_LOCK_MANAGED_BY = "codex-remote-proxy/config-lock";
const CONFIG_LOCK_FIELDS = new Set([
  "schemaVersion",
  "managedBy",
  "owner",
  "phase",
  "binding"
]);
const CONFIG_LOCK_OWNER_FIELDS = new Set(["pid", "startedAt", "instanceId"]);
const CONFIG_LOCK_BINDING_FIELDS = new Set([
  "operationId",
  "sourceConfigSha256",
  "targetConfigSha256",
  "pendingRequired"
]);
const SAFE_LOCK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROCESS_STARTED_AT = new Date(
  Date.now() - Math.floor(process.uptime() * 1000)
).toISOString();
const NO_HISTORY_REPAIR = Object.freeze({
  required: false,
  completed: false,
  resumed: false,
  backupCreated: false,
  rolloutFiles: 0,
  rolloutRecords: 0,
  sqliteFiles: 0,
  sqliteRows: 0,
  encryptedContentDetected: false
});
const DEFAULT_HISTORY_REPAIR = Object.freeze({
  plan: planCodexProviderTransition,
  hasPending: hasPendingCodexHistoryRepair,
  inspectPending: inspectPendingCodexHistoryRepair,
  run: runCodexHistoryRepairTransition
});
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  fsyncDirectorySync: defaultFsyncDirectorySync,
  statSync,
  writeFileSync
};

function defaultFsyncDirectorySync(path) {
  if (process.platform === "win32") return;
  const directoryFlag = typeof constants.O_DIRECTORY === "number"
    ? constants.O_DIRECTORY
    : 0;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | directoryFlag);
    const stats = fstatSync(descriptor);
    if (!stats.isDirectory()) throw new Error("Directory identity is invalid.");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncDirectory(path, fileOperations) {
  if (typeof fileOperations.fsyncDirectorySync !== "function") {
    throw new Error("Directory fsync is unavailable.");
  }
  fileOperations.fsyncDirectorySync(path);
}

function exactObjectFields(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

function configSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createDefaultConfigLockOwner() {
  return Object.freeze({
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT,
    instanceId: randomUUID()
  });
}

function defaultConfigLockOwnerLiveness(owner) {
  if (owner.pid === process.pid && owner.startedAt === PROCESS_STARTED_AT) return "live";
  try {
    process.kill(owner.pid, 0);
    return "live";
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "unknown";
  }
}

function makeBackupStem(configPath, date) {
  const timestamp = date.toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  return `${configPath}.${timestamp}`;
}

function copyBackupExclusively(configPath, source, date, fileOperations) {
  const stem = makeBackupStem(configPath, date);
  const bytes = source.bytes;
  let suffix = 1;
  let backupPath = `${stem}.bak`;

  while (true) {
    let descriptor;
    let identity;
    let writtenBytes = Buffer.alloc(0);
    try {
      descriptor = fileOperations.openSync(backupPath, "wx", source.mode);
      identity = fileOperations.fstatSync(descriptor);
      if (!identity.isFile()) throw new Error("Backup identity is invalid.");
      fileOperations.writeFileSync(descriptor, bytes);
      writtenBytes = bytes;
      fileOperations.fsyncSync(descriptor);
      fileOperations.closeSync(descriptor);
      descriptor = undefined;
      const backup = readClaimedPath(backupPath, fileOperations);
      if (!sameIdentity(backup.identity, identity) || !backup.bytes.equals(bytes)) {
        throw new Error("Backup identity changed.");
      }
      syncDirectory(dirname(backupPath), fileOperations);
      return backupPath;
    } catch (error) {
      if (descriptor !== undefined) {
        try { fileOperations.closeSync(descriptor); } catch {}
      }
      if (identity !== undefined) {
        claimOwnedPath(backupPath, identity, fileOperations, { expectedBytes: writtenBytes });
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }
      backupPath = `${stem}.${suffix}.bak`;
      suffix += 1;
    }
  }
}

function createConfigError(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

function configCommittedDegraded(cause) {
  const error = createConfigError(
    "CODEX_CONFIG_COMMITTED_DEGRADED",
    "The Codex configuration was updated, but completion could not be confirmed.",
    cause
  );
  error.action = "Review the Codex configuration and retry before starting the proxy.";
  error.status = 500;
  error.details = { committed: true, degraded: true, pending: false };
  return error;
}

function classifyConfigError(error, phase) {
  if (STABLE_CONFIG_ERROR_CODES.has(error?.code)) return error;
  return phase === "read"
    ? createConfigError(
      "CODEX_CONFIG_READ_FAILED",
      "Codex configuration could not be read safely.",
      error
    )
    : createConfigError(
      "CODEX_CONFIG_WRITE_FAILED",
      "Codex configuration could not be written safely.",
      error
    );
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function parentUnsafe(cause) {
  return createConfigError(
    "CODEX_CONFIG_PARENT_UNSAFE",
    "The Codex configuration directory is unsafe.",
    cause
  );
}

function ensureConfigParent(configPath, fileOperations) {
  const parentPath = dirname(configPath);
  let parent;
  let created = false;
  try {
    parent = fileOperations.lstatSync(parentPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw parentUnsafe(error);
    try {
      fileOperations.mkdirSync(parentPath, { mode: 0o700 });
      fileOperations.chmodSync(parentPath, 0o700);
      created = true;
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
    try {
      parent = fileOperations.lstatSync(parentPath);
    } catch (error) {
      throw parentUnsafe(error);
    }
  }
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw parentUnsafe();
  }
  syncDirectory(parentPath, fileOperations);
  if (created) syncDirectory(dirname(parentPath), fileOperations);
  return { path: parentPath, identity: parent };
}

function assertConfigParent(parent, fileOperations) {
  let current;
  try {
    current = fileOperations.lstatSync(parent.path);
  } catch (error) {
    throw parentUnsafe(error);
  }
  if (current.isSymbolicLink()
    || !current.isDirectory()
    || !sameIdentity(current, parent.identity)) {
    throw parentUnsafe();
  }
}

function configChanged(cause) {
  return createConfigError(
    "CODEX_CONFIG_CHANGED",
    "Codex configuration changed during bootstrap.",
    cause
  );
}

function readConfigSource(path, fileOperations, { missing = false } = {}) {
  let before;
  try {
    before = fileOperations.lstatSync(path);
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw createConfigError(
      "CODEX_CONFIG_READ_FAILED",
      "Codex configuration could not be read safely."
    );
  }

  const noFollow = typeof fileOperations.constants.O_NOFOLLOW === "number"
    ? fileOperations.constants.O_NOFOLLOW
    : 0;
  let descriptor;
  try {
    descriptor = fileOperations.openSync(
      path,
      fileOperations.constants.O_RDONLY | noFollow
    );
    const opened = fileOperations.fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw configChanged();
    }
    const bytes = Buffer.from(fileOperations.readFileSync(descriptor));
    let after;
    try {
      after = fileOperations.lstatSync(path);
    } catch (error) {
      throw configChanged(error);
    }
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after)) {
      throw configChanged();
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw createConfigError(
        "CODEX_CONFIG_READ_FAILED",
        "Codex configuration could not be read safely.",
        error
      );
    }
    return {
      bytes,
      text,
      identity: opened,
      mode: opened.mode & 0o7777
    };
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
}

function assertCurrentConfig(path, source, fileOperations) {
  const current = readConfigSource(path, fileOperations, { missing: true });
  if (current === null
    || !sameIdentity(current.identity, source.identity)
    || !current.bytes.equals(source.bytes)) {
    throw configChanged();
  }
}

function ensureCanonicalBlocker(path, residualPath, fileOperations) {
  try {
    fileOperations.lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }

  if (residualPath !== null) {
    try {
      fileOperations.linkSync(residualPath, path);
      syncDirectory(dirname(path), fileOperations);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return true;
    }
  }

  let descriptor;
  try {
    descriptor = fileOperations.openSync(path, "wx", 0o600);
    fileOperations.writeFileSync(descriptor, "crp-blocked\n", "utf8");
    fileOperations.fsyncSync(descriptor);
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(dirname(path), fileOperations);
    return true;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileOperations.closeSync(descriptor); } catch {}
    }
    return error?.code === "EEXIST";
  }
}

function readClaimedPath(path, fileOperations) {
  const before = fileOperations.lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Claimed path is not a regular file.");
  }
  const noFollow = typeof fileOperations.constants.O_NOFOLLOW === "number"
    ? fileOperations.constants.O_NOFOLLOW
    : 0;
  let descriptor;
  try {
    descriptor = fileOperations.openSync(
      path,
      fileOperations.constants.O_RDONLY | noFollow
    );
    const opened = fileOperations.fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error("Claimed path identity changed.");
    }
    const bytes = Buffer.from(fileOperations.readFileSync(descriptor));
    const after = fileOperations.lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after)) {
      throw new Error("Claimed path identity changed.");
    }
    return { identity: opened, bytes };
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
}

function restoreCanonicalBlocker(claimPath, path, fileOperations) {
  try {
    fileOperations.linkSync(claimPath, path);
    syncDirectory(dirname(path), fileOperations);
  } catch (error) {
    if (error?.code === "EEXIST") return true;
    return ensureCanonicalBlocker(path, claimPath, fileOperations);
  }
  try {
    fileOperations.rmSync(claimPath);
  } catch {
    // The restored canonical hard link remains the blocker.
  }
  return true;
}

function claimOwnedPath(
  path,
  expectedIdentity,
  fileOperations,
  { expectedBytes = null, missingIsRemoved = true, suffix = "claim" } = {}
) {
  const claimPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.${suffix}`);
  try {
    fileOperations.renameSync(path, claimPath);
    syncDirectory(dirname(path), fileOperations);
  } catch (error) {
    if (error?.code === "ENOENT" && missingIsRemoved) return true;
    ensureCanonicalBlocker(path, null, fileOperations);
    return false;
  }

  let claimed;
  try {
    claimed = readClaimedPath(claimPath, fileOperations);
  } catch {
    restoreCanonicalBlocker(claimPath, path, fileOperations);
    return false;
  }
  if (!sameIdentity(claimed.identity, expectedIdentity)
    || expectedBytes !== null && !claimed.bytes.equals(expectedBytes)) {
    restoreCanonicalBlocker(claimPath, path, fileOperations);
    return false;
  }
  try {
    fileOperations.rmSync(claimPath);
    syncDirectory(dirname(path), fileOperations);
    return true;
  } catch {
    restoreCanonicalBlocker(claimPath, path, fileOperations);
    return false;
  }
}

function validConfigLockOwner(owner) {
  return exactObjectFields(owner, CONFIG_LOCK_OWNER_FIELDS)
    && Number.isInteger(owner.pid) && owner.pid > 0 && owner.pid <= 0xffffffff
    && typeof owner.startedAt === "string" && owner.startedAt.length <= 64
    && !Number.isNaN(Date.parse(owner.startedAt))
    && new Date(owner.startedAt).toISOString() === owner.startedAt
    && typeof owner.instanceId === "string"
    && SAFE_LOCK_ID_PATTERN.test(owner.instanceId);
}

function validConfigLockBinding(binding) {
  return exactObjectFields(binding, CONFIG_LOCK_BINDING_FIELDS)
    && SAFE_LOCK_ID_PATTERN.test(binding.operationId)
    && (binding.sourceConfigSha256 === null
      || SHA256_PATTERN.test(binding.sourceConfigSha256))
    && SHA256_PATTERN.test(binding.targetConfigSha256)
    && typeof binding.pendingRequired === "boolean";
}

function configLockBytes(owner, phase = "acquired", binding = null) {
  if (!validConfigLockOwner(owner)
    || !new Set(["acquired", "prepared", "completed"]).has(phase)
    || (binding === null ? phase !== "acquired" : !validConfigLockBinding(binding))) {
    throw createConfigError(
      "CODEX_CONFIG_WRITE_FAILED",
      "Codex configuration lock metadata is invalid."
    );
  }
  return Buffer.from(`${JSON.stringify({
    schemaVersion: CONFIG_LOCK_SCHEMA_VERSION,
    managedBy: CONFIG_LOCK_MANAGED_BY,
    owner,
    phase,
    binding
  })}\n`, "utf8");
}

function parseConfigLock(source) {
  let value;
  try {
    value = JSON.parse(source.bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!exactObjectFields(value, CONFIG_LOCK_FIELDS)
    || value.schemaVersion !== CONFIG_LOCK_SCHEMA_VERSION
    || value.managedBy !== CONFIG_LOCK_MANAGED_BY
    || !validConfigLockOwner(value.owner)
    || !new Set(["acquired", "prepared", "completed"]).has(value.phase)
    || (value.binding === null
      ? value.phase !== "acquired"
      : !validConfigLockBinding(value.binding))) {
    return null;
  }
  return value;
}

function samePendingAndLockBinding(pending, binding) {
  return pending !== null && binding !== null
    && pending.operationId === binding.operationId
    && pending.sourceConfigSha256 === binding.sourceConfigSha256
    && pending.targetConfigSha256 === binding.targetConfigSha256;
}

function configHashForRecovery(configPath, fileOperations) {
  const source = readConfigSource(configPath, fileOperations, { missing: true });
  return source === null ? null : configSha256(source.bytes);
}

function staleLockCanBeRecovered({
  document,
  pending,
  configHash
}) {
  if (document.binding === null) return pending === null;
  const binding = document.binding;
  const sourceMatches = configHash === binding.sourceConfigSha256;
  const targetMatches = configHash === binding.targetConfigSha256;
  if (document.phase === "completed") {
    return targetMatches && (pending === null
      || binding.pendingRequired && samePendingAndLockBinding(pending, binding));
  }
  if (pending !== null) {
    return binding.pendingRequired
      && samePendingAndLockBinding(pending, binding)
      && (sourceMatches || targetMatches);
  }
  if (document.phase !== "prepared") return false;
  if (!binding.pendingRequired) return sourceMatches || targetMatches;
  return sourceMatches;
}

function busyConfigLock(cause) {
  return createConfigError(
    "CODEX_CONFIG_BUSY",
    "Codex configuration is already being updated.",
    cause
  );
}

function acquireConfigLock(lockPath, fileOperations, {
  owner,
  ownerLiveness,
  pending,
  configPath,
  initialBinding = null,
  allowRecovery = true
}) {
  let descriptor;
  try {
    descriptor = fileOperations.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!allowRecovery) throw busyConfigLock(error);
    let existing;
    try {
      existing = readClaimedPath(lockPath, fileOperations);
    } catch (readError) {
      throw busyConfigLock(readError);
    }
    const document = parseConfigLock(existing);
    if (document === null) throw busyConfigLock(error);
    let liveness = "unknown";
    try {
      liveness = ownerLiveness(Object.freeze({ ...document.owner }));
    } catch {}
    if (!new Set(["live", "dead", "unknown"]).has(liveness)) liveness = "unknown";
    if (liveness !== "dead") throw busyConfigLock(error);
    const configHash = configHashForRecovery(configPath, fileOperations);
    if (!staleLockCanBeRecovered({ document, pending, configHash })) {
      throw createConfigError(
        "CODEX_HISTORY_REPAIR_CONFLICT",
        "Codex history repair state conflicts with the configuration."
      );
    }
    if (!claimOwnedPath(lockPath, existing.identity, fileOperations, {
      expectedBytes: existing.bytes,
      missingIsRemoved: false,
      suffix: "stale"
    })) {
      throw busyConfigLock(error);
    }
    return acquireConfigLock(lockPath, fileOperations, {
      owner,
      ownerLiveness,
      pending,
      configPath,
      initialBinding,
      allowRecovery: false
    });
  }

  let identity;
  const phase = initialBinding === null ? "acquired" : "prepared";
  const token = configLockBytes(owner, phase, initialBinding);
  try {
    identity = fileOperations.fstatSync(descriptor);
    fileOperations.writeFileSync(descriptor, token);
    fileOperations.fsyncSync(descriptor);
    syncDirectory(dirname(lockPath), fileOperations);
    return { descriptor, identity, token, owner, phase, binding: initialBinding };
  } catch (error) {
    let closed = false;
    try {
      fileOperations.closeSync(descriptor);
      closed = true;
    } catch {}
    if (identity === undefined || !closed) {
      ensureCanonicalBlocker(lockPath, null, fileOperations);
    } else if (!claimOwnedPath(lockPath, identity, fileOperations)) {
      ensureCanonicalBlocker(lockPath, null, fileOperations);
    }
    throw error;
  }
}

function assertConfigLockOwned(lockPath, lock, fileOperations) {
  const current = readClaimedPath(lockPath, fileOperations);
  if (!sameIdentity(current.identity, lock.identity)
    || !current.bytes.equals(lock.token)) {
    throw createConfigError(
      "CODEX_CONFIG_WRITE_FAILED",
      "Codex configuration lock ownership changed."
    );
  }
}

function replaceConfigLockMetadata(
  lockPath,
  lock,
  owner,
  phase,
  binding,
  fileOperations
) {
  assertConfigLockOwned(lockPath, lock, fileOperations);
  if (lock.descriptor !== undefined) {
    fileOperations.closeSync(lock.descriptor);
    lock.descriptor = undefined;
  }
  const bytes = configLockBytes(owner, phase, binding);
  writeFileAtomically(
    lockPath,
    bytes,
    0o600,
    fileOperations,
    () => assertConfigLockOwned(lockPath, lock, fileOperations)
  );
  const current = readClaimedPath(lockPath, fileOperations);
  if (!current.bytes.equals(bytes)) {
    throw createConfigError(
      "CODEX_CONFIG_CHANGED",
      "Codex configuration lock metadata changed."
    );
  }
  lock.identity = current.identity;
  lock.token = current.bytes;
  lock.phase = phase;
  lock.binding = binding;
}

function releaseConfigLock(lockPath, lock, parent, fileOperations) {
  let cleanupError;
  if (lock.descriptor !== undefined) {
    try {
      fileOperations.closeSync(lock.descriptor);
      lock.descriptor = undefined;
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    assertConfigParent(parent, fileOperations);
    const removed = claimOwnedPath(lockPath, lock.identity, fileOperations, {
      expectedBytes: lock.token,
      missingIsRemoved: false,
      suffix: "release"
    });
    if (!removed) {
      ensureCanonicalBlocker(lockPath, null, fileOperations);
      throw new Error("Codex configuration lock cleanup is uncertain.");
    }
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

function writeFileAtomically(
  path,
  text,
  mode,
  fileOperations,
  beforePublish,
  { exclusive = false } = {}
) {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  let fileDescriptor;
  let tempIdentity;
  let writtenBytes = Buffer.alloc(0);
  const targetBytes = Buffer.from(text, "utf8");

  try {
    fileDescriptor = fileOperations.openSync(tempPath, "wx", mode);
    tempIdentity = fileOperations.fstatSync(fileDescriptor);
    fileOperations.writeFileSync(fileDescriptor, text, "utf8");
    writtenBytes = targetBytes;
    fileOperations.fsyncSync(fileDescriptor);
    fileOperations.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    const currentTemp = fileOperations.lstatSync(tempPath);
    if (!sameIdentity(currentTemp, tempIdentity)) {
      throw createConfigError(
        "CODEX_CONFIG_CHANGED",
        "Codex configuration changed during bootstrap."
      );
    }
    fileOperations.chmodSync(tempPath, mode);
    beforePublish();
    if (exclusive) {
      try {
        fileOperations.linkSync(tempPath, path);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw createConfigError(
            "CODEX_CONFIG_CHANGED",
            "Codex configuration changed during bootstrap.",
            error
          );
        }
        throw error;
      }
      if (!claimOwnedPath(tempPath, tempIdentity, fileOperations, {
        expectedBytes: writtenBytes
      })) {
        throw new Error("Codex configuration temp cleanup is uncertain.");
      }
    } else {
      fileOperations.renameSync(tempPath, path);
    }
    syncDirectory(dirname(path), fileOperations);
    tempIdentity = undefined;
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fileOperations.closeSync(fileDescriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    if (tempIdentity !== undefined) {
      try {
        claimOwnedPath(tempPath, tempIdentity, fileOperations, {
          expectedBytes: writtenBytes
        });
      } catch {
        // Preserve the original write failure.
      }
    }
    throw error;
  }
}

export function patchCodexConfigText(text, proxyUrl) {
  return patchCodexProviderConfigText(text, proxyUrl);
}

export async function bootstrapCodexConfig({
  configPath,
  proxyUrl,
  now = () => new Date(),
  fileOperations: fileOverrides = DEFAULT_FILE_OPERATIONS,
  historyRepair = DEFAULT_HISTORY_REPAIR,
  configLockOwner = createDefaultConfigLockOwner(),
  configLockOwnerLiveness = defaultConfigLockOwnerLiveness
}) {
  const fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...fileOverrides };
  const customFileOperations = fileOverrides !== DEFAULT_FILE_OPERATIONS;
  if (!validConfigLockOwner(configLockOwner)
    || typeof configLockOwnerLiveness !== "function") {
    throw createConfigError(
      "CODEX_CONFIG_WRITE_FAILED",
      "Codex configuration lock ownership input is invalid."
    );
  }
  const lockPath = `${configPath}.crp.lock`;
  let parent;
  let lock;
  let primaryError;
  let committedWithoutPending = false;
  let phase = "write";

  try {
    parent = ensureConfigParent(configPath, fileOperations);
    const pendingOptions = { codexRoot: dirname(configPath) };
    if (customFileOperations) pendingOptions.fileOperations = fileOperations;
    const inspectedPending = typeof historyRepair.inspectPending === "function"
      ? historyRepair.inspectPending(pendingOptions)
      : null;
    const historyRepairPending = inspectedPending !== null
      || historyRepair.hasPending(pendingOptions);
    const initialBinding = inspectedPending === null ? null : {
      ...inspectedPending,
      pendingRequired: true
    };
    lock = acquireConfigLock(lockPath, fileOperations, {
      owner: configLockOwner,
      ownerLiveness: configLockOwnerLiveness,
      pending: inspectedPending,
      configPath,
      initialBinding
    });
    assertConfigParent(parent, fileOperations);
    phase = "read";
    const source = readConfigSource(configPath, fileOperations, { missing: true });
    const sourceExists = source !== null;
    const originalText = source?.text ?? "";
    const patchedText = patchCodexConfigText(originalText, proxyUrl);
    const targetBytes = Buffer.from(patchedText, "utf8");
    const transition = historyRepair.plan({
      sourceExists,
      sourceText: originalText,
      targetText: patchedText,
      targetProvider: TARGET_PROVIDER,
      targetBaseUrl: proxyUrl
    });
    const normalizeLockBinding = (binding) => {
      if (!validConfigLockBinding(binding)
        || binding.targetConfigSha256 !== transition.targetConfigSha256
        || (inspectedPending !== null
          ? !samePendingAndLockBinding(inspectedPending, binding)
          : binding.sourceConfigSha256 !== transition.sourceConfigSha256)) {
        throw createConfigError(
          "CODEX_HISTORY_REPAIR_CONFLICT",
          "Codex history repair lock binding is invalid."
        );
      }
      return Object.freeze({ ...binding });
    };
    const bindPreparedLock = (binding) => {
      phase = "write";
      const normalized = normalizeLockBinding(binding);
      if (lock.binding !== null) {
        if (JSON.stringify(lock.binding) !== JSON.stringify(normalized)) {
          throw createConfigError(
            "CODEX_HISTORY_REPAIR_CONFLICT",
            "Codex history repair lock binding changed."
          );
        }
        assertConfigLockOwned(lockPath, lock, fileOperations);
        return;
      }
      replaceConfigLockMetadata(
        lockPath,
        lock,
        configLockOwner,
        "prepared",
        normalized,
        fileOperations
      );
    };
    const assertBoundLock = (binding) => {
      const normalized = normalizeLockBinding(binding);
      if (lock.binding === null
        || JSON.stringify(lock.binding) !== JSON.stringify(normalized)) {
        throw createConfigError(
          "CODEX_HISTORY_REPAIR_CONFLICT",
          "Codex history repair lock binding changed."
        );
      }
      assertConfigLockOwned(lockPath, lock, fileOperations);
    };
    const completeBoundLock = (binding) => {
      phase = "write";
      const normalized = normalizeLockBinding(binding);
      assertBoundLock(normalized);
      replaceConfigLockMetadata(
        lockPath,
        lock,
        configLockOwner,
        "completed",
        normalized,
        fileOperations
      );
    };

    const publishConfig = (bytes = targetBytes) => {
      const bytesToPublish = Buffer.from(bytes);
      if (!bytesToPublish.equals(targetBytes)) {
        throw createConfigError(
          "CODEX_HISTORY_REPAIR_CONFLICT",
          "Codex history repair target changed during bootstrap."
        );
      }
      if (!sourceExists) {
        phase = "write";
        writeFileAtomically(
          configPath,
          patchedText,
          0o600,
          fileOperations,
          () => {
            assertConfigParent(parent, fileOperations);
            try {
              fileOperations.lstatSync(configPath);
            } catch (error) {
              if (error?.code === "ENOENT") return;
              throw error;
            }
            throw createConfigError(
              "CODEX_CONFIG_CHANGED",
              "Codex configuration changed during bootstrap."
            );
          },
          { exclusive: true }
        );
        return { changed: true, backupPath: null };
      }

      assertCurrentConfig(configPath, source, fileOperations);
      phase = "write";
      const backupPath = copyBackupExclusively(configPath, source, now(), fileOperations);
      phase = "read";
      assertCurrentConfig(configPath, source, fileOperations);
      phase = "write";
      writeFileAtomically(
        configPath,
        patchedText,
        source.mode,
        fileOperations,
        () => {
          assertConfigParent(parent, fileOperations);
          assertCurrentConfig(configPath, source, fileOperations);
        }
      );
      return { changed: true, backupPath };
    };

    if (!transition.required && !historyRepairPending) {
      let result;
      if (patchedText === originalText) {
        result = { changed: false, backupPath: null };
      } else {
        const configOnlyBinding = {
          operationId: randomUUID(),
          sourceConfigSha256: transition.sourceConfigSha256,
          targetConfigSha256: transition.targetConfigSha256,
          pendingRequired: false
        };
        bindPreparedLock(configOnlyBinding);
        try {
          result = publishConfig();
        } catch (error) {
          if (new Set([
            "CODEX_CONFIG_PARENT_UNSAFE",
            "CODEX_CONFIG_BUSY",
            "CODEX_CONFIG_CHANGED",
            "CODEX_CONFIG_READ_FAILED",
            "CODEX_HISTORY_REPAIR_INVALID",
            "CODEX_HISTORY_REPAIR_CONFLICT"
          ]).has(error?.code)) {
            throw error;
          }
          let published;
          try {
            published = readConfigSource(configPath, fileOperations, { missing: true });
          } catch (readError) {
            throw configCommittedDegraded(readError);
          }
          if (published !== null && published.bytes.equals(targetBytes)) {
            throw configCommittedDegraded(error);
          }
          throw error;
        }
        try {
          completeBoundLock(configOnlyBinding);
          const completed = readConfigSource(configPath, fileOperations, { missing: true });
          if (completed === null || !completed.bytes.equals(targetBytes)) {
            throw createConfigError(
              "CODEX_CONFIG_CHANGED",
              "Codex configuration changed after publication."
            );
          }
        } catch (error) {
          throw configCommittedDegraded(error);
        }
        committedWithoutPending = true;
      }
      return { ...result, historyRepair: NO_HISTORY_REPAIR };
    }

    const repaired = await historyRepair.run({
      codexRoot: dirname(configPath),
      currentConfigBytes: source?.bytes ?? Buffer.alloc(0),
      targetConfigBytes: targetBytes,
      transition,
      publishConfig,
      beforeJournalPublish: bindPreparedLock,
      beforePendingClear: completeBoundLock,
      assertConfigLock: assertBoundLock,
      ...(customFileOperations ? { fileOperations } : {})
    });
    if (repaired?.handled !== true) {
      throw createConfigError(
        "CODEX_HISTORY_REPAIR_CONFLICT",
        "Codex history repair state changed during bootstrap."
      );
    }
    committedWithoutPending = true;
    return {
      ...(repaired.publishResult ?? { changed: false, backupPath: null }),
      historyRepair: repaired.historyRepair
    };
  } catch (error) {
    primaryError = classifyConfigError(error, phase);
    throw primaryError;
  } finally {
    if (lock !== undefined && primaryError?.retainConfigLock !== true) {
      try {
        releaseConfigLock(lockPath, lock, parent, fileOperations);
      } catch (cleanupError) {
        if (primaryError === undefined) {
          throw committedWithoutPending
            ? configCommittedDegraded(cleanupError)
            : classifyConfigError(cleanupError, "write");
        }
      }
    }
  }
}
