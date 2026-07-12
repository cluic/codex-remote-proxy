import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

const OPENAI_SECTION_HEADER = "[model_providers.OpenAI]";
const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
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

function acquireConfigLock(lockPath, fileOperations) {
  try {
    return fileOperations.openSync(lockPath, "wx", 0o600);
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
}

function releaseConfigLock(lockPath, fileDescriptor, fileOperations) {
  let cleanupError;
  try {
    fileOperations.closeSync(fileDescriptor);
  } catch (error) {
    cleanupError = error;
  }
  try {
    fileOperations.rmSync(lockPath, { force: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

function writeFileAtomically(path, text, mode, fileOperations, beforeRename) {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  let fileDescriptor;

  try {
    fileDescriptor = fileOperations.openSync(tempPath, "wx", mode);
    fileOperations.writeFileSync(fileDescriptor, text, "utf8");
    fileOperations.fsyncSync(fileDescriptor);
    fileOperations.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fileOperations.chmodSync(tempPath, mode);
    beforeRename();
    fileOperations.renameSync(tempPath, path);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fileOperations.closeSync(fileDescriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      fileOperations.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original write failure.
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
  let lockFileDescriptor;

  try {
    lockFileDescriptor = acquireConfigLock(lockPath, fileOperations);
    const originalText = fileOperations.readFileSync(configPath, "utf8");
    const patchedText = patchCodexConfigText(originalText, proxyUrl);
    if (patchedText === originalText) {
      return { changed: false, backupPath: null };
    }

    const sourceMode = fileOperations.statSync(configPath).mode & 0o7777;
    const backupPath = copyBackupExclusively(configPath, now(), fileOperations);
    writeFileAtomically(
      configPath,
      patchedText,
      sourceMode,
      fileOperations,
      () => {
        if (fileOperations.readFileSync(configPath, "utf8") !== originalText) {
          throw createConfigError(
            "CODEX_CONFIG_CHANGED",
            "Codex configuration changed during bootstrap."
          );
        }
      }
    );
    return { changed: true, backupPath };
  } finally {
    if (lockFileDescriptor !== undefined) {
      releaseConfigLock(lockPath, lockFileDescriptor, fileOperations);
    }
  }
}
