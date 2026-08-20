import { fork } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import {
  PROTOCOL_VERSION,
  validateChildMessage,
  validateParentMessage
} from "../worker/protocol.mjs";
import { CHATGPT_METRICS_PROVIDER_ID } from "../routing/account-routing.mjs";

const WORKER_ENTRY_PATH = fileURLToPath(new URL("../worker/worker-entry.mjs", import.meta.url));
const CRASH_WINDOW_MS = 60_000;
const CRASH_BACKOFF_MS = Object.freeze([250, 500, 1_000, 2_000, 4_000]);
const MAX_METRIC_GENERATIONS = 256;
const MAX_PROVIDER_ID_CODE_POINTS = 128;
const PROVIDER_ID_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

const REAL_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer)
});

const ERROR_MESSAGES = Object.freeze({
  WORKER_MANAGER_CLOSED: "Worker manager is closed.",
  WORKER_READY_TIMEOUT: "Worker did not become ready in time.",
  WORKER_ACK_TIMEOUT: "Worker did not acknowledge the request in time.",
  WORKER_HEALTH_FAILED: "Worker health verification failed.",
  WORKER_PROTOCOL_INVALID: "Worker protocol message is invalid.",
  WORKER_START_FAILED: "Worker failed to start.",
  WORKER_IPC_SEND_FAILED: "Worker IPC send failed.",
  WORKER_NOT_RUNNING: "Worker is not running.",
  WORKER_SNAPSHOT_INVALID: "Worker settings snapshot is invalid.",
  WORKER_EXIT_TIMEOUT: "Worker did not exit in time.",
  WORKER_STOP_FAILED: "Worker could not be stopped.",
  WORKER_PORT_BUSY: "The fixed proxy port is still in use.",
  WORKER_EXITED: "Proxy worker exited unexpectedly.",
  WORKER_CONFIGURE_FAILED: "Worker configuration failed.",
  WORKER_RUNTIME_FAILED: "Worker runtime failed.",
  STALE_SNAPSHOT: "Worker rejected a stale settings snapshot.",
  RUNTIME_SETTINGS_INVALID: "Worker settings are invalid."
});

function managerError(code) {
  const error = new Error(ERROR_MESSAGES[code] ?? "Worker lifecycle operation failed.");
  error.name = "WorkerManagerError";
  error.code = code;
  return error;
}

function defaultForkWorker(forkImpl = fork) {
  return forkImpl(WORKER_ENTRY_PATH, [], {
    execPath: process.execPath,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true
  });
}

function defaultWaitForPortFree(host, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => rejectPromise(managerError("WORKER_PORT_BUSY")));
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => {
        if (error) rejectPromise(managerError("WORKER_PORT_BUSY"));
        else resolvePromise();
      });
    });
  });
}

function publicStateCopy(state) {
  return state ? {
    phase: state.phase,
    configured: state.configured,
    generation: state.generation,
    listening: state.listening,
    listenHost: state.listenHost,
    listenPort: state.listenPort,
    inFlight: state.inFlight
  } : null;
}

function validProviderId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PROVIDER_ID_CODE_POINTS * 2
    && [...value].length <= MAX_PROVIDER_ID_CODE_POINTS
    && value.trim() === value
    && !PROVIDER_ID_CONTROL_PATTERN.test(value);
}

function optionalSnapshotProviderId(snapshot) {
  if (!snapshot || !Object.hasOwn(snapshot, "providerId")) return null;
  if (!validProviderId(snapshot.providerId)) throw managerError("WORKER_SNAPSHOT_INVALID");
  return snapshot.providerId;
}

export class WorkerManager {
  #host;
  #port;
  #clock;
  #forkWorker;
  #fetch;
  #readyTimeoutMs;
  #ackTimeoutMs;
  #healthTimeoutMs;
  #terminateTimeoutMs;
  #killTimeoutMs;
  #waitForPortFree;
  #runRecoveryWhenReady;
  #phase = "stopped";
  #child = null;
  #epoch = 0;
  #generation = 0;
  #accountRevision = 0;
  #accountState = null;
  #workerState = null;
  #restartCount = 0;
  #startedAt = null;
  #lastError = null;
  #lastSnapshot = null;
  #requestSequence = 0;
  #waiters = new Set();
  #exits = new Map();
  #expectedEpochs = new Set();
  #exitErrors = new Map();
  #crashTimes = [];
  #recoveryTimer = null;
  #recoveryVersion = 0;
  #operation = null;
  #closed = false;
  #closePromise = null;
  #recordMetric;
  #noteDroppedMetric;
  #metricProviders = new Map();

  constructor({
    host = "127.0.0.1",
    port = 15100,
    clock = REAL_CLOCK,
    forkWorker,
    forkImpl = fork,
    fetchImpl = globalThis.fetch,
    readyTimeoutMs = 5_000,
    ackTimeoutMs = 5_000,
    healthTimeoutMs = 5_000,
    terminateTimeoutMs = 1_000,
    killTimeoutMs = 1_000,
    waitForPortFree = defaultWaitForPortFree,
    runRecoveryWhenReady,
    recordMetric = () => true,
    noteDroppedMetric = () => {}
  } = {}) {
    if (typeof runRecoveryWhenReady !== "function") {
      throw new TypeError("Worker recovery operation runner is required.");
    }
    if (typeof recordMetric !== "function" || typeof noteDroppedMetric !== "function") {
      throw new TypeError("Worker metrics callbacks are invalid.");
    }
    this.#host = host;
    this.#port = port;
    this.#clock = clock;
    this.#forkWorker = forkWorker === undefined
      ? () => defaultForkWorker(forkImpl)
      : forkWorker;
    this.#fetch = fetchImpl;
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#ackTimeoutMs = ackTimeoutMs;
    this.#healthTimeoutMs = healthTimeoutMs;
    this.#terminateTimeoutMs = terminateTimeoutMs;
    this.#killTimeoutMs = killTimeoutMs;
    this.#waitForPortFree = waitForPortFree;
    this.#runRecoveryWhenReady = runRecoveryWhenReady;
    this.#recordMetric = recordMetric;
    this.#noteDroppedMetric = noteDroppedMetric;
  }

  getPublicState() {
    return {
      phase: this.#phase,
      pid: this.#child?.pid ?? null,
      generation: this.#generation,
      state: publicStateCopy(this.#workerState),
      restartCount: this.#restartCount,
      startedAt: this.#startedAt,
      error: this.#lastError ? { ...this.#lastError } : null
    };
  }

  start(snapshot) {
    if (this.#closed) {
      return Promise.reject(managerError("WORKER_MANAGER_CLOSED"));
    }
    if (this.#operation) {
      return this.#operation;
    }
    if (this.#phase === "running") {
      return Promise.resolve(this.getPublicState());
    }
    if (this.#child) {
      return Promise.reject(managerError("WORKER_STOP_FAILED"));
    }
    return this.#trackOperation(this.#performStart(snapshot));
  }

  applySnapshot(snapshot) {
    if (this.#closed) {
      return Promise.reject(managerError("WORKER_MANAGER_CLOSED"));
    }
    if (this.#operation) {
      return this.#operation;
    }
    if (this.#phase !== "running" || !this.#child) {
      return Promise.reject(managerError("WORKER_NOT_RUNNING"));
    }
    return this.#trackOperation(this.#performApplySnapshot(snapshot));
  }

  applyAccountState(update) {
    if (this.#closed) {
      return Promise.reject(managerError("WORKER_MANAGER_CLOSED"));
    }
    let message;
    try {
      message = {
        version: PROTOCOL_VERSION,
        type: "account-state",
        requestId: this.#nextRequestId("account-state"),
        revision: update?.revision,
        state: update?.state
      };
      validateParentMessage(message);
    } catch {
      return Promise.reject(managerError("WORKER_SNAPSHOT_INVALID"));
    }
    if (this.#operation) {
      return this.#operation.then(() => this.applyAccountState(update));
    }
    if (this.#phase !== "running" || !this.#child) {
      return Promise.reject(managerError("WORKER_NOT_RUNNING"));
    }
    if (message.revision <= this.#accountRevision) {
      return Promise.resolve(this.getPublicState());
    }
    return this.#trackOperation(this.#performApplyAccountState(message));
  }

  stop({ drainTimeoutMs = 5_000 } = {}) {
    if (this.#closed) {
      return Promise.reject(managerError("WORKER_MANAGER_CLOSED"));
    }
    if (this.#operation) return this.#operation;
    if (!this.#child || this.#phase === "stopped") {
      this.#cancelRecovery();
      this.#phase = "stopped";
      this.#workerState = null;
      return Promise.resolve(this.getPublicState());
    }
    return this.#trackOperation(this.#performStop({ drainTimeoutMs }));
  }

  restart(snapshot, { drainTimeoutMs = 5_000 } = {}) {
    if (this.#closed) {
      return Promise.reject(managerError("WORKER_MANAGER_CLOSED"));
    }
    if (this.#operation) return this.#operation;
    let validatedSnapshot;
    try {
      validatedSnapshot = this.#validateSnapshot(snapshot);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#trackOperation(this.#performRestart(validatedSnapshot, { drainTimeoutMs }));
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#cancelRecovery();
    const attempt = (this.#operation ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.#performClose());
    this.#closePromise = attempt;
    void attempt.catch(() => {
      if (this.#closePromise === attempt && this.#child) this.#closePromise = null;
    });
    return attempt;
  }

  async #performClose() {
    const child = this.#child;
    const epoch = this.#epoch;
    this.#rejectWaiters(epoch, managerError("WORKER_MANAGER_CLOSED"));
    let failure = null;
    if (child) {
      this.#expectedEpochs.add(epoch);
      try {
        await this.#terminateChild(child, epoch);
        await this.#waitForPortFree(this.#host, this.#port);
      } catch (error) {
        const code = error?.code === "WORKER_PORT_BUSY" ? "WORKER_PORT_BUSY" : "WORKER_STOP_FAILED";
        failure = managerError(code);
      } finally {
        if (this.#hasExited(child)) this.#releaseChild(child, epoch);
      }
    } else {
      for (const staleEpoch of this.#exits.keys()) {
        this.#detachChild(staleEpoch);
        this.#exits.delete(staleEpoch);
      }
    }
    this.#workerState = null;
    if (failure) {
      this.#phase = "failed";
      this.#lastError = { code: failure.code, message: failure.message };
      throw failure;
    }
    this.#phase = "stopped";
    return this.getPublicState();
  }

  async #performStart(snapshot) {
    const providerId = optionalSnapshotProviderId(snapshot);
    const requestId = this.#nextRequestId("configure");
    const configureMessage = {
      version: PROTOCOL_VERSION,
      type: "configure",
      requestId,
      generation: snapshot?.generation,
      settings: snapshot?.settings
    };
    validateParentMessage(configureMessage);
    if (snapshot.settings.server.host !== this.#host || snapshot.settings.server.port !== this.#port) {
      throw managerError("WORKER_START_FAILED");
    }
    this.#rememberMetricProvider(snapshot.generation, providerId);

    this.#phase = "starting";
    let child;
    try {
      child = this.#forkWorker();
    } catch {
      const error = managerError("WORKER_START_FAILED");
      this.#lastError = { code: error.code, message: error.message };
      this.#phase = "stopped";
      throw error;
    }
    const epoch = ++this.#epoch;
    this.#child = child;
    this.#attachChild(child, epoch);

    try {
      const ready = await this.#waitForMessage({
        epoch,
        requestId: "worker-ready",
        type: "ready",
        timeoutMs: this.#readyTimeoutMs,
        timeoutCode: "WORKER_READY_TIMEOUT"
      });
      if (ready.state.phase !== "ready" || ready.state.configured || ready.state.generation !== 0) {
        throw managerError("WORKER_PROTOCOL_INVALID");
      }

      const configured = await this.#sendAndWait(child, configureMessage, {
        epoch,
        requestId,
        type: "configured",
        timeoutMs: this.#ackTimeoutMs,
        timeoutCode: "WORKER_ACK_TIMEOUT"
      });
      if (configured.state.phase !== "running"
        || configured.state.generation !== snapshot.generation
        || configured.state.listenHost !== this.#host
        || configured.state.listenPort !== this.#port) {
        throw managerError("WORKER_PROTOCOL_INVALID");
      }

      await this.#verifyHealth(snapshot.generation);
      if (epoch !== this.#epoch || child !== this.#child) {
        throw managerError("WORKER_START_FAILED");
      }
      this.#workerState = publicStateCopy(configured.state);
      this.#generation = snapshot.generation;
      this.#accountRevision = snapshot.settings.routing.accountRevision;
      this.#accountState = structuredClone(snapshot.settings.routing.account);
      this.#lastSnapshot = structuredClone(snapshot);
      this.#phase = "running";
      this.#startedAt = new Date(this.#clock.now()).toISOString();
      return this.getPublicState();
    } catch (error) {
      this.#lastError = {
        code: error?.code && ERROR_MESSAGES[error.code] ? error.code : "WORKER_START_FAILED",
        message: ERROR_MESSAGES[error?.code] ?? ERROR_MESSAGES.WORKER_START_FAILED
      };
      this.#expectedEpochs.add(epoch);
      let cleanupError = null;
      try {
        await this.#terminateChild(child, epoch);
        await this.#waitForPortFree(this.#host, this.#port);
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
      this.#workerState = null;
      if (this.#hasExited(child)) {
        this.#releaseChild(child, epoch);
        if (cleanupError) {
          const code = cleanupError?.code === "WORKER_PORT_BUSY"
            ? "WORKER_PORT_BUSY"
            : "WORKER_STOP_FAILED";
          const publicCleanupError = managerError(code);
          this.#lastError = {
            code: publicCleanupError.code,
            message: publicCleanupError.message
          };
          this.#phase = "failed";
        } else {
          this.#phase = "stopped";
        }
      } else {
        this.#phase = "failed";
      }
      throw error?.code ? error : managerError("WORKER_START_FAILED");
    }
  }

  async #performApplySnapshot(snapshot) {
    const child = this.#child;
    const epoch = this.#epoch;
    const requestId = this.#nextRequestId("configure");
    const message = {
      version: PROTOCOL_VERSION,
      type: "configure",
      requestId,
      generation: snapshot?.generation,
      settings: snapshot?.settings
    };
    try {
      validateParentMessage(message);
      optionalSnapshotProviderId(snapshot);
    } catch {
      throw managerError("WORKER_SNAPSHOT_INVALID");
    }
    if (snapshot.generation <= this.#generation
      || snapshot.settings.server.host !== this.#host
      || snapshot.settings.server.port !== this.#port) {
      throw managerError("WORKER_SNAPSHOT_INVALID");
    }
    this.#rememberMetricProvider(snapshot.generation, snapshot.providerId ?? null);
    const configured = await this.#sendAndWait(child, message, {
      epoch,
      requestId,
      type: "configured",
      timeoutMs: this.#ackTimeoutMs,
      timeoutCode: "WORKER_ACK_TIMEOUT"
    });
    if (epoch !== this.#epoch
      || child !== this.#child
      || configured.state.phase !== "running"
      || configured.state.generation !== snapshot.generation
      || configured.state.listenHost !== this.#host
      || configured.state.listenPort !== this.#port) {
      throw managerError("WORKER_PROTOCOL_INVALID");
    }
    const snapshotAccountIsCurrent = snapshot.settings.routing.accountRevision >= this.#accountRevision;
    this.#workerState = publicStateCopy(configured.state);
    this.#generation = snapshot.generation;
    if (snapshotAccountIsCurrent) {
      this.#accountRevision = snapshot.settings.routing.accountRevision;
      this.#accountState = structuredClone(snapshot.settings.routing.account);
    }
    this.#lastSnapshot = structuredClone(snapshot);
    if (!snapshotAccountIsCurrent) {
      this.#lastSnapshot.settings.routing.accountRevision = this.#accountRevision;
      this.#lastSnapshot.settings.routing.account = structuredClone(this.#accountState);
    }
    return this.getPublicState();
  }

  async #performApplyAccountState(message) {
    const child = this.#child;
    const epoch = this.#epoch;
    const applied = await this.#sendAndWait(child, message, {
      epoch,
      requestId: message.requestId,
      type: "account-state-applied",
      timeoutMs: this.#ackTimeoutMs,
      timeoutCode: "WORKER_ACK_TIMEOUT"
    });
    if (epoch !== this.#epoch
      || child !== this.#child
      || applied.revision !== message.revision) {
      throw managerError("WORKER_PROTOCOL_INVALID");
    }
    this.#accountRevision = message.revision;
    this.#accountState = structuredClone(message.state);
    if (this.#lastSnapshot?.settings?.routing) {
      this.#lastSnapshot.settings.routing.accountRevision = message.revision;
      this.#lastSnapshot.settings.routing.account = structuredClone(message.state);
    }
    return this.getPublicState();
  }

  async #performStop({ drainTimeoutMs }) {
    const child = this.#child;
    const epoch = this.#epoch;
    this.#expectedEpochs.add(epoch);
    this.#phase = "draining";

    let drained = false;
    let drainFailure = null;
    const requestId = this.#nextRequestId("drain");
    try {
      const message = await this.#sendAndWait(
        child,
        { version: PROTOCOL_VERSION, type: "drain", requestId },
        {
        epoch,
        requestId,
        type: "drained",
        timeoutMs: drainTimeoutMs,
        timeoutCode: "WORKER_ACK_TIMEOUT"
        }
      );
      if (message.state.phase !== "drained"
        || message.state.generation !== this.#generation
        || message.state.listening) {
        throw managerError("WORKER_PROTOCOL_INVALID");
      }
      this.#workerState = publicStateCopy(message.state);
      drained = true;
    } catch (error) {
      if (error?.code === "WORKER_IPC_SEND_FAILED") drainFailure = error;
      // Escalation below owns cleanup after a bounded drain failure.
    }

    let failure = null;
    try {
      if (drained) {
        const shutdownRequestId = this.#nextRequestId("shutdown");
        try {
          await this.#send(child, {
            version: PROTOCOL_VERSION,
            type: "shutdown",
            requestId: shutdownRequestId
          });
          await this.#waitForExit(epoch, this.#terminateTimeoutMs);
        } catch {
          await this.#terminateChild(child, epoch);
        }
      } else {
        await this.#terminateChild(child, epoch);
      }
      await this.#waitForPortFree(this.#host, this.#port);
    } catch (error) {
      const code = error?.code === "WORKER_PORT_BUSY" ? "WORKER_PORT_BUSY" : "WORKER_STOP_FAILED";
      failure = managerError(code);
      this.#lastError = { code: failure.code, message: failure.message };
    } finally {
      if (this.#hasExited(child)) {
        this.#releaseChild(child, epoch);
        this.#workerState = null;
      }
    }

    if (failure) {
      this.#phase = "failed";
      throw failure;
    }
    this.#phase = "stopped";
    if (drainFailure) {
      this.#lastError = { code: drainFailure.code, message: drainFailure.message };
      throw drainFailure;
    }
    return this.getPublicState();
  }

  async #performRestart(snapshot, { drainTimeoutMs }) {
    this.#cancelRecovery();
    if (this.#child && this.#phase !== "stopped") {
      await this.#performStop({ drainTimeoutMs });
      this.#restartCount += 1;
    }
    return this.#performStart(snapshot);
  }

  #validateSnapshot(snapshot) {
    let cloned;
    try {
      cloned = structuredClone(snapshot);
      validateParentMessage({
        version: PROTOCOL_VERSION,
        type: "configure",
        requestId: "snapshot-validation",
        generation: cloned?.generation,
        settings: cloned?.settings
      });
      optionalSnapshotProviderId(cloned);
    } catch {
      throw managerError("WORKER_SNAPSHOT_INVALID");
    }
    if (cloned.settings.server.host !== this.#host || cloned.settings.server.port !== this.#port) {
      throw managerError("WORKER_SNAPSHOT_INVALID");
    }
    return cloned;
  }

  async #terminateChild(child, epoch) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    try {
      await this.#waitForExit(epoch, this.#terminateTimeoutMs);
      return;
    } catch {
      // A stuck worker receives one final bounded escalation.
    }
    child.kill("SIGKILL");
    try {
      await this.#waitForExit(epoch, this.#killTimeoutMs);
    } catch {
      throw managerError("WORKER_STOP_FAILED");
    }
  }

  #hasExited(child) {
    return child.exitCode !== null || child.signalCode !== null;
  }

  #releaseChild(child, epoch) {
    if (this.#child === child) this.#child = null;
    this.#detachChild(epoch);
    this.#exits.delete(epoch);
    this.#expectedEpochs.delete(epoch);
    this.#exitErrors.delete(epoch);
  }

  #attachChild(child, epoch) {
    let resolveExit;
    const exitPromise = new Promise((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    const onMessage = (rawMessage) => {
      if (epoch !== this.#epoch || child !== this.#child) return;
      let message;
      try {
        message = validateChildMessage(rawMessage);
      } catch {
        const error = managerError("WORKER_PROTOCOL_INVALID");
        this.#lastError = { code: error.code, message: error.message };
        this.#rejectWaiters(epoch, error);
        if (this.#phase === "running") {
          this.#exitErrors.set(epoch, this.#lastError);
          void this.#terminateChild(child, epoch).catch(() => {
            if (epoch !== this.#epoch || child !== this.#child) return;
            const stopError = managerError("WORKER_STOP_FAILED");
            this.#lastError = { code: stopError.code, message: stopError.message };
            this.#phase = "failed";
          });
        }
        return;
      }
      if (message.type === "fatal") {
        const error = managerError(message.error.code);
        this.#lastError = { code: error.code, message: error.message };
        for (const waiter of [...this.#waiters]) {
          if (waiter.epoch === epoch
            && (waiter.requestId === message.requestId || message.requestId === "worker-fatal")) {
            waiter.reject(error);
          }
        }
        return;
      }
      if (message.type === "metric") {
        this.#acceptMetric(message.observation);
        return;
      }
      for (const waiter of [...this.#waiters]) {
        if (waiter.epoch === epoch
          && waiter.requestId === message.requestId
          && waiter.type === message.type) {
          waiter.resolve(message);
        }
      }
    };
    const onError = () => {
      this.#rejectWaiters(epoch, managerError("WORKER_START_FAILED"));
    };
    const onExit = (code, signal) => {
      const exit = this.#exits.get(epoch);
      if (exit && !exit.settled) {
        exit.settled = true;
        exit.result = { code, signal };
        resolveExit(exit.result);
      }
      this.#rejectWaiters(epoch, managerError("WORKER_START_FAILED"));
      if (epoch === this.#epoch
        && child === this.#child
        && !this.#expectedEpochs.has(epoch)
        && !this.#closed
        && this.#phase === "running") {
        this.#child = null;
        this.#workerState = null;
        const exitError = this.#exitErrors.get(epoch);
        this.#exitErrors.delete(epoch);
        this.#scheduleRecovery(exitError);
        this.#detachChild(epoch);
        this.#exits.delete(epoch);
      }
    };
    this.#exits.set(epoch, {
      promise: exitPromise,
      settled: false,
      child,
      onMessage,
      onError,
      onExit
    });
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  }

  #detachChild(epoch) {
    const context = this.#exits.get(epoch);
    if (!context) return;
    context.child.off("message", context.onMessage);
    context.child.off("error", context.onError);
    context.child.off("exit", context.onExit);
  }

  #scheduleRecovery(exitError = null) {
    const now = this.#clock.now();
    this.#phase = "crashed";
    this.#lastError = exitError ? { ...exitError } : {
      code: "WORKER_EXITED",
      message: ERROR_MESSAGES.WORKER_EXITED
    };
    this.#crashTimes = this.#crashTimes
      .filter((crashedAt) => now - crashedAt < CRASH_WINDOW_MS);
    this.#crashTimes.push(now);
    if (this.#crashTimes.length >= CRASH_BACKOFF_MS.length) {
      this.#phase = "failed";
      return;
    }

    const delay = CRASH_BACKOFF_MS[this.#crashTimes.length - 1];
    const snapshot = structuredClone(this.#lastSnapshot);
    this.#phase = "backoff";
    this.#restartCount += 1;
    const recoveryVersion = ++this.#recoveryVersion;
    this.#recoveryTimer = this.#clock.setTimeout(() => {
      if (recoveryVersion !== this.#recoveryVersion) return;
      this.#recoveryTimer = null;
      if (!this.#canRecover(recoveryVersion)) return;
      let attemptStarted = false;
      const recovery = Promise.resolve()
        .then(() => this.#waitForPortFree(this.#host, this.#port))
        .then(() => {
          if (!this.#canRecover(recoveryVersion)) return undefined;
          return this.#runRecoveryWhenReady(() => {
            if (!this.#canRecover(recoveryVersion)) return this.getPublicState();
            attemptStarted = true;
            return this.#trackOperation(this.#performStart(snapshot));
          });
        });
      void recovery.catch(() => {
        if (recoveryVersion === this.#recoveryVersion
          && !this.#closed
          && this.#child === null
          && (this.#phase === "backoff" || attemptStarted)) {
          this.#scheduleRecovery();
        }
      });
    }, delay);
  }

  #canRecover(recoveryVersion) {
    return recoveryVersion === this.#recoveryVersion
      && !this.#closed
      && this.#phase === "backoff"
      && this.#child === null;
  }

  #cancelRecovery() {
    this.#recoveryVersion += 1;
    if (this.#recoveryTimer !== null) {
      this.#clock.clearTimeout(this.#recoveryTimer);
      this.#recoveryTimer = null;
    }
  }

  #rememberMetricProvider(generation, providerId) {
    if (!validProviderId(providerId)) return;
    this.#metricProviders.delete(generation);
    this.#metricProviders.set(generation, providerId);
    while (this.#metricProviders.size > MAX_METRIC_GENERATIONS) {
      this.#metricProviders.delete(this.#metricProviders.keys().next().value);
    }
  }

  #acceptMetric(observation) {
    const providerId = observation.route === "account"
      ? CHATGPT_METRICS_PROVIDER_ID
      : this.#metricProviders.get(observation.generation);
    if (!providerId) {
      this.#dropMetric();
      return;
    }
    const { generation: _generation, route: _route, ...fields } = observation;
    try {
      const result = this.#recordMetric({ providerId, ...fields });
      if (result && typeof result.then === "function") {
        void result.then((accepted) => {
          if (accepted === false) this.#dropMetric();
        }, () => this.#dropMetric());
      } else if (result === false) {
        this.#dropMetric();
      }
    } catch {
      this.#dropMetric();
    }
  }

  #dropMetric() {
    try {
      this.#noteDroppedMetric();
    } catch {
      // Metrics degradation must remain outside worker lifecycle state.
    }
  }

  #waitForExit(epoch, timeoutMs) {
    const exit = this.#exits.get(epoch);
    if (!exit) return Promise.reject(managerError("WORKER_STOP_FAILED"));
    if (exit.settled) return Promise.resolve(exit.result);
    return this.#withTimeout(exit.promise, timeoutMs, "WORKER_EXIT_TIMEOUT");
  }

  #waitForMessage({ epoch, requestId, type, timeoutMs, timeoutCode }) {
    return this.#registerMessageWaiter({
      epoch,
      requestId,
      type,
      timeoutMs,
      timeoutCode
    }).promise;
  }

  #registerMessageWaiter({ epoch, requestId, type, timeoutMs, timeoutCode }) {
    const waiter = {
      epoch,
      requestId,
      type,
      timer: null,
      settled: false,
      resolve: null,
      reject: null
    };
    const promise = new Promise((resolvePromise, rejectPromise) => {
      const settle = (callback, value) => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.#waiters.delete(waiter);
        this.#clock.clearTimeout(waiter.timer);
        callback(value);
      };
      waiter.resolve = (value) => settle(resolvePromise, value);
      waiter.reject = (error) => settle(rejectPromise, error);
    });
    waiter.timer = this.#clock.setTimeout(
      () => waiter.reject(managerError(timeoutCode)),
      timeoutMs
    );
    this.#waiters.add(waiter);
    return {
      promise,
      cancel: (error) => waiter.reject(error)
    };
  }

  async #sendAndWait(child, message, waitFor) {
    const waiter = this.#registerMessageWaiter(waitFor);
    const observed = waiter.promise.then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    try {
      await this.#send(child, message);
    } catch (error) {
      waiter.cancel(error);
      await observed;
      throw error;
    }
    const result = await observed;
    if (result.error) throw result.error;
    return result.value;
  }

  #rejectWaiters(epoch, error) {
    for (const waiter of [...this.#waiters]) {
      if (waiter.epoch !== epoch) continue;
      waiter.reject(error);
    }
  }

  #send(child, message) {
    validateParentMessage(message);
    return new Promise((resolvePromise, rejectPromise) => {
      if (!child.connected) {
        rejectPromise(managerError("WORKER_IPC_SEND_FAILED"));
        return;
      }
      child.send(message, (error) => {
        if (error) rejectPromise(managerError("WORKER_IPC_SEND_FAILED"));
        else resolvePromise();
      });
    });
  }

  async #verifyHealth(generation) {
    const healthPromise = Promise.resolve()
      .then(() => this.#fetch(`http://${this.#host}:${this.#port}/_proxy/health`))
      .then(async (response) => {
        if (!response?.ok) throw managerError("WORKER_HEALTH_FAILED");
        const health = await response.json();
        if (health?.configured !== true || health?.generation !== generation) {
          throw managerError("WORKER_HEALTH_FAILED");
        }
      });
    await this.#withTimeout(healthPromise, this.#healthTimeoutMs, "WORKER_HEALTH_FAILED");
  }

  #withTimeout(promise, timeoutMs, code) {
    let timer;
    const timeout = new Promise((_, rejectPromise) => {
      timer = this.#clock.setTimeout(() => rejectPromise(managerError(code)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => this.#clock.clearTimeout(timer));
  }

  #nextRequestId(prefix) {
    this.#requestSequence += 1;
    return `${prefix}-${this.#requestSequence}`;
  }

  #trackOperation(operation) {
    this.#operation = operation;
    void operation.then(
      () => {
        if (this.#operation === operation) this.#operation = null;
      },
      () => {
        if (this.#operation === operation) this.#operation = null;
      }
    );
    return operation;
  }
}
