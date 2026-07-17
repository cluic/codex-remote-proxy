import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
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
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";

import { bootstrapCodexConfig, patchCodexConfigText } from "../codex/codex-config.mjs";
import {
  hasPendingCodexHistoryRepair,
  inspectPendingCodexHistoryRepair,
  planCodexProviderTransition,
  runCodexHistoryRepairTransition
} from "../codex/codex-history-repair.mjs";
import { createCredentialStore } from "../credentials/credential-store.mjs";
import { ProviderModelCache } from "../providers/provider-model-cache.mjs";
import { ProviderRegistry } from "../providers/provider-registry.mjs";
import { CrpError } from "../shared/errors.mjs";
import { getPaths } from "../shared/paths.mjs";
import { ActivityStore } from "./activity-store.mjs";
import { createAdminServer } from "./admin-server.mjs";
import { migrateLegacyConfiguration } from "./migration.mjs";
import { MetricsStore } from "./metrics-store.mjs";
import { ProviderService } from "./provider-service.mjs";
import { SessionAuth } from "./session-auth.mjs";
import { WorkerManager } from "./worker-manager.mjs";

const DEFAULT_UI_DIR = fileURLToPath(new URL("../../ui", import.meta.url));
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  constants,
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
const DEFAULT_CODEX_HISTORY_REPAIR = Object.freeze({
  plan: planCodexProviderTransition,
  hasPending: hasPendingCodexHistoryRepair,
  inspectPending: inspectPendingCodexHistoryRepair,
  run: runCodexHistoryRepairTransition
});

function completePaths(home, provided) {
  const base = provided ?? getPaths(home);
  return {
    ...base,
    modelCachePath: base.modelCachePath
      ?? resolve(base.globalHome, "provider-model-cache.json"),
    metricsPath: base.metricsPath ?? resolve(base.globalHome, "metrics.json"),
    runtimeConfigPath: base.runtimeConfigPath
      ?? resolve(base.globalHome, "node", "proxy-config.json"),
    capturePath: base.capturePath ?? resolve(base.globalHome, "traffic.sqlite3")
  };
}

function publicChildState(state) {
  if (state === null || typeof state !== "object") return null;
  return {
    phase: state.phase,
    configured: state.configured,
    generation: state.generation,
    listening: state.listening,
    listenHost: state.listenHost,
    listenPort: state.listenPort,
    inFlight: state.inFlight
  };
}

function publicWorkerState(state) {
  if (state === null || typeof state !== "object") return null;
  return {
    phase: state.phase,
    pid: state.pid,
    generation: state.generation,
    state: publicChildState(state.state),
    restartCount: state.restartCount,
    startedAt: state.startedAt,
    error: state.error === null || typeof state.error !== "object"
      ? null
      : { code: state.error.code, message: state.error.message }
  };
}

const CODEX_BOOTSTRAP_ERROR_CONTRACTS = new Map([
  ["CODEX_CONFIG_PARENT_UNSAFE", {
    message: "The Codex configuration directory is unsafe.",
    action: "Repair the Codex configuration directory and retry.",
    status: 500
  }],
  ["CODEX_CONFIG_BUSY", {
    message: "Codex configuration is already being updated.",
    action: "Wait for the current update to finish and retry.",
    status: 409
  }],
  ["CODEX_CONFIG_CHANGED", {
    message: "Codex configuration changed during bootstrap.",
    action: "Review the current Codex configuration and retry.",
    status: 409
  }],
  ["CODEX_CONFIG_READ_FAILED", {
    message: "Codex configuration could not be read safely.",
    action: "Repair local filesystem access and retry.",
    status: 500
  }],
  ["CODEX_CONFIG_WRITE_FAILED", {
    message: "Codex configuration could not be written safely.",
    action: "Repair local filesystem access and retry.",
    status: 500
  }],
  ["CODEX_CONFIG_COMMITTED_DEGRADED", {
    message: "The Codex configuration was updated, but completion could not be confirmed.",
    action: "Review the Codex configuration and retry before starting the proxy.",
    status: 500,
    details: { committed: true, degraded: true, pending: false }
  }],
  ["CODEX_HISTORY_REPAIR_INVALID", {
    message: "The Codex history repair input is invalid.",
    action: "Repair the Codex configuration or history state and try again.",
    status: 400
  }],
  ["CODEX_HISTORY_REPAIR_CONFLICT", {
    message: "Another Codex history repair transition is already pending.",
    action: "Complete or recover the pending Codex history repair before retrying.",
    status: 409
  }],
  ["CODEX_HISTORY_REPAIR_FAILED", {
    message: "Codex history repair could not be completed.",
    action: "Repair local Codex history storage and retry before starting the proxy.",
    status: 500
  }],
  ["CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED", {
    message: "Codex configuration was updated, but history repair remains pending.",
    action: "Retry crp start to resume Codex history repair before using the proxy.",
    status: 500
  }]
]);

function projectCodexBootstrapError(error) {
  const code = CODEX_BOOTSTRAP_ERROR_CONTRACTS.has(error?.code)
    ? error.code
    : "CODEX_CONFIG_WRITE_FAILED";
  const contract = CODEX_BOOTSTRAP_ERROR_CONTRACTS.get(code);
  const details = contract.details ?? (code === "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED"
    ? { committed: true, degraded: true, pending: true }
    : {});
  return new CrpError(code, contract.message, contract.action, {
    status: contract.status,
    details,
    cause: error
  });
}

function codexNotReady() {
  return new CrpError(
    "CODEX_NOT_READY",
    "The Codex configuration is not ready.",
    "Complete Codex bootstrap before activating a provider or starting or restarting the proxy.",
    { status: 409 }
  );
}

function createSerialGate() {
  let tail = Promise.resolve();
  return (operation) => {
    const previous = tail;
    let release;
    tail = new Promise((resolvePromise) => {
      release = resolvePromise;
    });
    return (async () => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    })();
  };
}

function readCodexConfigText(path, fileOperations) {
  let before;
  try {
    before = fileOperations.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Codex configuration status source is unsafe.");
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
      throw new Error("Codex configuration status identity changed.");
    }
    const bytes = Buffer.from(fileOperations.readFileSync(descriptor));
    const after = fileOperations.lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after)) {
      throw new Error("Codex configuration status identity changed.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
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

function createCodexService({
  paths,
  proxyUrl,
  fileOperations,
  bootstrapImpl,
  historyRepair
}) {
  const runExclusive = createSerialGate();
  const inspectStatus = () => {
    let configured = false;
    let historyRepairPending = false;
    const operations = fileOperations ?? DEFAULT_FILE_OPERATIONS;
    try {
      const codexRoot = dirname(paths.codexConfigPath);
      let rootBefore;
      try {
        rootBefore = operations.lstatSync(codexRoot);
      } catch (error) {
        if (error?.code === "ENOENT") {
          return {
            configured: false,
            modelProvider: "OpenAI",
            proxyUrl,
            historyRepairPending: false
          };
        }
        throw error;
      }
      if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
        throw new Error("Codex configuration root is unsafe.");
      }
      const pendingOptions = { codexRoot };
      if (fileOperations !== undefined) pendingOptions.fileOperations = fileOperations;
      historyRepairPending = historyRepair.hasPending(pendingOptions);
      const configLockPath = `${paths.codexConfigPath}.crp.lock`;
      const configLockedBeforeRead = pathExists(configLockPath, operations);
      const text = readCodexConfigText(paths.codexConfigPath, operations);
      const rootAfter = operations.lstatSync(codexRoot);
      if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink()
        || !sameIdentity(rootBefore, rootAfter)) {
        throw new Error("Codex configuration root identity changed.");
      }
      const configLockedAfterRead = pathExists(configLockPath, operations);
      const pendingAfterRead = historyRepair.hasPending(pendingOptions);
      historyRepairPending ||= pendingAfterRead;
      const configLockedAfterPending = pathExists(configLockPath, operations);
      if (text !== null && !configLockedBeforeRead && !configLockedAfterRead
        && !configLockedAfterPending) {
        const patchedText = patchCodexConfigText(text, proxyUrl);
        const transition = planCodexProviderTransition({
          sourceExists: true,
          sourceText: text,
          targetText: patchedText,
          targetProvider: "OpenAI",
          targetBaseUrl: proxyUrl
        });
        configured = patchedText === text
          && transition.required === false
          && !historyRepairPending;
      }
    } catch {
      configured = false;
      historyRepairPending = true;
    }
    return {
      configured,
      modelProvider: "OpenAI",
      proxyUrl,
      historyRepairPending
    };
  };

  return {
    bootstrap() {
      return runExclusive(async () => {
        const options = {
          configPath: paths.codexConfigPath,
          proxyUrl,
          historyRepair
        };
        if (fileOperations !== undefined) options.fileOperations = fileOperations;
        try {
          return await bootstrapImpl(options);
        } catch (error) {
          throw projectCodexBootstrapError(error);
        }
      });
    },
    getStatus() {
      return runExclusive(async () => inspectStatus());
    },
    runWhenReady(operation) {
      if (typeof operation !== "function") {
        return Promise.reject(new TypeError("Codex readiness operation is invalid."));
      }
      return runExclusive(async () => {
        const status = inspectStatus();
        if (status.configured !== true || status.historyRepairPending === true) {
          throw codexNotReady();
        }
        return await operation();
      });
    }
  };
}

function createSettingsService({ registry, credentialStore }) {
  return {
    getSettings() {
      return {
        ...registry.getDocument().settings,
        credentialBackend: credentialStore.backend ?? null
      };
    }
  };
}

function createDiagnosticsService({ activityStore, now }) {
  return {
    exportDiagnostics() {
      return {
        created: true,
        generatedAt: now(),
        eventCount: activityStore.list({ limit: 10_000 }).length
      };
    }
  };
}

function writeState(path, document, fileOperations, createId) {
  const parent = dirname(path);
  fileOperations.mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    fileOperations.chmodSync(parent, 0o700);
  } catch {
    // Windows ACL validation remains an L3 platform gate.
  }
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  const tempPath = resolve(parent, `.${basename(path)}.${createId()}.tmp`);
  let descriptor;
  try {
    descriptor = fileOperations.openSync(tempPath, "wx", 0o600);
    fileOperations.writeFileSync(descriptor, bytes);
    fileOperations.fsyncSync(descriptor);
    fileOperations.fchmodSync(descriptor, 0o600);
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
    fileOperations.renameSync(tempPath, path);
    const identity = fileOperations.lstatSync(path);
    return { bytes, identity };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileOperations.closeSync(descriptor); } catch {}
    }
    try { fileOperations.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function removeOwnedState(path, owned, fileOperations, createId) {
  if (!owned) return;
  let before;
  try {
    before = fileOperations.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!sameIdentity(before, owned.identity)) return;
  const claimPath = resolve(dirname(path), `.${basename(path)}.${createId()}.claim`);
  fileOperations.renameSync(path, claimPath);
  const claimed = fileOperations.lstatSync(claimPath);
  if (!sameIdentity(claimed, owned.identity)) {
    try {
      fileOperations.linkSync(claimPath, path);
      fileOperations.rmSync(claimPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    return;
  }
  const bytes = fileOperations.readFileSync(claimPath);
  if (!bytes.equals(owned.bytes)) {
    try {
      fileOperations.linkSync(claimPath, path);
      fileOperations.rmSync(claimPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    return;
  }
  fileOperations.rmSync(claimPath);
}

export async function createSupervisor({
  home,
  paths: providedPaths,
  pid = process.pid,
  now = () => new Date().toISOString(),
  backend = "native",
  fallbackConsent = false,
  uiDir = DEFAULT_UI_DIR,
  stateFileOperations = DEFAULT_FILE_OPERATIONS,
  codexFileOperations,
  bootstrapCodex = bootstrapCodexConfig,
  codexHistoryRepair = DEFAULT_CODEX_HISTORY_REPAIR,
  createStateId = randomUUID,
  activityStoreFactory = (options) => new ActivityStore(options),
  credentialStoreFactory = (options) => createCredentialStore(options),
  migrate = migrateLegacyConfiguration,
  registryFactory = (options) => new ProviderRegistry(options),
  providerModelCacheFactory = (options) => new ProviderModelCache(options),
  metricsStoreFactory = (options) => new MetricsStore(options),
  workerManagerFactory = (options) => new WorkerManager(options),
  providerServiceFactory = (options) => new ProviderService(options),
  authFactory = (options) => new SessionAuth(options),
  adminServerFactory = (options) => createAdminServer(options)
} = {}) {
  const paths = completePaths(home, providedPaths);
  const startedAt = now();
  const activityStore = activityStoreFactory({ path: paths.activityPath, now });
  const credentialStore = credentialStoreFactory({
    backend,
    fallbackConsent,
    paths
  });
  await migrate({ paths, credentialStore, activityStore, now });
  const registry = registryFactory({ path: paths.registryPath, now });
  const modelCache = providerModelCacheFactory({ path: paths.modelCachePath, now });
  const settings = registry.getDocument().settings;
  let workerManager;
  let metricsStore;
  let providerService;
  let auth;
  let codexService;
  let settingsService;
  let diagnosticsService;
  let adminServer;
  try {
    const proxyUrl = `http://${settings.proxyHost}:${settings.proxyPort}`;
    codexService = createCodexService({
      paths,
      proxyUrl,
      fileOperations: codexFileOperations,
      bootstrapImpl: bootstrapCodex,
      historyRepair: codexHistoryRepair
    });
    metricsStore = metricsStoreFactory({ path: paths.metricsPath, now });
    workerManager = workerManagerFactory({
      host: settings.proxyHost,
      port: settings.proxyPort,
      runRecoveryWhenReady: (operation) => codexService.runWhenReady(operation),
      recordMetric: (observation) => metricsStore.record(observation),
      noteDroppedMetric: () => metricsStore.noteDropped()
    });
    providerService = providerServiceFactory({
      registry,
      credentialStore,
      activityStore,
      workerManager,
      modelCache,
      now,
      paths
    });
    auth = authFactory({ controlTokenPath: paths.controlTokenPath });
    settingsService = createSettingsService({ registry, credentialStore });
    diagnosticsService = createDiagnosticsService({ activityStore, now });
    adminServer = adminServerFactory({
      auth,
      providerService,
      activityStore,
      settingsService,
      codexService,
      diagnosticsService,
      metricsService: metricsStore,
      getSupervisorState: () => ({ pid, startedAt }),
      uiDir,
      host: settings.adminHost,
      port: settings.adminPort
    });
  } catch (error) {
    try { await auth?.close?.(); } catch {}
    try { await workerManager?.close?.(); } catch {}
    try { await metricsStore?.close?.(); } catch {}
    throw error;
  }
  let address = null;
  let ownedState = null;
  let listenPromise = null;
  let closePromise = null;

  const getPublicState = () => ({
    supervisorPid: pid,
    startedAt,
    admin: address,
    worker: publicWorkerState(workerManager.getPublicState())
  });
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      let firstError = null;
      for (const operation of [
        () => adminServer.close(),
        () => auth.close(),
        () => workerManager.close(),
        () => metricsStore.close(),
        () => removeOwnedState(paths.statePath, ownedState, stateFileOperations, createStateId)
      ]) {
        try {
          await operation();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    })();
    return closePromise;
  };

  return {
    paths,
    getPublicState,
    listen() {
      if (listenPromise) return listenPromise;
      listenPromise = (async () => {
        try {
          address = await adminServer.listen();
          const state = {
            schemaVersion: 1,
            ...getPublicState()
          };
          ownedState = writeState(
            paths.statePath,
            state,
            stateFileOperations,
            createStateId
          );
          return { ...address };
        } catch (error) {
          await close().catch(() => {});
          throw error;
        }
      })();
      return listenPromise;
    },
    close
  };
}
