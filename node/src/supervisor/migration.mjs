import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as FS_CONSTANTS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { ProviderRegistry } from "../providers/provider-registry.mjs";
import {
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

function parseJson(bytes) {
  try {
    const value = JSON.parse(bytes);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch (error) {
    throw migrationError("MIGRATION_INPUT_INVALID", error);
  }
}

function optionalString(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

function sourceValues(config, runtime) {
  const runtimeUpstream = runtime?.upstream;
  const runtimeObject = runtimeUpstream !== null && typeof runtimeUpstream === "object"
    && !Array.isArray(runtimeUpstream) ? runtimeUpstream : {};
  const secretCandidates = [
    runtimeObject.apiKey,
    runtime?.apiKey,
    runtime?.upstreamApiKey,
    runtime?.upstream_api_key,
    config?.apiKey,
    config?.upstreamApiKey,
    config?.upstream_api_key
  ].filter((value) => typeof value === "string" && value.length > 0);
  if (new Set(secretCandidates).size > 1) {
    throw migrationError("MIGRATION_INPUT_INVALID");
  }
  return {
    baseUrl: optionalString(
      runtimeObject.baseUrl,
      runtime?.baseUrl,
      runtime?.upstreamBaseUrl,
      runtime?.upstream_base_url,
      config?.upstreamBaseUrl,
      config?.upstream_base_url,
      config?.baseUrl
    ),
    secret: secretCandidates[0] ?? null,
    authHeader: optionalString(runtimeObject.authHeader, runtime?.authHeader) ?? "authorization",
    authScheme: typeof runtimeObject.authScheme === "string"
      ? runtimeObject.authScheme
      : (typeof runtime?.authScheme === "string" ? runtime.authScheme : "Bearer"),
    extraHeaders: runtimeObject.extraHeaders ?? runtime?.extraHeaders ?? {}
  };
}

function scrubDocument(document) {
  const next = structuredClone(document);
  for (const key of ["apiKey", "upstreamApiKey", "upstream_api_key"]) delete next[key];
  if (next.upstream !== null && typeof next.upstream === "object" && !Array.isArray(next.upstream)) {
    delete next.upstream.apiKey;
  }
  return next;
}

function registryBytesForProvider(provider) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 4,
    activeProviderId: null,
    providers: [provider],
    settings: {
      proxyHost: "127.0.0.1",
      proxyPort: 15100,
      adminHost: "127.0.0.1",
      adminPort: 15101,
      captureEnabled: false,
      routingMode: "custom_only"
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

function createLock({ lockPath, fileOperations, createId }) {
  fileOperations.mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${createId()}\n`;
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

function readSource(path, fileOperations) {
  const source = readSafeFile(path, fileOperations, { missing: true });
  if (source === null) return null;
  return { ...source, currentIdentity: source.identity, document: parseJson(source.bytes) };
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
      validateStoredProvider({ ...provider, weight: DEFAULT_PROVIDER_WEIGHT });
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
      validateStoredProvider({ ...provider, weight: DEFAULT_PROVIDER_WEIGHT });
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

function inspectCurrentRegistry(path, fileOperations) {
  const source = readSafeFile(path, fileOperations, { missing: true });
  if (source === null) return { kind: "missing" };
  const document = parseJson(source.bytes);
  if (document.schemaVersion === 2) {
    validateSchema2Registry(document);
    return { kind: "schema-2", source: { ...source, document } };
  }
  if (document.schemaVersion === 3) {
    validateSchema3Registry(document);
    return { kind: "schema-3", source: { ...source, document } };
  }
  if (document.schemaVersion !== 4) throw migrationError("MIGRATION_INPUT_INVALID");
  new ProviderRegistry({ path, fileOperations });
  const after = lstatRegular(path, fileOperations);
  if (!sameIdentity(after.identity, source.identity)) {
    throw migrationError("MIGRATION_INPUT_INVALID");
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
  fileOperations: overrides = {}
}) {
  if (!paths || typeof paths.globalHome !== "string" || typeof paths.registryPath !== "string"
    || !credentialStore || typeof credentialStore.set !== "function"
    || typeof credentialStore.delete !== "function") {
    throw migrationError("MIGRATION_INPUT_INVALID");
  }
  const fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...overrides };
  const legacyConfigPath = paths.legacyConfigPath ?? join(paths.globalHome, "config.json");
  const runtimeConfigPath = paths.runtimeConfigPath
    ?? join(paths.globalHome, "node", "proxy-config.json");
  const lockPath = `${paths.registryPath}.migration.lock`;
  const lock = createLock({
    lockPath,
    fileOperations,
    createId: createLockId
  });
  const registryLockPath = `${paths.registryPath}.crp.lock`;
  let registryLock;
  try {
    registryLock = createLock({
      lockPath: registryLockPath,
      fileOperations,
      createId: createLockId
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
  let credentialRef = null;
  let credentialAttempted = false;
  let registryOwned = null;
  let upgradedRegistry = null;
  let commitWarning = null;
  const sources = [];
  const scrubbedSources = [];
  let failure;

  try {
    const registryInspection = inspectCurrentRegistry(paths.registryPath, fileOperations);
    if (registryInspection.kind === "current") {
      completed = true;
      return { migrated: false, reason: "already-current" };
    }
    if (registryInspection.kind === "schema-2" || registryInspection.kind === "schema-3") {
      const source = registryInspection.source;
      createBackup(source, fileOperations, createBackupId);
      const upgradedDocument = {
        ...source.document,
        schemaVersion: 4,
        providers: source.document.providers.map((provider) => ({
          ...provider,
          weight: DEFAULT_PROVIDER_WEIGHT
        })),
        settings: {
          ...source.document.settings,
          routingMode: source.document.settings.routingMode ?? "custom_only"
        }
      };
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
      if (activityStore) {
        await activityStore.append({
          category: "migration",
          action: "provider-registry-schema-4",
          providerId: null,
          result: "success",
          errorCode: null,
          details: {
            sourceSchemaVersion: source.document.schemaVersion,
            providerWeight: DEFAULT_PROVIDER_WEIGHT
          }
        });
      }
      completed = true;
      return { migrated: true, reason: "provider-registry-schema-4" };
    }

    const configSource = readSource(legacyConfigPath, fileOperations);
    const runtimeSource = readSource(runtimeConfigPath, fileOperations);
    if (configSource) sources.push(configSource);
    if (runtimeSource) sources.push(runtimeSource);
    if (sources.length === 0) {
      completed = true;
      return { migrated: false, reason: "no-legacy-config" };
    }

    const values = sourceValues(configSource?.document, runtimeSource?.document);
    if (!values.baseUrl || !values.secret) throw migrationError("MIGRATION_INPUT_INVALID");

    fileOperations.mkdirSync(paths.globalHome, { recursive: true, mode: 0o700 });
    for (const source of sources) {
      createBackup(source, fileOperations, createBackupId);
    }

    providerId = createProviderId();
    credentialRef = createCredentialRef();
    credentialAttempted = true;
    try {
      await credentialStore.set(credentialRef, values.secret);
    } catch (error) {
      if (isCommittedError(error)) commitWarning = error;
      else throw error;
    }

    const profile = normalizeProvider({
      name: "Default",
      baseUrl: values.baseUrl,
      credentialRef,
      authHeader: values.authHeader,
      authScheme: values.authScheme,
      extraHeaders: values.extraHeaders,
      modelMode: "passthrough",
      modelOverride: null
    }, { id: providerId, now: now() });
    const initialRegistryBytes = registryBytesForProvider(profile);
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
    if (committed.schemaVersion !== 4
      || committed.activeProviderId !== null
      || committed.providers.length !== 1
      || committed.providers[0].lastTestStatus !== "untested") {
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

    if (activityStore) {
      await activityStore.append({
        category: "migration",
        action: "legacy-config",
        providerId,
        result: commitWarning ? "degraded" : "success",
        errorCode: commitWarning ? "MIGRATION_COMMITTED_DEGRADED" : null,
        details: { sourceCount: sources.length }
      });
    }
    completed = true;
    if (commitWarning) {
      throw migrationError("MIGRATION_COMMITTED_DEGRADED", commitWarning, {
        committed: true,
        degraded: true
      });
    }
    return { migrated: true, providerId };
  } catch (error) {
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
    if (credentialAttempted && credentialRef !== null) {
      try { await credentialStore.delete(credentialRef); } catch { rollbackFailed = true; }
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
