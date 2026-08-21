import { CrpError } from "../shared/errors.mjs";
import { validateHeaderValue } from "node:http";

export const TEST_STATUSES = new Set(["untested", "passed", "failed"]);
export const DEFAULT_PROVIDER_WEIGHT = 100;
export const MIN_PROVIDER_WEIGHT = 1;
export const MAX_PROVIDER_WEIGHT = 1_000;

const INPUT_FIELDS = new Set([
  "name",
  "baseUrl",
  "credentialRef",
  "authHeader",
  "authScheme",
  "extraHeaders",
  "weight",
  "modelMode",
  "modelOverride"
]);
const PROFILE_FIELDS = new Set([
  "id",
  ...INPUT_FIELDS,
  "lastTestAt",
  "lastTestStatus",
  "lastTestCode",
  "createdAt",
  "updatedAt"
]);
const SENSITIVE_HEADER_TERMS = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "apikey"
];
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TEST_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function inputError(field, reason) {
  throw new CrpError(
    "PROVIDER_INPUT_INVALID",
    "Provider settings are invalid.",
    "Review the provider settings and try again.",
    { status: 400, details: { field, reason } }
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactFields(value, allowedFields, field) {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      inputError(field, "contains an unsupported field");
    }
  }
}

function normalizeRequiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    inputError(field, "must be a non-empty string");
  }
  return value.trim();
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    inputError("baseUrl", "must be a non-empty string");
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    inputError("baseUrl", "must not contain control characters");
  }
  const baseUrl = value.trim();
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    inputError("baseUrl", "must be a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    inputError("baseUrl", "must use HTTP or HTTPS");
  }
  if (authorityContainsUserInfo(baseUrl) || parsed.username || parsed.password) {
    inputError("baseUrl", "must not contain credentials");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    inputError("baseUrl", "HTTP is allowed only for loopback hosts");
  }
  return parsed.toString();
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

function normalizeAuthHeader(value) {
  const authHeader = value === undefined
    ? "authorization"
    : normalizeRequiredString(value, "authHeader");
  if (!HEADER_NAME_PATTERN.test(authHeader)) {
    inputError("authHeader", "must be a valid HTTP header name");
  }
  return authHeader;
}

function normalizeAuthScheme(value) {
  if (value === undefined) {
    return "Bearer";
  }
  if (typeof value !== "string") {
    inputError("authScheme", "must be a string");
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    inputError("authScheme", "must not contain control characters");
  }
  const authScheme = value.trim();
  if (authScheme && !HEADER_NAME_PATTERN.test(authScheme)) {
    inputError("authScheme", "must be empty or an HTTP token");
  }
  return authScheme;
}

function isSensitiveHeaderName(name) {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_HEADER_TERMS.some((term) => compact.includes(term));
}

function normalizeExtraHeaders(value) {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    inputError("extraHeaders", "must be a string map");
  }

  const extraHeaders = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      inputError("extraHeaders", "contains an invalid HTTP header name");
    }
    if (isSensitiveHeaderName(name)) {
      inputError("extraHeaders", "contains a sensitive header name");
    }
    if (typeof headerValue !== "string") {
      inputError("extraHeaders", "must contain only string values");
    }
    try {
      validateHeaderValue(name, headerValue);
    } catch {
      inputError("extraHeaders", "contains an invalid HTTP header value");
    }
    extraHeaders[name] = headerValue;
  }
  return extraHeaders;
}

function normalizeWeight(value) {
  const weight = value === undefined ? DEFAULT_PROVIDER_WEIGHT : value;
  if (!Number.isInteger(weight)
    || weight < MIN_PROVIDER_WEIGHT
    || weight > MAX_PROVIDER_WEIGHT) {
    inputError(
      "weight",
      `must be an integer between ${MIN_PROVIDER_WEIGHT} and ${MAX_PROVIDER_WEIGHT}`
    );
  }
  return weight;
}

function normalizeModelPolicy(modeValue, overrideValue, { allowControlCharacters = false } = {}) {
  const modelMode = modeValue === undefined ? "passthrough" : modeValue;
  if (modelMode !== "passthrough" && modelMode !== "override") {
    inputError("modelMode", "must be passthrough or override");
  }

  let modelOverride = overrideValue === undefined ? null : overrideValue;
  if (modelOverride !== null) {
    if (typeof modelOverride !== "string"
      || modelOverride.trim().length === 0
      || (!allowControlCharacters && CONTROL_CHARACTER_PATTERN.test(modelOverride))) {
      inputError("modelOverride", "must be a non-empty string or null");
    }
    modelOverride = modelOverride.trim();
  }
  if (modelMode === "override" && modelOverride === null) {
    inputError("modelOverride", "is required in override mode");
  }
  return { modelMode, modelOverride };
}

function normalizeInput(input, options) {
  if (!isPlainObject(input)) {
    inputError("provider", "must be an object");
  }
  assertExactFields(input, INPUT_FIELDS, "provider");
  const modelPolicy = normalizeModelPolicy(input.modelMode, input.modelOverride, options);
  return {
    name: normalizeRequiredString(input.name, "name"),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    credentialRef: normalizeRequiredString(input.credentialRef, "credentialRef"),
    authHeader: normalizeAuthHeader(input.authHeader),
    authScheme: normalizeAuthScheme(input.authScheme),
    extraHeaders: normalizeExtraHeaders(input.extraHeaders),
    weight: normalizeWeight(input.weight),
    ...modelPolicy
  };
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function assertStoredValue(condition, field, reason) {
  if (!condition) {
    inputError(field, reason);
  }
}

export function validateProviderInput(input) {
  normalizeInput(input);
  return true;
}

export function normalizeProvider(input, { id, now }) {
  const normalized = normalizeInput(input);
  const providerId = normalizeRequiredString(id, "id");
  if (!isIsoTimestamp(now)) {
    inputError("now", "must be an ISO timestamp");
  }
  return {
    id: providerId,
    ...normalized,
    lastTestAt: null,
    lastTestStatus: "untested",
    lastTestCode: null,
    createdAt: now,
    updatedAt: now
  };
}

export function validateStoredProvider(profile) {
  if (!isPlainObject(profile)) {
    inputError("provider", "must be an object");
  }
  assertExactFields(profile, PROFILE_FIELDS, "provider");
  assertStoredValue(
    Object.keys(profile).length === PROFILE_FIELDS.size,
    "provider",
    "is missing required fields"
  );

  const normalized = normalizeInput({
    name: profile.name,
    baseUrl: profile.baseUrl,
    credentialRef: profile.credentialRef,
    authHeader: profile.authHeader,
    authScheme: profile.authScheme,
    extraHeaders: profile.extraHeaders,
    weight: profile.weight,
    modelMode: profile.modelMode,
    modelOverride: profile.modelOverride
  }, { allowControlCharacters: true });
  assertStoredValue(
    typeof profile.id === "string" && profile.id.trim() === profile.id && profile.id.length > 0,
    "id",
    "must be a normalized non-empty string"
  );
  for (const key of INPUT_FIELDS) {
    assertStoredValue(
      JSON.stringify(profile[key]) === JSON.stringify(normalized[key]),
      key,
      "must be normalized"
    );
  }
  assertStoredValue(isIsoTimestamp(profile.createdAt), "createdAt", "must be an ISO timestamp");
  assertStoredValue(isIsoTimestamp(profile.updatedAt), "updatedAt", "must be an ISO timestamp");
  assertStoredValue(profile.updatedAt >= profile.createdAt, "updatedAt", "must not precede createdAt");
  assertStoredValue(TEST_STATUSES.has(profile.lastTestStatus), "lastTestStatus", "is invalid");
  assertStoredValue(
    profile.lastTestAt === null || isIsoTimestamp(profile.lastTestAt),
    "lastTestAt",
    "must be null or an ISO timestamp"
  );
  if (profile.lastTestAt !== null) {
    assertStoredValue(
      profile.lastTestAt >= profile.createdAt && profile.lastTestAt <= profile.updatedAt,
      "lastTestAt",
      "must be between createdAt and updatedAt"
    );
  }
  assertStoredValue(
    profile.lastTestCode === null
      || (typeof profile.lastTestCode === "string" && TEST_CODE_PATTERN.test(profile.lastTestCode)),
    "lastTestCode",
    "must be null or a stable error code"
  );

  if (profile.lastTestStatus === "untested") {
    assertStoredValue(profile.lastTestAt === null, "lastTestAt", "must be null when untested");
    assertStoredValue(profile.lastTestCode === null, "lastTestCode", "must be null when untested");
  } else {
    assertStoredValue(profile.lastTestAt !== null, "lastTestAt", "is required after a test");
  }
  if (profile.lastTestStatus === "passed") {
    assertStoredValue(profile.lastTestCode === null, "lastTestCode", "must be null after a passed test");
  }
  if (profile.lastTestStatus === "failed") {
    assertStoredValue(profile.lastTestCode !== null, "lastTestCode", "is required after a failed test");
  }
  return true;
}

export function toPublicProvider(profile, credentialConfigured) {
  if (typeof credentialConfigured !== "boolean") {
    inputError("credentialConfigured", "must be a boolean");
  }
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    authHeader: profile.authHeader,
    authScheme: profile.authScheme,
    extraHeaders: { ...profile.extraHeaders },
    weight: profile.weight,
    modelMode: profile.modelMode,
    modelOverride: profile.modelOverride,
    lastTestAt: profile.lastTestAt,
    lastTestStatus: profile.lastTestStatus,
    lastTestCode: profile.lastTestCode,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    credentialConfigured
  };
}
