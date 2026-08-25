import { randomBytes as cryptoRandomBytes } from "node:crypto";
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

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_FILE_OPERATIONS = {
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
};

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalToken(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError("private token random source is invalid");
  }
  const buffer = Buffer.from(bytes);
  if (buffer.length !== TOKEN_BYTES) throw new TypeError("private token size is invalid");
  return buffer.toString("base64url");
}

function parseToken(text) {
  if (typeof text !== "string") throw new TypeError("private token bytes are invalid");
  const token = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!TOKEN_PATTERN.test(token) || (text !== token && text !== `${token}\n`)) {
    throw new TypeError("private token format is invalid");
  }
  return token;
}

function ensureParent(path, fileOperations, platform) {
  const parent = dirname(path);
  fileOperations.mkdirSync(parent, { recursive: true, mode: 0o700 });
  let stats = fileOperations.lstatSync(parent);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError("private token parent is unsafe");
  }
  if (platform !== "win32") {
    fileOperations.chmodSync(parent, 0o700);
    stats = fileOperations.lstatSync(parent);
    if ((stats.mode & 0o777) !== 0o700) {
      throw new TypeError("private token parent is not private");
    }
  }
}

function readToken(path, fileOperations, platform) {
  const before = fileOperations.lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()
    || (platform !== "win32" && (before.mode & 0o777) !== 0o600)
    || before.size < 43 || before.size > 44) {
    throw new TypeError("private token path is unsafe");
  }
  let descriptor;
  try {
    const noFollow = typeof fileOperations.constants.O_NOFOLLOW === "number"
      ? fileOperations.constants.O_NOFOLLOW
      : 0;
    descriptor = fileOperations.openSync(
      path,
      fileOperations.constants.O_RDONLY | noFollow
    );
    const opened = fileOperations.fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new TypeError("private token identity changed");
    }
    const token = parseToken(fileOperations.readFileSync(descriptor, "utf8"));
    const after = fileOperations.lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after)) {
      throw new TypeError("private token identity changed");
    }
    return token;
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
}

function createToken(path, token, fileOperations) {
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

export function loadOrCreatePrivateToken({
  path,
  randomBytes = cryptoRandomBytes,
  fileOperations = DEFAULT_FILE_OPERATIONS,
  platform = process.platform
} = {}) {
  if (typeof path !== "string" || path.length === 0 || typeof randomBytes !== "function") {
    throw new TypeError("private token input is invalid");
  }
  ensureParent(path, fileOperations, platform);
  try {
    return readToken(path, fileOperations, platform);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const token = canonicalToken(randomBytes(TOKEN_BYTES));
  try {
    createToken(path, token, fileOperations);
    return token;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return readToken(path, fileOperations, platform);
  }
}
