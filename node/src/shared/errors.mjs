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
