import { createApp } from "../server.mjs";
import {
  PROTOCOL_VERSION,
  createFatalMessage,
  validateChildMessage,
  validateParentMessage
} from "./protocol.mjs";
import { AccountRoutingStateSource } from "./account-routing-state.mjs";
import { RuntimeSettingsSource } from "./runtime-settings.mjs";

const PARENT_DISCONNECT_GRACE_MS = 250;

const runtimeSettings = new RuntimeSettingsSource();
const accountRoutingState = new AccountRoutingStateSource();

let app = null;
let phase = "ready";
let listenHost = null;
let listenPort = null;
let inFlight = 0;
let stopping = false;
let intendedExitCode = 0;
let operation = Promise.resolve();
let drainPromise = null;
let resourceClosePromise = null;
let parentDisconnectCleanupPromise = null;

function getPublicState() {
  const runtime = runtimeSettings.publicState();
  return {
    phase,
    configured: runtime.configured,
    generation: runtime.generation,
    listening: app?.server.listening === true,
    listenHost: app?.server.listening === true ? listenHost : null,
    listenPort: app?.server.listening === true ? listenPort : null,
    inFlight
  };
}

function sendChildMessage(message) {
  validateChildMessage(message);
  if (typeof process.send !== "function" || !process.connected) {
    return Promise.reject(new Error("Worker IPC channel is unavailable."));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    process.send(message, (error) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
  });
}

function lifecycleMessage(type, requestId) {
  return {
    version: PROTOCOL_VERSION,
    type,
    requestId,
    state: getPublicState()
  };
}

function emitMetric(observation) {
  void sendChildMessage({
    version: PROTOCOL_VERSION,
    type: "metric",
    requestId: "metric-observation",
    observation
  }).catch(() => {
    // Metrics are best effort and must not change request or worker lifecycle state.
  });
}

function trackRequests(server) {
  server.prependListener("request", (_req, res) => {
    inFlight += 1;
    let completed = false;
    const complete = () => {
      if (completed) {
        return;
      }
      completed = true;
      inFlight -= 1;
      if (drainPromise && inFlight === 0) {
        setImmediate(() => {
          if (drainPromise && inFlight === 0) {
            app?.server.closeIdleConnections?.();
          }
        });
      }
    };
    res.once("finish", complete);
    res.once("close", complete);
  });
}

function listen(server, settings) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      listenHost = typeof address === "object" && address ? address.address : settings.server.host;
      listenPort = typeof address === "object" && address ? address.port : settings.server.port;
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(settings.server.port, settings.server.host);
  });
}

async function closeResources() {
  if (!app) {
    return;
  }
  if (drainPromise) {
    await drainPromise;
    return;
  }
  if (!resourceClosePromise) {
    if (app.server.listening) {
      resourceClosePromise = new Promise((resolvePromise) => app.server.close(resolvePromise));
    } else {
      app.captureManager.close();
      app.accessKeyStore?.close();
      resourceClosePromise = Promise.resolve();
    }
  }
  await resourceClosePromise;
}

async function finishProcess(exitCode) {
  intendedExitCode = exitCode;
  await closeResources();
  process.exitCode = exitCode;
  if (process.connected) {
    process.disconnect();
  }
}

async function failWorker({ requestId, code }) {
  if (stopping) {
    return;
  }
  stopping = true;
  phase = "failed";
  intendedExitCode = 1;
  try {
    await sendChildMessage(createFatalMessage({ requestId, code }));
  } catch {
    // The parent may already be gone; cleanup still has to complete.
  }
  await finishProcess(1);
}

async function configure(message) {
  if (stopping || (phase !== "ready" && phase !== "running")) {
    const error = new Error("Worker configuration is not allowed in the current phase.");
    error.code = "WORKER_CONFIGURE_FAILED";
    throw error;
  }
  runtimeSettings.apply({
    generation: message.generation,
    settings: message.settings
  });
  accountRoutingState.seed({
    revision: message.settings.routing.accountRevision,
    state: message.settings.routing.account
  });
  if (!app) {
    app = createApp(message.settings, {
      settingsSource: runtimeSettings,
      accountStateSource: accountRoutingState,
      recordMetric: emitMetric
    });
    trackRequests(app.server);
    try {
      await listen(app.server, message.settings);
    } catch (error) {
      error.workerFatalCode = "WORKER_START_FAILED";
      throw error;
    }
  } else {
    app.captureManager.applyRuntimeConfig(message.settings.capture);
  }
  phase = "running";
  await sendChildMessage(lifecycleMessage("configured", message.requestId));
}

async function applyAccountState(message) {
  if (stopping || phase !== "running") {
    const error = new Error("Worker account routing state is unavailable.");
    error.code = "WORKER_CONFIGURE_FAILED";
    throw error;
  }
  accountRoutingState.apply({ revision: message.revision, state: message.state });
  await sendChildMessage({
    version: PROTOCOL_VERSION,
    type: "account-state-applied",
    requestId: message.requestId,
    revision: message.revision
  });
}

async function previewRoute(message) {
  if (stopping || phase !== "running" || !app || typeof app.previewRoute !== "function") {
    const error = new Error("Worker route preview is unavailable.");
    error.code = "WORKER_CONFIGURE_FAILED";
    throw error;
  }
  await sendChildMessage({
    version: PROTOCOL_VERSION,
    type: "route-preview",
    requestId: message.requestId,
    preview: app.previewRoute(message.model, message.operation, message.requestFormat)
  });
}

async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  phase = "stopping";
  intendedExitCode = 0;
  await finishProcess(0);
}

function forceCloseResources() {
  if (!app) {
    return;
  }
  app.server.closeIdleConnections?.();
  app.server.closeAllConnections?.();
  app.captureManager.close();
  app.accessKeyStore?.close();
}

async function performParentDisconnectCleanup() {
  const exitCode = intendedExitCode;
  if (!stopping) {
    stopping = true;
    phase = "stopping";
  }

  let deadline;
  const timedOut = new Promise((resolvePromise) => {
    deadline = setTimeout(() => resolvePromise(false), PARENT_DISCONNECT_GRACE_MS);
  });
  const closedGracefully = closeResources()
    .then(() => true)
    .catch(() => false);
  const outcome = await Promise.race([closedGracefully, timedOut]);
  clearTimeout(deadline);

  if (outcome === true) {
    process.exitCode = exitCode;
    return;
  }
  try {
    forceCloseResources();
  } finally {
    process.exit(exitCode);
  }
}

function shutdownAfterParentDisconnect() {
  if (!parentDisconnectCleanupPromise) {
    parentDisconnectCleanupPromise = performParentDisconnectCleanup();
  }
  return parentDisconnectCleanupPromise;
}

function closeForDrain() {
  if (!app?.server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise, rejectPromise) => {
    app.server.close((error) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
  });
}

function beginDrain(requestId) {
  if (!drainPromise) {
    phase = "draining";
    drainPromise = closeForDrain().then(() => {
      phase = "drained";
    });
  }
  void drainPromise
    .then(() => {
      phase = "drained";
      return sendChildMessage(lifecycleMessage("drained", requestId));
    })
    .catch(() => failWorker({ requestId, code: "WORKER_RUNTIME_FAILED" }));
}

async function handleParentMessage(rawMessage) {
  let message;
  try {
    message = validateParentMessage(rawMessage);
  } catch (error) {
    await failWorker({
      requestId: "worker-fatal",
      code: error.code === "WORKER_PROTOCOL_INVALID" ? error.code : "WORKER_RUNTIME_FAILED"
    });
    return;
  }

  try {
    if (message.type === "configure") {
      await configure(message);
      return;
    }
    if (message.type === "account-state") {
      await applyAccountState(message);
      return;
    }
    if (message.type === "route-preview") {
      await previewRoute(message);
      return;
    }
    if (message.type === "status") {
      await sendChildMessage(lifecycleMessage("status", message.requestId));
      return;
    }
    if (message.type === "shutdown") {
      await shutdown();
      return;
    }
    beginDrain(message.requestId);
  } catch (error) {
    await failWorker({
      requestId: message.requestId,
      code: error.workerFatalCode ?? error.code ?? "WORKER_RUNTIME_FAILED"
    });
  }
}

function scheduleMessage(message) {
  operation = operation
    .then(() => handleParentMessage(message))
    .catch(() => failWorker({ requestId: "worker-fatal", code: "WORKER_RUNTIME_FAILED" }));
}

async function startWorker() {
  if (typeof process.send !== "function") {
    throw new Error("Worker requires an IPC channel.");
  }
  process.on("message", scheduleMessage);
  process.once("disconnect", () => {
    void shutdownAfterParentDisconnect();
  });
  await sendChildMessage(lifecycleMessage("ready", "worker-ready"));
}

process.once("uncaughtException", () => {
  void failWorker({ requestId: "worker-fatal", code: "WORKER_RUNTIME_FAILED" });
});
process.once("unhandledRejection", () => {
  void failWorker({ requestId: "worker-fatal", code: "WORKER_RUNTIME_FAILED" });
});

void startWorker().catch(() => {
  void failWorker({ requestId: "worker-fatal", code: "WORKER_START_FAILED" });
});
