import { randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

import { CrpError } from "../shared/errors.mjs";

export const SESSION_COOKIE_NAME = "crp_session";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
};

function authError(code, { clearCookie = false, cause } = {}) {
  const contracts = {
    AUTH_CONTROL_TOKEN_INVALID: [
      "The local control token is invalid.",
      "Stop CRP, repair the private control token file, and restart CRP.",
      500
    ],
    AUTH_REQUIRED: [
      "Local authentication is required.",
      "Open the local CRP UI again or provide the local control token.",
      401
    ],
    AUTH_SESSION_EXPIRED: [
      "The local session has expired.",
      "Open the local CRP UI again to create a new session.",
      401
    ],
    AUTH_CSRF_INVALID: [
      "The request could not be verified.",
      "Refresh the local CRP UI and try again.",
      403
    ]
  };
  const [message, action, status] = contracts[code] ?? contracts.AUTH_REQUIRED;
  const error = new CrpError(code, message, action, { status, cause });
  if (clearCookie) {
    Object.defineProperty(error, "clearCookie", { value: true, enumerable: false });
  }
  return error;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPrivateMode(stats, platform) {
  return platform === "win32" || (stats.mode & 0o777) === 0o600;
}

function canonicalToken(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError("randomBytes must return bytes");
  }
  const buffer = Buffer.from(bytes);
  if (buffer.length !== TOKEN_BYTES) throw new TypeError("token byte count is invalid");
  return buffer.toString("base64url");
}

function parseStoredToken(text) {
  if (typeof text !== "string") throw new TypeError("control token bytes are invalid");
  const token = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!TOKEN_PATTERN.test(token) || text !== token && text !== `${token}\n`) {
    throw new TypeError("control token format is invalid");
  }
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== TOKEN_BYTES || bytes.toString("base64url") !== token) {
    throw new TypeError("control token encoding is invalid");
  }
  return token;
}

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function ensurePrivateParent(path, fileOperations, platform) {
  const parent = dirname(path);
  fileOperations.mkdirSync(parent, { recursive: true, mode: 0o700 });
  let stats = fileOperations.lstatSync(parent);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError("control token parent is unsafe");
  }
  if (platform !== "win32") {
    fileOperations.chmodSync(parent, 0o700);
    stats = fileOperations.lstatSync(parent);
    if ((stats.mode & 0o777) !== 0o700) throw new TypeError("control token parent is not private");
  }
}

function readExistingToken(path, fileOperations, platform) {
  const before = fileOperations.lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || !isPrivateMode(before, platform)) {
    throw new TypeError("control token path is unsafe");
  }
  if (before.size < 43 || before.size > 44) throw new TypeError("control token size is invalid");

  let descriptor;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = fileOperations.openSync(path, constants.O_RDONLY | noFollow);
    const opened = fileOperations.fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened) || !isPrivateMode(opened, platform)) {
      throw new TypeError("control token identity changed");
    }
    const text = fileOperations.readFileSync(descriptor, "utf8");
    const after = fileOperations.lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after)) {
      throw new TypeError("control token identity changed");
    }
    return parseStoredToken(text);
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
}

function createTokenFile(path, token, fileOperations) {
  let descriptor;
  try {
    descriptor = fileOperations.openSync(path, "wx", 0o600);
    fileOperations.writeFileSync(descriptor, `${token}\n`, "utf8");
    fileOperations.fsyncSync(descriptor);
    fileOperations.fchmodSync(descriptor, 0o600);
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
}

function loadOrCreateControlToken({
  path,
  randomBytes,
  fileOperations,
  platform
}) {
  try {
    ensurePrivateParent(path, fileOperations, platform);
    try {
      return readExistingToken(path, fileOperations, platform);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const token = canonicalToken(randomBytes(TOKEN_BYTES));
    try {
      createTokenFile(path, token, fileOperations);
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return readExistingToken(path, fileOperations, platform);
    }
  } catch (error) {
    if (error instanceof CrpError) throw error;
    throw authError("AUTH_CONTROL_TOKEN_INVALID", { cause: error });
  }
}

function bearerToken(authorization) {
  if (typeof authorization !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function sessionCookie(cookie) {
  if (typeof cookie !== "string") return null;
  const matches = [];
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length !== 1 || !TOKEN_PATTERN.test(matches[0])) return null;
  return matches[0];
}

export class SessionAuth {
  #controlToken;
  #randomBytes;
  #now;
  #sessionTtlMs;
  #sessions = new Map();

  constructor({
    controlTokenPath,
    randomBytes = cryptoRandomBytes,
    now = () => Date.now(),
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    fileOperations = DEFAULT_FILE_OPERATIONS,
    platform = process.platform
  } = {}) {
    if (typeof controlTokenPath !== "string" || controlTokenPath.length === 0
      || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1) {
      throw authError("AUTH_CONTROL_TOKEN_INVALID");
    }
    this.#randomBytes = randomBytes;
    this.#now = now;
    this.#sessionTtlMs = sessionTtlMs;
    this.#controlToken = loadOrCreateControlToken({
      path: controlTokenPath,
      randomBytes,
      fileOperations,
      platform
    });
  }

  createBrowserSession(authorization) {
    const token = bearerToken(authorization);
    if (!secureEqual(token, this.#controlToken)) throw authError("AUTH_REQUIRED");
    this.#purgeExpired();
    const sessionId = canonicalToken(this.#randomBytes(TOKEN_BYTES));
    const csrfToken = canonicalToken(this.#randomBytes(TOKEN_BYTES));
    const expiresAtMs = this.#now() + this.#sessionTtlMs;
    this.#sessions.set(sessionId, { csrfToken, expiresAtMs });
    return {
      csrfToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
      setCookie: `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(this.#sessionTtlMs / 1_000)}`
    };
  }

  authorize({ authorization, cookie, csrfToken, mutation = false } = {}) {
    if (authorization !== undefined && authorization !== null) {
      const token = bearerToken(authorization);
      if (!secureEqual(token, this.#controlToken)) throw authError("AUTH_REQUIRED");
      return { kind: "cli" };
    }

    const sessionId = sessionCookie(cookie);
    const session = sessionId === null ? null : this.#sessions.get(sessionId);
    if (!session) throw authError("AUTH_REQUIRED");
    if (this.#now() >= session.expiresAtMs) {
      this.#sessions.delete(sessionId);
      throw authError("AUTH_SESSION_EXPIRED", { clearCookie: true });
    }
    if (mutation && !secureEqual(csrfToken, session.csrfToken)) {
      throw authError("AUTH_CSRF_INVALID");
    }
    return { kind: "browser" };
  }

  clearCookie() {
    return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  close() {
    this.#sessions.clear();
  }

  #purgeExpired() {
    const now = this.#now();
    for (const [sessionId, session] of this.#sessions) {
      if (now >= session.expiresAtMs) this.#sessions.delete(sessionId);
    }
  }
}
