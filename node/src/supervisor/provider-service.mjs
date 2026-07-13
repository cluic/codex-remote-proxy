import { randomUUID } from "node:crypto";

import { toPublicProvider } from "../providers/provider-schema.mjs";
import { CrpError } from "../shared/errors.mjs";

function serviceError(code, { status = 500, cause, details = {} } = {}) {
  const contracts = {
    PROVIDER_SECRET_INVALID: [
      "The provider credential is invalid.",
      "Enter a non-empty provider credential and try again."
    ],
    PROVIDER_ACTIVE: [
      "The active provider cannot be deleted.",
      "Activate another provider or stop the proxy first."
    ],
    PROVIDER_CREATE_FAILED: [
      "The provider could not be created.",
      "Review the provider settings and try again."
    ],
    PROVIDER_CREATE_ROLLBACK_DEGRADED: [
      "Provider creation failed and its credential could not be removed safely.",
      "Stop CRP and repair the credential entry before retrying."
    ],
    PROVIDER_CREATE_COMMITTED_DEGRADED: [
      "The provider was created, but its persistence cleanup degraded.",
      "Stop CRP and repair the residual provider state before restarting."
    ],
    PROVIDER_UPDATE_ROLLBACK_DEGRADED: [
      "Provider update failed and its prior credential could not be restored safely.",
      "Stop CRP and repair the provider credential before retrying."
    ],
    PROVIDER_UPDATE_COMMITTED_DEGRADED: [
      "The provider update was saved, but its persistence cleanup degraded.",
      "Stop CRP and repair the residual provider state before restarting."
    ],
    PROVIDER_DELETE_FAILED: [
      "The provider could not be deleted.",
      "Review Activity and try again."
    ],
    PROVIDER_DELETE_ROLLBACK_DEGRADED: [
      "Provider deletion failed and its credential could not be restored safely.",
      "Stop CRP and repair the provider credential before retrying."
    ],
    PROVIDER_DELETE_COMMITTED_DEGRADED: [
      "The provider was deleted, but its persistence cleanup degraded.",
      "Stop CRP and repair the residual provider state before restarting."
    ],
    PROVIDER_TEST_INPUT_INVALID: [
      "The provider test model is invalid.",
      "Enter a non-empty model name and try again."
    ],
    PROVIDER_NOT_READY: [
      "The provider has not passed its compatibility test.",
      "Test the provider successfully before activating it."
    ],
    PROVIDER_ACTIVATION_FAILED: [
      "The provider could not be activated.",
      "Review worker health and try the activation again."
    ],
    PROVIDER_ACTIVATION_ROLLBACK_DEGRADED: [
      "Provider activation failed and the prior active provider could not be restored safely.",
      "Stop CRP and repair the active-provider state before restarting."
    ],
    PROVIDER_ACTIVATION_COMMITTED_DEGRADED: [
      "The provider was activated, but its persistence cleanup degraded.",
      "Stop CRP and repair the residual active-provider state before restarting."
    ],
    PROXY_NOT_CONFIGURED: [
      "No active provider is configured for the proxy.",
      "Test and activate a provider before starting the proxy."
    ],
    PROXY_START_FAILED: [
      "The proxy worker could not be started.",
      "Review worker health and try again."
    ],
    PROXY_STOP_FAILED: [
      "The proxy worker could not be stopped.",
      "Review worker health and try again."
    ],
    PROXY_RESTART_FAILED: [
      "The proxy worker could not be restarted.",
      "Review worker health and try again."
    ]
  };
  const [message, action] = contracts[code] ?? [
    "The provider operation failed.",
    "Review Activity and try again."
  ];
  return new CrpError(code, message, action, { status, cause, details });
}

function assertSecret(secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw serviceError("PROVIDER_SECRET_INVALID", { status: 400 });
  }
}

function isCommittedError(error) {
  return error instanceof CrpError && error.details?.committed === true;
}

function committedServiceError(action, cause) {
  return serviceError(`PROVIDER_${action.toUpperCase()}_COMMITTED_DEGRADED`, {
    cause,
    details: { committed: true, degraded: true }
  });
}

export class ProviderService {
  #operationTail = Promise.resolve();
  #lifecycleOperation = null;

  constructor({
    registry,
    credentialStore,
    activityStore,
    workerManager,
    createCredentialRef = randomUUID,
    now = () => new Date().toISOString(),
    ...options
  }) {
    if (!registry || !credentialStore || !activityStore || !workerManager) {
      throw new TypeError("ProviderService dependencies are required.");
    }
    this.registry = registry;
    this.credentialStore = credentialStore;
    this.activityStore = activityStore;
    this.workerManager = workerManager;
    this.createCredentialRef = createCredentialRef;
    this.now = now;
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.createTimeoutSignal = options.createTimeoutSignal
      ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));
    this.testTimeoutMs = options.testTimeoutMs ?? 15_000;
    this.verifyWorkerHealth = options.verifyWorkerHealth ?? (async (generation, state) => (
      state?.phase === "running" && state?.generation === generation
    ));
    this.paths = options.paths ?? {};
    const workerGeneration = workerManager.getPublicState()?.generation;
    this.confirmedGeneration = Number.isSafeInteger(workerGeneration) && workerGeneration >= 0
      ? workerGeneration
      : 0;
    this.confirmedSnapshot = options.initialSnapshot
      ? structuredClone(options.initialSnapshot)
      : null;
  }

  async listProviders() {
    const profiles = this.registry.list();
    return await Promise.all(profiles.map((profile) => this.#toPublic(profile)));
  }

  createProvider(input, secret, { fallbackConsent = false } = {}) {
    return this.#runExclusive(async () => {
      let credentialRef = null;
      let credentialWritten = false;
      let credentialCommitWarning = null;
      let profile;
      try {
        assertSecret(secret);
        credentialRef = this.createCredentialRef();
        try {
          await this.credentialStore.set(credentialRef, secret, { fallbackConsent });
          credentialWritten = true;
        } catch (error) {
          if (isCommittedError(error)) {
            credentialWritten = true;
            credentialCommitWarning = error;
          } else {
            throw error;
          }
        }
        profile = this.registry.create({ ...input, credentialRef });
      } catch (error) {
        if (isCommittedError(error)) {
          profile = this.registry.list().find((candidate) => (
            candidate.credentialRef === credentialRef
          ));
          if (profile) {
            const committed = committedServiceError("create", error);
            await this.#recordCommitted("create", profile.id, committed);
            throw committed;
          }
          const degraded = serviceError("PROVIDER_CREATE_ROLLBACK_DEGRADED", {
            cause: error,
            details: { committed: false, degraded: true }
          });
          await this.#safeRecordFailure("create", null, degraded);
          throw degraded;
        }
        let failure = error;
        if (credentialWritten) {
          try {
            await this.credentialStore.delete(credentialRef);
          } catch (rollbackError) {
            failure = serviceError("PROVIDER_CREATE_ROLLBACK_DEGRADED", {
              cause: rollbackError,
              details: { committed: false, degraded: true }
            });
          }
        }
        if (!(failure instanceof CrpError)) {
          failure = serviceError("PROVIDER_CREATE_FAILED", { cause: failure });
        }
        await this.#safeRecordFailure("create", null, failure);
        throw failure;
      }
      if (credentialCommitWarning) {
        const committed = committedServiceError("create", credentialCommitWarning);
        await this.#recordCommitted("create", profile.id, committed);
        throw committed;
      }
      const publicProfile = toPublicProvider(profile, true);
      await this.#record("create", profile.id, "success", null, {});
      return publicProfile;
    });
  }

  updateProvider(id, patch, replacementSecret) {
    return this.#runExclusive(async () => {
      let profile;
      let safeId = null;
      try {
        const current = this.registry.get(id);
        safeId = current.id;
        if (this.registry.getDocument().activeProviderId === current.id) {
          throw serviceError("PROVIDER_ACTIVE", { status: 409 });
        }
        if (replacementSecret !== undefined) assertSecret(replacementSecret);
        profile = replacementSecret === undefined
          ? this.registry.update(id, patch)
          : await this.#updateWithReplacementSecret(current, patch, replacementSecret);
      } catch (error) {
        if (isCommittedError(error)) {
          const committed = committedServiceError("update", error);
          await this.#recordCommitted("update", safeId, committed);
          throw committed;
        }
        await this.#safeRecordFailure("update", safeId, error);
        throw error;
      }
      const publicProfile = await this.#toPublic(profile);
      await this.#record(
        "update",
        profile.id,
        "success",
        null,
        replacementSecret === undefined ? {} : { credentialReplaced: true }
      );
      return publicProfile;
    });
  }

  deleteProvider(id) {
    return this.#runExclusive(async () => {
      let profile;
      let oldSecret;
      let deleted;
      let credentialDeleted = false;
      let credentialCommitWarning = null;
      try {
        const document = this.registry.getDocument();
        if (document.activeProviderId === id) {
          throw serviceError("PROVIDER_ACTIVE", { status: 409 });
        }
        profile = this.registry.get(id);
        oldSecret = await this.credentialStore.get(profile.credentialRef);
        try {
          credentialDeleted = await this.credentialStore.delete(profile.credentialRef);
        } catch (error) {
          if (isCommittedError(error)) {
            credentialDeleted = true;
            credentialCommitWarning = error;
          } else {
            throw error;
          }
        }
        if (!credentialDeleted) throw serviceError("PROVIDER_DELETE_FAILED");
        deleted = this.registry.delete(id);
      } catch (error) {
        if (isCommittedError(error)) {
          const committed = committedServiceError("delete", error);
          await this.#recordCommitted("delete", profile?.id ?? id, committed);
          throw committed;
        }
        if (credentialCommitWarning) {
          const degraded = serviceError("PROVIDER_DELETE_ROLLBACK_DEGRADED", {
            cause: error,
            details: { committed: false, degraded: true }
          });
          await this.#safeRecordFailure("delete", profile?.id ?? id, degraded);
          throw degraded;
        }
        let failure = error;
        if (credentialDeleted) {
          try {
            await this.credentialStore.set(profile.credentialRef, oldSecret);
          } catch (rollbackError) {
            failure = serviceError("PROVIDER_DELETE_ROLLBACK_DEGRADED", {
              cause: rollbackError,
              details: { committed: false, degraded: true }
            });
          }
        }
        if (!(failure instanceof CrpError)) {
          failure = serviceError("PROVIDER_DELETE_FAILED", { cause: failure });
        }
        await this.#safeRecordFailure("delete", profile?.id ?? null, failure);
        throw failure;
      }
      if (credentialCommitWarning) {
        const committed = committedServiceError("delete", credentialCommitWarning);
        await this.#recordCommitted("delete", deleted.id, committed);
        throw committed;
      }
      await this.#record("delete", deleted.id, "success", null, {});
      return toPublicProvider(deleted, false);
    });
  }

  testProvider(id, model) {
    return this.#runExclusive(async () => {
      if (typeof model !== "string" || model.trim().length === 0) {
        throw serviceError("PROVIDER_TEST_INPUT_INVALID", { status: 400 });
      }
      const profile = this.registry.get(id);
      const secret = await this.credentialStore.get(profile.credentialRef);
      let result;
      let status = null;
      try {
        const base = profile.baseUrl.endsWith("/") ? profile.baseUrl : `${profile.baseUrl}/`;
        const response = await this.fetchImpl(new URL("responses", base).toString(), {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            ...profile.extraHeaders,
            [profile.authHeader]: profile.authScheme
              ? `${profile.authScheme} ${secret}`
              : secret
          },
          body: JSON.stringify({
            model: model.trim(),
            stream: false,
            input: "Reply with OK."
          }),
          signal: this.createTimeoutSignal(this.testTimeoutMs)
        });
        status = Number.isInteger(response?.status) ? response.status : null;
        if (!response?.ok) {
          result = { ok: false, code: classifyHttpStatus(status) };
        } else {
          let payload;
          try {
            payload = await response.json();
          } catch {
            result = { ok: false, code: "PROVIDER_TEST_INVALID_JSON" };
          }
          if (!result) {
            result = isCompatibleResponsesPayload(payload)
              ? { ok: true, code: null }
              : { ok: false, code: "PROVIDER_TEST_INVALID_RESPONSES" };
          }
        }
      } catch (error) {
        result = { ok: false, code: classifyFetchError(error) };
      }

      this.registry.markTest(id, result.ok
        ? { status: "passed" }
        : { status: "failed", code: result.code });
      await this.#record(
        "test",
        id,
        result.ok ? "success" : "failed",
        result.code,
        status === null ? {} : { httpStatus: status }
      );
      return result;
    });
  }

  activate(id) {
    return this.#runExclusive(async () => {
      const profile = this.registry.get(id);
      if (profile.lastTestStatus !== "passed") {
        await this.#record(
          "activate",
          id,
          "failed",
          "PROVIDER_NOT_READY",
          {}
        );
        throw serviceError("PROVIDER_NOT_READY", { status: 409 });
      }
      const secret = await this.credentialStore.get(profile.credentialRef);
      const previousId = this.registry.getDocument().activeProviderId;
      const generation = this.confirmedGeneration + 1;
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw serviceError("PROVIDER_ACTIVATION_FAILED");
      }
      const snapshot = this.#buildSnapshot(profile, secret, generation);
      let activePersisted = false;
      let workerAttempted = false;
      let activeCommitWarning = null;
      let activationCompleted = false;
      try {
        try {
          this.registry.setActive(id);
          activePersisted = true;
        } catch (error) {
          if (isCommittedError(error)
            && this.registry.getDocument().activeProviderId === id) {
            activePersisted = true;
            activeCommitWarning = error;
          } else {
            throw error;
          }
        }
        const before = this.workerManager.getPublicState();
        workerAttempted = true;
        const workerState = before.phase === "running"
          ? await this.workerManager.applySnapshot(snapshot)
          : await this.workerManager.start(snapshot);
        if (!isConfirmedWorkerState(workerState, generation)) {
          throw new Error("worker generation was not confirmed");
        }
        const healthy = await this.verifyWorkerHealth(generation, workerState);
        if (healthy !== true) throw new Error("worker health was not confirmed");
        this.confirmedGeneration = generation;
        this.confirmedSnapshot = structuredClone(snapshot);
        if (activeCommitWarning) {
          const committed = committedServiceError("activation", activeCommitWarning);
          await this.#recordCommitted("activate", id, committed, { generation });
          activationCompleted = true;
          throw committed;
        }
        await this.#record("activate", id, "success", null, { generation });
        return {
          activeProviderId: id,
          activeProvider: toPublicProvider(profile, true),
          generation,
          worker: publicWorkerState(workerState)
        };
      } catch (error) {
        if (activationCompleted && isCommittedError(error)) throw error;
        let rollbackFailure = null;
        if (activePersisted) {
          try {
            this.registry.setActive(previousId);
          } catch (rollbackError) {
            rollbackFailure = rollbackError;
          }
        }
        if (workerAttempted) {
          try {
            if (this.confirmedSnapshot) {
              const observedGeneration = this.workerManager.getPublicState()?.generation;
              const rollbackGeneration = Math.max(
                generation,
                this.confirmedGeneration,
                Number.isSafeInteger(observedGeneration) ? observedGeneration : 0
              ) + 1;
              if (!Number.isSafeInteger(rollbackGeneration)) {
                throw new Error("worker rollback generation is invalid");
              }
              const rollbackSnapshot = structuredClone(this.confirmedSnapshot);
              rollbackSnapshot.generation = rollbackGeneration;
              const rollbackState = this.workerManager.getPublicState();
              const restored = rollbackState?.phase === "running"
                ? await this.workerManager.applySnapshot(rollbackSnapshot)
                : await this.workerManager.restart(rollbackSnapshot);
              if (!isConfirmedWorkerState(restored, rollbackGeneration)) {
                throw new Error("worker rollback was not confirmed");
              }
              const rollbackHealthy = await this.verifyWorkerHealth(
                rollbackGeneration,
                restored
              );
              if (rollbackHealthy !== true) {
                throw new Error("worker rollback health was not confirmed");
              }
              this.confirmedGeneration = rollbackGeneration;
              this.confirmedSnapshot = structuredClone(rollbackSnapshot);
            } else {
              const stopped = await this.workerManager.stop();
              if (stopped?.phase !== "stopped") {
                throw new Error("unconfirmed worker did not stop");
              }
            }
          } catch (workerRollbackError) {
            rollbackFailure ??= workerRollbackError;
          }
        }
        if (rollbackFailure) {
          const degraded = serviceError("PROVIDER_ACTIVATION_ROLLBACK_DEGRADED", {
            cause: rollbackFailure,
            details: { committed: false, degraded: true }
          });
          await this.#safeRecordFailure("activate", id, degraded, { generation });
          throw degraded;
        }
        await this.#safeRecordFailure("activate", id, error, { generation });
        throw serviceError("PROVIDER_ACTIVATION_FAILED", { cause: error });
      }
    });
  }

  startProxy() {
    return this.#runLifecycleOperation(async () => {
      const current = this.workerManager.getPublicState();
      if (current?.phase === "running") {
        const worker = publicWorkerState(current);
        await this.#recordProxy("start", "success", null, { alreadyRunning: true });
        return worker;
      }
      return await this.#startOrRestartProxy("start");
    });
  }

  stopProxy() {
    return this.#runLifecycleOperation(async () => {
      try {
        const state = await this.workerManager.stop();
        const worker = publicWorkerState(state);
        await this.#recordProxy("stop", "success", null, {});
        return worker;
      } catch (error) {
        const failure = serviceError("PROXY_STOP_FAILED", { cause: error });
        await this.#safeRecordProxyFailure("stop", failure);
        throw failure;
      }
    });
  }

  restartProxy() {
    return this.#runLifecycleOperation(() => this.#startOrRestartProxy("restart"));
  }

  async getStatus() {
    const document = this.registry.getDocument();
    const activeProfile = document.activeProviderId === null
      ? null
      : document.providers.find((profile) => profile.id === document.activeProviderId) ?? null;
    return {
      activeProviderId: document.activeProviderId,
      activeProvider: activeProfile === null ? null : await this.#toPublic(activeProfile),
      generation: this.confirmedGeneration,
      worker: publicWorkerState(this.workerManager.getPublicState())
    };
  }

  async #updateWithReplacementSecret(current, patch, replacementSecret) {
    const oldSecret = await this.credentialStore.get(current.credentialRef);
    let replacementWritten = false;
    let replacementCommitWarning = null;
    let testReset = false;
    try {
      try {
        await this.credentialStore.set(current.credentialRef, replacementSecret);
        replacementWritten = true;
      } catch (error) {
        if (isCommittedError(error)) {
          replacementWritten = true;
          replacementCommitWarning = error;
        } else {
          throw error;
        }
      }
      this.registry.markTest(current.id, { status: "untested" });
      testReset = true;
      this.registry.update(current.id, patch);
      if (replacementCommitWarning) throw replacementCommitWarning;
      return this.registry.get(current.id);
    } catch (error) {
      if (isCommittedError(error)) throw error;
      let rollbackFailure = null;
      let credentialRestored = false;
      if (replacementWritten) {
        try {
          await this.credentialStore.set(current.credentialRef, oldSecret);
          credentialRestored = true;
        } catch (rollbackError) {
          rollbackFailure = rollbackError;
        }
      }
      if (testReset && credentialRestored) {
        try {
          this.registry.markTest(current.id, {
            status: current.lastTestStatus,
            code: current.lastTestCode
          });
        } catch (rollbackError) {
          rollbackFailure ??= rollbackError;
        }
      }
      if (rollbackFailure) {
        throw serviceError("PROVIDER_UPDATE_ROLLBACK_DEGRADED", {
          cause: rollbackFailure,
          details: { committed: false, degraded: true }
        });
      }
      throw error;
    }
  }

  async #toPublic(profile) {
    const configured = await this.credentialStore.has(profile.credentialRef);
    return toPublicProvider(profile, configured);
  }

  async #startOrRestartProxy(action) {
    let workerAttempted = false;
    let generation = null;
    try {
      const document = this.registry.getDocument();
      if (document.activeProviderId === null) {
        throw serviceError("PROXY_NOT_CONFIGURED", { status: 409 });
      }
      const profile = document.providers.find(({ id }) => id === document.activeProviderId);
      if (!profile || profile.lastTestStatus !== "passed") {
        throw serviceError("PROXY_NOT_CONFIGURED", { status: 409 });
      }
      const secret = await this.credentialStore.get(profile.credentialRef);
      const observedGeneration = this.workerManager.getPublicState()?.generation;
      generation = Math.max(
        this.confirmedGeneration,
        Number.isSafeInteger(observedGeneration) ? observedGeneration : 0
      ) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error("proxy generation is invalid");
      const snapshot = this.#buildSnapshot(profile, secret, generation);
      workerAttempted = true;
      const state = action === "restart"
        ? await this.workerManager.restart(snapshot)
        : await this.workerManager.start(snapshot);
      if (!isConfirmedWorkerState(state, generation)) {
        throw new Error("worker generation was not confirmed");
      }
      if (await this.verifyWorkerHealth(generation, state) !== true) {
        throw new Error("worker health was not confirmed");
      }
      this.confirmedGeneration = generation;
      this.confirmedSnapshot = structuredClone(snapshot);
      const worker = publicWorkerState(state);
      await this.#recordProxy(action, "success", null, { generation });
      return worker;
    } catch (error) {
      if (error instanceof CrpError && error.code === "PROXY_NOT_CONFIGURED") {
        await this.#safeRecordProxyFailure(action, error);
        throw error;
      }
      let cleanupFailure = null;
      if (workerAttempted) {
        try {
          await this.workerManager.stop();
        } catch (caught) {
          cleanupFailure = caught;
        }
      }
      const code = action === "restart" ? "PROXY_RESTART_FAILED" : "PROXY_START_FAILED";
      const failure = serviceError(code, {
        cause: cleanupFailure ?? error,
        details: cleanupFailure ? { degraded: true } : {}
      });
      await this.#safeRecordProxyFailure(action, failure, generation === null ? {} : { generation });
      throw failure;
    }
  }

  #buildSnapshot(profile, secret, generation) {
    const document = this.registry.getDocument();
    const runtimeConfigPath = this.paths.runtimeConfigPath;
    const capturePath = this.paths.capturePath;
    if (typeof runtimeConfigPath !== "string" || runtimeConfigPath.length === 0
      || typeof capturePath !== "string" || capturePath.length === 0) {
      throw serviceError("PROVIDER_ACTIVATION_FAILED");
    }
    return {
      generation,
      settings: {
        configPath: runtimeConfigPath,
        server: {
          host: document.settings.proxyHost,
          port: document.settings.proxyPort,
          logLevel: "info"
        },
        upstream: {
          baseUrl: profile.baseUrl,
          apiKey: secret,
          timeoutMs: 300_000,
          verifySsl: true,
          authHeader: profile.authHeader,
          authScheme: profile.authScheme,
          extraHeaders: { ...profile.extraHeaders }
        },
        proxy: {
          overrideAuthorization: true,
          requestIdHeader: "x-client-request-id"
        },
        capture: {
          enabled: document.settings.captureEnabled,
          dbPath: capturePath
        }
      }
    };
  }

  async #record(action, providerId, result, errorCode, details) {
    await this.activityStore.append({
      category: "provider",
      action,
      providerId,
      result,
      errorCode,
      details
    });
  }

  async #recordProxy(action, result, errorCode, details) {
    await this.activityStore.append({
      category: "proxy",
      action,
      providerId: null,
      result,
      errorCode,
      details
    });
  }

  async #safeRecordProxyFailure(action, error, details = {}) {
    try {
      await this.#recordProxy(
        action,
        "failed",
        stableErrorCode(error, `PROXY_${action.toUpperCase()}_FAILED`),
        details
      );
    } catch {
      // Preserve the lifecycle error when the audit store is unavailable.
    }
  }

  async #safeRecordFailure(action, providerId, error, details = {}) {
    const errorCode = stableErrorCode(error, `PROVIDER_${action.toUpperCase()}_FAILED`);
    try {
      await this.#record(action, providerId, "failed", errorCode, details);
    } catch {
      // Preserve the operation error when the audit store is also unavailable.
    }
  }

  async #recordCommitted(action, providerId, error, details = {}) {
    await this.#record(action, providerId, "degraded", error.code, details);
  }

  #runLifecycleOperation(operation) {
    if (this.#lifecycleOperation) return this.#lifecycleOperation;
    const run = this.#runExclusive(operation);
    this.#lifecycleOperation = run;
    const clear = () => {
      if (this.#lifecycleOperation === run) this.#lifecycleOperation = null;
    };
    void run.then(clear, clear);
    return run;
  }

  #runExclusive(operation) {
    const run = this.#operationTail.then(operation, operation);
    this.#operationTail = run.catch(() => {});
    return run;
  }
}

function isCompatibleResponsesPayload(payload) {
  return payload !== null
    && typeof payload === "object"
    && !Array.isArray(payload)
    && typeof payload.id === "string"
    && payload.id.length > 0
    && payload.object === "response"
    && Array.isArray(payload.output);
}

function classifyHttpStatus(status) {
  if (status >= 300 && status <= 399) return "PROVIDER_TEST_REDIRECT";
  if (status === 401 || status === 403) return "PROVIDER_TEST_AUTH";
  if (status === 404) return "PROVIDER_TEST_NOT_FOUND";
  return "PROVIDER_TEST_HTTP";
}

function collectErrorCodes(error) {
  const codes = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === "string") codes.push(current.code.toUpperCase());
    current = current.cause;
  }
  return codes;
}

function classifyFetchError(error) {
  const codes = collectErrorCodes(error);
  if (error?.name === "AbortError" || error?.name === "TimeoutError"
    || codes.includes("ETIMEDOUT") || codes.includes("UND_ERR_CONNECT_TIMEOUT")) {
    return "PROVIDER_TEST_TIMEOUT";
  }
  if (codes.includes("ENOTFOUND") || codes.includes("EAI_AGAIN")) {
    return "PROVIDER_TEST_DNS";
  }
  if (codes.some((code) => code.startsWith("CERT_")
    || code.startsWith("ERR_TLS_")
    || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")) {
    return "PROVIDER_TEST_TLS";
  }
  return "PROVIDER_TEST_NETWORK";
}

function stableErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code)
    ? error.code
    : fallback;
}

function isConfirmedWorkerState(state, generation) {
  return state !== null
    && typeof state === "object"
    && state.phase === "running"
    && state.generation === generation
    && state.state !== null
    && typeof state.state === "object"
    && state.state.phase === "running"
    && state.state.configured === true
    && state.state.generation === generation
    && state.state.listening === true;
}

function publicWorkerState(state) {
  if (state === null || typeof state !== "object") return null;
  const nested = state.state === null || typeof state.state !== "object"
    ? null
    : {
      phase: state.state.phase,
      configured: state.state.configured,
      generation: state.state.generation,
      listening: state.state.listening,
      listenHost: state.state.listenHost,
      listenPort: state.state.listenPort,
      inFlight: state.state.inFlight
    };
  const error = state.error === null || typeof state.error !== "object"
    ? null
    : { code: state.error.code, message: state.error.message };
  return {
    phase: state.phase,
    pid: state.pid,
    generation: state.generation,
    state: nested,
    restartCount: state.restartCount,
    startedAt: state.startedAt,
    error
  };
}
