import {
  accountSupportsOperation,
  decideUpstreamRoute,
  isRouteOperation,
  operationRequestUrl
} from "./account-routing.mjs";

const MAX_MODEL_CODE_POINTS = 256;
const MAX_MODEL_BYTES = 512;
const MAX_PROVIDER_ID_CODE_POINTS = 128;
const MAX_PROVIDER_NAME_CODE_POINTS = 256;
const MAX_CANDIDATES = 100;
const MAX_TIMESTAMP_MS = 32_503_680_000_000;
const MODEL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const SOURCES = new Set(["live", "configured"]);
const ROUTES = new Set(["account", "custom", "unavailable"]);
const REASONS = new Set([
  "account_eligible",
  "account_cooldown",
  "account_quota_exhausted",
  "unsupported_operation",
  "unsupported_account_model",
  "custom_only",
  "not_chatgpt_auth",
  "provider_pool_unavailable",
  "custom_model_unavailable"
]);
const ACCOUNT_REASONS = new Set([
  "account_eligible",
  "account_cooldown",
  "account_quota_exhausted",
  "unsupported_operation",
  "unsupported_account_model",
  "custom_only",
  "not_chatgpt_auth"
]);
const CUSTOM_REASONS = new Set([
  "account_cooldown",
  "account_quota_exhausted",
  "unsupported_operation",
  "unsupported_account_model",
  "custom_only",
  "not_chatgpt_auth"
]);
const UNAVAILABLE_REASONS = new Set([
  "provider_pool_unavailable",
  "custom_model_unavailable"
]);
const PROVIDER_SELECTION_REASONS = new Set([
  "sole_eligible",
  "model_priority",
  "weight",
  "runtime_order",
  "cooldown_fallback"
]);
const TRANSFORMATIONS = new Set(["passthrough", "mapping", "override"]);
const AVAILABILITIES = new Set(["ready", "cooling", "disabled", "not_listed"]);
const PREVIEW_FIELDS = new Set([
  "source",
  "generation",
  "evaluatedAt",
  "operation",
  "route",
  "reason",
  "account",
  "matchedPriorityRule",
  "customSelectionReason",
  "customPrimaryProviderId",
  "candidates"
]);
const ACCOUNT_FIELDS = new Set([
  "enabled",
  "selected",
  "reason",
  "operationSupported",
  "fallbackAvailable"
]);
const CANDIDATE_FIELDS = new Set([
  "providerId",
  "providerName",
  "weight",
  "targetModel",
  "transformation",
  "availability",
  "coolingUntil",
  "order"
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function isBoundedText(value, maximumCodePoints) {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && value.length <= maximumCodePoints * 2
    && [...value].length <= maximumCodePoints
    && !MODEL_CONTROL_PATTERN.test(value);
}

function isModel(value) {
  return isBoundedText(value, MAX_MODEL_CODE_POINTS)
    && Buffer.byteLength(value, "utf8") <= MAX_MODEL_BYTES;
}

function safeIso(value) {
  if (typeof value !== "string") return null;
  try {
    const timestamp = Date.parse(value);
    return timestamp >= 0
      && timestamp <= MAX_TIMESTAMP_MS
      && new Date(timestamp).toISOString() === value
      ? value
      : null;
  } catch {
    return null;
  }
}

function candidateAvailability(candidate) {
  if (candidate.support === "disabled") return "disabled";
  if (candidate.support === "not_listed") return "not_listed";
  return candidate.cooling ? "cooling" : "ready";
}

function coolingUntil(candidate) {
  if (!candidate.cooling || !Number.isFinite(candidate.blockedUntilMs)) return null;
  const bounded = Math.min(MAX_TIMESTAMP_MS, Math.max(0, Math.trunc(candidate.blockedUntilMs)));
  return new Date(bounded).toISOString();
}

export function isRoutePreviewModel(value) {
  return isModel(value);
}

export function buildRoutePreview({
  source,
  generation,
  settings,
  accountState,
  providerScheduler,
  localBlockedUntilMs = null,
  nowMs = Date.now(),
  model,
  operation = "responses"
}) {
  if (!SOURCES.has(source)
    || !Number.isSafeInteger(generation)
    || generation < 0
    || !isPlainObject(settings)
    || !providerScheduler
    || typeof providerScheduler.explain !== "function"
    || !isModel(model)
    || !isRouteOperation(operation)) {
    throw new TypeError("Route preview input is invalid.");
  }
  const evaluatedMs = Number.isFinite(nowMs)
    ? Math.min(MAX_TIMESTAMP_MS, Math.max(0, Math.trunc(nowMs)))
    : Date.now();
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  const priorityRules = Array.isArray(settings.routing?.providerPriorityRules)
    ? settings.routing.providerPriorityRules
    : [];
  const explanation = providerScheduler.explain(providers, { model, priorityRules });
  const customPrimary = explanation.candidates.find((candidate) => candidate.order === 1) ?? null;
  const routeDecision = decideUpstreamRoute({
    mode: settings.routing?.mode ?? "custom_only",
    method: "POST",
    requestUrl: operationRequestUrl(operation),
    rawHeaders: [
      "authorization", "Bearer route-preview",
      "chatgpt-account-id", "route-preview"
    ],
    accountState,
    model,
    localBlockedUntilMs,
    nowMs: evaluatedMs
  });
  let route = routeDecision.route;
  let reason = routeDecision.reason;
  if (route === "custom" && providers.length === 0) {
    route = "unavailable";
    reason = "provider_pool_unavailable";
  } else if (route === "custom" && customPrimary === null) {
    route = "unavailable";
    reason = "custom_model_unavailable";
  }
  const candidates = explanation.candidates.map((candidate) => {
    const availability = candidateAvailability(candidate);
    return {
      providerId: candidate.providerId,
      providerName: candidate.providerName,
      weight: candidate.weight,
      targetModel: candidate.targetModel,
      transformation: candidate.transformation,
      availability,
      coolingUntil: availability === "cooling" ? coolingUntil(candidate) : null,
      order: candidate.order
    };
  });
  const preview = {
    source,
    generation,
    evaluatedAt: new Date(evaluatedMs).toISOString(),
    operation,
    route,
    reason,
    account: {
      enabled: settings.routing?.mode === "account_first",
      selected: route === "account",
      reason: ACCOUNT_REASONS.has(routeDecision.reason) ? routeDecision.reason : "custom_only",
      operationSupported: accountSupportsOperation(operation),
      fallbackAvailable: customPrimary !== null
    },
    matchedPriorityRule: explanation.matchedPriorityRule,
    customSelectionReason: customPrimary === null ? null : explanation.primaryReason,
    customPrimaryProviderId: customPrimary?.providerId ?? null,
    candidates
  };
  if (!isValidRoutePreview(preview)) throw new TypeError("Route preview output is invalid.");
  return preview;
}

export function isValidRoutePreview(value) {
  if (!isPlainObject(value)
    || !hasExactFields(value, PREVIEW_FIELDS)
    || !SOURCES.has(value.source)
    || !Number.isSafeInteger(value.generation)
    || value.generation < 0
    || (value.source === "live" && value.generation === 0)
    || (value.source === "configured" && value.generation !== 0)
    || safeIso(value.evaluatedAt) === null
    || !isRouteOperation(value.operation)
    || !ROUTES.has(value.route)
    || !REASONS.has(value.reason)
    || !isPlainObject(value.account)
    || !hasExactFields(value.account, ACCOUNT_FIELDS)
    || typeof value.account.enabled !== "boolean"
    || typeof value.account.selected !== "boolean"
    || !ACCOUNT_REASONS.has(value.account.reason)
    || typeof value.account.operationSupported !== "boolean"
    || typeof value.account.fallbackAvailable !== "boolean"
    || typeof value.matchedPriorityRule !== "boolean"
    || (value.customSelectionReason !== null
      && !PROVIDER_SELECTION_REASONS.has(value.customSelectionReason))
    || !Array.isArray(value.candidates)
    || value.candidates.length > MAX_CANDIDATES) {
    return false;
  }
  const providerIds = new Set();
  const orders = [];
  for (const candidate of value.candidates) {
    if (!isPlainObject(candidate)
      || !hasExactFields(candidate, CANDIDATE_FIELDS)
      || !isBoundedText(candidate.providerId, MAX_PROVIDER_ID_CODE_POINTS)
      || !isBoundedText(candidate.providerName, MAX_PROVIDER_NAME_CODE_POINTS)
      || !Number.isInteger(candidate.weight)
      || candidate.weight < 1
      || candidate.weight > 1_000
      || (candidate.targetModel !== null && !isModel(candidate.targetModel))
      || !TRANSFORMATIONS.has(candidate.transformation)
      || (candidate.transformation === "passthrough" && candidate.targetModel !== null)
      || (candidate.transformation !== "passthrough" && candidate.targetModel === null)
      || !AVAILABILITIES.has(candidate.availability)
      || (candidate.coolingUntil !== null && safeIso(candidate.coolingUntil) === null)
      || (candidate.availability === "cooling") !== (candidate.coolingUntil !== null)
      || (candidate.order !== null
        && (!Number.isInteger(candidate.order)
          || candidate.order < 1
          || candidate.order > MAX_CANDIDATES))
      || (candidate.availability === "ready" && candidate.order === null)
      || (["disabled", "not_listed"].includes(candidate.availability)
        && candidate.order !== null)
      || providerIds.has(candidate.providerId)) {
      return false;
    }
    providerIds.add(candidate.providerId);
    if (candidate.order !== null) orders.push(candidate.order);
  }
  orders.sort((left, right) => left - right);
  if (orders.some((order, index) => order !== index + 1)) return false;
  const customPrimary = value.customPrimaryProviderId;
  if (customPrimary !== null
    && (!providerIds.has(customPrimary)
      || value.candidates.find((candidate) => candidate.providerId === customPrimary)?.order !== 1)) {
    return false;
  }
  if ((value.route === "custom" && customPrimary === null)
    || (value.route === "account" && value.reason !== "account_eligible")
    || (value.route === "custom" && !CUSTOM_REASONS.has(value.reason))
    || (value.route === "unavailable" && !UNAVAILABLE_REASONS.has(value.reason))
    || (value.route === "unavailable" && customPrimary !== null)
    || value.account.enabled !== (value.account.reason !== "custom_only")
    || value.account.selected !== (value.route === "account")
    || value.account.operationSupported !== accountSupportsOperation(value.operation)
    || value.account.selected && !value.account.operationSupported
    || (customPrimary === null) !== (value.customSelectionReason === null)
    || value.account.fallbackAvailable !== (customPrimary !== null)) {
    return false;
  }
  return true;
}
