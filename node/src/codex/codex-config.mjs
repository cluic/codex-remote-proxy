import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

const OPENAI_SECTION_HEADER = "[model_providers.OpenAI]";
const STABLE_CONFIG_ERROR_CODES = new Set([
  "CODEX_CONFIG_PARENT_UNSAFE",
  "CODEX_CONFIG_BUSY",
  "CODEX_CONFIG_CHANGED",
  "CODEX_CONFIG_READ_FAILED",
  "CODEX_CONFIG_WRITE_FAILED"
]);
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
};

function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function findSectionRange(lines, sectionHeader) {
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start].trim() !== sectionHeader) {
      continue;
    }
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      const stripped = lines[index].trim();
      if (stripped.startsWith("[") && stripped.endsWith("]")) {
        end = index;
        break;
      }
    }
    return [start, end];
  }
  return null;
}

function renderTomlString(value) {
  return JSON.stringify(value);
}

function upsertKey(lines, startIndex, endIndex, key, value) {
  const rendered = typeof value === "boolean"
    ? (value ? "true" : "false")
    : renderTomlString(String(value));

  for (let index = startIndex; index < endIndex; index += 1) {
    const stripped = lines[index].trim();
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) {
      continue;
    }
    const currentKey = stripped.split("=", 1)[0].trim();
    if (currentKey === key) {
      lines[index] = `${key} = ${rendered}`;
      return;
    }
  }
  lines.splice(endIndex, 0, `${key} = ${rendered}`);
}

function firstSectionIndex(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = lines[index].trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      return index;
    }
  }
  return lines.length;
}

function makeBackupStem(configPath, date) {
  const timestamp = date.toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  return `${configPath}.${timestamp}`;
}

function copyBackupExclusively(configPath, date, fileOperations) {
  const stem = makeBackupStem(configPath, date);
  let suffix = 1;
  let backupPath = `${stem}.bak`;

  while (true) {
    try {
      fileOperations.copyFileSync(
        configPath,
        backupPath,
        fileOperations.constants.COPYFILE_EXCL
      );
      return backupPath;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      backupPath = `${stem}.${suffix}.bak`;
      suffix += 1;
    }
  }
}

function createConfigError(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

function classifyConfigError(error, phase) {
  if (STABLE_CONFIG_ERROR_CODES.has(error?.code)) return error;
  return phase === "read"
    ? createConfigError(
      "CODEX_CONFIG_READ_FAILED",
      "Codex configuration could not be read safely.",
      error
    )
    : createConfigError(
      "CODEX_CONFIG_WRITE_FAILED",
      "Codex configuration could not be written safely.",
      error
    );
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function parentUnsafe(cause) {
  return createConfigError(
    "CODEX_CONFIG_PARENT_UNSAFE",
    "The Codex configuration directory is unsafe.",
    cause
  );
}

function ensureConfigParent(configPath, fileOperations) {
  const parentPath = dirname(configPath);
  let parent;
  try {
    parent = fileOperations.lstatSync(parentPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw parentUnsafe(error);
    try {
      fileOperations.mkdirSync(parentPath, { mode: 0o700 });
      fileOperations.chmodSync(parentPath, 0o700);
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
    try {
      parent = fileOperations.lstatSync(parentPath);
    } catch (error) {
      throw parentUnsafe(error);
    }
  }
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw parentUnsafe();
  }
  return { path: parentPath, identity: parent };
}

function assertConfigParent(parent, fileOperations) {
  let current;
  try {
    current = fileOperations.lstatSync(parent.path);
  } catch (error) {
    throw parentUnsafe(error);
  }
  if (current.isSymbolicLink()
    || !current.isDirectory()
    || !sameIdentity(current, parent.identity)) {
    throw parentUnsafe();
  }
}

function configChanged(cause) {
  return createConfigError(
    "CODEX_CONFIG_CHANGED",
    "Codex configuration changed during bootstrap.",
    cause
  );
}

function readConfigSource(path, fileOperations, { missing = false } = {}) {
  let before;
  try {
    before = fileOperations.lstatSync(path);
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw createConfigError(
      "CODEX_CONFIG_READ_FAILED",
      "Codex configuration could not be read safely."
    );
  }

  const noFollow = typeof fileOperations.constants.O_NOFOLLOW === "number"
    ? fileOperations.constants.O_NOFOLLOW
    : 0;
  let descriptor;
  try {
    descriptor = fileOperations.openSync(
      path,
      fileOperations.constants.O_RDONLY | noFollow
    );
    const opened = fileOperations.fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw configChanged();
    }
    const bytes = Buffer.from(fileOperations.readFileSync(descriptor));
    let after;
    try {
      after = fileOperations.lstatSync(path);
    } catch (error) {
      throw configChanged(error);
    }
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after)) {
      throw configChanged();
    }
    return {
      bytes,
      text: bytes.toString("utf8"),
      identity: opened,
      mode: opened.mode & 0o7777
    };
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
}

function assertCurrentConfig(path, source, fileOperations) {
  const current = readConfigSource(path, fileOperations, { missing: true });
  if (current === null
    || !sameIdentity(current.identity, source.identity)
    || !current.bytes.equals(source.bytes)) {
    throw configChanged();
  }
}

function ensureCanonicalBlocker(path, residualPath, fileOperations) {
  try {
    fileOperations.lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }

  if (residualPath !== null) {
    try {
      fileOperations.linkSync(residualPath, path);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return true;
    }
  }

  let descriptor;
  try {
    descriptor = fileOperations.openSync(path, "wx", 0o600);
    fileOperations.writeFileSync(descriptor, "crp-blocked\n", "utf8");
    fileOperations.fsyncSync(descriptor);
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
    return true;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileOperations.closeSync(descriptor); } catch {}
    }
    return error?.code === "EEXIST";
  }
}

function readClaimedPath(path, fileOperations) {
  const before = fileOperations.lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Claimed path is not a regular file.");
  }
  const noFollow = typeof fileOperations.constants.O_NOFOLLOW === "number"
    ? fileOperations.constants.O_NOFOLLOW
    : 0;
  let descriptor;
  try {
    descriptor = fileOperations.openSync(
      path,
      fileOperations.constants.O_RDONLY | noFollow
    );
    const opened = fileOperations.fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error("Claimed path identity changed.");
    }
    const bytes = Buffer.from(fileOperations.readFileSync(descriptor));
    const after = fileOperations.lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after)) {
      throw new Error("Claimed path identity changed.");
    }
    return { identity: opened, bytes };
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
}

function restoreCanonicalBlocker(claimPath, path, fileOperations) {
  try {
    fileOperations.linkSync(claimPath, path);
  } catch (error) {
    if (error?.code === "EEXIST") return true;
    return ensureCanonicalBlocker(path, claimPath, fileOperations);
  }
  try {
    fileOperations.rmSync(claimPath);
  } catch {
    // The restored canonical hard link remains the blocker.
  }
  return true;
}

function claimOwnedPath(
  path,
  expectedIdentity,
  fileOperations,
  { expectedBytes = null, missingIsRemoved = true, suffix = "claim" } = {}
) {
  const claimPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.${suffix}`);
  try {
    fileOperations.renameSync(path, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT" && missingIsRemoved) return true;
    ensureCanonicalBlocker(path, null, fileOperations);
    return false;
  }

  let claimed;
  try {
    claimed = readClaimedPath(claimPath, fileOperations);
  } catch {
    restoreCanonicalBlocker(claimPath, path, fileOperations);
    return false;
  }
  if (!sameIdentity(claimed.identity, expectedIdentity)
    || expectedBytes !== null && !claimed.bytes.equals(expectedBytes)) {
    restoreCanonicalBlocker(claimPath, path, fileOperations);
    return false;
  }
  try {
    fileOperations.rmSync(claimPath);
    return true;
  } catch {
    restoreCanonicalBlocker(claimPath, path, fileOperations);
    return false;
  }
}

function acquireConfigLock(lockPath, fileOperations) {
  let descriptor;
  try {
    descriptor = fileOperations.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw createConfigError(
        "CODEX_CONFIG_BUSY",
        "Codex configuration is already being updated.",
        error
      );
    }
    throw error;
  }

  let identity;
  const token = Buffer.from(`${randomUUID()}\n`, "utf8");
  try {
    identity = fileOperations.fstatSync(descriptor);
    fileOperations.writeFileSync(descriptor, token);
    fileOperations.fsyncSync(descriptor);
    return { descriptor, identity, token };
  } catch (error) {
    let closed = false;
    try {
      fileOperations.closeSync(descriptor);
      closed = true;
    } catch {}
    if (identity === undefined || !closed) {
      ensureCanonicalBlocker(lockPath, null, fileOperations);
    } else if (!claimOwnedPath(lockPath, identity, fileOperations)) {
      ensureCanonicalBlocker(lockPath, null, fileOperations);
    }
    throw error;
  }
}

function releaseConfigLock(lockPath, lock, parent, fileOperations) {
  let cleanupError;
  try {
    fileOperations.closeSync(lock.descriptor);
  } catch (error) {
    cleanupError = error;
  }
  try {
    assertConfigParent(parent, fileOperations);
    const removed = claimOwnedPath(lockPath, lock.identity, fileOperations, {
      expectedBytes: lock.token,
      missingIsRemoved: false,
      suffix: "release"
    });
    if (!removed) {
      ensureCanonicalBlocker(lockPath, null, fileOperations);
      throw new Error("Codex configuration lock cleanup is uncertain.");
    }
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

function writeFileAtomically(
  path,
  text,
  mode,
  fileOperations,
  beforePublish,
  { exclusive = false } = {}
) {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  let fileDescriptor;
  let tempIdentity;

  try {
    fileDescriptor = fileOperations.openSync(tempPath, "wx", mode);
    tempIdentity = fileOperations.fstatSync(fileDescriptor);
    fileOperations.writeFileSync(fileDescriptor, text, "utf8");
    fileOperations.fsyncSync(fileDescriptor);
    fileOperations.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    const currentTemp = fileOperations.lstatSync(tempPath);
    if (!sameIdentity(currentTemp, tempIdentity)) {
      throw createConfigError(
        "CODEX_CONFIG_CHANGED",
        "Codex configuration changed during bootstrap."
      );
    }
    fileOperations.chmodSync(tempPath, mode);
    beforePublish();
    if (exclusive) {
      try {
        fileOperations.linkSync(tempPath, path);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw createConfigError(
            "CODEX_CONFIG_CHANGED",
            "Codex configuration changed during bootstrap.",
            error
          );
        }
        throw error;
      }
      if (!claimOwnedPath(tempPath, tempIdentity, fileOperations)) {
        throw new Error("Codex configuration temp cleanup is uncertain.");
      }
    } else {
      fileOperations.renameSync(tempPath, path);
    }
    tempIdentity = undefined;
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fileOperations.closeSync(fileDescriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    if (tempIdentity !== undefined) {
      try {
        claimOwnedPath(tempPath, tempIdentity, fileOperations);
      } catch {
        // Preserve the original write failure.
      }
    }
    throw error;
  }
}

export function patchCodexConfigText(text, proxyUrl) {
  const lineEnding = text.match(/\r\n|\n/)?.[0] ?? "\n";
  const lines = splitLines(text);
  const topEnd = firstSectionIndex(lines);
  upsertKey(lines, 0, topEnd, "model_provider", "OpenAI");
  let sectionRange = findSectionRange(lines, OPENAI_SECTION_HEADER);

  if (!sectionRange) {
    if (lines.length && lines.at(-1).trim()) {
      lines.push("");
    }
    lines.push(
      OPENAI_SECTION_HEADER,
      'name = "OpenAI"',
      `base_url = ${renderTomlString(proxyUrl)}`,
      'wire_api = "responses"',
      "requires_openai_auth = true"
    );
    return `${lines.join(lineEnding)}${lineEnding}`;
  }

  const [sectionStart] = sectionRange;
  upsertKey(lines, sectionStart + 1, sectionRange[1], "name", "OpenAI");
  sectionRange = findSectionRange(lines, OPENAI_SECTION_HEADER);
  upsertKey(lines, sectionStart + 1, sectionRange[1], "base_url", proxyUrl);
  sectionRange = findSectionRange(lines, OPENAI_SECTION_HEADER);
  upsertKey(lines, sectionStart + 1, sectionRange[1], "wire_api", "responses");
  sectionRange = findSectionRange(lines, OPENAI_SECTION_HEADER);
  upsertKey(lines, sectionStart + 1, sectionRange[1], "requires_openai_auth", true);
  return `${lines.join(lineEnding)}${lineEnding}`;
}

export function bootstrapCodexConfig({
  configPath,
  proxyUrl,
  now = () => new Date(),
  fileOperations = DEFAULT_FILE_OPERATIONS
}) {
  const lockPath = `${configPath}.crp.lock`;
  let parent;
  let lock;
  let primaryError;
  let phase = "write";

  try {
    parent = ensureConfigParent(configPath, fileOperations);
    lock = acquireConfigLock(lockPath, fileOperations);
    assertConfigParent(parent, fileOperations);
    phase = "read";
    const source = readConfigSource(configPath, fileOperations, { missing: true });
    const sourceExists = source !== null;
    const originalText = source?.text ?? "";
    const patchedText = patchCodexConfigText(originalText, proxyUrl);
    if (patchedText === originalText) {
      return { changed: false, backupPath: null };
    }

    if (!sourceExists) {
      phase = "write";
      writeFileAtomically(
        configPath,
        patchedText,
        0o600,
        fileOperations,
        () => {
          assertConfigParent(parent, fileOperations);
          try {
            fileOperations.lstatSync(configPath);
          } catch (error) {
            if (error?.code === "ENOENT") return;
            throw error;
          }
          throw createConfigError(
            "CODEX_CONFIG_CHANGED",
            "Codex configuration changed during bootstrap."
          );
        },
        { exclusive: true }
      );
      return { changed: true, backupPath: null };
    }

    assertCurrentConfig(configPath, source, fileOperations);
    phase = "write";
    const backupPath = copyBackupExclusively(configPath, now(), fileOperations);
    phase = "read";
    assertCurrentConfig(configPath, source, fileOperations);
    phase = "write";
    writeFileAtomically(
      configPath,
      patchedText,
      source.mode,
      fileOperations,
      () => {
        assertConfigParent(parent, fileOperations);
        assertCurrentConfig(configPath, source, fileOperations);
      }
    );
    return { changed: true, backupPath };
  } catch (error) {
    primaryError = classifyConfigError(error, phase);
    throw primaryError;
  } finally {
    if (lock !== undefined) {
      try {
        releaseConfigLock(lockPath, lock, parent, fileOperations);
      } catch (cleanupError) {
        if (primaryError === undefined) {
          throw classifyConfigError(cleanupError, "write");
        }
      }
    }
  }
}
