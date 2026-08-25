import { validateHeaderValue } from "node:http";

import { isValidAccountRoutingState } from "../routing/account-routing.mjs";

export const PROTOCOL_VERSION = 1;

const PARENT_TYPES = new Set(["configure", "account-state", "drain", "shutdown", "status"]);
const CHILD_STATE_TYPES = new Set(["ready", "configured", "drained", "status"]);
const CHILD_TYPES = new Set([
  ...CHILD_STATE_TYPES,
  "account-state-applied",
  "fatal",
  "metric"
]);
const BASE_FIELDS = new Set(["version", "type", "requestId"]);
const CONFIGURE_FIELDS = new Set([...BASE_FIELDS, "generation", "settings"]);
const ACCOUNT_STATE_FIELDS = new Set([...BASE_FIELDS, "revision", "state"]);
const ACCOUNT_STATE_APPLIED_FIELDS = new Set([...BASE_FIELDS, "revision"]);
const CHILD_STATE_FIELDS = new Set([...BASE_FIELDS, "state"]);
const FATAL_FIELDS = new Set([...BASE_FIELDS, "error"]);
const METRIC_FIELDS = new Set([...BASE_FIELDS, "observation"]);
const STATE_FIELDS = new Set([
  "phase",
  "configured",
  "generation",
  "listening",
  "listenHost",
  "listenPort",
  "inFlight"
]);
const ERROR_FIELDS = new Set(["code", "message"]);
const METRIC_OBSERVATION_FIELDS = new Set([
  "generation",
  "route",
  "providerId",
  "result",
  "model",
  "inputTokens",
  "outputTokens",
  "durationBin",
  "responseStartBin"
]);
const SETTINGS_FIELDS = new Set([
  "configPath",
  "server",
  "providers",
  "upstream",
  "proxy",
  "capture",
  "access",
  "routing"
]);
const SERVER_FIELDS = new Set(["host", "port", "logLevel"]);
const PROVIDER_FIELDS = new Set([
  "id",
  "name",
  "weight",
  "supportedModels",
  "disabledModels",
  "upstream",
  "proxy"
]);
const UPSTREAM_FIELDS = new Set([
  "baseUrl",
  "apiKey",
  "timeoutMs",
  "verifySsl",
  "authHeader",
  "authScheme",
  "extraHeaders"
]);
const PROXY_FIELDS = new Set([
  "overrideAuthorization",
  "requestIdHeader",
  "modelMode",
  "modelOverride",
  "modelMappings"
]);
const MODEL_MAPPING_RULE_FIELDS = new Set(["sourceModel", "targetModel"]);
const CAPTURE_FIELDS = new Set(["enabled", "dbPath"]);
const ACCESS_FIELDS = new Set(["enabled", "dbPath", "localToken"]);
const ROUTING_FIELDS = new Set([
  "mode",
  "accountRevision",
  "account",
  "providerPriorityRules"
]);
const PROVIDER_PRIORITY_RULE_FIELDS = new Set(["model", "providerIds"]);
const ROUTING_MODES = new Set(["custom_only", "account_first"]);
const METRIC_ROUTES = new Set(["custom", "account"]);
const WORKER_PHASES = new Set(["ready", "running", "draining", "drained", "stopping", "failed"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const METRIC_TEXT_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const METRIC_RESULTS = new Set([
  "success",
  "upstreamRejected",
  "upstreamError",
  "timeout",
  "networkError",
  "clientAbort"
]);
const METRIC_MAX_MODEL_CODE_POINTS = 256;
const METRIC_MAX_OBSERVATION_TOKENS = 100_000_000;
const METRIC_LATENCY_BIN_COUNT = 13;
const SENSITIVE_HEADER_TERMS = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "apikey"
];

const FATAL_MESSAGES = new Map([
  ["WORKER_PROTOCOL_INVALID", "Worker protocol message is invalid."],
  ["WORKER_CONFIGURE_FAILED", "Worker configuration failed."],
  ["WORKER_START_FAILED", "Worker failed to start."],
  ["WORKER_RUNTIME_FAILED", "Worker runtime failed."],
  ["STALE_SNAPSHOT", "Worker rejected a stale settings snapshot."],
  ["RUNTIME_SETTINGS_INVALID", "Worker settings are invalid."]
]);

function protocolError() {
  const error = new Error("Worker protocol message is invalid.");
  error.name = "WorkerProtocolError";
  error.code = "WORKER_PROTOCOL_INVALID";
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function isRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function isNonEmptyString(value) {
  return typeof value === "string"
    && value.length > 0
    && !CONTROL_CHARACTER_PATTERN.test(value);
}

function isValidHeaderName(value) {
  return isNonEmptyString(value) && HEADER_NAME_PATTERN.test(value);
}

function isSensitiveHeaderName(name) {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_HEADER_TERMS.some((term) => compact.includes(term));
}

function isValidExtraHeaders(value, authHeader) {
  if (!isPlainObject(value)) {
    return false;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    if (!isValidHeaderName(name)
      || isSensitiveHeaderName(name)
      || name.toLowerCase() === authHeader.toLowerCase()
      || typeof headerValue !== "string") {
      return false;
    }
    try {
      validateHeaderValue(name, headerValue);
    } catch {
      return false;
    }
  }
  return true;
}

function isValidAuthenticationHeader(upstream) {
  const scheme = upstream.authScheme.trim();
  const value = scheme ? `${scheme} ${upstream.apiKey}` : upstream.apiKey;
  try {
    validateHeaderValue(upstream.authHeader, value);
    return true;
  } catch {
    return false;
  }
}

function isValidModelPolicy(proxy) {
  if (proxy.modelMode !== "passthrough" && proxy.modelMode !== "override") {
    return false;
  }
  // Schema 2 historically allowed internal controls, so existing snapshots must remain startable.
  if (proxy.modelOverride !== null
    && (typeof proxy.modelOverride !== "string"
      || proxy.modelOverride.length === 0
      || proxy.modelOverride.trim() !== proxy.modelOverride)) {
    return false;
  }
  if (!Array.isArray(proxy.modelMappings)
    || proxy.modelMappings.length > 50) {
    return false;
  }
  const sources = new Set();
  for (const rule of proxy.modelMappings) {
    if (!isPlainObject(rule)
      || !hasExactFields(rule, MODEL_MAPPING_RULE_FIELDS)
      || !isNonEmptyString(rule.sourceModel)
      || [...rule.sourceModel].length > 256
      || Buffer.byteLength(rule.sourceModel, "utf8") > 512
      || rule.sourceModel.trim() !== rule.sourceModel
      || METRIC_TEXT_CONTROL_PATTERN.test(rule.sourceModel)
      || !isNonEmptyString(rule.targetModel)
      || [...rule.targetModel].length > 256
      || Buffer.byteLength(rule.targetModel, "utf8") > 512
      || rule.targetModel.trim() !== rule.targetModel
      || METRIC_TEXT_CONTROL_PATTERN.test(rule.targetModel)
      || sources.has(rule.sourceModel)) {
      return false;
    }
    sources.add(rule.sourceModel);
  }
  return (proxy.modelMode !== "override" || proxy.modelOverride !== null)
    && (proxy.modelMode !== "override" || proxy.modelMappings.length === 0);
}

function isValidSupportedModels(value) {
  if (value === null) return true;
  if (!Array.isArray(value) || value.length > 2_000) return false;
  const models = new Set();
  for (const model of value) {
    if (!isNonEmptyString(model)
      || [...model].length > 256
      || Buffer.byteLength(model, "utf8") > 512
      || model.trim() !== model
      || METRIC_TEXT_CONTROL_PATTERN.test(model)
      || models.has(model)) {
      return false;
    }
    models.add(model);
  }
  return true;
}

function isValidProviderPriorityRules(value, providerIds) {
  if (!Array.isArray(value) || value.length > 100) return false;
  const models = new Set();
  for (const rule of value) {
    if (!isPlainObject(rule)
      || !hasExactFields(rule, PROVIDER_PRIORITY_RULE_FIELDS)
      || !isNonEmptyString(rule.model)
      || [...rule.model].length > 256
      || Buffer.byteLength(rule.model, "utf8") > 512
      || rule.model.trim() !== rule.model
      || METRIC_TEXT_CONTROL_PATTERN.test(rule.model)
      || models.has(rule.model)
      || !Array.isArray(rule.providerIds)
      || rule.providerIds.length < 1
      || rule.providerIds.length > 100
      || rule.providerIds.some((providerId) => !providerIds.has(providerId))
      || new Set(rule.providerIds).size !== rule.providerIds.length) {
      return false;
    }
    models.add(rule.model);
  }
  return true;
}

function isValidProviderCandidate(provider) {
  return isPlainObject(provider)
    && hasExactFields(provider, PROVIDER_FIELDS)
    && isNonEmptyString(provider.id)
    && provider.id.length <= 128
    && isNonEmptyString(provider.name)
    && [...provider.name].length <= 256
    && Number.isInteger(provider.weight)
    && provider.weight >= 1
    && provider.weight <= 1_000
    && isValidSupportedModels(provider.supportedModels)
    && Array.isArray(provider.disabledModels)
    && isValidSupportedModels(provider.disabledModels)
    && isPlainObject(provider.upstream)
    && hasExactFields(provider.upstream, UPSTREAM_FIELDS)
    && isValidBaseUrl(provider.upstream.baseUrl)
    && typeof provider.upstream.apiKey === "string"
    && Number.isFinite(provider.upstream.timeoutMs)
    && provider.upstream.timeoutMs > 0
    && typeof provider.upstream.verifySsl === "boolean"
    && isValidHeaderName(provider.upstream.authHeader)
    && typeof provider.upstream.authScheme === "string"
    && !CONTROL_CHARACTER_PATTERN.test(provider.upstream.authScheme)
    && (provider.upstream.authScheme === ""
      || HEADER_NAME_PATTERN.test(provider.upstream.authScheme))
    && isValidExtraHeaders(provider.upstream.extraHeaders, provider.upstream.authHeader)
    && isPlainObject(provider.proxy)
    && hasExactFields(provider.proxy, PROXY_FIELDS)
    && typeof provider.proxy.overrideAuthorization === "boolean"
    && isValidHeaderName(provider.proxy.requestIdHeader)
    && isValidModelPolicy(provider.proxy)
    && (!provider.proxy.overrideAuthorization
      || (provider.upstream.apiKey.length > 0 && isValidAuthenticationHeader(provider.upstream)));
}

function isValidBaseUrl(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username === ""
      && parsed.password === ""
      && !authorityContainsUserInfo(value)
      && (parsed.protocol === "https:" || isLoopbackHostname(parsed.hostname));
  } catch {
    return false;
  }
}

function authorityContainsUserInfo(value) {
  const authorityStart = value.indexOf("://");
  if (authorityStart === -1) {
    return false;
  }
  const remainder = value.slice(authorityStart + 3);
  const authorityEnd = remainder.search(/[/?#]/);
  const authority = authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd);
  return authority.includes("@");
}

function isLoopbackHostname(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "::1" || lower === "[::1]") {
    return true;
  }
  const octets = lower.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) {
    return false;
  }
  const numbers = octets.map(Number);
  return numbers[0] === 127 && numbers.every((octet) => octet >= 0 && octet <= 255);
}

function validateRuntimeSettings(settings) {
  const providerIds = Array.isArray(settings?.providers)
    ? new Set(settings.providers.map((provider) => provider?.id))
    : new Set();
  if (!isPlainObject(settings)
    || !hasExactFields(settings, SETTINGS_FIELDS)
    || !isNonEmptyString(settings.configPath)
    || !isPlainObject(settings.server)
    || !hasExactFields(settings.server, SERVER_FIELDS)
    || (settings.server.host !== "127.0.0.1" && settings.server.host !== "0.0.0.0")
    || !Number.isInteger(settings.server.port)
    || settings.server.port < 0
    || settings.server.port > 65535
    || !isNonEmptyString(settings.server.logLevel)
    || !Array.isArray(settings.providers)
    || settings.providers.length < 1
    || settings.providers.length > 100
    || settings.providers.some((provider) => !isValidProviderCandidate(provider))
    || new Set(settings.providers.map((provider) => provider.id)).size !== settings.providers.length
    || !isPlainObject(settings.upstream)
    || !hasExactFields(settings.upstream, UPSTREAM_FIELDS)
    || !isValidBaseUrl(settings.upstream.baseUrl)
    || typeof settings.upstream.apiKey !== "string"
    || !Number.isFinite(settings.upstream.timeoutMs)
    || settings.upstream.timeoutMs <= 0
    || typeof settings.upstream.verifySsl !== "boolean"
    || !isValidHeaderName(settings.upstream.authHeader)
    || typeof settings.upstream.authScheme !== "string"
    || CONTROL_CHARACTER_PATTERN.test(settings.upstream.authScheme)
    || (settings.upstream.authScheme !== ""
      && !HEADER_NAME_PATTERN.test(settings.upstream.authScheme))
    || !isValidExtraHeaders(settings.upstream.extraHeaders, settings.upstream.authHeader)
    || !isPlainObject(settings.proxy)
    || !hasExactFields(settings.proxy, PROXY_FIELDS)
    || typeof settings.proxy.overrideAuthorization !== "boolean"
    || !isValidHeaderName(settings.proxy.requestIdHeader)
    || !isValidModelPolicy(settings.proxy)
    || (settings.proxy.overrideAuthorization
      && !isValidAuthenticationHeader(settings.upstream))
    || (settings.proxy.overrideAuthorization && settings.upstream.apiKey.length === 0)
    || !isPlainObject(settings.capture)
    || !hasExactFields(settings.capture, CAPTURE_FIELDS)
    || typeof settings.capture.enabled !== "boolean"
    || !isNonEmptyString(settings.capture.dbPath)
    || !isPlainObject(settings.access)
    || !hasExactFields(settings.access, ACCESS_FIELDS)
    || typeof settings.access.enabled !== "boolean"
    || (settings.server.host === "0.0.0.0" && settings.access.enabled !== true)
    || !isNonEmptyString(settings.access.dbPath)
    || typeof settings.access.localToken !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(settings.access.localToken)
    || !isPlainObject(settings.routing)
    || !hasExactFields(settings.routing, ROUTING_FIELDS)
    || !ROUTING_MODES.has(settings.routing.mode)
    || !isValidProviderPriorityRules(settings.routing.providerPriorityRules, providerIds)
    || !Number.isSafeInteger(settings.routing.accountRevision)
    || settings.routing.accountRevision <= 0
    || !isValidAccountRoutingState(settings.routing.account)) {
    throw protocolError();
  }
  return settings;
}

function validateBase(message, allowedTypes) {
  if (!isPlainObject(message)
    || message.version !== PROTOCOL_VERSION
    || !allowedTypes.has(message.type)
    || !isRequestId(message.requestId)) {
    throw protocolError();
  }
}

function isListenHost(value) {
  return value === null
    || (typeof value === "string"
      && value.length > 0
      && value.length <= 255
      && !CONTROL_CHARACTER_PATTERN.test(value));
}

function isListenPort(value) {
  return value === null || (Number.isInteger(value) && value >= 0 && value <= 65535);
}

function validateState(state, { exact = true } = {}) {
  if (!isPlainObject(state)
    || (exact && !hasExactFields(state, STATE_FIELDS))
    || !WORKER_PHASES.has(state.phase)
    || typeof state.configured !== "boolean"
    || !Number.isSafeInteger(state.generation)
    || state.generation < 0
    || typeof state.listening !== "boolean"
    || !isListenHost(state.listenHost)
    || !isListenPort(state.listenPort)
    || !Number.isSafeInteger(state.inFlight)
    || state.inFlight < 0) {
    throw protocolError();
  }
  return state;
}

function validateFatalError(error) {
  if (!isPlainObject(error) || !hasExactFields(error, ERROR_FIELDS)) {
    throw protocolError();
  }
  const expectedMessage = FATAL_MESSAGES.get(error.code);
  if (!expectedMessage || error.message !== expectedMessage) {
    throw protocolError();
  }
  return error;
}

function isBoundedMetricModel(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= METRIC_MAX_MODEL_CODE_POINTS * 2
    && [...value].length <= METRIC_MAX_MODEL_CODE_POINTS
    && value.trim() === value
    && !METRIC_TEXT_CONTROL_PATTERN.test(value);
}

function isMetricTokenCount(value) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= METRIC_MAX_OBSERVATION_TOKENS;
}

function isMetricLatencyBin(value) {
  return Number.isInteger(value) && value >= 0 && value < METRIC_LATENCY_BIN_COUNT;
}

function validateMetricObservation(observation) {
  const noUsage = observation?.inputTokens === null && observation?.outputTokens === null;
  const completeUsage = isMetricTokenCount(observation?.inputTokens)
    && isMetricTokenCount(observation?.outputTokens);
  if (!isPlainObject(observation)
    || !hasExactFields(observation, METRIC_OBSERVATION_FIELDS)
    || !Number.isSafeInteger(observation.generation)
    || observation.generation <= 0
    || !METRIC_ROUTES.has(observation.route)
    || (observation.route === "account" && observation.providerId !== null)
    || (observation.route === "custom"
      && (!isNonEmptyString(observation.providerId) || observation.providerId.length > 128))
    || !METRIC_RESULTS.has(observation.result)
    || (observation.model !== null && !isBoundedMetricModel(observation.model))
    || (!noUsage && !completeUsage)
    || !isMetricLatencyBin(observation.durationBin)
    || (observation.responseStartBin !== null
      && !isMetricLatencyBin(observation.responseStartBin))) {
    throw protocolError();
  }
  return observation;
}

function projectState(state) {
  try {
    validateState(state, { exact: false });
  } catch {
    return undefined;
  }
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

export function validateParentMessage(message) {
  validateBase(message, PARENT_TYPES);
  if (message.type === "configure") {
    if (!hasExactFields(message, CONFIGURE_FIELDS)
      || !Number.isSafeInteger(message.generation)
      || message.generation <= 0
      || !isPlainObject(message.settings)) {
      throw protocolError();
    }
    validateRuntimeSettings(message.settings);
    return message;
  }
  if (message.type === "account-state") {
    if (!hasExactFields(message, ACCOUNT_STATE_FIELDS)
      || !Number.isSafeInteger(message.revision)
      || message.revision <= 0
      || !isValidAccountRoutingState(message.state)) {
      throw protocolError();
    }
    return message;
  }
  if (!hasExactFields(message, BASE_FIELDS)) {
    throw protocolError();
  }
  return message;
}

export function validateChildMessage(message) {
  validateBase(message, CHILD_TYPES);
  if (CHILD_STATE_TYPES.has(message.type)) {
    if (!hasExactFields(message, CHILD_STATE_FIELDS)) {
      throw protocolError();
    }
    validateState(message.state);
    return message;
  }
  if (message.type === "metric") {
    if (!hasExactFields(message, METRIC_FIELDS)
      || message.requestId !== "metric-observation") {
      throw protocolError();
    }
    validateMetricObservation(message.observation);
    return message;
  }
  if (message.type === "account-state-applied") {
    if (!hasExactFields(message, ACCOUNT_STATE_APPLIED_FIELDS)
      || !Number.isSafeInteger(message.revision)
      || message.revision <= 0) {
      throw protocolError();
    }
    return message;
  }
  if (!hasExactFields(message, FATAL_FIELDS)) {
    throw protocolError();
  }
  validateFatalError(message.error);
  return message;
}

export function sanitizeProtocolMessage(message) {
  if (!isPlainObject(message)
    || message.version !== PROTOCOL_VERSION
    || (!PARENT_TYPES.has(message.type) && !CHILD_TYPES.has(message.type))
    || !isRequestId(message.requestId)
    || (message.type === "metric" && message.requestId !== "metric-observation")) {
    return {};
  }

  const result = {
    version: PROTOCOL_VERSION,
    type: message.type,
    requestId: message.requestId
  };
  if (message.type === "configure" && Number.isSafeInteger(message.generation) && message.generation > 0) {
    result.generation = message.generation;
  }
  if ((message.type === "account-state" || message.type === "account-state-applied")
    && Number.isSafeInteger(message.revision)
    && message.revision > 0) {
    result.revision = message.revision;
  }
  if (CHILD_STATE_TYPES.has(message.type)) {
    const state = projectState(message.state);
    if (state) {
      result.state = state;
    }
  }
  if (message.type === "fatal" && isPlainObject(message.error)) {
    const messageText = FATAL_MESSAGES.get(message.error.code);
    if (messageText) {
      result.error = {
        code: message.error.code,
        message: messageText
      };
    }
  }
  return result;
}

export function createFatalMessage({ requestId, code }) {
  const safeCode = FATAL_MESSAGES.has(code) ? code : "WORKER_RUNTIME_FAILED";
  return {
    version: PROTOCOL_VERSION,
    type: "fatal",
    requestId: isRequestId(requestId) ? requestId : "worker-fatal",
    error: {
      code: safeCode,
      message: FATAL_MESSAGES.get(safeCode)
    }
  };
}
