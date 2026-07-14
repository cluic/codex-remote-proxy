import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
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
import { createCredentialStore } from "../credentials/credential-store.mjs";
import { ProviderRegistry } from "../providers/provider-registry.mjs";
import { CrpError } from "../shared/errors.mjs";
import { getPaths } from "../shared/paths.mjs";
import { ActivityStore } from "./activity-store.mjs";
import { createAdminServer } from "./admin-server.mjs";
import { migrateLegacyConfiguration } from "./migration.mjs";
import { ProviderService } from "./provider-service.mjs";
import { SessionAuth } from "./session-auth.mjs";
import { WorkerManager } from "./worker-manager.mjs";

const DEFAULT_UI_DIR = fileURLToPath(new URL("../../ui", import.meta.url));
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
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

function completePaths(home, provided) {
  const base = provided ?? getPaths(home);
  return {
    ...base,
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
  }]
]);

function projectCodexBootstrapError(error) {
  const code = CODEX_BOOTSTRAP_ERROR_CONTRACTS.has(error?.code)
    ? error.code
    : "CODEX_CONFIG_WRITE_FAILED";
  const contract = CODEX_BOOTSTRAP_ERROR_CONTRACTS.get(code);
  return new CrpError(code, contract.message, contract.action, {
    status: contract.status,
    cause: error
  });
}

function createCodexService({
  paths,
  proxyUrl,
  fileOperations,
  bootstrapImpl
}) {
  return {
    bootstrap() {
      const options = {
        configPath: paths.codexConfigPath,
        proxyUrl
      };
      if (fileOperations !== undefined) options.fileOperations = fileOperations;
      try {
        return bootstrapImpl(options);
      } catch (error) {
        throw projectCodexBootstrapError(error);
      }
    },
    getStatus() {
      let configured = false;
      const operations = fileOperations ?? DEFAULT_FILE_OPERATIONS;
      try {
        if (operations.existsSync(paths.codexConfigPath)) {
          const text = operations.readFileSync(paths.codexConfigPath, "utf8");
          configured = patchCodexConfigText(text, proxyUrl) === text;
        }
      } catch {
        configured = false;
      }
      return { configured, modelProvider: "OpenAI", proxyUrl };
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
  createStateId = randomUUID,
  activityStoreFactory = (options) => new ActivityStore(options),
  credentialStoreFactory = (options) => createCredentialStore(options),
  migrate = migrateLegacyConfiguration,
  registryFactory = (options) => new ProviderRegistry(options),
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
  const settings = registry.getDocument().settings;
  let workerManager;
  let providerService;
  let auth;
  let codexService;
  let settingsService;
  let diagnosticsService;
  let adminServer;
  try {
    workerManager = workerManagerFactory({
      host: settings.proxyHost,
      port: settings.proxyPort
    });
    providerService = providerServiceFactory({
      registry,
      credentialStore,
      activityStore,
      workerManager,
      now,
      paths
    });
    auth = authFactory({ controlTokenPath: paths.controlTokenPath });
    const proxyUrl = `http://${settings.proxyHost}:${settings.proxyPort}`;
    codexService = createCodexService({
      paths,
      proxyUrl,
      fileOperations: codexFileOperations,
      bootstrapImpl: bootstrapCodex
    });
    settingsService = createSettingsService({ registry, credentialStore });
    diagnosticsService = createDiagnosticsService({ activityStore, now });
    adminServer = adminServerFactory({
      auth,
      providerService,
      activityStore,
      settingsService,
      codexService,
      diagnosticsService,
      getSupervisorState: () => ({ pid, startedAt }),
      uiDir,
      host: settings.adminHost,
      port: settings.adminPort
    });
  } catch (error) {
    try { await auth?.close?.(); } catch {}
    try { await workerManager?.close?.(); } catch {}
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
