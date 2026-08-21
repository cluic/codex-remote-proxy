import test from "node:test";
import assert from "node:assert/strict";

import {
  PROTOCOL_VERSION,
  createFatalMessage,
  sanitizeProtocolMessage,
  validateChildMessage,
  validateParentMessage
} from "../src/worker/protocol.mjs";

function makeSettings() {
  const upstream = {
    baseUrl: "http://127.0.0.1:41001",
    apiKey: "protocol-test-secret",
    timeoutMs: 5000,
    verifySsl: true,
    authHeader: "x-provider-auth",
    authScheme: "Bearer",
    extraHeaders: {
      "x-region": "test"
    }
  };
  const proxy = {
    overrideAuthorization: true,
    requestIdHeader: "x-client-request-id",
    modelMode: "passthrough",
    modelOverride: null,
    modelMappings: []
  };
  return {
    configPath: "/tmp/crp-worker/proxy-config.json",
    server: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "info"
    },
    providers: [{ id: "provider-1", name: "Primary", weight: 100, upstream, proxy }],
    upstream,
    proxy,
    capture: {
      enabled: false,
      dbPath: "/tmp/crp-worker/traffic.sqlite3"
    },
    routing: {
      mode: "custom_only",
      accountRevision: 1,
      account: {
        authMode: null,
        quotaStatus: "unknown",
        blockedUntil: null,
        updatedAt: null
      }
    }
  };
}

function makeState(overrides = {}) {
  return {
    phase: "running",
    configured: true,
    generation: 1,
    listening: true,
    listenHost: "127.0.0.1",
    listenPort: 15100,
    inFlight: 0,
    ...overrides
  };
}

test("parent protocol accepts exact configure, account state, drain, shutdown, and status messages", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  const messages = [
    {
      version: 1,
      type: "configure",
      requestId: "configure-1",
      generation: 1,
      settings: makeSettings()
    },
    {
      version: 1,
      type: "account-state",
      requestId: "account-state-1",
      revision: 2,
      state: {
        authMode: "chatgpt",
        quotaStatus: "available",
        blockedUntil: null,
        updatedAt: "2026-08-20T00:00:00.000Z"
      }
    },
    { version: 1, type: "drain", requestId: "drain-1" },
    { version: 1, type: "shutdown", requestId: "shutdown-1" },
    { version: 1, type: "status", requestId: "status-1" }
  ];

  for (const message of messages) {
    assert.deepEqual(validateParentMessage(message), message);
  }
});

test("parent protocol rejects unknown, malformed, and secret-bearing non-configure messages", () => {
  const invalidMessages = [
    null,
    [],
    { version: 2, type: "status", requestId: "status-1" },
    { version: 1, type: "unknown", requestId: "unknown-1" },
    { version: 1, type: "status", requestId: "" },
    { version: 1, type: "status", requestId: "contains spaces" },
    { version: 1, type: "status", requestId: "status-1", extra: true },
    { version: 1, type: "drain", requestId: "drain-1", apiKey: "must-not-pass" },
    { version: 1, type: "configure", requestId: "configure-1", generation: 0, settings: makeSettings() },
    { version: 1, type: "configure", requestId: "configure-1", generation: 1 },
    { version: 1, type: "configure", requestId: "configure-1", generation: 1, settings: [] }
  ];

  for (const message of invalidMessages) {
    assert.throws(
      () => validateParentMessage(message),
      (error) => error?.code === "WORKER_PROTOCOL_INVALID"
        && !String(error.message).includes("must-not-pass")
    );
  }
});

test("configure rejects incomplete, extra, and invalid runtime settings before worker startup", () => {
  const missingServer = makeSettings();
  delete missingServer.server;
  const extraRootField = { ...makeSettings(), credentialRef: "must-not-pass" };
  const extraNestedField = makeSettings();
  extraNestedField.upstream.secret = "must-not-pass";
  const invalidPort = makeSettings();
  invalidPort.server.port = -1;
  const invalidTimeout = makeSettings();
  invalidTimeout.upstream.timeoutMs = Number.POSITIVE_INFINITY;
  const emptyApiKey = makeSettings();
  emptyApiKey.upstream.apiKey = "";
  const invalidExtraHeaders = makeSettings();
  invalidExtraHeaders.upstream.extraHeaders = { "x-region": 123 };
  const invalidModelMode = makeSettings();
  invalidModelMode.proxy.modelMode = "automatic";
  const missingModelOverride = makeSettings();
  missingModelOverride.proxy.modelMode = "override";
  const blankModelOverride = makeSettings();
  blankModelOverride.proxy.modelMode = "override";
  blankModelOverride.proxy.modelOverride = " ";
  const controlModelOverride = makeSettings();
  controlModelOverride.proxy.modelMode = "override";
  controlModelOverride.proxy.modelOverride = "model\ninvalid";
  const duplicateModelMappings = makeSettings();
  duplicateModelMappings.proxy.modelMappings = [
    { sourceModel: "gpt-5", targetModel: "provider/gpt-5" },
    { sourceModel: "gpt-5", targetModel: "provider/gpt-5-alt" }
  ];
  const overrideWithMappings = makeSettings();
  overrideWithMappings.proxy.modelMode = "override";
  overrideWithMappings.proxy.modelOverride = "fixed-model";
  overrideWithMappings.proxy.modelMappings = [
    { sourceModel: "gpt-5", targetModel: "provider/gpt-5" }
  ];
  const invalidRoutingMode = makeSettings();
  invalidRoutingMode.routing.mode = "automatic";
  const invalidAccountState = makeSettings();
  invalidAccountState.routing.account.authMode = "unknown-mode";

  for (const settings of [
    missingServer,
    extraRootField,
    extraNestedField,
    invalidPort,
    invalidTimeout,
    emptyApiKey,
    invalidExtraHeaders,
    invalidModelMode,
    invalidRoutingMode,
    invalidAccountState,
    missingModelOverride,
    blankModelOverride,
    duplicateModelMappings,
    overrideWithMappings
  ]) {
    assert.throws(
      () => validateParentMessage({
        version: 1,
        type: "configure",
        requestId: "configure-invalid",
        generation: 1,
        settings
      }),
      (error) => error?.code === "WORKER_PROTOCOL_INVALID"
        && !String(error.message).includes("must-not-pass")
    );
  }

  assert.doesNotThrow(() => validateParentMessage({
    version: 1,
    type: "configure",
    requestId: "configure-legacy-model",
    generation: 1,
    settings: controlModelOverride
  }));
  const mapped = makeSettings();
  mapped.proxy.modelMappings = [
    { sourceModel: "gpt-5", targetModel: "openai/gpt-5" }
  ];
  assert.doesNotThrow(() => validateParentMessage({
    version: 1,
    type: "configure",
    requestId: "configure-mapping",
    generation: 2,
    settings: mapped
  }));
});

test("configure enforces provider URL and header security contracts", () => {
  for (const baseUrl of [
    "https://api.example.com/v1",
    "http://localhost:41001/v1",
    "http://127.42.0.9:41001/v1",
    "http://[::1]:41001/v1"
  ]) {
    const settings = makeSettings();
    settings.upstream.baseUrl = baseUrl;
    assert.doesNotThrow(() => validateParentMessage({
      version: 1,
      type: "configure",
      requestId: "configure-valid-security",
      generation: 1,
      settings
    }));
  }

  const remotePlaintext = makeSettings();
  remotePlaintext.upstream.baseUrl = "http://api.example.com/v1";
  const spacedAuthScheme = makeSettings();
  spacedAuthScheme.upstream.authScheme = "Bearer token";
  const controlAuthScheme = makeSettings();
  controlAuthScheme.upstream.authScheme = "Bearer\n";
  const invalidAuthHeader = makeSettings();
  invalidAuthHeader.upstream.authHeader = "x provider auth";
  const unsafeHeaderValue = makeSettings();
  unsafeHeaderValue.upstream.extraHeaders = { "x-region": "safe\r\nmust-not-pass" };

  const invalidSettings = [
    remotePlaintext,
    spacedAuthScheme,
    controlAuthScheme,
    invalidAuthHeader,
    unsafeHeaderValue
  ];
  for (const name of [
    "Authorization",
    "Proxy-Authorization",
    "Cookie",
    "Set-Cookie",
    "X-API-Key",
    "X-Service-Secret",
    "X-PROVIDER-AUTH"
  ]) {
    const settings = makeSettings();
    settings.upstream.extraHeaders = { [name]: "must-not-pass" };
    invalidSettings.push(settings);
  }

  for (const settings of invalidSettings) {
    assert.throws(
      () => validateParentMessage({
        version: 1,
        type: "configure",
        requestId: "configure-invalid-security",
        generation: 1,
        settings
      }),
      (error) => error?.code === "WORKER_PROTOCOL_INVALID"
        && error.message === "Worker protocol message is invalid."
        && !String(error.message).includes("must-not-pass")
    );
  }
});

test("configure rejects API keys that cannot form an HTTP authentication header", () => {
  const validSettings = makeSettings();
  validSettings.upstream.apiKey = "sk-test_123.abc-XYZ";
  assert.doesNotThrow(() => validateParentMessage({
    version: 1,
    type: "configure",
    requestId: "configure-valid-api-key",
    generation: 1,
    settings: validSettings
  }));

  for (const apiKey of [
    "line-one\r\nx-injected: must-not-pass",
    "control-\u0000must-not-pass",
    "unicode-\u{1f512}-must-not-pass"
  ]) {
    const settings = makeSettings();
    settings.upstream.apiKey = apiKey;
    assert.throws(
      () => validateParentMessage({
        version: 1,
        type: "configure",
        requestId: "configure-invalid-api-key",
        generation: 1,
        settings
      }),
      (error) => error?.code === "WORKER_PROTOCOL_INVALID"
        && error.message === "Worker protocol message is invalid."
        && !String(error.message).includes(apiKey)
    );
  }
});

test("child protocol accepts exact lifecycle acknowledgements, status, and fatal messages", () => {
  const messages = [
    { version: 1, type: "ready", requestId: "worker-ready", state: makeState({
      phase: "ready",
      configured: false,
      generation: 0,
      listening: false,
      listenHost: null,
      listenPort: null
    }) },
    { version: 1, type: "configured", requestId: "configure-1", state: makeState() },
    { version: 1, type: "drained", requestId: "drain-1", state: makeState({
      phase: "drained",
      listening: false,
      listenHost: null,
      listenPort: null
    }) },
    { version: 1, type: "status", requestId: "status-1", state: makeState() },
    {
      version: 1,
      type: "account-state-applied",
      requestId: "account-state-1",
      revision: 2
    },
    {
      version: 1,
      type: "fatal",
      requestId: "configure-1",
      error: {
        code: "WORKER_CONFIGURE_FAILED",
        message: "Worker configuration failed."
      }
    }
  ];

  for (const message of messages) {
    assert.deepEqual(validateChildMessage(message), message);
  }
});

test("child protocol accepts only bounded anonymous metric observations", () => {
  const message = {
    version: 1,
    type: "metric",
    requestId: "metric-observation",
    observation: {
      generation: 7,
      route: "custom",
      providerId: "provider-1",
      result: "success",
      model: "gpt-5-codex",
      inputTokens: 123,
      outputTokens: 45,
      durationBin: 4,
      responseStartBin: 2
    }
  };
  assert.deepEqual(validateChildMessage(message), message);
  assert.deepEqual(validateChildMessage({
    ...message,
    observation: {
      ...message.observation,
      result: "networkError",
      model: null,
      inputTokens: null,
      outputTokens: null,
      responseStartBin: null
    }
  }).observation, {
    generation: 7,
    route: "custom",
    providerId: "provider-1",
    result: "networkError",
    model: null,
    inputTokens: null,
    outputTokens: null,
    durationBin: 4,
    responseStartBin: null
  });

  const sentinel = "metric-secret-sentinel";
  const invalid = [
    { ...message, requestId: "actual request id" },
    { ...message, requestId: "actual-request-id" },
    { ...message, observation: { ...message.observation, generation: 0 } },
    { ...message, observation: { ...message.observation, route: "fallback" } },
    { ...message, observation: { ...message.observation, result: "raw-error" } },
    { ...message, observation: { ...message.observation, model: `bad\u0000${sentinel}` } },
    { ...message, observation: { ...message.observation, inputTokens: 100_000_001 } },
    { ...message, observation: { ...message.observation, outputTokens: null } },
    { ...message, observation: { ...message.observation, durationBin: 13 } },
    { ...message, observation: { ...message.observation, responseStartBin: -1 } },
    { ...message, observation: { ...message.observation, requestId: sentinel } },
    { ...message, observation: { ...message.observation, url: `https://${sentinel}.invalid` } },
    { ...message, observation: { ...message.observation, error: sentinel } }
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => validateChildMessage(candidate),
      (error) => error?.code === "WORKER_PROTOCOL_INVALID"
        && !String(error.message).includes(sentinel)
    );
  }

  const sanitized = sanitizeProtocolMessage({
    ...message,
    observation: { ...message.observation, model: sentinel }
  });
  assert.equal(JSON.stringify(sanitized).includes(sentinel), false);
  assert.deepEqual(sanitized, {
    version: 1,
    type: "metric",
    requestId: "metric-observation"
  });
});

test("child protocol rejects invalid state, extra fields, and secret-bearing errors", () => {
  const invalidMessages = [
    { version: 1, type: "ready", requestId: "worker-ready" },
    { version: 1, type: "configured", requestId: "configure-1", state: makeState({ generation: -1 }) },
    { version: 1, type: "status", requestId: "status-1", state: makeState({ inFlight: 1.5 }) },
    { version: 1, type: "drained", requestId: "drain-1", state: { ...makeState(), apiKey: "must-not-pass" } },
    { version: 1, type: "fatal", requestId: "fatal-1", error: { code: "bad-code", message: "bad" } },
    {
      version: 1,
      type: "fatal",
      requestId: "fatal-1",
      error: {
        code: "WORKER_START_FAILED",
        message: "Worker failed.",
        secret: "must-not-pass"
      }
    }
  ];

  for (const message of invalidMessages) {
    assert.throws(
      () => validateChildMessage(message),
      (error) => error?.code === "WORKER_PROTOCOL_INVALID"
        && !String(error.message).includes("must-not-pass")
    );
  }
});

test("sanitizeProtocolMessage removes configure settings and projects only safe fields", () => {
  const message = {
    version: 1,
    type: "configure",
    requestId: "configure-1",
    generation: 7,
    settings: makeSettings(),
    authorization: "complete-authorization-secret",
    nested: {
      cookie: "complete-cookie-secret"
    }
  };

  const sanitized = sanitizeProtocolMessage(message);
  assert.deepEqual(sanitized, {
    version: 1,
    type: "configure",
    requestId: "configure-1",
    generation: 7
  });
  const serialized = JSON.stringify(sanitized);
  for (const forbidden of [
    "settings",
    "apiKey",
    "authorization",
    "cookie",
    "protocol-test-secret",
    "complete-authorization-secret",
    "complete-cookie-secret"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `sanitized message leaked ${forbidden}`);
  }
});

test("sanitizeProtocolMessage allowlists child state and replaces arbitrary fatal details", () => {
  const stateMessage = {
    version: 1,
    type: "status",
    requestId: "status-1",
    state: {
      ...makeState(),
      apiKey: "state-secret",
      settings: makeSettings()
    }
  };
  assert.deepEqual(sanitizeProtocolMessage(stateMessage), {
    version: 1,
    type: "status",
    requestId: "status-1",
    state: makeState()
  });

  const fatal = sanitizeProtocolMessage({
    version: 1,
    type: "fatal",
    requestId: "fatal-1",
    error: {
      code: "WORKER_START_FAILED",
      message: "backend included complete-secret-value",
      stack: "complete-secret-value"
    }
  });
  assert.deepEqual(fatal, {
    version: 1,
    type: "fatal",
    requestId: "fatal-1",
    error: {
      code: "WORKER_START_FAILED",
      message: "Worker failed to start."
    }
  });
  assert.equal(JSON.stringify(fatal).includes("complete-secret-value"), false);
});

test("createFatalMessage uses a safe fallback request ID and never echoes causes", () => {
  const message = createFatalMessage({
    requestId: "unsafe request id complete-secret-value",
    code: "WORKER_PROTOCOL_INVALID",
    message: "Protocol rejected complete-secret-value",
    cause: new Error("complete-secret-value")
  });

  assert.deepEqual(message, {
    version: 1,
    type: "fatal",
    requestId: "worker-fatal",
    error: {
      code: "WORKER_PROTOCOL_INVALID",
      message: "Worker protocol message is invalid."
    }
  });
  assert.equal(JSON.stringify(message).includes("complete-secret-value"), false);
});
