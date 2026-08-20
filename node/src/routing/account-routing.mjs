export const CHATGPT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CHATGPT_METRICS_PROVIDER_ID = "crp-chatgpt-account";
export const ACCOUNT_REQUEST_REPLAY_MAX_BYTES = 8 * 1024 * 1024;
export const ACCOUNT_STATE_MAX_AGE_MS = 10 * 60 * 1_000;
export const ACCOUNT_429_FALLBACK_COOLDOWN_MS = 5_000;

const MAX_HEADER_VALUE_BYTES = 64 * 1024;
const MAX_RESET_AFTER_SECONDS = 31 * 24 * 60 * 60;
const MAX_WINDOW_MINUTES = 10 * 365 * 24 * 60;
const MAX_UNIX_SECONDS = 32_503_680_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const CHATGPT_AUTH_MODES = new Set([
  "chatgpt",
  "chatgptAuthTokens",
  "agentIdentity",
  "personalAccessToken"
]);
const NON_CHATGPT_AUTH_MODES = new Set(["apikey", "headers", "bedrockApiKey"]);
const ROUTING_MODES = new Set(["custom_only", "account_first"]);
const QUOTA_STATUSES = new Set(["available", "exhausted", "unknown"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeIsoTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function safeUnixSeconds(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_UNIX_SECONDS
    ? value
    : null;
}

function headerValues(rawHeaders, wantedName) {
  const values = [];
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return values;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === wantedName) {
      values.push(String(rawHeaders[index + 1]));
    }
  }
  return values;
}

function singleSafeHeader(rawHeaders, name) {
  const values = headerValues(rawHeaders, name);
  if (values.length !== 1) return null;
  const value = values[0];
  return value.length > 0
    && Buffer.byteLength(value) <= MAX_HEADER_VALUE_BYTES
    && !CONTROL_CHARACTER_PATTERN.test(value)
    ? value
    : null;
}

export function buildChatGptResponsesTarget(requestUrl) {
  if (typeof requestUrl !== "string" || !requestUrl.startsWith("/")) return null;
  let incoming;
  try {
    incoming = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
  if (incoming.pathname !== "/responses" && incoming.pathname !== "/v1/responses") return null;
  const target = new URL(CHATGPT_CODEX_RESPONSES_URL);
  target.search = incoming.search;
  return target;
}

export function projectAccountRoutingState(monitorState) {
  const authMode = typeof monitorState?.authMode === "string"
    && (CHATGPT_AUTH_MODES.has(monitorState.authMode)
      || NON_CHATGPT_AUTH_MODES.has(monitorState.authMode))
    ? monitorState.authMode
    : null;
  const quotaStatus = QUOTA_STATUSES.has(monitorState?.quota?.status)
    ? monitorState.quota.status
    : "unknown";
  const exhaustedResets = quotaStatus === "exhausted" && Array.isArray(monitorState?.quota?.windows)
    ? monitorState.quota.windows
      .filter((window) => window?.usedPercent >= 100)
      .map((window) => safeUnixSeconds(window.resetsAt))
      .filter((value) => value !== null)
    : [];
  if (quotaStatus === "exhausted" && monitorState?.quota?.spendControlReached === true) {
    const spendControlResetsAt = safeUnixSeconds(monitorState.quota.spendControlResetsAt);
    if (spendControlResetsAt !== null) exhaustedResets.push(spendControlResetsAt);
  }
  return {
    authMode,
    quotaStatus,
    blockedUntil: exhaustedResets.length > 0 ? Math.min(...exhaustedResets) : null,
    updatedAt: safeIsoTimestamp(monitorState?.updatedAt ?? null)
  };
}

export function isValidAccountRoutingState(value) {
  return isPlainObject(value)
    && Object.keys(value).length === 4
    && Object.keys(value).every((key) => [
      "authMode",
      "quotaStatus",
      "blockedUntil",
      "updatedAt"
    ].includes(key))
    && (value.authMode === null
      || CHATGPT_AUTH_MODES.has(value.authMode)
      || NON_CHATGPT_AUTH_MODES.has(value.authMode))
    && QUOTA_STATUSES.has(value.quotaStatus)
    && (value.blockedUntil === null || safeUnixSeconds(value.blockedUntil) !== null)
    && (value.updatedAt === null || safeIsoTimestamp(value.updatedAt) !== null);
}

export function decideUpstreamRoute({
  mode,
  method,
  requestUrl,
  rawHeaders,
  accountState,
  localBlockedUntilMs = null,
  nowMs = Date.now()
}) {
  if (!ROUTING_MODES.has(mode) || mode === "custom_only") {
    return { route: "custom", reason: "custom_only", target: null };
  }
  if (method !== "POST") {
    return { route: "custom", reason: "unsupported_method", target: null };
  }
  const target = buildChatGptResponsesTarget(requestUrl);
  if (!target) return { route: "custom", reason: "unsupported_path", target: null };
  if (!singleSafeHeader(rawHeaders, "authorization")
    || !singleSafeHeader(rawHeaders, "chatgpt-account-id")) {
    return { route: "custom", reason: "account_headers_missing", target: null };
  }
  if (NON_CHATGPT_AUTH_MODES.has(accountState?.authMode)) {
    return { route: "custom", reason: "not_chatgpt_auth", target: null };
  }
  if (Number.isFinite(localBlockedUntilMs) && localBlockedUntilMs > nowMs) {
    return { route: "custom", reason: "account_cooldown", target: null };
  }
  if (Number.isSafeInteger(accountState?.blockedUntil)
    && accountState.blockedUntil * 1_000 > nowMs) {
    return { route: "custom", reason: "account_quota_exhausted", target: null };
  }
  const updatedAtMs = Date.parse(accountState?.updatedAt ?? "");
  const fresh = Number.isFinite(updatedAtMs)
    && updatedAtMs <= nowMs + 60_000
    && nowMs - updatedAtMs <= ACCOUNT_STATE_MAX_AGE_MS;
  if (fresh && accountState?.quotaStatus === "exhausted") {
    return { route: "custom", reason: "account_quota_exhausted", target: null };
  }
  return { route: "account", reason: "account_eligible", target };
}

function firstHeader(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return typeof value === "string" ? value : null;
}

function boundedNumberHeader(headers, name, minimum, maximum) {
  const raw = firstHeader(headers, name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

export function parseCodexQuotaHeaders(headers, nowMs = Date.now()) {
  const windows = [];
  for (const kind of ["primary", "secondary"]) {
    const usedPercent = boundedNumberHeader(
      headers,
      `x-codex-${kind}-used-percent`,
      0,
      100
    );
    const resetAfterSeconds = boundedNumberHeader(
      headers,
      `x-codex-${kind}-reset-after-seconds`,
      0,
      MAX_RESET_AFTER_SECONDS
    );
    const windowDurationMins = boundedNumberHeader(
      headers,
      `x-codex-${kind}-window-minutes`,
      1,
      MAX_WINDOW_MINUTES
    );
    if (usedPercent === null && resetAfterSeconds === null && windowDurationMins === null) continue;
    windows.push({ kind, usedPercent, resetAfterSeconds, windowDurationMins });
  }
  if (windows.length === 0) return null;
  const exhaustedResets = windows
    .filter((window) => window.usedPercent !== null && window.usedPercent >= 100)
    .map((window) => window.resetAfterSeconds)
    .filter((value) => value !== null);
  return {
    status: windows.some((window) => window.usedPercent !== null && window.usedPercent >= 100)
      ? "exhausted"
      : "available",
    windows,
    blockedUntilMs: exhaustedResets.length > 0
      ? nowMs + (Math.min(...exhaustedResets) * 1_000)
      : null
  };
}

export function account429Cooldown(headers, nowMs = Date.now()) {
  const quota = parseCodexQuotaHeaders(headers, nowMs);
  const resetAfterSeconds = quota?.windows
    .map((window) => window.resetAfterSeconds)
    .filter((value) => value !== null)
    .sort((left, right) => left - right)[0] ?? null;
  const explicitUntilMs = quota?.blockedUntilMs
    ?? (resetAfterSeconds === null ? null : nowMs + (resetAfterSeconds * 1_000));
  return {
    untilMs: explicitUntilMs ?? (nowMs + ACCOUNT_429_FALLBACK_COOLDOWN_MS),
    explicit: explicitUntilMs !== null,
    quota
  };
}
