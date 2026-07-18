export class CrpError extends Error {
  constructor(code, message, action, { status = 500, details = {}, cause } = {}) {
    super(message, { cause });
    this.name = "CrpError";
    this.code = code;
    this.action = action;
    this.status = status;
    this.details = details;
  }
}

const STARTUP_MESSAGE_FIELDS = new Set(["version", "type", "error"]);
const STARTUP_ERROR_FIELDS = new Set(["code", "message", "action", "status", "details"]);
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_STARTUP_MESSAGE_BYTES = 8 * 1024;
const STARTUP_ERROR_CONTRACTS = new Map([
  ["SUPERVISOR_START_FAILED", Object.freeze({
    message: "The local supervisor could not be started.",
    action: "Review the supervisor log and try again.",
    status: 500,
    detailFields: new Set()
  })],
  ["MIGRATION_INPUT_INVALID", Object.freeze({
    message: "The legacy provider configuration is invalid.",
    action: "Restore a complete legacy provider URL and credential before migrating.",
    status: 400,
    detailFields: new Set()
  })]
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function isSafeText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !CONTROL_CHARACTER_PATTERN.test(value);
}

function sanitizeStartupDetails(details, allowedFields) {
  if (!isPlainObject(details)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (allowedFields.has(key) && (
      typeof value === "boolean" || value === null
      || (typeof value === "number" && Number.isFinite(value))
      || (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    )) safe[key] = value;
  }
  return safe;
}

function startupContract(code) {
  return STARTUP_ERROR_CONTRACTS.get(code)
    ?? STARTUP_ERROR_CONTRACTS.get("SUPERVISOR_START_FAILED");
}

export function createStartupFailureMessage(error) {
  const code = error instanceof CrpError && STARTUP_ERROR_CONTRACTS.has(error.code)
    ? error.code
    : "SUPERVISOR_START_FAILED";
  const contract = startupContract(code);
  return {
    version: 1,
    type: "startup-failed",
    error: {
      code,
      message: contract.message,
      action: contract.action,
      status: contract.status,
      details: sanitizeStartupDetails(error?.details, contract.detailFields)
    }
  };
}

export function parseStartupFailureMessage(message) {
  try {
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_STARTUP_MESSAGE_BYTES
      || !hasExactFields(message, STARTUP_MESSAGE_FIELDS)
      || message.version !== 1 || message.type !== "startup-failed"
      || !hasExactFields(message.error, STARTUP_ERROR_FIELDS)) {
      return null;
    }
    const error = message.error;
    const contract = STARTUP_ERROR_CONTRACTS.get(error.code);
    if (!contract || typeof error.code !== "string" || !ERROR_CODE_PATTERN.test(error.code)
      || !isSafeText(error.message) || !isSafeText(error.action)
      || !Number.isInteger(error.status) || error.status < 400 || error.status > 599
      || !isPlainObject(error.details)
      || error.message !== contract.message || error.action !== contract.action
      || error.status !== contract.status) {
      return null;
    }
    const details = sanitizeStartupDetails(error.details, contract.detailFields);
    if (Object.keys(details).length !== Object.keys(error.details).length) return null;
    return new CrpError(error.code, error.message, error.action, {
      status: error.status,
      details
    });
  } catch {
    return null;
  }
}

export function toPublicError(error, requestId) {
  const safe = error instanceof CrpError
    ? error
    : new CrpError(
      "INTERNAL_ERROR",
      "CRP could not complete the operation.",
      "Open Activity for details."
    );
  return {
    error: {
      code: safe.code,
      message: safe.message,
      action: safe.action,
      requestId,
      details: safe.details
    }
  };
}
