const RETRYABLE_RESPONSE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT"
]);
const DEFAULT_RESPONSE_COOLDOWN_MS = 30_000;
const DEFAULT_NETWORK_COOLDOWN_MS = 15_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

function safeNow(now) {
  const value = now();
  return Number.isFinite(value) ? value : Date.now();
}

function collectErrorCodes(error) {
  const codes = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === "string") codes.push(current.code);
    current = current.cause;
  }
  return codes;
}

function retryAfterMs(headers, nowMs) {
  const raw = headers?.["retry-after"] ?? headers?.get?.("retry-after");
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  if (/^\d+$/.test(value.trim())) {
    return Math.min(MAX_COOLDOWN_MS, Number(value.trim()) * 1_000);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(MAX_COOLDOWN_MS, Math.max(0, timestamp - nowMs))
    : null;
}

function targetModelForProvider(provider, requestedModel) {
  if (typeof requestedModel !== "string" || requestedModel.length === 0) return null;
  if (provider?.proxy?.modelMode === "override"
    && typeof provider.proxy.modelOverride === "string") {
    return provider.proxy.modelOverride;
  }
  const mapping = Array.isArray(provider?.proxy?.modelMappings)
    ? provider.proxy.modelMappings.find((rule) => rule?.sourceModel === requestedModel)
    : null;
  return typeof mapping?.targetModel === "string" ? mapping.targetModel : requestedModel;
}

function supportsRequestedModel(provider, requestedModel) {
  if (requestedModel === null) return true;
  const targetModel = targetModelForProvider(provider, requestedModel);
  if (targetModel === null) return false;
  if (Array.isArray(provider?.disabledModels)
    && provider.disabledModels.includes(targetModel)) return false;
  if (provider?.supportedModels === null || provider?.supportedModels === undefined) return true;
  if (!Array.isArray(provider?.supportedModels)) return false;
  return provider.supportedModels.includes(targetModel);
}

function priorityRanks(priorityRules, requestedModel) {
  if (typeof requestedModel !== "string" || !Array.isArray(priorityRules)) return new Map();
  const rule = priorityRules.find((candidate) => candidate?.model === requestedModel);
  return new Map((rule?.providerIds ?? []).map((providerId, index) => [providerId, index]));
}

export function isRetryableProviderResponse(statusCode) {
  return Number.isInteger(statusCode) && RETRYABLE_RESPONSE_STATUSES.has(statusCode);
}

export function isRetryableProviderTransportError(error) {
  return collectErrorCodes(error).some((code) => RETRYABLE_TRANSPORT_CODES.has(code));
}

export class ProviderScheduler {
  #states = new Map();
  #now;

  constructor({ now = Date.now } = {}) {
    if (typeof now !== "function") throw new TypeError("Provider scheduler clock is invalid.");
    this.#now = now;
  }

  ordered(providers, { model = null, priorityRules = [] } = {}) {
    if (!Array.isArray(providers) || providers.length === 0) return [];
    const nowMs = safeNow(this.#now);
    const ranks = priorityRanks(priorityRules, model);
    const indexed = providers.filter((provider) => supportsRequestedModel(provider, model)).map((provider, index) => ({
      provider,
      index,
      priority: ranks.get(provider.id) ?? Number.POSITIVE_INFINITY,
      blockedUntilMs: this.#states.get(provider.id)?.blockedUntilMs ?? 0
    }));
    if (indexed.length === 0) return [];
    const healthy = indexed.filter((candidate) => candidate.blockedUntilMs <= nowMs);
    const candidates = healthy.length > 0
      ? healthy
      : indexed.sort((left, right) => left.blockedUntilMs - right.blockedUntilMs).slice(0, 1);
    return candidates.sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      if (left.provider.weight !== right.provider.weight) {
        return right.provider.weight - left.provider.weight;
      }
      return left.index - right.index;
    }).map(({ provider }) => provider);
  }

  markResponse(providerId, statusCode, headers = {}) {
    if (!isRetryableProviderResponse(statusCode)) {
      if (Number.isInteger(statusCode) && statusCode >= 200 && statusCode <= 499) {
        this.markSuccess(providerId);
      }
      return false;
    }
    const nowMs = safeNow(this.#now);
    const baseMs = statusCode === 429
      ? retryAfterMs(headers, nowMs) ?? 60_000
      : DEFAULT_RESPONSE_COOLDOWN_MS;
    this.#markFailure(providerId, baseMs, nowMs);
    return true;
  }

  markTransportFailure(providerId, error) {
    if (!isRetryableProviderTransportError(error)) return false;
    this.#markFailure(providerId, DEFAULT_NETWORK_COOLDOWN_MS, safeNow(this.#now));
    return true;
  }

  markSuccess(providerId) {
    if (typeof providerId === "string") this.#states.delete(providerId);
  }

  state(providerId) {
    const state = this.#states.get(providerId);
    return state ? { ...state } : { failures: 0, blockedUntilMs: null };
  }

  #markFailure(providerId, baseMs, nowMs) {
    if (typeof providerId !== "string" || providerId.length === 0) return;
    const previous = this.#states.get(providerId);
    const failures = Math.min((previous?.failures ?? 0) + 1, 8);
    const cooldownMs = Math.min(MAX_COOLDOWN_MS, baseMs * (2 ** (failures - 1)));
    this.#states.set(providerId, {
      failures,
      blockedUntilMs: nowMs + cooldownMs
    });
  }
}
