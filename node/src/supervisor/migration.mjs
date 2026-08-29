import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as FS_CONSTANTS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ProviderRegistry,
  validateProviderRegistryDocument
} from "../providers/provider-registry.mjs";
import {
  DEFAULT_PROVIDER_MODELS_PATH,
  DEFAULT_PROVIDER_WEIGHT,
  normalizeProvider,
  validateStoredProvider
} from "../providers/provider-schema.mjs";
import { CrpError } from "../shared/errors.mjs";

const DEFAULT_FILE_OPERATIONS = {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
};
const BACKUP_ATTEMPTS = 8;
const REPLACEMENT_COMMITTED_IDENTITY = Symbol("replacementCommittedIdentity");
const REGISTRY_QUARANTINE_COMMITTED = Symbol("registryQuarantineCommitted");
const REGISTRY_QUARANTINE_STATE_VERSION = 1;
const LEGACY_URL_KEYS = Object.freeze(["baseUrl", "upstreamBaseUrl", "upstream_base_url"]);
const LEGACY_SECRET_KEYS = Object.freeze(["apiKey", "upstreamApiKey", "upstream_api_key"]);
const LEGACY_AUTH_HEADER_KEYS = Object.freeze(["authHeader"]);
const LEGACY_AUTH_SCHEME_KEYS = Object.freeze(["authScheme"]);
const LEGACY_EXTRA_HEADER_KEYS = Object.freeze(["extraHeaders"]);

function migrationError(code, cause, details = {}) {
  const contracts = {
    MIGRATION_BUSY: [
      "Provider migration is already running.",
      "Wait for the current migration to finish and try again.",
      409
    ],
    MIGRATION_INPUT_INVALID: [
      "The legacy provider configuration is invalid.",
      "Restore a complete legacy provider URL and credential before migrating.",
      400
    ],
    MIGRATION_REGISTRY_CONFLICT: [
      "The provider registry was created by another process during migration.",
      "Review the current provider registry before retrying migration.",
      409
    ],
    MIGRATION_FAILED: [
      "CRP could not migrate the legacy provider configuration.",
      "Review local storage and credential-backend health, then retry migration.",
      500
    ],
    MIGRATION_ROLLBACK_DEGRADED: [
      "Provider migration failed and rollback could not be completed safely.",
      "Stop CRP and restore the retained migration backup before restarting.",
      500
    ],
    MIGRATION_COMMITTED_LOCK_DEGRADED: [
      "Provider migration completed, but its transaction lock could not be fully released.",
      "Stop CRP, explicitly repair the residual migration lock, then restart CRP.",
      500
    ],
    MIGRATION_COMMITTED_DEGRADED: [
      "Provider migration completed, but persistence cleanup degraded.",
      "Stop CRP and repair the retained migration state before restarting.",
      500
    ]
  };
  const [message, action, status] = contracts[code] ?? contracts.MIGRATION_FAILED;
  return new CrpError(code, message, action, { status, cause, details });
}

function isCommittedError(error) {
  return error instanceof CrpError && error.details?.committed === true;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveAliases(scopes, keys, { trim = true, normalize = (value) => value } = {}) {
  const candidates = [];
  for (const scope of scopes) {
    if (!isPlainObject(scope)) continue;
    for (const key of keys) {
      if (!Object.hasOwn(scope, key)) continue;
      const raw = scope[key];
      if (typeof raw !== "string" || raw.length === 0) {
        return { value: null, comparable: null, conflict: false, invalid: true };
      }
      const value = trim ? raw.trim() : raw;
      if (trim && value.length === 0) {
        return { value: null, comparable: null, conflict: false, invalid: true };
      }
      let comparable;
      try {
        comparable = normalize(value);
      } catch {
        return { value: null, comparable: null, conflict: false, invalid: true };
      }
      candidates.push({ value, comparable });
    }
  }
  if (candidates.length === 0) {
    return { value: null, comparable: null, conflict: false, invalid: false };
  }
  if (new Set(candidates.map(({ comparable }) => comparable)).size !== 1) {
    return { value: null, comparable: null, conflict: true, invalid: false };
  }
  return {
    value: candidates[0].value,
    comparable: candidates[0].comparable,
    conflict: false,
    invalid: false
  };
}

function resolveExtraHeaders(scopes) {
  const candidates = [];
  for (const scope of scopes) {
    if (!isPlainObject(scope)) continue;
    for (const key of LEGACY_EXTRA_HEADER_KEYS) {
      if (!Object.hasOwn(scope, key)) continue;
      if (!isPlainObject(scope[key])) {
        return { value: null, conflict: false, invalid: true, explicit: true };
      }
      candidates.push(scope[key]);
    }
  }
  if (candidates.length === 0) {
    return { value: {}, conflict: false, invalid: false, explicit: false };
  }
  if (candidates.some((candidate) => !isDeepStrictEqual(candidate, candidates[0]))) {
    return { value: null, conflict: true, invalid: false, explicit: true };
  }
  return { value: candidates[0], conflict: false, invalid: false, explicit: true };
}

function canonicalUrl(value) {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

function candidateFromDocument(source, document) {
  const nested = isPlainObject(document?.upstream) ? document.upstream : null;
  const scopes = nested === null ? [document] : [document, nested];
  if (!isPlainObject(document)) return { source, state: "invalid" };
  const url = resolveAliases(scopes, LEGACY_URL_KEYS, { normalize: canonicalUrl });
  const secret = resolveAliases(scopes, LEGACY_SECRET_KEYS, { trim: false });
  const authHeader = resolveAliases(scopes, LEGACY_AUTH_HEADER_KEYS, {
    normalize: (value) => value.toLowerCase()
  });
  const authScheme = resolveAliases(scopes, LEGACY_AUTH_SCHEME_KEYS);
  const extraHeaders = resolveExtraHeaders(scopes);
  if (url.invalid || url.conflict || secret.invalid || secret.conflict
    || authHeader.invalid || authHeader.conflict || authScheme.invalid || authScheme.conflict
    || extraHeaders.invalid || extraHeaders.conflict) {
    return { source, state: "invalid" };
  }
  if (url.value === null || secret.value === null) {
    return { source, state: "incomplete" };
  }
  const hasExplicitAuth = authHeader.value !== null
    || authScheme.value !== null
    || extraHeaders.explicit;
  const candidate = {
    source,
    state: "complete",
    baseUrl: url.value,
    canonicalBaseUrl: url.comparable,
    secret: secret.value,
    authHeader: authHeader.value ?? "authorization",
    authScheme: authScheme.value ?? "Bearer",
    extraHeaders: extraHeaders.value,
    hasExplicitAuth
  };
  try {
    const normalized = normalizeProvider({
      name: "Legacy candidate",
      baseUrl: candidate.baseUrl,
      credentialRef: "legacy-candidate",
      authHeader: candidate.authHeader,
      authScheme: candidate.authScheme,
      extraHeaders: candidate.extraHeaders,
      modelMode: "passthrough",
      modelOverride: null
    }, { id: `legacy-${source}`, now: "2000-01-01T00:00:00.000Z" });
    return { ...candidate, normalized };
  } catch {
    return { source, state: "invalid" };
  }
}

function sameConnection(left, right) {
  return left.canonicalBaseUrl === right.canonicalBaseUrl
    && left.secret === right.secret
    && left.normalized.authHeader.toLowerCase() === right.normalized.authHeader.toLowerCase()
    && left.normalized.authScheme === right.normalized.authScheme
    && isDeepStrictEqual(left.normalized.extraHeaders, right.normalized.extraHeaders);
}

function sameBaseAndSecret(left, right) {
  return left.canonicalBaseUrl === right.canonicalBaseUrl
    && left.secret === right.secret;
}

function resolveImportCandidates(candidates) {
  const runtime = candidates.find(({ source }) => source === "runtime") ?? null;
  const saved = candidates.find(({ source }) => source === "saved") ?? null;
  if (!runtime || !saved) return { candidates, conflict: false };
  if (sameConnection(runtime, saved)) {
    return { candidates: [runtime], conflict: false };
  }
  if (sameBaseAndSecret(runtime, saved)
    && runtime.hasExplicitAuth !== saved.hasExplicitAuth) {
    return {
      candidates: [runtime.hasExplicitAuth ? runtime : saved],
      conflict: false
    };
  }
  return { candidates: [runtime, saved], conflict: true };
}

function scrubDocument(document) {
  const next = structuredClone(document);
  for (const key of LEGACY_SECRET_KEYS) delete next[key];
  if (next.upstream !== null && typeof next.upstream === "object" && !Array.isArray(next.upstream)) {
    for (const key of LEGACY_SECRET_KEYS) delete next.upstream[key];
  }
  return next;
}

function registryBytesForProviders(providers) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 9,
    activeProviderId: null,
    providers,
    modelMappingGroups: [],
    routingRuleGroups: [],
    settings: {
      proxyHost: "127.0.0.1",
      proxyPort: 15100,
      adminHost: "127.0.0.1",
      adminPort: 15101,
      apiKeyAuthEnabled: false,
      captureEnabled: false,
      captureDetailsEnabled: false,
      routingMode: "custom_only",
      routingRuleGroupId: null
    }
  }, null, 2)}\n`, "utf8");
}

function identityOf(stats) {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left, right) {
  return left !== null && right !== null
    && left.dev === right.dev
    && left.ino === right.ino;
}

function fsyncDirectory(path, fileOperations) {
  let descriptor;
  try {
    const directoryFlag = typeof FS_CONSTANTS.O_DIRECTORY === "number"
      ? FS_CONSTANTS.O_DIRECTORY
      : 0;
    descriptor = fileOperations.openSync(path, FS_CONSTANTS.O_RDONLY | directoryFlag);
    fileOperations.fsyncSync(descriptor);
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileOperations.closeSync(descriptor); } catch {}
    }
    if (process.platform === "win32"
      && ["EACCES", "EINVAL", "EPERM"].includes(error?.code)) return;
    throw error;
  }
}

function lstatRegular(path, fileOperations, { missing = false } = {}) {
  let stats;
  try {
    stats = fileOperations.lstatSync(path);
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    throw migrationError("MIGRATION_INPUT_INVALID", error);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw migrationError("MIGRATION_INPUT_INVALID");
  }
  return { stats, identity: identityOf(stats) };
}

function readSafeFile(path, fileOperations, { missing = false } = {}) {
  const before = lstatRegular(path, fileOperations, { missing });
  if (before === null) return null;
  const noFollow = typeof FS_CONSTANTS.O_NOFOLLOW === "number" ? FS_CONSTANTS.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = fileOperations.openSync(path, FS_CONSTANTS.O_RDONLY | noFollow);
    const descriptorStats = fileOperations.fstatSync(descriptor);
    if (!descriptorStats.isFile()
      || !sameIdentity(before.identity, identityOf(descriptorStats))) {
      throw migrationError("MIGRATION_INPUT_INVALID");
    }
    const bytes = fileOperations.readFileSync(descriptor);
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
    return { path, bytes, identity: before.identity };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileOperations.closeSync(descriptor); } catch {}
    }
    if (error instanceof CrpError) throw error;
    throw migrationError("MIGRATION_INPUT_INVALID", error);
  }
}

function restoreClaim(claimPath, canonicalPath, fileOperations) {
  try {
    fileOperations.renameSync(claimPath, canonicalPath);
  } catch {
    // A foreign canonical path is already a blocker; never remove it.
  }
}

function ensureCanonicalBlocker(path, fileOperations) {
  let descriptor;
  try {
    descriptor = fileOperations.openSync(path, "wx", 0o600);
    fileOperations.writeFileSync(descriptor, "migration-degraded\n", "utf8");
    fileOperations.fsyncSync(descriptor);
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(dirname(path), fileOperations);
    return true;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileOperations.closeSync(descriptor); } catch {}
    }
    return error?.code === "EEXIST";
  }
}

function claimOwnedPath(path, expectedIdentity, fileOperations, createId = randomUUID) {
  const claimPath = join(dirname(path), `.${basename(path)}.${createId()}.claim`);
  try {
    fileOperations.renameSync(path, claimPath);
  } catch {
    return false;
  }
  let claim;
  try {
    claim = lstatRegular(claimPath, fileOperations);
  } catch {
    restoreClaim(claimPath, path, fileOperations);
    return false;
  }
  if (!sameIdentity(claim.identity, expectedIdentity)) {
    restoreClaim(claimPath, path, fileOperations);
    return false;
  }
  try {
    fileOperations.rmSync(claimPath);
    fsyncDirectory(dirname(path), fileOperations);
    return true;
  } catch {
    restoreClaim(claimPath, path, fileOperations);
    return false;
  }
}

function createLock({ lockPath, fileOperations, createId, token: providedToken }) {
  fileOperations.mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = providedToken ?? `${createId()}\n`;
  let descriptor;
  let identity = null;
  let closed = false;
  try {
    descriptor = fileOperations.openSync(lockPath, "wx", 0o600);
    identity = identityOf(fileOperations.fstatSync(descriptor));
    fileOperations.writeFileSync(descriptor, token, "utf8");
    fileOperations.fchmodSync(descriptor, 0o600);
    fileOperations.fsyncSync(descriptor);
    fileOperations.closeSync(descriptor);
    closed = true;
    descriptor = undefined;
    fsyncDirectory(dirname(lockPath), fileOperations);
    return { token, identity };
  } catch (error) {
    if (identity === null) {
      if (error?.code === "EEXIST") throw migrationError("MIGRATION_BUSY", error);
      throw migrationError("MIGRATION_FAILED", error);
    }
    if (!closed && descriptor !== undefined) {
      try {
        fileOperations.closeSync(descriptor);
        closed = true;
      } catch {}
    }
    const cleaned = closed && claimOwnedPath(lockPath, identity, fileOperations, createId);
    if (!cleaned) {
      ensureCanonicalBlocker(lockPath, fileOperations);
      throw migrationError("MIGRATION_ROLLBACK_DEGRADED", error, {
        committed: false,
        degraded: true
      });
    }
    throw migrationError("MIGRATION_FAILED", error);
  }
}

function releaseLock({ lockPath, lock, fileOperations, createId }) {
  const claimPath = join(
    dirname(lockPath),
    `.${basename(lockPath)}.${createId()}.release`
  );
  try {
    fileOperations.renameSync(lockPath, claimPath);
  } catch {
    ensureCanonicalBlocker(lockPath, fileOperations);
    return false;
  }
  try {
    const claimed = readSafeFile(claimPath, fileOperations);
    if (!sameIdentity(claimed.identity, lock.identity)
      || claimed.bytes.toString("utf8") !== lock.token) {
      restoreClaim(claimPath, lockPath, fileOperations);
      ensureCanonicalBlocker(lockPath, fileOperations);
      return false;
    }
    fileOperations.rmSync(claimPath);
    fsyncDirectory(dirname(lockPath), fileOperations);
    return true;
  } catch {
    restoreClaim(claimPath, lockPath, fileOperations);
    ensureCanonicalBlocker(lockPath, fileOperations);
    return false;
  }
}

function writeExclusive(path, bytes, fileOperations, createId = randomUUID) {
  let descriptor;
  let identity = null;
  let closed = false;
  try {
    descriptor = fileOperations.openSync(path, "wx", 0o600);
    identity = identityOf(fileOperations.fstatSync(descriptor));
    fileOperations.writeFileSync(descriptor, bytes);
    fileOperations.fchmodSync(descriptor, 0o600);
    fileOperations.fsyncSync(descriptor);
    fileOperations.closeSync(descriptor);
    closed = true;
    descriptor = undefined;
    fsyncDirectory(dirname(path), fileOperations);
    const committed = lstatRegular(path, fileOperations);
    if (!sameIdentity(committed.identity, identity)) {
      throw migrationError("MIGRATION_ROLLBACK_DEGRADED", null, {
        committed: false,
        degraded: true
      });
    }
    return committed.identity;
  } catch (error) {
    if (identity === null) throw error;
    if (!closed && descriptor !== undefined) {
      try {
        fileOperations.closeSync(descriptor);
        closed = true;
      } catch {}
    }
    const cleaned = closed && claimOwnedPath(path, identity, fileOperations, createId);
    if (!cleaned) {
      throw migrationError("MIGRATION_ROLLBACK_DEGRADED", error, {
        committed: false,
        degraded: true
      });
    }
    throw error;
  }
}

function createBackup(source, fileOperations, createBackupId) {
  for (let attempt = 0; attempt < BACKUP_ATTEMPTS; attempt += 1) {
    const backupPath = `${source.path}.${createBackupId()}.bak`;
    try {
      writeExclusive(backupPath, source.bytes, fileOperations, createBackupId);
      return backupPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw migrationError("MIGRATION_FAILED");
}

function pathExists(path, fileOperations) {
  try {
    fileOperations.lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw migrationError("MIGRATION_INPUT_INVALID", error, {
      reason: "registry-recovery-marker-unreadable"
    });
  }
}

function secureMarker(path, expectedIdentity, fileOperations) {
  const noFollow = typeof FS_CONSTANTS.O_NOFOLLOW === "number" ? FS_CONSTANTS.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = fileOperations.openSync(path, FS_CONSTANTS.O_RDONLY | noFollow);
    const stats = fileOperations.fstatSync(descriptor);
    if (!stats.isFile() || !sameIdentity(identityOf(stats), expectedIdentity)) {
      throw new Error("registry recovery marker identity mismatch");
    }
    fileOperations.fchmodSync(descriptor, 0o600);
    fileOperations.fsyncSync(descriptor);
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileOperations.closeSync(descriptor); } catch {}
    }
    throw error;
  }
}

function defaultIsProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function transactionLockToken(pid, transactionId, purpose) {
  return `${JSON.stringify({ version: 1, pid, transactionId, purpose })}\n`;
}

function parseTransactionLock(bytes, purpose) {
  try {
    const value = JSON.parse(bytes);
    if (!isPlainObject(value)
      || value.version !== 1
      || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.transactionId !== "string"
      || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.transactionId)
      || value.purpose !== purpose
      || Object.keys(value).length !== 4) return null;
    return value;
  } catch {
    return null;
  }
}

function quarantinePendingBytes({
  phase,
  pid,
  sourceIdentity,
  reason,
  lock,
  registryLock
}) {
  return Buffer.from(`${JSON.stringify({
    version: REGISTRY_QUARANTINE_STATE_VERSION,
    phase,
    pid,
    sourceIdentity,
    reason,
    migrationLock: lock,
    registryLock
  }, null, 2)}\n`, "utf8");
}

function quarantineInvalidRegistry({
  path,
  source,
  reason,
  fileOperations,
  createBackupId,
  createId,
  pid,
  lock,
  registryLock
}) {
  const markerPath = `${path}.recovery-invalid`;
  const pendingPath = `${path}.recovery-pending`;
  if (pathExists(markerPath, fileOperations)) {
    throw migrationError("MIGRATION_INPUT_INVALID", null, {
      reason: "registry-recovery-marker-exists"
    });
  }
  const before = lstatRegular(path, fileOperations);
  if (!sameIdentity(before.identity, source.identity)) {
    throw migrationError("MIGRATION_INPUT_INVALID", null, {
      reason: "registry-identity-changed"
    });
  }
  let pendingBytes = quarantinePendingBytes({
    phase: "prepared",
    pid,
    sourceIdentity: source.identity,
    reason,
    lock,
    registryLock
  });
  let pendingIdentity;
  try {
    pendingIdentity = writeExclusive(pendingPath, pendingBytes, fileOperations, createId);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw migrationError("MIGRATION_INPUT_INVALID", error, {
        reason: "registry-recovery-pending-exists"
      });
    }
    throw error;
  }
  const updatePendingPhase = (phase) => {
    const nextBytes = quarantinePendingBytes({
      phase,
      pid,
      sourceIdentity: source.identity,
      reason,
      lock,
      registryLock
    });
    pendingIdentity = replaceFile(
      pendingPath,
      nextBytes,
      pendingIdentity,
      fileOperations,
      createId
    );
    pendingBytes = nextBytes;
  };
  let linked = false;
  try {
    createBackup(source, fileOperations, createBackupId);
    try {
      fileOperations.linkSync(path, markerPath);
      linked = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw migrationError("MIGRATION_INPUT_INVALID", error, {
          reason: "registry-recovery-marker-exists"
        });
      }
      throw error;
    }
    updatePendingPhase("linked");
    const marker = lstatRegular(markerPath, fileOperations);
    const canonical = lstatRegular(path, fileOperations, { missing: true });
    if (!sameIdentity(marker.identity, source.identity)
      || canonical === null
      || !sameIdentity(canonical.identity, source.identity)) {
      throw new Error("registry quarantine identity mismatch");
    }
    secureMarker(markerPath, source.identity, fileOperations);
    if (!claimOwnedPath(path, source.identity, fileOperations, createId)) {
      throw new Error("registry quarantine canonical release failed");
    }
    const releasedCanonical = lstatRegular(path, fileOperations, { missing: true });
    const retainedMarker = lstatRegular(markerPath, fileOperations);
    if (releasedCanonical !== null || !sameIdentity(retainedMarker.identity, source.identity)) {
      throw new Error("registry quarantine final verification failed");
    }
    fsyncDirectory(dirname(path), fileOperations);
    updatePendingPhase("canonical-released");
    return {
      markerPath,
      markerIdentity: retainedMarker.identity,
      reason,
      pending: { path: pendingPath, identity: pendingIdentity, bytes: pendingBytes }
    };
  } catch (error) {
    if (!linked) {
      if (!claimOwnedPath(pendingPath, pendingIdentity, fileOperations, createId)) {
        const degraded = migrationError("MIGRATION_ROLLBACK_DEGRADED", error, {
          committed: false,
          degraded: true,
          reason: "registry-recovery-pending-cleanup-failed"
        });
        Object.defineProperty(degraded, REGISTRY_QUARANTINE_COMMITTED, {
          value: true
        });
        throw degraded;
      }
      if (error instanceof CrpError) throw error;
      throw migrationError("MIGRATION_FAILED", error, {
        committed: false,
        reason: "registry-quarantine-link-failed"
      });
    }
    const degraded = migrationError("MIGRATION_COMMITTED_DEGRADED", error, {
      committed: true,
      degraded: true,
      reason: "registry-quarantine-verification-failed"
    });
    Object.defineProperty(degraded, REGISTRY_QUARANTINE_COMMITTED, {
      value: true
    });
    throw degraded;
  }
}

function validIdentity(value) {
  return isPlainObject(value)
    && Number.isSafeInteger(value.dev) && value.dev >= 0
    && Number.isSafeInteger(value.ino) && value.ino >= 0;
}

function validPersistedLock(value) {
  return isPlainObject(value)
    && typeof value.token === "string" && value.token.length >= 2 && value.token.length <= 256
    && validIdentity(value.identity);
}

function parseQuarantinePending(bytes) {
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw migrationError("MIGRATION_INPUT_INVALID", null, {
      reason: "registry-recovery-pending-invalid"
    });
  }
  const fields = new Set([
    "version",
    "phase",
    "pid",
    "sourceIdentity",
    "reason",
    "migrationLock",
    "registryLock"
  ]);
  if (!isPlainObject(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((key) => !fields.has(key))
    || value.version !== REGISTRY_QUARANTINE_STATE_VERSION
    || !["prepared", "linked", "canonical-released"].includes(value.phase)
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !validIdentity(value.sourceIdentity)
    || typeof value.reason !== "string" || !/^registry-[a-z-]{1,96}$/.test(value.reason)
    || !validPersistedLock(value.migrationLock)
    || !validPersistedLock(value.registryLock)) {
    throw migrationError("MIGRATION_INPUT_INVALID", null, {
      reason: "registry-recovery-pending-invalid"
    });
  }
  return value;
}

function quarantineResumeDegraded(cause) {
  return migrationError("MIGRATION_COMMITTED_DEGRADED", cause, {
    committed: true,
    degraded: true,
    reason: "registry-quarantine-resume-failed"
  });
}

function resumeInvalidRegistryQuarantine({
  registryPath,
  fileOperations,
  createId,
  isProcessAlive
}) {
  const pendingPath = `${registryPath}.recovery-pending`;
  const pending = readSafeFile(pendingPath, fileOperations, { missing: true });
  if (pending === null) {
    const migrationLockPath = `${registryPath}.migration.lock`;
    const registryLockPath = `${registryPath}.crp.lock`;
    const migrationLockSource = readSafeFile(migrationLockPath, fileOperations, { missing: true });
    const registryLockSource = readSafeFile(registryLockPath, fileOperations, { missing: true });
    if (migrationLockSource === null && registryLockSource === null) return false;
    const parsedMigration = migrationLockSource === null
      ? null
      : parseTransactionLock(migrationLockSource.bytes, "migration");
    const parsedRegistry = registryLockSource === null
      ? null
      : parseTransactionLock(registryLockSource.bytes, "registry");
    if ((migrationLockSource !== null && parsedMigration === null)
      || (registryLockSource !== null && parsedRegistry === null)) return false;
    const owner = parsedMigration ?? parsedRegistry;
    if (owner === null
      || (parsedMigration !== null && parsedMigration.transactionId !== owner.transactionId)
      || (parsedRegistry !== null && parsedRegistry.transactionId !== owner.transactionId)
      || (parsedMigration !== null && parsedMigration.pid !== owner.pid)
      || (parsedRegistry !== null && parsedRegistry.pid !== owner.pid)) return false;
    const inspection = inspectCurrentRegistry(registryPath, fileOperations);
    if (inspection.kind !== "invalid-registry") return false;
    if (isProcessAlive(owner.pid)) throw migrationError("MIGRATION_BUSY");
    if (registryLockSource !== null && !releaseLock({
      lockPath: registryLockPath,
      lock: { token: registryLockSource.bytes.toString("utf8"), identity: registryLockSource.identity },
      fileOperations,
      createId
    })) throw quarantineResumeDegraded();
    if (migrationLockSource !== null && !releaseLock({
      lockPath: migrationLockPath,
      lock: { token: migrationLockSource.bytes.toString("utf8"), identity: migrationLockSource.identity },
      fileOperations,
      createId
    })) throw quarantineResumeDegraded();
    return true;
  }
  const state = parseQuarantinePending(pending.bytes);
  const markerPath = `${registryPath}.recovery-invalid`;
  let marker;
  let canonical;
  let migrationLockSource;
  let registryLockSource;
  try {
    marker = lstatRegular(markerPath, fileOperations, { missing: true });
    canonical = lstatRegular(registryPath, fileOperations, { missing: true });
    migrationLockSource = readSafeFile(`${registryPath}.migration.lock`, fileOperations, {
      missing: true
    });
    registryLockSource = readSafeFile(`${registryPath}.crp.lock`, fileOperations, {
      missing: true
    });
  } catch (error) {
    throw quarantineResumeDegraded(error);
  }
  if ((marker !== null && !sameIdentity(marker.identity, state.sourceIdentity))
    || (canonical !== null && !sameIdentity(canonical.identity, state.sourceIdentity))) {
    throw quarantineResumeDegraded();
  }
  if (migrationLockSource !== null && (
    !sameIdentity(migrationLockSource.identity, state.migrationLock.identity)
    || migrationLockSource.bytes.toString("utf8") !== state.migrationLock.token
  )) throw quarantineResumeDegraded();
  if (registryLockSource !== null && (
    !sameIdentity(registryLockSource.identity, state.registryLock.identity)
    || registryLockSource.bytes.toString("utf8") !== state.registryLock.token
  )) throw quarantineResumeDegraded();
  const anyLockPresent = migrationLockSource !== null || registryLockSource !== null;
  if (anyLockPresent) {
    if (isProcessAlive(state.pid)) {
      throw migrationError("MIGRATION_BUSY");
    }
  }
  if (marker === null) {
    if (state.phase !== "prepared" || canonical === null) {
      throw quarantineResumeDegraded();
    }
    try {
      if (registryLockSource !== null && !releaseLock({
        lockPath: `${registryPath}.crp.lock`,
        lock: state.registryLock,
        fileOperations,
        createId
      })) throw new Error("registry quarantine prepared registry-lock release failed");
      if (migrationLockSource !== null && !releaseLock({
        lockPath: `${registryPath}.migration.lock`,
        lock: state.migrationLock,
        fileOperations,
        createId
      })) throw new Error("registry quarantine prepared migration-lock release failed");
      if (!claimOwnedPath(pendingPath, pending.identity, fileOperations, createId)) {
        throw new Error("registry quarantine prepared pending cleanup failed");
      }
      return true;
    } catch (error) {
      throw quarantineResumeDegraded(error);
    }
  }
  try {
    secureMarker(markerPath, state.sourceIdentity, fileOperations);
    if (canonical !== null
      && !claimOwnedPath(registryPath, state.sourceIdentity, fileOperations, createId)) {
      throw new Error("registry quarantine resume release failed");
    }
    const finalCanonical = lstatRegular(registryPath, fileOperations, { missing: true });
    const finalMarker = lstatRegular(markerPath, fileOperations);
    if (finalCanonical !== null || !sameIdentity(finalMarker.identity, state.sourceIdentity)) {
      throw new Error("registry quarantine resume verification failed");
    }
    fsyncDirectory(dirname(registryPath), fileOperations);
    if (registryLockSource !== null) {
      const registryReleased = releaseLock({
        lockPath: `${registryPath}.crp.lock`,
        lock: state.registryLock,
        fileOperations,
        createId
      });
      if (!registryReleased) {
        throw new Error("registry quarantine resume registry-lock release failed");
      }
    }
    if (migrationLockSource !== null) {
      const migrationReleased = releaseLock({
        lockPath: `${registryPath}.migration.lock`,
        lock: state.migrationLock,
        fileOperations,
        createId
      });
      if (!migrationReleased) {
        throw new Error("registry quarantine resume migration-lock release failed");
      }
    }
    if (!claimOwnedPath(pendingPath, pending.identity, fileOperations, createId)) {
      throw new Error("registry quarantine pending cleanup failed");
    }
    return true;
  } catch (error) {
    throw quarantineResumeDegraded(error);
  }
}

function replaceFile(path, bytes, expectedIdentity, fileOperations, createId) {
  const tempPath = join(dirname(path), `.${basename(path)}.${createId()}.tmp`);
  let tempIdentity = null;
  try {
    const before = lstatRegular(path, fileOperations);
    if (!sameIdentity(before.identity, expectedIdentity)) {
      throw migrationError("MIGRATION_ROLLBACK_DEGRADED", null, {
        committed: false,
        degraded: true
      });
    }
    tempIdentity = writeExclusive(tempPath, bytes, fileOperations, createId);
    const current = lstatRegular(path, fileOperations);
    if (!sameIdentity(current.identity, expectedIdentity)) {
      throw migrationError("MIGRATION_ROLLBACK_DEGRADED", null, {
        committed: false,
        degraded: true
      });
    }
    fileOperations.renameSync(tempPath, path);
    const committed = lstatRegular(path, fileOperations);
    if (!sameIdentity(committed.identity, tempIdentity)) {
      throw migrationError("MIGRATION_ROLLBACK_DEGRADED", null, {
        committed: true,
        degraded: true
      });
    }
    try {
      fsyncDirectory(dirname(path), fileOperations);
    } catch (error) {
      Object.defineProperty(error, REPLACEMENT_COMMITTED_IDENTITY, {
        value: committed.identity
      });
      throw error;
    }
    return committed.identity;
  } catch (error) {
    if (tempIdentity !== null) {
      claimOwnedPath(tempPath, tempIdentity, fileOperations, createId);
    }
    throw error;
  }
}

function readLegacySource(path, sourceName, fileOperations) {
  const fileSource = readSafeFile(path, fileOperations, { missing: true });
  if (fileSource === null) return { source: sourceName, state: "missing", file: null };
  try {
    const document = JSON.parse(fileSource.bytes);
    if (!isPlainObject(document)) throw new Error("not an object");
    return {
      source: sourceName,
      state: "valid",
      file: { ...fileSource, currentIdentity: fileSource.identity, document }
    };
  } catch {
    return {
      source: sourceName,
      state: "malformed",
      file: { ...fileSource, currentIdentity: fileSource.identity, document: null }
    };
  }
}

function validateSchema2Registry(document) {
  const documentFields = new Set(["schemaVersion", "activeProviderId", "providers", "settings"]);
  const settingsFields = new Set([
    "proxyHost",
    "proxyPort",
    "adminHost",
    "adminPort",
    "captureEnabled"
  ]);
  if (document.schemaVersion !== 2
    || Object.keys(document).length !== documentFields.size
    || Object.keys(document).some((key) => !documentFields.has(key))
    || !Array.isArray(document.providers)
    || document.settings === null
    || typeof document.settings !== "object"
    || Array.isArray(document.settings)
    || Object.keys(document.settings).length !== settingsFields.size
    || Object.keys(document.settings).some((key) => !settingsFields.has(key))
    || document.settings.proxyHost !== "127.0.0.1"
    || document.settings.proxyPort !== 15100
    || document.settings.adminHost !== "127.0.0.1"
    || document.settings.adminPort !== 15101
    || document.settings.captureEnabled !== false
    || (document.activeProviderId !== null && typeof document.activeProviderId !== "string")) {
    throw migrationError("MIGRATION_INPUT_INVALID");
  }
  const ids = new Set();
  const names = new Set();
  try {
    for (const provider of document.providers) {
      validateStoredProvider({
        ...provider,
        weight: DEFAULT_PROVIDER_WEIGHT,
        modelMappingGroupId: null,
        supportedModelsMode: "auto",
        supportedModels: [],
        modelsPath: DEFAULT_PROVIDER_MODELS_PATH,
        customModels: []
      });
      const normalizedName = provider.name.toLowerCase();
      if (ids.has(provider.id) || names.has(normalizedName)) {
        throw new Error("duplicate provider");
      }
      ids.add(provider.id);
      names.add(normalizedName);
    }
  } catch (error) {
    throw migrationError("MIGRATION_INPUT_INVALID", error);
  }
  if (document.activeProviderId !== null && !ids.has(document.activeProviderId)) {
    throw migrationError("MIGRATION_INPUT_INVALID");
  }
}

function validateSchema3Registry(document) {
  const documentFields = new Set(["schemaVersion", "activeProviderId", "providers", "settings"]);
  const settingsFields = new Set([
    "proxyHost",
    "proxyPort",
    "adminHost",
    "adminPort",
    "captureEnabled",
    "routingMode"
  ]);
  if (document.schemaVersion !== 3
    || Object.keys(document).length !== documentFields.size
    || Object.keys(document).some((key) => !documentFields.has(key))
    || !Array.isArray(document.providers)
    || document.settings === null
    || typeof document.settings !== "object"
    || Array.isArray(document.settings)
    || Object.keys(document.settings).length !== settingsFields.size
    || Object.keys(document.settings).some((key) => !settingsFields.has(key))
    || document.settings.proxyHost !== "127.0.0.1"
    || document.settings.proxyPort !== 15100
    || document.settings.adminHost !== "127.0.0.1"
    || document.settings.adminPort !== 15101
    || typeof document.settings.captureEnabled !== "boolean"
    || !["custom_only", "account_first"].includes(document.settings.routingMode)
    || (document.activeProviderId !== null && typeof document.activeProviderId !== "string")) {
    throw migrationError("MIGRATION_INPUT_INVALID");
  }
  const ids = new Set();
  const names = new Set();
  try {
    for (const provider of document.providers) {
      validateStoredProvider({
        ...provider,
        weight: DEFAULT_PROVIDER_WEIGHT,
        modelMappingGroupId: null,
        supportedModelsMode: "auto",
        supportedModels: [],
        modelsPath: DEFAULT_PROVIDER_MODELS_PATH,
        customModels: []
      });
      const normalizedName = provider.name.toLowerCase();
      if (ids.has(provider.id) || names.has(normalizedName)) {
        throw new Error("duplicate provider");
      }
      ids.add(provider.id);
      names.add(normalizedName);
    }
  } catch (error) {
    throw migrationError("MIGRATION_INPUT_INVALID", error);
  }
  if (document.activeProviderId !== null && !ids.has(document.activeProviderId)) {
    throw migrationError("MIGRATION_INPUT_INVALID");
  }
}

function validateSchema4Registry(document) {
  const documentFields = new Set(["schemaVersion", "activeProviderId", "providers", "settings"]);
  const settingsFields = new Set([
    "proxyHost",
    "proxyPort",
    "adminHost",
    "adminPort",
    "captureEnabled",
    "routingMode"
  ]);
  if (document.schemaVersion !== 4
    || Object.keys(document).length !== documentFields.size
    || Object.keys(document).some((key) => !documentFields.has(key))
    || !Array.isArray(document.providers)
    || document.settings === null
    || typeof document.settings !== "object"
    || Array.isArray(document.settings)
    || Object.keys(document.settings).length !== settingsFields.size
    || Object.keys(document.settings).some((key) => !settingsFields.has(key))
    || document.settings.proxyHost !== "127.0.0.1"
    || document.settings.proxyPort !== 15100
    || document.settings.adminHost !== "127.0.0.1"
    || document.settings.adminPort !== 15101
    || typeof document.settings.captureEnabled !== "boolean"
    || !["custom_only", "account_first"].includes(document.settings.routingMode)
    || (document.activeProviderId !== null && typeof document.activeProviderId !== "string")) {
    throw migrationError("MIGRATION_INPUT_INVALID");
  }
  const ids = new Set();
  const names = new Set();
  try {
    for (const provider of document.providers) {
      validateStoredProvider({
        ...provider,
        modelMappingGroupId: null,
        supportedModelsMode: "auto",
        supportedModels: [],
        modelsPath: DEFAULT_PROVIDER_MODELS_PATH,
        customModels: []
      });
      const normalizedName = provider.name.toLowerCase();
      if (ids.has(provider.id) || names.has(normalizedName)) {
        throw new Error("duplicate provider");
      }
      ids.add(provider.id);
      names.add(normalizedName);
    }
  } catch (error) {
    throw migrationError("MIGRATION_INPUT_INVALID", error);
  }
  if (document.activeProviderId !== null && !ids.has(document.activeProviderId)) {
    throw migrationError("MIGRATION_INPUT_INVALID");
  }
}

function upgradeRegistryDocument(document) {
  return {
    ...document,
    schemaVersion: 9,
    providers: document.providers.map((provider) => {
      const supportedModelsMode = provider.supportedModelsMode ?? "auto";
      const supportedModels = provider.supportedModels ?? [];
      return {
        ...provider,
        weight: provider.weight ?? DEFAULT_PROVIDER_WEIGHT,
        modelMappingGroupId: provider.modelMappingGroupId ?? null,
        supportedModelsMode,
        supportedModels,
        modelsPath: provider.modelsPath ?? DEFAULT_PROVIDER_MODELS_PATH,
        customModels: provider.customModels
          ?? (supportedModelsMode === "custom" ? [...supportedModels] : [])
      };
    }),
    modelMappingGroups: document.modelMappingGroups ?? [],
    routingRuleGroups: (document.routingRuleGroups ?? []).map((group) => ({
      ...group,
      rules: group.rules.map((rule) => {
        if (Array.isArray(rule.models)) return rule;
        const { model, ...rest } = rule;
        return { ...rest, models: [model] };
      })
    })),
    settings: {
      ...document.settings,
      apiKeyAuthEnabled: document.settings.proxyHost === "0.0.0.0"
        ? true
        : (document.settings.apiKeyAuthEnabled ?? false),
      routingMode: document.settings.routingMode ?? "custom_only",
      routingRuleGroupId: document.settings.routingRuleGroupId ?? null,
      captureDetailsEnabled: document.settings.captureEnabled === true
        && document.settings.captureDetailsEnabled === true
        ? true
        : false
    }
  };
}

function inspectCurrentRegistry(path, fileOperations) {
  let source;
  try {
    source = readSafeFile(path, fileOperations, { missing: true });
  } catch (error) {
    throw migrationError("MIGRATION_INPUT_INVALID", error, {
      reason: "registry-path-unsafe"
    });
  }
  if (source === null) return { kind: "missing" };
  const invalid = (reason) => {
    const after = lstatRegular(path, fileOperations);
    if (!sameIdentity(after.identity, source.identity)) {
      throw migrationError("MIGRATION_INPUT_INVALID", null, {
        reason: "registry-identity-changed"
      });
    }
    return { kind: "invalid-registry", source, reason };
  };
  let document;
  try {
    document = JSON.parse(source.bytes);
    if (!isPlainObject(document)) throw new Error("not an object");
  } catch {
    return invalid("registry-json-invalid");
  }
  if (![2, 3, 4, 5, 6, 7, 8, 9].includes(document.schemaVersion)) {
    return invalid("registry-schema-unsupported");
  }
  try {
    if (document.schemaVersion === 2) {
      validateSchema2Registry(document);
      return { kind: "schema-2", source: { ...source, document } };
    }
    if (document.schemaVersion === 3) {
      validateSchema3Registry(document);
      return { kind: "schema-3", source: { ...source, document } };
    }
    if (document.schemaVersion === 4) {
      validateSchema4Registry(document);
      return { kind: "schema-4", source: { ...source, document } };
    }
    if (document.schemaVersion === 5) {
      validateProviderRegistryDocument(upgradeRegistryDocument(document));
      return { kind: "schema-5", source: { ...source, document } };
    }
    if (document.schemaVersion === 6) {
      validateProviderRegistryDocument(upgradeRegistryDocument(document));
      return { kind: "schema-6", source: { ...source, document } };
    }
    if (document.schemaVersion === 7) {
      validateProviderRegistryDocument(upgradeRegistryDocument(document));
      return { kind: "schema-7", source: { ...source, document } };
    }
    if (document.schemaVersion === 8) {
      validateProviderRegistryDocument(upgradeRegistryDocument(document));
      return { kind: "schema-8", source: { ...source, document } };
    }
    validateProviderRegistryDocument(document);
  } catch {
    return invalid("registry-document-invalid");
  }
  const after = lstatRegular(path, fileOperations);
  if (!sameIdentity(after.identity, source.identity)) {
    throw migrationError("MIGRATION_INPUT_INVALID", null, {
      reason: "registry-identity-changed"
    });
  }
  return { kind: "current" };
}

export async function migrateLegacyConfiguration({
  paths,
  credentialStore,
  activityStore = null,
  now = () => new Date().toISOString(),
  createProviderId = randomUUID,
  createCredentialRef = randomUUID,
  createBackupId = randomUUID,
  createLockId = randomUUID,
  createTransactionId = randomUUID,
  processId = process.pid,
  isProcessAlive = defaultIsProcessAlive,
  fileOperations: overrides = {}
}) {
  if (!paths || typeof paths.globalHome !== "string" || typeof paths.registryPath !== "string"
    || !credentialStore || typeof credentialStore.set !== "function"
    || typeof credentialStore.delete !== "function"
    || typeof createTransactionId !== "function"
    || !Number.isSafeInteger(processId) || processId < 1
    || typeof isProcessAlive !== "function") {
    throw migrationError("MIGRATION_INPUT_INVALID");
  }
  const fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...overrides };
  const legacyConfigPath = paths.legacyConfigPath ?? join(paths.globalHome, "config.json");
  const runtimeConfigPath = paths.runtimeConfigPath
    ?? join(paths.globalHome, "node", "proxy-config.json");
  resumeInvalidRegistryQuarantine({
    registryPath: paths.registryPath,
    fileOperations,
    createId: createLockId,
    isProcessAlive
  });
  const transactionId = createTransactionId();
  if (typeof transactionId !== "string"
    || !/^[A-Za-z0-9_.:-]{1,128}$/.test(transactionId)) {
    throw migrationError("MIGRATION_INPUT_INVALID");
  }
  const lockPath = `${paths.registryPath}.migration.lock`;
  const lock = createLock({
    lockPath,
    fileOperations,
    createId: createLockId,
    token: transactionLockToken(processId, transactionId, "migration")
  });
  const registryLockPath = `${paths.registryPath}.crp.lock`;
  let registryLock;
  try {
    registryLock = createLock({
      lockPath: registryLockPath,
      fileOperations,
      createId: createLockId,
      token: transactionLockToken(processId, transactionId, "registry")
    });
  } catch (error) {
    const migrationLockReleased = releaseLock({
      lockPath,
      lock,
      fileOperations,
      createId: createLockId
    });
    if (!migrationLockReleased) {
      throw migrationError("MIGRATION_ROLLBACK_DEGRADED", error, {
        committed: false,
        degraded: true
      });
    }
    throw error;
  }
  let registryLockReleased = false;

  let completed = false;
  let providerId = null;
  let providerIds = [];
  const credentialAttempts = [];
  let registryOwned = null;
  let upgradedRegistry = null;
  let commitWarning = null;
  const sources = [];
  const scrubbedSources = [];
  let failure;
  let rollbackDegraded = false;
  let quarantinePending = null;

  try {
    const registryInspection = inspectCurrentRegistry(paths.registryPath, fileOperations);
    if (registryInspection.kind === "invalid-registry") {
      const recovery = quarantineInvalidRegistry({
        path: paths.registryPath,
        source: registryInspection.source,
        reason: registryInspection.reason,
        fileOperations,
        createBackupId,
        createId: createLockId,
        pid: processId,
        lock,
        registryLock
      });
      quarantinePending = recovery.pending;
      completed = true;
      if (activityStore) {
        try {
          await activityStore.append({
            category: "migration",
            action: "provider-registry-recovery",
            providerId: null,
            result: "success",
            errorCode: null,
            details: {
              reason: registryInspection.reason,
              backupCreated: true,
              markerRetained: true
            }
          });
        } catch {
          // Registry recovery is complete; Activity is intentionally best-effort.
        }
      }
      return { migrated: false, reason: "invalid-registry-requires-setup" };
    }
    if (registryInspection.kind === "current") {
      completed = true;
      return { migrated: false, reason: "already-current" };
    }
    if ([
      "schema-2",
      "schema-3",
      "schema-4",
      "schema-5",
      "schema-6",
      "schema-7",
      "schema-8"
    ].includes(registryInspection.kind)) {
      const source = registryInspection.source;
      createBackup(source, fileOperations, createBackupId);
      const upgradedDocument = upgradeRegistryDocument(source.document);
      const bytes = Buffer.from(`${JSON.stringify(upgradedDocument, null, 2)}\n`, "utf8");
      let currentIdentity;
      try {
        currentIdentity = replaceFile(
          paths.registryPath,
          bytes,
          source.identity,
          fileOperations,
          createLockId
        );
      } catch (error) {
        if (error?.[REPLACEMENT_COMMITTED_IDENTITY]) {
          upgradedRegistry = {
            source,
            currentIdentity: error[REPLACEMENT_COMMITTED_IDENTITY]
          };
        }
        throw error;
      }
      upgradedRegistry = { source, currentIdentity };
      new ProviderRegistry({ path: paths.registryPath, fileOperations });
      const verified = readSafeFile(paths.registryPath, fileOperations);
      if (!sameIdentity(verified.identity, currentIdentity) || !verified.bytes.equals(bytes)) {
        throw migrationError("MIGRATION_FAILED");
      }
      completed = true;
      if (activityStore) {
        try {
          await activityStore.append({
            category: "migration",
            action: "provider-registry-schema-9",
            providerId: null,
            result: "success",
            errorCode: null,
            details: {
              sourceSchemaVersion: source.document.schemaVersion,
              ...(source.document.schemaVersion < 4
                ? { providerWeight: DEFAULT_PROVIDER_WEIGHT }
                : {})
            }
          });
        } catch (error) {
          throw migrationError("MIGRATION_COMMITTED_DEGRADED", error, {
            committed: true,
            degraded: true
          });
        }
      }
      return { migrated: true, reason: "provider-registry-schema-9" };
    }

    const legacySources = [
      readLegacySource(legacyConfigPath, "saved", fileOperations),
      readLegacySource(runtimeConfigPath, "runtime", fileOperations)
    ];
    const existingSources = legacySources.filter(({ state }) => state !== "missing");
    if (existingSources.length === 0) {
      completed = true;
      return { migrated: false, reason: "no-legacy-config" };
    }
    const parseableSources = legacySources.filter(({ state }) => state === "valid");
    for (const source of parseableSources) sources.push(source.file);
    const candidateStates = parseableSources.map(({ source, file }) => (
      candidateFromDocument(source, file.document)
    ));
    const completeCandidates = candidateStates.filter(({ state }) => state === "complete");
    const invalidSourceCount = existingSources.length - completeCandidates.length;
    const resolved = resolveImportCandidates(completeCandidates);
    if (resolved.candidates.length === 0) {
      completed = true;
      return { migrated: false, reason: "legacy-config-requires-setup" };
    }

    const timestamp = now();
    const allocations = resolved.candidates.map((candidate) => ({
      candidate,
      providerId: createProviderId(),
      credentialRef: createCredentialRef()
    }));
    if (new Set(allocations.map(({ providerId: id }) => id)).size !== allocations.length
      || new Set(allocations.map(({ credentialRef: ref }) => ref)).size !== allocations.length) {
      throw migrationError("MIGRATION_INPUT_INVALID");
    }
    const profiles = allocations.map(({ candidate, providerId: id, credentialRef: ref }) => (
      normalizeProvider({
        name: allocations.length === 1
          ? "Default"
          : candidate.source === "runtime"
            ? "Recovered runtime"
            : "Recovered saved",
        baseUrl: candidate.baseUrl,
        credentialRef: ref,
        authHeader: candidate.authHeader,
        authScheme: candidate.authScheme,
        extraHeaders: candidate.extraHeaders,
        modelMode: "passthrough",
        modelOverride: null
      }, { id, now: timestamp })
    ));
    providerIds = profiles.map(({ id }) => id);
    providerId = profiles.length === 1 ? profiles[0].id : null;

    fileOperations.mkdirSync(paths.globalHome, { recursive: true, mode: 0o700 });
    for (const source of sources) {
      createBackup(source, fileOperations, createBackupId);
    }

    for (const { candidate, credentialRef } of allocations) {
      credentialAttempts.push(credentialRef);
      try {
        await credentialStore.set(credentialRef, candidate.secret);
      } catch (error) {
        if (isCommittedError(error)) commitWarning ??= error;
        else throw error;
      }
    }

    const initialRegistryBytes = registryBytesForProviders(profiles);
    try {
      registryOwned = {
        identity: writeExclusive(
          paths.registryPath,
          initialRegistryBytes,
          fileOperations,
          createLockId
        ),
        bytes: Buffer.from(initialRegistryBytes)
      };
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw migrationError("MIGRATION_REGISTRY_CONFLICT", error);
      }
      throw error;
    }

    const registry = new ProviderRegistry({
      path: paths.registryPath,
      fileOperations
    });
    const committed = registry.getDocument();
    if (committed.schemaVersion !== 9
      || committed.activeProviderId !== null
      || committed.providers.length !== profiles.length
      || committed.providers.some((provider) => provider.lastTestStatus !== "untested")) {
      throw migrationError("MIGRATION_FAILED");
    }
    const committedRegistry = readSafeFile(paths.registryPath, fileOperations);
    if (!sameIdentity(committedRegistry.identity, registryOwned.identity)
      || !committedRegistry.bytes.equals(registryOwned.bytes)) {
      throw migrationError("MIGRATION_FAILED");
    }

    for (const source of sources) {
      const scrubbedBytes = Buffer.from(
        `${JSON.stringify(scrubDocument(source.document), null, 2)}\n`,
        "utf8"
      );
      try {
        source.currentIdentity = replaceFile(
          source.path,
          scrubbedBytes,
          source.currentIdentity,
          fileOperations,
          createLockId
        );
        scrubbedSources.push(source);
      } catch (error) {
        if (error?.[REPLACEMENT_COMMITTED_IDENTITY]) {
          source.currentIdentity = error[REPLACEMENT_COMMITTED_IDENTITY];
          scrubbedSources.push(source);
        }
        throw error;
      }
    }

    completed = true;
    const activityDetails = {
      selectedSource: profiles.length === 1 ? resolved.candidates[0].source : null,
      importedSources: resolved.candidates.map(({ source }) => source),
      conflict: resolved.conflict,
      invalidSourceCount,
      sourceCount: existingSources.length
    };
    if (activityStore) {
      try {
        await activityStore.append({
          category: "migration",
          action: "legacy-config",
          providerId,
          result: commitWarning ? "degraded" : "success",
          errorCode: commitWarning ? "MIGRATION_COMMITTED_DEGRADED" : null,
          details: activityDetails
        });
      } catch (error) {
        throw migrationError("MIGRATION_COMMITTED_DEGRADED", error, {
          committed: true,
          degraded: true
        });
      }
    }
    if (commitWarning) {
      throw migrationError("MIGRATION_COMMITTED_DEGRADED", commitWarning, {
        committed: true,
        degraded: true
      });
    }
    return profiles.length === 1
      ? { migrated: true, providerId: profiles[0].id }
      : { migrated: true, providerIds };
  } catch (error) {
    if (error?.[REGISTRY_QUARANTINE_COMMITTED]) {
      completed = error.details?.committed === true;
      rollbackDegraded = true;
      throw error;
    }
    if (completed && isCommittedError(error)) throw error;
    failure = error;
    let rollbackFailed = error?.code === "MIGRATION_ROLLBACK_DEGRADED"
      || error?.details?.degraded === true;
    if (upgradedRegistry !== null) {
      try {
        upgradedRegistry.source.currentIdentity = replaceFile(
          paths.registryPath,
          upgradedRegistry.source.bytes,
          upgradedRegistry.currentIdentity,
          fileOperations,
          createLockId
        );
      } catch {
        rollbackFailed = true;
      }
    }
    for (const source of scrubbedSources.reverse()) {
      try {
        source.currentIdentity = replaceFile(
          source.path,
          source.bytes,
          source.currentIdentity,
          fileOperations,
          createLockId
        );
      } catch {
        rollbackFailed = true;
      }
    }
    if (registryOwned !== null) {
      try {
        const currentRegistry = readSafeFile(paths.registryPath, fileOperations, { missing: true });
        if (currentRegistry === null
          || !sameIdentity(currentRegistry.identity, registryOwned.identity)
          || !currentRegistry.bytes.equals(registryOwned.bytes)
          || !claimOwnedPath(
            paths.registryPath,
            registryOwned.identity,
            fileOperations,
            createLockId
          )) {
          rollbackFailed = true;
        }
      } catch {
        rollbackFailed = true;
      }
    }
    for (const ref of [...credentialAttempts].reverse()) {
      try { await credentialStore.delete(ref); } catch { rollbackFailed = true; }
    }
    if (activityStore) {
      try {
        const safeFailureCode = error instanceof CrpError
          && error.code === "MIGRATION_INPUT_INVALID"
          ? error.code
          : "MIGRATION_FAILED";
        await activityStore.append({
          category: "migration",
          action: "legacy-config",
          providerId,
          result: "failed",
          errorCode: rollbackFailed ? "MIGRATION_ROLLBACK_DEGRADED" : safeFailureCode,
          details: { rollbackDegraded: rollbackFailed }
        });
      } catch {
        rollbackFailed = true;
      }
    }
    if (rollbackFailed) {
      rollbackDegraded = true;
      throw migrationError("MIGRATION_ROLLBACK_DEGRADED", failure, {
        committed: false,
        degraded: true
      });
    }
    if (error instanceof CrpError && (
      error.code === "MIGRATION_INPUT_INVALID"
      || error.code === "MIGRATION_REGISTRY_CONFLICT"
    )) {
      throw error;
    }
    throw migrationError("MIGRATION_FAILED", failure, { committed: false });
  } finally {
    if (!rollbackDegraded) {
      let registryReleased = true;
      if (!registryLockReleased) {
        registryLockReleased = true;
        registryReleased = releaseLock({
          lockPath: registryLockPath,
          lock: registryLock,
          fileOperations,
          createId: createLockId
        });
      }
      const migrationReleased = releaseLock({
        lockPath,
        lock,
        fileOperations,
        createId: createLockId
      });
      const released = registryReleased && migrationReleased;
      if (released && quarantinePending !== null
        && !claimOwnedPath(
          quarantinePending.path,
          quarantinePending.identity,
          fileOperations,
          createLockId
        )) {
        throw migrationError("MIGRATION_COMMITTED_DEGRADED", null, {
          committed: true,
          degraded: true,
          reason: "registry-recovery-pending-cleanup-failed"
        });
      }
      if (!released && completed) {
        throw migrationError("MIGRATION_COMMITTED_LOCK_DEGRADED", null, {
          committed: true,
          degraded: true
        });
      }
      if (!released && !completed) {
        throw migrationError("MIGRATION_ROLLBACK_DEGRADED", failure, {
          committed: false,
          degraded: true
        });
      }
    }
  }
}
