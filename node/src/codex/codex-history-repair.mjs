import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as FS_CONSTANTS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import { CrpError } from "../shared/errors.mjs";

const MANAGED_BY = "codex-remote-proxy/history-repair";
const SCHEMA_VERSION = 1;
const MANAGED_DIRECTORY = ".crp-history-repair";
const PENDING_FILE = "pending.json";
const CLEARING_FILE = "pending.json.clearing";
const BACKUP_DIRECTORY = "backups";
const BACKUP_METADATA_FILE = "metadata.json";
const TARGET_PROVIDER = "OpenAI";
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATABASE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);
const DATABASE_SIDECAR_SUFFIXES = Object.freeze(["-wal", "-shm", "-journal"]);
const MAX_SUMMARY_COUNT = 1_000_000;
const EXACT_JOURNAL_FIELDS = new Set([
  "schemaVersion",
  "managedBy",
  "operationId",
  "sourceConfigSha256",
  "targetConfigSha256",
  "targetProvider",
  "createdAt"
]);

const DEFAULT_FILE_OPERATIONS = {
  chmodSync,
  closeSync,
  constants: FS_CONSTANTS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  fsyncDirectorySync: defaultFsyncDirectorySync,
  writeFileSync
};

let sqliteModulePromise;

function defaultFsyncDirectorySync(path) {
  if (process.platform === "win32") return;
  const directoryFlag = typeof FS_CONSTANTS.O_DIRECTORY === "number"
    ? FS_CONSTANTS.O_DIRECTORY
    : 0;
  let descriptor;
  try {
    descriptor = openSync(path, FS_CONSTANTS.O_RDONLY | directoryFlag);
    const stats = fstatSync(descriptor);
    if (!stats.isDirectory()) throw new Error("Directory identity is invalid.");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const DEFAULT_DATABASE_OPERATIONS = {
  async open(path) {
    sqliteModulePromise ??= import("node:sqlite");
    const { DatabaseSync } = await sqliteModulePromise;
    return new DatabaseSync(path);
  },
  async backup(database, destination) {
    sqliteModulePromise ??= import("node:sqlite");
    const { backup } = await sqliteModulePromise;
    await backup(database, destination);
  }
};

function repairError(code, cause) {
  const contracts = {
    CODEX_HISTORY_REPAIR_INVALID: [
      "The Codex history repair input is invalid.",
      "Review the Codex provider configuration before retrying.",
      400
    ],
    CODEX_HISTORY_REPAIR_CONFLICT: [
      "The Codex history repair state conflicts with the current configuration.",
      "Stop Codex, review the pending local transition, and retry.",
      409
    ],
    CODEX_HISTORY_REPAIR_FAILED: [
      "CRP could not repair Codex history safely.",
      "Stop Codex, review local storage health, and retry.",
      500
    ],
    CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED: [
      "The Codex provider change was published, but history repair is incomplete.",
      "Keep the pending repair state and retry before starting Codex.",
      500
    ],
    CODEX_CONFIG_COMMITTED_DEGRADED: [
      "The Codex configuration was updated, but completion could not be confirmed.",
      "Review the Codex configuration and retry before starting the proxy.",
      500
    ]
  };
  const [message, action, status] = contracts[code]
    ?? contracts.CODEX_HISTORY_REPAIR_FAILED;
  const details = code === "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED"
    ? { committed: true, degraded: true, pending: true }
    : code === "CODEX_CONFIG_COMMITTED_DEGRADED"
      ? { committed: true, degraded: true, pending: false }
      : {};
  return new CrpError(code, message, action, { status, details, cause });
}

function invalid(cause) {
  return repairError("CODEX_HISTORY_REPAIR_INVALID", cause);
}

function conflict(cause) {
  return repairError("CODEX_HISTORY_REPAIR_CONFLICT", cause);
}

function failed(cause) {
  return repairError("CODEX_HISTORY_REPAIR_FAILED", cause);
}

function committedDegraded(cause) {
  return repairError("CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED", cause);
}

function configCommittedDegraded(cause) {
  return repairError("CODEX_CONFIG_COMMITTED_DEGRADED", cause);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, fields) {
  return isPlainObject(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

function asBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw invalid();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(left, right) {
  return left !== null && right !== null
    && left.dev === right.dev
    && left.ino === right.ino;
}

function identityOf(stats) {
  return { dev: stats.dev, ino: stats.ino };
}

function boundedAdd(value, increment = 1) {
  return Math.min(MAX_SUMMARY_COUNT, value + increment);
}

function nextSafeId(createId) {
  const value = createId();
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) throw invalid();
  return value;
}

function syncDirectory(path, fileOperations) {
  if (typeof fileOperations.fsyncDirectorySync !== "function") throw invalid();
  fileOperations.fsyncDirectorySync(path);
}

function normalizedUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw invalid();
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw invalid(error);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)
    || parsed.username.length > 0 || parsed.password.length > 0
    || parsed.hash.length > 0) {
    throw invalid();
  }
  return parsed.href;
}

function parseBasicString(text, start) {
  const multiline = text.slice(start, start + 3) === "\"\"\"";
  const delimiterLength = multiline ? 3 : 1;
  let value = "";
  let index = start + delimiterLength;
  if (multiline) {
    if (text.slice(index, index + 2) === "\r\n") index += 2;
    else if (text[index] === "\n") index += 1;
  }
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\"") {
      if (!multiline) return { value, end: index + 1 };
      let quoteCount = 1;
      while (text[index + quoteCount] === "\"") quoteCount += 1;
      if (quoteCount >= 3) {
        if (quoteCount > 5) throw invalid();
        value += "\"".repeat(quoteCount - 3);
        return { value, end: index + quoteCount };
      }
      value += "\"".repeat(quoteCount);
      index += quoteCount - 1;
      continue;
    }
    if (!multiline && (character === "\n" || character === "\r")) throw invalid();
    if (character !== "\\") {
      if (character === "\0"
        || (character < " " && character !== "\t" && character !== "\n" && character !== "\r")) {
        throw invalid();
      }
      value += character;
      continue;
    }
    index += 1;
    if (index >= text.length) throw invalid();
    if (multiline) {
      let continuation = index;
      while (text[continuation] === " " || text[continuation] === "\t") {
        continuation += 1;
      }
      if (text[continuation] === "\n" || text[continuation] === "\r") {
        index = continuation;
        if (text[index] === "\r") {
          if (text[index + 1] !== "\n") throw invalid();
          index += 1;
        }
        while (/\s/.test(text[index + 1] ?? "")) index += 1;
        continue;
      }
    }
    const escape = text[index];
    const simple = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      "\"": "\"",
      "\\": "\\"
    };
    if (Object.hasOwn(simple, escape)) {
      value += simple[escape];
      continue;
    }
    if (escape !== "u" && escape !== "U") throw invalid();
    const length = escape === "u" ? 4 : 8;
    const encoded = text.slice(index + 1, index + 1 + length);
    if (!new RegExp(`^[A-Fa-f0-9]{${length}}$`).test(encoded)) throw invalid();
    const codePoint = Number.parseInt(encoded, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw invalid();
    }
    value += String.fromCodePoint(codePoint);
    index += length;
  }
  throw invalid();
}

function parseLiteralString(text, start) {
  const multiline = text.slice(start, start + 3) === "'''";
  let index = start + (multiline ? 3 : 1);
  if (multiline) {
    if (text.slice(index, index + 2) === "\r\n") index += 2;
    else if (text[index] === "\n") index += 1;
  }
  let value = "";
  for (; index < text.length; index += 1) {
    if (text[index] === "'") {
      if (!multiline) return { value, end: index + 1 };
      let quoteCount = 1;
      while (text[index + quoteCount] === "'") quoteCount += 1;
      if (quoteCount >= 3) {
        if (quoteCount > 5) throw invalid();
        value += "'".repeat(quoteCount - 3);
        return { value, end: index + quoteCount };
      }
      value += "'".repeat(quoteCount);
      index += quoteCount - 1;
      continue;
    }
    if (!multiline && (text[index] === "\n" || text[index] === "\r")) throw invalid();
    if (text[index] === "\0"
      || (text[index] < " " && text[index] !== "\t"
        && text[index] !== "\n" && text[index] !== "\r")) {
      throw invalid();
    }
    value += text[index];
  }
  throw invalid();
}

function parseTomlStringAt(text, start = 0) {
  if (text[start] === "\"") return parseBasicString(text, start);
  if (text[start] === "'") return parseLiteralString(text, start);
  throw invalid();
}

function assertOnlyComment(text, start) {
  const remainder = text.slice(start).trimStart();
  if (remainder.length > 0 && !remainder.startsWith("#")) throw invalid();
}

function parseStringValue(text) {
  const start = text.search(/\S/);
  if (start === -1) throw invalid();
  const parsed = parseTomlStringAt(text, start);
  assertOnlyComment(text, parsed.end);
  return parsed.value;
}

function parseDottedKey(text) {
  const parts = [];
  let index = 0;
  while (index < text.length) {
    while (/\s/.test(text[index] ?? "")) index += 1;
    if (index >= text.length) throw invalid();
    if (text[index] === "\"" || text[index] === "'") {
      if (text.slice(index, index + 3) === "\"\"\""
        || text.slice(index, index + 3) === "'''") {
        throw invalid();
      }
      const parsed = parseTomlStringAt(text, index);
      parts.push(parsed.value);
      index = parsed.end;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(index));
      if (!match) throw invalid();
      parts.push(match[0]);
      index += match[0].length;
    }
    while (/\s/.test(text[index] ?? "")) index += 1;
    if (index >= text.length) break;
    if (text[index] !== ".") throw invalid();
    index += 1;
    if (text.slice(index).trim().length === 0) throw invalid();
  }
  return parts;
}

function findUnquoted(text, wanted) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === "\"") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === wanted) return index;
  }
  return -1;
}

function parseHeader(line) {
  const stripped = line.trimStart();
  const array = stripped.startsWith("[[");
  const openingLength = array ? 2 : 1;
  const end = findUnquoted(stripped.slice(openingLength), "]");
  if (end === -1) throw invalid();
  const closing = end + openingLength;
  const afterClosing = array ? closing + 2 : closing + 1;
  if (array && stripped[closing + 1] !== "]") throw invalid();
  assertOnlyComment(stripped, afterClosing);
  return {
    array,
    path: parseDottedKey(stripped.slice(openingLength, closing))
  };
}

function parseAssignment(line) {
  const equals = findUnquoted(line, "=");
  if (equals === -1) return null;
  return {
    key: parseDottedKey(line.slice(0, equals)),
    value: line.slice(equals + 1)
  };
}

function scanTomlValueEnd(lines, startLine, startColumn) {
  const fragments = lines.slice(startLine);
  fragments[0] = fragments[0].slice(startColumn);
  const text = fragments.join("\n");
  let mode = null;
  let bracketDepth = 0;
  let braceDepth = 0;
  let lineOffset = 0;
  let sawValue = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (mode === "basic") {
      if (character === "\\") {
        if (text[index + 1] === undefined || text[index + 1] === "\n") throw invalid();
        index += 1;
      } else if (character === "\"") {
        mode = null;
      } else if (character === "\n" || character === "\r") {
        throw invalid();
      }
      continue;
    }
    if (mode === "literal") {
      if (character === "'") mode = null;
      else if (character === "\n" || character === "\r") throw invalid();
      continue;
    }
    if (mode === "multiline-basic") {
      if (character === "\\") {
        if (text[index + 1] === "\n") lineOffset += 1;
        if (text[index + 1] !== undefined) index += 1;
        continue;
      }
      if (text.slice(index, index + 3) === "\"\"\"") {
        let count = 3;
        while (text[index + count] === "\"") count += 1;
        if (count > 5) throw invalid();
        mode = null;
        index += count - 1;
      } else if (character === "\n") {
        lineOffset += 1;
      }
      continue;
    }
    if (mode === "multiline-literal") {
      if (text.slice(index, index + 3) === "'''") {
        let count = 3;
        while (text[index + count] === "'") count += 1;
        if (count > 5) throw invalid();
        mode = null;
        index += count - 1;
      } else if (character === "\n") {
        lineOffset += 1;
      }
      continue;
    }
    if (character === "#") {
      const newline = text.indexOf("\n", index);
      if (newline === -1) {
        if (!sawValue || bracketDepth !== 0 || braceDepth !== 0) throw invalid();
        return startLine + lineOffset;
      }
      index = newline - 1;
      continue;
    }
    if (character === "\n") {
      if (bracketDepth === 0 && braceDepth === 0) {
        if (!sawValue) throw invalid();
        return startLine + lineOffset;
      }
      lineOffset += 1;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") continue;
    sawValue = true;
    if (text.slice(index, index + 3) === "\"\"\"") {
      mode = "multiline-basic";
      index += 2;
    } else if (text.slice(index, index + 3) === "'''") {
      mode = "multiline-literal";
      index += 2;
    } else if (character === "\"") {
      mode = "basic";
    } else if (character === "'") {
      mode = "literal";
    } else if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) throw invalid();
    } else if (character === "{") {
      braceDepth += 1;
    } else if (character === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) throw invalid();
    }
  }
  if (!sawValue || mode !== null || bracketDepth !== 0 || braceDepth !== 0) throw invalid();
  return lines.length - 1;
}

function statementValue(lines, statement) {
  const fragments = lines.slice(statement.startLine, statement.endLine + 1);
  fragments[0] = fragments[0].slice(statement.valueColumn);
  return fragments.join("\n");
}

function absoluteAssignmentPath(section, key) {
  return section === null ? [...key] : [...section.path, ...key];
}

function samePath(left, right) {
  return left.length === right.length
    && left.every((part, index) => part === right[index]);
}

function startsWithPath(path, prefix) {
  return path.length >= prefix.length
    && prefix.every((part, index) => path[index] === part);
}

function pathsOverlap(left, right) {
  return startsWithPath(left, right) || startsWithPath(right, left);
}

function scanTomlDocument(text) {
  if (typeof text !== "string") throw invalid();
  const lineEnding = text.match(/\r\n|\n/)?.[0] ?? "\n";
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const statements = [];
  let currentSection = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const stripped = rawLine.trimStart();
    if (stripped.length === 0 || stripped.startsWith("#")) continue;
    if (stripped.startsWith("[")) {
      const header = parseHeader(rawLine);
      currentSection = header;
      statements.push({
        kind: header.array ? "array-table" : "table",
        path: header.path,
        startLine: lineIndex,
        endLine: lineIndex
      });
      continue;
    }
    const assignment = parseAssignment(rawLine);
    if (assignment === null) throw invalid();
    const equals = findUnquoted(rawLine, "=");
    const endLine = scanTomlValueEnd(lines, lineIndex, equals + 1);
    const section = currentSection === null ? null : {
      array: currentSection.array,
      path: [...currentSection.path]
    };
    const statement = {
      kind: "assignment",
      key: assignment.key,
      absolutePath: absoluteAssignmentPath(section, assignment.key),
      section,
      startLine: lineIndex,
      endLine,
      valueColumn: equals + 1
    };
    statements.push(statement);
    lineIndex = endLine;
  }
  return { lineEnding, lines, statements };
}

function assignmentsAt(document, path) {
  return document.statements.filter(
    (statement) => statement.kind === "assignment"
      && samePath(statement.absolutePath, path)
  );
}

function tablesAt(document, path, array) {
  return document.statements.filter(
    (statement) => statement.kind === (array ? "array-table" : "table")
      && samePath(statement.path, path)
  );
}

export function inspectCodexProviderBinding(text) {
  const document = scanTomlDocument(text);
  const rootAssignments = assignmentsAt(document, ["model_provider"]);
  const rootConflicts = document.statements.filter(
    (statement) => (statement.kind === "assignment"
      ? pathsOverlap(statement.absolutePath, ["model_provider"])
        && !samePath(statement.absolutePath, ["model_provider"])
      : startsWithPath(statement.path, ["model_provider"]))
  );
  if (rootAssignments.length > 1 || rootConflicts.length > 0) throw invalid();
  const providerName = rootAssignments.length === 0
    ? null
    : parseStringValue(statementValue(document.lines, rootAssignments[0]));
  if (providerName === null) {
    return Object.freeze({
      providerName: null,
      baseUrl: null,
      normalizedBaseUrl: null
    });
  }
  if (providerName.length === 0) throw invalid();
  const providerPath = ["model_providers", providerName];
  const sections = tablesAt(document, providerPath, false);
  const arraySections = tablesAt(document, providerPath, true);
  const baseUrlAssignments = assignmentsAt(document, [...providerPath, "base_url"]);
  const selectedAssignments = document.statements.filter(
    (statement) => statement.kind === "assignment"
      && startsWithPath(statement.absolutePath, providerPath)
  );
  const selectedContext = (statement) => {
    if (statement.section === null && startsWithPath(statement.key, providerPath)) {
      return "root-dotted";
    }
    if (statement.section?.array === false
      && samePath(statement.section.path, ["model_providers"])
      && startsWithPath(statement.key, [providerName])) {
      return "provider-parent";
    }
    if (statement.section?.array === false
      && samePath(statement.section.path, providerPath)) {
      return "provider-table";
    }
    return null;
  };
  const selectedContexts = new Set(
    selectedAssignments.map(selectedContext).filter((context) => context !== null)
  );
  const providerConflicts = document.statements.filter(
    (statement) => statement.kind === "assignment"
      && pathsOverlap(statement.absolutePath, providerPath)
      && (!startsWithPath(statement.absolutePath, providerPath)
        || samePath(statement.absolutePath, providerPath))
  );
  const baseUrlTableConflicts = document.statements.filter(
    (statement) => statement.kind !== "assignment"
      && startsWithPath(statement.path, [...providerPath, "base_url"])
  );
  if (sections.length > 1 || arraySections.length > 0 || baseUrlAssignments.length > 1
    || providerConflicts.length > 0 || baseUrlTableConflicts.length > 0
    || (sections.length === 1
      && [...selectedContexts].some((context) => context !== "provider-table"))
    || (sections.length === 0 && selectedContexts.size > 1)) {
    throw invalid();
  }
  const baseUrl = baseUrlAssignments.length === 0
    ? null
    : parseStringValue(statementValue(document.lines, baseUrlAssignments[0]));
  return Object.freeze({
    providerName,
    baseUrl,
    normalizedBaseUrl: baseUrl === null ? null : normalizedUrl(baseUrl)
  });
}

function replaceStatement(lines, statement, replacement) {
  lines.splice(
    statement.startLine,
    statement.endLine - statement.startLine + 1,
    replacement
  );
}

function renderedDocument(lines, lineEnding) {
  return `${lines.join(lineEnding)}${lineEnding}`;
}

export function patchCodexProviderConfigText(text, proxyUrl) {
  normalizedUrl(proxyUrl);
  let document = scanTomlDocument(text);
  const rootAssignments = assignmentsAt(document, ["model_provider"]);
  const rootConflicts = document.statements.filter(
    (statement) => (statement.kind === "assignment"
      ? pathsOverlap(statement.absolutePath, ["model_provider"])
        && !samePath(statement.absolutePath, ["model_provider"])
      : startsWithPath(statement.path, ["model_provider"]))
  );
  if (rootAssignments.length > 1 || rootConflicts.length > 0) throw invalid();
  if (rootAssignments.length === 1) {
    replaceStatement(document.lines, rootAssignments[0], 'model_provider = "OpenAI"');
  } else {
    const firstHeader = document.statements.find(
      (statement) => statement.kind === "table" || statement.kind === "array-table"
    );
    document.lines.splice(firstHeader?.startLine ?? document.lines.length, 0,
      'model_provider = "OpenAI"');
  }

  document = scanTomlDocument(renderedDocument(document.lines, document.lineEnding));
  const providerPath = ["model_providers", TARGET_PROVIDER];
  const providerTables = tablesAt(document, providerPath, false);
  const providerArrays = tablesAt(document, providerPath, true);
  const overlappingArrays = document.statements.filter(
    (statement) => statement.kind === "array-table"
      && startsWithPath(providerPath, statement.path)
  );
  if (providerTables.length > 1 || providerArrays.length > 0
    || overlappingArrays.length > 0) {
    throw invalid();
  }
  const providerAssignments = document.statements.filter(
    (statement) => statement.kind === "assignment"
      && startsWithPath(statement.absolutePath, providerPath)
  );
  const providerParentConflicts = document.statements.filter(
    (statement) => statement.kind === "assignment"
      && startsWithPath(providerPath, statement.absolutePath)
  );
  if (providerParentConflicts.length > 0) throw invalid();

  const desired = [
    [[...providerPath, "name"], "name", '"OpenAI"'],
    [[...providerPath, "base_url"], "base_url", JSON.stringify(proxyUrl)],
    [[...providerPath, "wire_api"], "wire_api", '"responses"'],
    [[...providerPath, "requires_openai_auth"], "requires_openai_auth", "true"]
  ];
  const directContext = (statement) => {
    if (statement.section === null && startsWithPath(statement.key, providerPath)) {
      return "root-dotted";
    }
    if (statement.section?.array === false
      && samePath(statement.section.path, ["model_providers"])
      && startsWithPath(statement.key, [TARGET_PROVIDER])) {
      return "provider-parent";
    }
    if (statement.section?.array === false
      && samePath(statement.section.path, providerPath)) {
      return "provider-table";
    }
    return null;
  };
  const contexts = new Set(
    providerAssignments.map(directContext).filter((context) => context !== null)
  );
  let context;
  if (providerTables.length === 1) {
    if ([...contexts].some((value) => value !== "provider-table")) throw invalid();
    context = "provider-table";
  } else if (contexts.size === 1) {
    [context] = contexts;
  } else if (contexts.size > 1) {
    throw invalid();
  } else {
    if (document.lines.length > 0 && document.lines.at(-1).trim() !== "") {
      document.lines.push("");
    }
    document.lines.push(
      "[model_providers.OpenAI]",
      ...desired.map(([, field, value]) => `${field} = ${value}`)
    );
    const output = renderedDocument(document.lines, document.lineEnding);
    const binding = inspectCodexProviderBinding(output);
    if (binding.providerName !== TARGET_PROVIDER
      || binding.normalizedBaseUrl !== normalizedUrl(proxyUrl)) {
      throw invalid();
    }
    return output;
  }

  const lineFor = (field, value) => {
    if (context === "root-dotted") {
      return `model_providers.OpenAI.${field} = ${value}`;
    }
    if (context === "provider-parent") return `OpenAI.${field} = ${value}`;
    return `${field} = ${value}`;
  };

  const existing = [];
  for (const [path, field, value] of desired) {
    const matches = assignmentsAt(document, path);
    if (matches.length > 1) throw invalid();
    const childConflicts = document.statements.filter(
      (statement) => statement.kind === "assignment"
        ? startsWithPath(statement.absolutePath, path)
          && !samePath(statement.absolutePath, path)
        : startsWithPath(statement.path, path)
    );
    if (childConflicts.length > 0) throw invalid();
    if (matches.length === 1) {
      const [statement] = matches;
      if (directContext(statement) !== context) throw invalid();
      existing.push({ statement, replacement: lineFor(field, value) });
    }
  }
  existing.sort((left, right) => right.statement.startLine - left.statement.startLine);
  for (const entry of existing) {
    replaceStatement(document.lines, entry.statement, entry.replacement);
  }

  document = scanTomlDocument(renderedDocument(document.lines, document.lineEnding));
  let insertionLine;
  if (context === "root-dotted") {
    const firstHeader = document.statements.find(
      (statement) => statement.kind === "table" || statement.kind === "array-table"
    );
    insertionLine = firstHeader?.startLine ?? document.lines.length;
  } else {
    const hostPath = context === "provider-parent" ? ["model_providers"] : providerPath;
    const hosts = tablesAt(document, hostPath, false);
    if (hosts.length !== 1 || tablesAt(document, hostPath, true).length > 0) throw invalid();
    const nextHeader = document.statements.find(
      (statement) => (statement.kind === "table" || statement.kind === "array-table")
        && statement.startLine > hosts[0].startLine
    );
    insertionLine = nextHeader?.startLine ?? document.lines.length;
  }
  const missing = desired.filter(([path]) => assignmentsAt(document, path).length === 0);
  if (missing.length > 0) {
    document.lines.splice(
      insertionLine,
      0,
      ...missing.map(([, field, value]) => lineFor(field, value))
    );
  }
  const output = renderedDocument(document.lines, document.lineEnding);
  const binding = inspectCodexProviderBinding(output);
  if (binding.providerName !== TARGET_PROVIDER
    || binding.normalizedBaseUrl !== normalizedUrl(proxyUrl)) {
    throw invalid();
  }
  return output;
}

export function planCodexProviderTransition({
  sourceExists,
  sourceText,
  targetText,
  targetProvider,
  targetBaseUrl
}) {
  if (typeof sourceExists !== "boolean" || typeof targetText !== "string"
    || typeof targetProvider !== "string" || targetProvider.length === 0
    || typeof targetBaseUrl !== "string") {
    throw invalid();
  }
  if (targetProvider !== TARGET_PROVIDER) throw invalid();
  const target = inspectCodexProviderBinding(targetText);
  const expectedTargetUrl = normalizedUrl(targetBaseUrl);
  if (target.providerName !== targetProvider
    || target.normalizedBaseUrl !== expectedTargetUrl) {
    throw invalid();
  }
  const targetBytes = Buffer.from(targetText, "utf8");
  if (!sourceExists) {
    return Object.freeze({
      required: false,
      reason: "source-missing",
      sourceConfigSha256: null,
      targetConfigSha256: sha256(targetBytes)
    });
  }
  if (typeof sourceText !== "string") throw invalid();
  const source = inspectCodexProviderBinding(sourceText);
  const sourceHash = sha256(Buffer.from(sourceText, "utf8"));
  const targetHash = sha256(targetBytes);
  if (source.normalizedBaseUrl === expectedTargetUrl) {
    return Object.freeze({
      required: false,
      reason: "base-url-unchanged",
      sourceConfigSha256: sourceHash,
      targetConfigSha256: targetHash
    });
  }
  return Object.freeze({
    required: true,
    reason: source.normalizedBaseUrl === null
      ? "source-binding-missing"
      : "base-url-changed",
    sourceConfigSha256: sourceHash,
    targetConfigSha256: targetHash
  });
}

function rootContext(codexRoot, fileOperations) {
  if (typeof codexRoot !== "string" || !isAbsolute(codexRoot)) throw invalid();
  const path = resolve(codexRoot);
  let stats;
  try {
    stats = fileOperations.lstatSync(path);
  } catch (error) {
    throw invalid(error);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw invalid();
  return { path, identity: identityOf(stats) };
}

function assertRoot(context, fileOperations) {
  let stats;
  try {
    stats = fileOperations.lstatSync(context.path);
  } catch (error) {
    throw conflict(error);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || !sameIdentity(context.identity, identityOf(stats))) {
    throw conflict();
  }
}

function pathWithin(root, path) {
  const suffix = relative(root, path);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}

function safeChild(root, ...parts) {
  const path = resolve(root, ...parts);
  if (!pathWithin(root, path)) throw invalid();
  return path;
}

function lstatMaybe(path, fileOperations) {
  try {
    return fileOperations.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function ensurePrivateDirectory(path, parent, fileOperations) {
  if (!pathWithin(parent, path) || path === parent) throw invalid();
  let stats = lstatMaybe(path, fileOperations);
  let created = false;
  if (stats === null) {
    try {
      fileOperations.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    stats = fileOperations.lstatSync(path);
    created = true;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw invalid();
  fileOperations.chmodSync(path, 0o700);
  syncDirectory(path, fileOperations);
  if (created) syncDirectory(parent, fileOperations);
  return identityOf(stats);
}

function ensurePrivateTree(root, relativeParts, fileOperations) {
  let parent = root;
  for (const part of relativeParts) {
    if (typeof part !== "string" || part.length === 0 || part === "." || part === ".."
      || part.includes("/") || part.includes("\\")) {
      throw invalid();
    }
    const path = safeChild(parent, part);
    ensurePrivateDirectory(path, parent, fileOperations);
    parent = path;
  }
  return parent;
}

function readSafeFile(path, fileOperations, { missing = false } = {}) {
  let before;
  try {
    before = fileOperations.lstatSync(path);
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw invalid();
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
    if (!opened.isFile() || !sameIdentity(identityOf(before), identityOf(opened))) {
      throw conflict();
    }
    const bytes = Buffer.from(fileOperations.readFileSync(descriptor));
    const after = fileOperations.lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink()
      || !sameIdentity(identityOf(opened), identityOf(after))) {
      throw conflict();
    }
    return {
      bytes,
      identity: identityOf(opened),
      mode: opened.mode & 0o7777,
      atime: opened.atime,
      mtime: opened.mtime
    };
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
}

function writePrivateExclusive(path, bytes, fileOperations, onIdentity = null) {
  let descriptor;
  try {
    descriptor = fileOperations.openSync(path, "wx", 0o600);
    fileOperations.writeFileSync(descriptor, bytes);
    fileOperations.fchmodSync(descriptor, 0o600);
    fileOperations.fsyncSync(descriptor);
    const identity = identityOf(fileOperations.fstatSync(descriptor));
    if (onIdentity !== null) onIdentity(identity);
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(dirname(path), fileOperations);
    return identity;
  } finally {
    if (descriptor !== undefined) fileOperations.closeSync(descriptor);
  }
}

function removeOwnedFile(path, expectedIdentity, expectedBytes, fileOperations, createId) {
  const claimPath = join(dirname(path), `.${basename(path)}.${nextSafeId(createId)}.claim`);
  try {
    fileOperations.renameSync(path, claimPath);
    syncDirectory(dirname(path), fileOperations);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  try {
    const claimed = readSafeFile(claimPath, fileOperations);
    if (!sameIdentity(claimed.identity, expectedIdentity)
      || !claimed.bytes.equals(expectedBytes)) {
      try { fileOperations.renameSync(claimPath, path); } catch {}
      return false;
    }
    fileOperations.rmSync(claimPath);
    syncDirectory(dirname(path), fileOperations);
    return true;
  } catch {
    try { fileOperations.renameSync(claimPath, path); } catch {}
    return false;
  }
}

function removeOwnedPath(path, expectedIdentity, fileOperations, createId) {
  const claimPath = join(dirname(path), `.${basename(path)}.${nextSafeId(createId)}.claim`);
  try {
    fileOperations.renameSync(path, claimPath);
    syncDirectory(dirname(path), fileOperations);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  const restoreClaim = () => {
    try {
      fileOperations.linkSync(claimPath, path);
      fileOperations.rmSync(claimPath);
      syncDirectory(dirname(path), fileOperations);
    } catch {}
  };
  try {
    const claimed = fileOperations.lstatSync(claimPath);
    if (!claimed.isFile() || claimed.isSymbolicLink()
      || !sameIdentity(identityOf(claimed), expectedIdentity)) {
      restoreClaim();
      return false;
    }
    fileOperations.rmSync(claimPath);
    syncDirectory(dirname(path), fileOperations);
    return true;
  } catch {
    restoreClaim();
    return false;
  }
}

function writeAtomicExclusive(path, bytes, fileOperations, createId) {
  const tempPath = join(dirname(path), `.${basename(path)}.${nextSafeId(createId)}.tmp`);
  let identity = null;
  try {
    identity = writePrivateExclusive(tempPath, bytes, fileOperations);
    fileOperations.linkSync(tempPath, path);
    syncDirectory(dirname(path), fileOperations);
    const published = readSafeFile(path, fileOperations);
    if (!sameIdentity(published.identity, identity) || !published.bytes.equals(bytes)) {
      throw failed();
    }
    if (!removeOwnedFile(tempPath, identity, bytes, fileOperations, createId)) {
      throw failed();
    }
    return published;
  } catch (error) {
    if (identity !== null) {
      removeOwnedFile(tempPath, identity, bytes, fileOperations, createId);
    }
    throw error;
  }
}

function parseJournal(source) {
  let value;
  try {
    value = JSON.parse(source.bytes.toString("utf8"));
  } catch (error) {
    throw conflict(error);
  }
  if (!exactFields(value, EXACT_JOURNAL_FIELDS)
    || value.schemaVersion !== SCHEMA_VERSION || value.managedBy !== MANAGED_BY
    || !SAFE_ID_PATTERN.test(value.operationId)
    || !SHA256_PATTERN.test(value.sourceConfigSha256)
    || !SHA256_PATTERN.test(value.targetConfigSha256)
    || value.targetProvider !== TARGET_PROVIDER
    || typeof value.createdAt !== "string" || value.createdAt.length === 0
    || value.createdAt.length > 64) {
    throw conflict();
  }
  return value;
}

function managedPaths(root) {
  const managed = safeChild(root, MANAGED_DIRECTORY);
  return {
    managed,
    pending: safeChild(managed, PENDING_FILE),
    clearing: safeChild(managed, CLEARING_FILE),
    backups: safeChild(managed, BACKUP_DIRECTORY)
  };
}

function readPending(root, fileOperations) {
  const paths = managedPaths(root);
  const managed = lstatMaybe(paths.managed, fileOperations);
  if (managed === null) return null;
  if (!managed.isDirectory() || managed.isSymbolicLink()) throw invalid();
  const canonical = readSafeFile(paths.pending, fileOperations, { missing: true });
  const clearing = readSafeFile(paths.clearing, fileOperations, { missing: true });
  if (canonical !== null && clearing !== null) throw conflict();
  const source = canonical ?? clearing;
  if (source === null) return null;
  return {
    source,
    sourcePath: canonical === null ? paths.clearing : paths.pending,
    journal: parseJournal(source),
    paths
  };
}

function pendingBinding(pending) {
  return Object.freeze({
    operationId: pending.journal.operationId,
    sourceConfigSha256: pending.journal.sourceConfigSha256,
    targetConfigSha256: pending.journal.targetConfigSha256
  });
}

function sameBinding(left, right) {
  return isPlainObject(left) && isPlainObject(right)
    && left.operationId === right.operationId
    && left.sourceConfigSha256 === right.sourceConfigSha256
    && left.targetConfigSha256 === right.targetConfigSha256;
}

export function inspectPendingCodexHistoryRepair({
  codexRoot,
  fileOperations: overrides = {}
}) {
  const fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...overrides };
  const root = rootContext(codexRoot, fileOperations);
  try {
    const pending = readPending(root.path, fileOperations);
    return pending === null ? null : pendingBinding(pending);
  } catch (error) {
    if (error instanceof CrpError) throw error;
    throw invalid(error);
  }
}

export function hasPendingCodexHistoryRepair({ codexRoot, fileOperations: overrides = {} }) {
  return inspectPendingCodexHistoryRepair({ codexRoot, fileOperations: overrides }) !== null;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function containsEncryptedContent(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Object.hasOwn(value, "encrypted_content")) return true;
  if (Array.isArray(value)) return value.some((item) => containsEncryptedContent(item, seen));
  return Object.values(value).some((item) => containsEncryptedContent(item, seen));
}

function transformRollout(bytes, targetProvider) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw invalid(error);
  }
  const pieces = text.split(/(\r\n|\n|\r)/);
  let records = 0;
  let encryptedContentDetected = false;
  for (let index = 0; index < pieces.length; index += 2) {
    const value = parseJsonLine(pieces[index]);
    if (value === null) continue;
    if (!encryptedContentDetected && containsEncryptedContent(value)) {
      encryptedContentDetected = true;
    }
    if (!isPlainObject(value) || value.type !== "session_meta"
      || !isPlainObject(value.payload)
      || value.payload.model_provider === targetProvider) {
      continue;
    }
    value.payload.model_provider = targetProvider;
    pieces[index] = JSON.stringify(value);
    records = boundedAdd(records);
  }
  return {
    bytes: Buffer.from(pieces.join(""), "utf8"),
    records,
    encryptedContentDetected
  };
}

function scanRolloutDirectory({ root, relativeRoot, fileOperations, targetProvider }) {
  const base = safeChild(root.path, relativeRoot);
  const baseStats = lstatMaybe(base, fileOperations);
  if (baseStats === null) return [];
  if (!baseStats.isDirectory() || baseStats.isSymbolicLink()) throw invalid();
  const results = [];

  function visit(path, expectedIdentity) {
    assertRoot(root, fileOperations);
    const before = fileOperations.lstatSync(path);
    if (!before.isDirectory() || before.isSymbolicLink()
      || !sameIdentity(identityOf(before), expectedIdentity)) {
      throw conflict();
    }
    const entries = fileOperations.readdirSync(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = safeChild(path, entry.name);
      if (!pathWithin(base, child)) throw invalid();
      if (entry.isSymbolicLink()) throw invalid();
      if (entry.isDirectory()) {
        const stats = fileOperations.lstatSync(child);
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw invalid();
        visit(child, identityOf(stats));
        continue;
      }
      if (!entry.isFile()) throw invalid();
      if (!/^rollout-.*\.jsonl$/.test(entry.name)) continue;
      const source = readSafeFile(child, fileOperations);
      const transformed = transformRollout(source.bytes, targetProvider);
      results.push({
        path: child,
        relativePath: relative(root.path, child).split(sep),
        source,
        transformed
      });
    }
    const after = fileOperations.lstatSync(path);
    if (!after.isDirectory() || after.isSymbolicLink()
      || !sameIdentity(expectedIdentity, identityOf(after))) {
      throw conflict();
    }
  }

  visit(base, identityOf(baseStats));
  return results;
}

function discoverRollouts(root, fileOperations, targetProvider) {
  return ["sessions", "archived_sessions"].flatMap((relativeRoot) => (
    scanRolloutDirectory({ root, relativeRoot, fileOperations, targetProvider })
  ));
}

function discoverDatabases(root, fileOperations) {
  const candidates = [];
  const legacy = safeChild(root.path, "state_5.sqlite");
  const legacyStats = lstatMaybe(legacy, fileOperations);
  if (legacyStats !== null) {
    if (!legacyStats.isFile() || legacyStats.isSymbolicLink() || legacyStats.nlink !== 1) {
      throw invalid();
    }
    assertSafeDatabaseSidecars(legacy, fileOperations, invalid);
    candidates.push({
      path: legacy,
      relativePath: ["state_5.sqlite"],
      identity: identityOf(legacyStats)
    });
  }

  const sqliteDirectory = safeChild(root.path, "sqlite");
  const sqliteStats = lstatMaybe(sqliteDirectory, fileOperations);
  if (sqliteStats !== null) {
    if (!sqliteStats.isDirectory() || sqliteStats.isSymbolicLink()) throw invalid();
    const entries = fileOperations.readdirSync(sqliteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const extension = extname(entry.name).toLowerCase();
      if (!DATABASE_EXTENSIONS.has(extension)) {
        if (entry.isSymbolicLink()) throw invalid();
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) throw invalid();
      const path = safeChild(sqliteDirectory, entry.name);
      const stats = fileOperations.lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) throw invalid();
      assertSafeDatabaseSidecars(path, fileOperations, invalid);
      candidates.push({
        path,
        relativePath: ["sqlite", entry.name],
        identity: identityOf(stats)
      });
    }
    const after = fileOperations.lstatSync(sqliteDirectory);
    if (!after.isDirectory() || after.isSymbolicLink()
      || !sameIdentity(identityOf(sqliteStats), identityOf(after))) {
      throw conflict();
    }
  }

  candidates.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const identities = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.identity.dev}:${candidate.identity.ino}`;
    if (identities.has(key)) throw invalid();
    identities.add(key);
  }
  return candidates;
}

function assertSafeDatabaseSidecars(path, fileOperations, errorFactory = conflict) {
  const parent = dirname(path);
  const name = basename(path);
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
    const sidecar = safeChild(parent, `${name}${suffix}`);
    const stats = lstatMaybe(sidecar, fileOperations);
    if (stats !== null
      && (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)) {
      throw errorFactory();
    }
  }
}

function statementGet(statement, ...parameters) {
  return statement.get(...parameters);
}

function databaseHasProviderColumn(database) {
  const table = statementGet(
    database.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = ? AND name = ? LIMIT 1"),
    "table",
    "threads"
  );
  if (!table) return false;
  const column = statementGet(
    database.prepare("SELECT 1 AS present FROM pragma_table_info('threads') WHERE name = ? LIMIT 1"),
    "model_provider"
  );
  return Boolean(column);
}

function mismatchedDatabaseRows(database, targetProvider) {
  const row = statementGet(
    database.prepare("SELECT COUNT(*) AS count FROM threads WHERE model_provider IS NOT ?"),
    targetProvider
  );
  const count = Number(row?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw invalid();
  return count;
}

async function inspectDatabases(candidates, databaseOperations, targetProvider, fileOperations) {
  const results = [];
  for (const candidate of candidates) {
    const before = fileOperations.lstatSync(candidate.path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || !sameIdentity(candidate.identity, identityOf(before))) {
      throw conflict();
    }
    assertSafeDatabaseSidecars(candidate.path, fileOperations);
    let database;
    try {
      database = await databaseOperations.open(candidate.path);
      const afterOpen = fileOperations.lstatSync(candidate.path);
      if (!afterOpen.isFile() || afterOpen.isSymbolicLink() || afterOpen.nlink !== 1
        || !sameIdentity(candidate.identity, identityOf(afterOpen))) {
        throw conflict();
      }
      assertSafeDatabaseSidecars(candidate.path, fileOperations);
      const supported = databaseHasProviderColumn(database);
      const rows = supported ? mismatchedDatabaseRows(database, targetProvider) : 0;
      results.push({ ...candidate, supported, rows });
    } finally {
      if (database !== undefined) database.close();
    }
  }
  return results;
}

function journalBytes(journal) {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

function createManagedOperation({
  root,
  transition,
  targetProvider,
  fileOperations,
  now,
  createId
}) {
  const paths = managedPaths(root.path);
  ensurePrivateDirectory(paths.managed, root.path, fileOperations);
  ensurePrivateDirectory(paths.backups, paths.managed, fileOperations);
  const operationId = nextSafeId(createId);
  const operationRoot = safeChild(paths.backups, operationId);
  ensurePrivateDirectory(operationRoot, paths.backups, fileOperations);
  const createdAt = now();
  if (typeof createdAt !== "string" || createdAt.length === 0 || createdAt.length > 64
    || Number.isNaN(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) {
    throw invalid();
  }
  const journal = {
    schemaVersion: SCHEMA_VERSION,
    managedBy: MANAGED_BY,
    operationId,
    sourceConfigSha256: transition.sourceConfigSha256,
    targetConfigSha256: transition.targetConfigSha256,
    targetProvider,
    createdAt
  };
  const bytes = journalBytes(journal);
  const metadataPath = safeChild(operationRoot, BACKUP_METADATA_FILE);
  writePrivateExclusive(metadataPath, bytes, fileOperations);
  return { paths, operationRoot, journal, bytes };
}

function assertManagedOperation(pending, fileOperations) {
  for (const path of [pending.paths.managed, pending.paths.backups]) {
    const ancestor = fileOperations.lstatSync(path);
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) throw conflict();
  }
  const operationRoot = safeChild(pending.paths.backups, pending.journal.operationId);
  const stats = fileOperations.lstatSync(operationRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw conflict();
  fileOperations.chmodSync(operationRoot, 0o700);
  const metadata = readSafeFile(safeChild(operationRoot, BACKUP_METADATA_FILE), fileOperations);
  if (!metadata.bytes.equals(journalBytes(pending.journal))) throw conflict();
  return operationRoot;
}

function operationHasBackups(operationRoot, fileOperations) {
  for (const name of ["rollouts", "databases"]) {
    const base = safeChild(operationRoot, name);
    const baseStats = lstatMaybe(base, fileOperations);
    if (baseStats === null) continue;
    if (!baseStats.isDirectory() || baseStats.isSymbolicLink()) throw conflict();
    const queue = [base];
    while (queue.length > 0) {
      const directory = queue.pop();
      for (const entry of fileOperations.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw conflict();
        const child = safeChild(directory, entry.name);
        if (!pathWithin(base, child)) throw conflict();
        if (entry.isDirectory()) queue.push(child);
        else if (entry.isFile()) return true;
        else throw conflict();
      }
    }
  }
  return false;
}

function backupRollouts(rollouts, operationRoot, fileOperations, createId) {
  let created = false;
  const rolloutRoot = ensurePrivateTree(operationRoot, ["rollouts"], fileOperations);
  for (const rollout of rollouts) {
    if (rollout.transformed.records === 0) continue;
    const directory = ensurePrivateTree(
      rolloutRoot,
      rollout.relativePath.slice(0, -1),
      fileOperations
    );
    const destination = safeChild(
      directory,
      `${rollout.relativePath.at(-1)}.${sha256(rollout.source.bytes)}.bak`
    );
    const existing = readSafeFile(destination, fileOperations, { missing: true });
    if (existing !== null) {
      if (!existing.bytes.equals(rollout.source.bytes)) throw conflict();
      continue;
    }
    try {
      writeAtomicExclusive(destination, rollout.source.bytes, fileOperations, createId);
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const raced = readSafeFile(destination, fileOperations);
      if (!raced.bytes.equals(rollout.source.bytes)) throw conflict(error);
    }
  }
  return created;
}

function availableDatabaseBackupPath(directory, name, token, fileOperations) {
  let suffix = 0;
  while (suffix < 10_000) {
    const ending = suffix === 0 ? "" : `.${suffix}`;
    const destination = safeChild(directory, `${name}.${token}${ending}.bak`);
    if (lstatMaybe(destination, fileOperations) === null) return destination;
    suffix += 1;
  }
  throw failed();
}

function rollbackAndClosePrepared(prepared) {
  for (const snapshot of prepared) {
    if (snapshot.closed) continue;
    if (snapshot.transaction) {
      try { snapshot.database.exec("ROLLBACK"); } catch {}
      snapshot.transaction = false;
    }
    try { snapshot.database.close(); } catch {}
    snapshot.closed = true;
  }
}

function collectMismatchedRowIds(database, targetProvider) {
  const rows = database.prepare(
    "SELECT rowid AS rowId FROM threads WHERE model_provider IS NOT ? ORDER BY rowid"
  ).all(targetProvider);
  const rowIds = [];
  for (const row of rows) {
    const rowId = row?.rowId;
    if (!(typeof rowId === "number" && Number.isSafeInteger(rowId))
      && typeof rowId !== "bigint") {
      throw invalid();
    }
    rowIds.push(rowId);
  }
  return rowIds;
}

async function backupOpenDatabase(
  candidate,
  operationRoot,
  databaseOperations,
  fileOperations,
  createId
) {
  const databaseRoot = ensurePrivateTree(operationRoot, ["databases"], fileOperations);
  const directory = ensurePrivateTree(
    databaseRoot,
    candidate.relativePath.slice(0, -1),
    fileOperations
  );
  const destination = availableDatabaseBackupPath(
    directory,
    candidate.relativePath.at(-1),
    nextSafeId(createId),
    fileOperations
  );
  const tempPath = join(
    directory,
    `.${basename(destination)}.${nextSafeId(createId)}.tmp`
  );
  let tempIdentity = null;
  let tempOwned = false;
  let backupDatabase;
  try {
    const current = fileOperations.lstatSync(candidate.path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || !sameIdentity(candidate.identity, identityOf(current))) {
      throw conflict();
    }
    assertSafeDatabaseSidecars(candidate.path, fileOperations);
    backupDatabase = await databaseOperations.open(candidate.path);
    const afterBackupOpen = fileOperations.lstatSync(candidate.path);
    if (!afterBackupOpen.isFile() || afterBackupOpen.isSymbolicLink()
      || afterBackupOpen.nlink !== 1
      || !sameIdentity(candidate.identity, identityOf(afterBackupOpen))) {
      throw conflict();
    }
    assertSafeDatabaseSidecars(candidate.path, fileOperations);
    writePrivateExclusive(tempPath, Buffer.alloc(0), fileOperations, (identity) => {
      tempIdentity = identity;
      tempOwned = true;
    });
    await databaseOperations.backup(backupDatabase, tempPath);
    backupDatabase.close();
    backupDatabase = undefined;
    const afterBackup = fileOperations.lstatSync(candidate.path);
    if (!afterBackup.isFile() || afterBackup.isSymbolicLink() || afterBackup.nlink !== 1
      || !sameIdentity(candidate.identity, identityOf(afterBackup))) {
      throw conflict();
    }
    assertSafeDatabaseSidecars(candidate.path, fileOperations);
    const temp = fileOperations.lstatSync(tempPath);
    if (!temp.isFile() || temp.isSymbolicLink()) throw failed();
    if (!sameIdentity(tempIdentity, identityOf(temp))) throw conflict();
    fileOperations.chmodSync(tempPath, 0o600);
    let descriptor;
    try {
      descriptor = fileOperations.openSync(
        tempPath,
        fileOperations.constants.O_RDONLY
          | (typeof fileOperations.constants.O_NOFOLLOW === "number"
            ? fileOperations.constants.O_NOFOLLOW
            : 0)
      );
      fileOperations.fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) fileOperations.closeSync(descriptor);
    }
    const beforeRename = fileOperations.lstatSync(tempPath);
    if (!beforeRename.isFile() || beforeRename.isSymbolicLink()
      || !sameIdentity(tempIdentity, identityOf(beforeRename))) {
      throw conflict();
    }
    if (lstatMaybe(destination, fileOperations) !== null) throw conflict();
    try {
      fileOperations.linkSync(tempPath, destination);
    } catch (error) {
      if (error?.code === "EEXIST") throw conflict(error);
      throw error;
    }
    syncDirectory(dirname(destination), fileOperations);
    const committed = fileOperations.lstatSync(destination);
    if (!committed.isFile() || committed.isSymbolicLink()
      || !sameIdentity(tempIdentity, identityOf(committed))) {
      throw failed();
    }
    if (!removeOwnedPath(tempPath, tempIdentity, fileOperations, createId)) throw failed();
    tempOwned = false;
    const finalDestination = fileOperations.lstatSync(destination);
    if (!finalDestination.isFile() || finalDestination.isSymbolicLink()
      || !sameIdentity(tempIdentity, identityOf(finalDestination))) {
      throw conflict();
    }
    return true;
  } catch (error) {
    if (tempOwned && tempIdentity !== null
      && !removeOwnedPath(tempPath, tempIdentity, fileOperations, createId)) {
      throw failed(error);
    }
    throw error;
  } finally {
    if (backupDatabase !== undefined) {
      try { backupDatabase.close(); } catch {}
    }
  }
}

async function prepareDatabaseSnapshots(
  candidates,
  operationRoot,
  databaseOperations,
  targetProvider,
  fileOperations,
  createId
) {
  const prepared = [];
  let created = false;
  try {
    for (const candidate of candidates) {
      const current = fileOperations.lstatSync(candidate.path);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || !sameIdentity(candidate.identity, identityOf(current))) {
        throw conflict();
      }
      assertSafeDatabaseSidecars(candidate.path, fileOperations);
      const database = await databaseOperations.open(candidate.path);
      const snapshot = {
        ...candidate,
        database,
        transaction: false,
        closed: false,
        rowIds: []
      };
      try {
        const afterOpen = fileOperations.lstatSync(candidate.path);
        if (!afterOpen.isFile() || afterOpen.isSymbolicLink() || afterOpen.nlink !== 1
          || !sameIdentity(candidate.identity, identityOf(afterOpen))) {
          throw conflict();
        }
        assertSafeDatabaseSidecars(candidate.path, fileOperations);
        database.exec("BEGIN IMMEDIATE");
        assertSafeDatabaseSidecars(candidate.path, fileOperations);
        snapshot.transaction = true;
        if (!databaseHasProviderColumn(database)) {
          database.exec("ROLLBACK");
          snapshot.transaction = false;
          database.close();
          snapshot.closed = true;
          continue;
        }
        snapshot.rowIds = collectMismatchedRowIds(database, targetProvider);
        if (snapshot.rowIds.length === 0) {
          database.exec("ROLLBACK");
          snapshot.transaction = false;
          database.close();
          snapshot.closed = true;
          continue;
        }
        const beforeBackup = fileOperations.lstatSync(candidate.path);
        if (!beforeBackup.isFile() || beforeBackup.isSymbolicLink() || beforeBackup.nlink !== 1
          || !sameIdentity(candidate.identity, identityOf(beforeBackup))) {
          throw conflict();
        }
        assertSafeDatabaseSidecars(candidate.path, fileOperations);
        created = await backupOpenDatabase(
          candidate,
          operationRoot,
          databaseOperations,
          fileOperations,
          createId
        ) || created;
        prepared.push(snapshot);
      } catch (error) {
        rollbackAndClosePrepared([snapshot]);
        throw error;
      }
    }
    return { created, prepared };
  } catch (error) {
    rollbackAndClosePrepared(prepared);
    throw error;
  }
}

function assertRolloutSnapshots(rollouts, fileOperations) {
  for (const rollout of rollouts) {
    if (rollout.transformed.records === 0) continue;
    const current = readSafeFile(rollout.path, fileOperations);
    if (!sameIdentity(current.identity, rollout.source.identity)
      || !current.bytes.equals(rollout.source.bytes)) {
      throw conflict();
    }
  }
}

function replaceRollout(rollout, fileOperations, createId) {
  const tempPath = join(
    dirname(rollout.path),
    `.${basename(rollout.path)}.${nextSafeId(createId)}.tmp`
  );
  let descriptor;
  let tempIdentity = null;
  let committed = false;
  try {
    descriptor = fileOperations.openSync(tempPath, "wx", 0o600);
    tempIdentity = identityOf(fileOperations.fstatSync(descriptor));
    fileOperations.writeFileSync(descriptor, rollout.transformed.bytes);
    fileOperations.fchmodSync(descriptor, rollout.source.mode);
    fileOperations.futimesSync(descriptor, rollout.source.atime, rollout.source.mtime);
    fileOperations.fsyncSync(descriptor);
    const current = readSafeFile(rollout.path, fileOperations);
    if (!sameIdentity(current.identity, rollout.source.identity)
      || !current.bytes.equals(rollout.source.bytes)) {
      throw conflict();
    }
    fileOperations.renameSync(tempPath, rollout.path);
    committed = true;
    const published = fileOperations.lstatSync(rollout.path);
    if (!published.isFile() || published.isSymbolicLink()
      || !sameIdentity(tempIdentity, identityOf(published))) {
      throw committedDegraded();
    }
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(dirname(rollout.path), fileOperations);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileOperations.closeSync(descriptor); } catch {}
    }
    if (!committed && tempIdentity !== null) {
      try {
        const temp = readSafeFile(tempPath, fileOperations);
        if (sameIdentity(temp.identity, tempIdentity)) fileOperations.rmSync(tempPath);
      } catch {}
    }
    if (committed && !(error instanceof CrpError
      && error.code === "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED")) {
      throw committedDegraded(error);
    }
    throw error;
  }
}

function repairRollouts(rollouts, fileOperations, createId) {
  const summary = {
    rolloutFiles: 0,
    rolloutRecords: 0,
    encryptedContentDetected: false
  };
  for (const rollout of rollouts) {
    summary.encryptedContentDetected ||= rollout.transformed.encryptedContentDetected;
    if (rollout.transformed.records === 0) continue;
    replaceRollout(rollout, fileOperations, createId);
    summary.rolloutFiles = boundedAdd(summary.rolloutFiles);
    summary.rolloutRecords = boundedAdd(
      summary.rolloutRecords,
      rollout.transformed.records
    );
  }
  return summary;
}

function rowIdBatches(rowIds, size = 400) {
  const batches = [];
  for (let index = 0; index < rowIds.length; index += size) {
    batches.push(rowIds.slice(index, index + size));
  }
  return batches;
}

function numericChanges(value) {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw failed();
  return number;
}

async function repairPreparedDatabases(prepared, targetProvider, fileOperations) {
  const summary = { sqliteFiles: 0, sqliteRows: 0 };
  for (let index = 0; index < prepared.length; index += 1) {
    const snapshot = prepared[index];
    try {
      const current = fileOperations.lstatSync(snapshot.path);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || !sameIdentity(snapshot.identity, identityOf(current))) {
        throw conflict();
      }
      assertSafeDatabaseSidecars(snapshot.path, fileOperations);
      let changes = 0;
      for (const batch of rowIdBatches(snapshot.rowIds)) {
        const placeholders = batch.map(() => "?").join(", ");
        const result = snapshot.database.prepare(
          `UPDATE threads SET model_provider = ? WHERE rowid IN (${placeholders}) AND model_provider IS NOT ?`
        ).run(targetProvider, ...batch, targetProvider);
        changes = boundedAdd(changes, numericChanges(result?.changes ?? 0));
        const remaining = snapshot.database.prepare(
          `SELECT COUNT(*) AS count FROM threads WHERE rowid IN (${placeholders}) AND model_provider IS NOT ?`
        ).get(...batch, targetProvider);
        if (numericChanges(remaining?.count ?? 0) !== 0) throw failed();
      }
      snapshot.database.exec("COMMIT");
      snapshot.transaction = false;
      assertSafeDatabaseSidecars(snapshot.path, fileOperations);
      snapshot.database.close();
      snapshot.closed = true;
      summary.sqliteFiles = boundedAdd(summary.sqliteFiles);
      summary.sqliteRows = boundedAdd(summary.sqliteRows, changes);
    } catch (error) {
      rollbackAndClosePrepared(prepared.slice(index));
      throw error;
    }
  }
  return summary;
}

async function verifyHistory(root, fileOperations, databaseOperations, targetProvider) {
  const rollouts = discoverRollouts(root, fileOperations, targetProvider);
  if (rollouts.some((rollout) => rollout.transformed.records > 0)) throw failed();
  const rolloutDirectories = [...new Set(rollouts.map((rollout) => dirname(rollout.path)))];
  rolloutDirectories.sort((left, right) => left.localeCompare(right, "en"));
  for (const directory of rolloutDirectories) syncDirectory(directory, fileOperations);
  const databases = discoverDatabases(root, fileOperations);
  const inspected = await inspectDatabases(
    databases,
    databaseOperations,
    targetProvider,
    fileOperations
  );
  if (inspected.some((database) => database.rows > 0)) throw failed();
  return rollouts.some((rollout) => rollout.transformed.encryptedContentDetected);
}

function validateTransition(transition, targetBytes) {
  if (!isPlainObject(transition) || typeof transition.required !== "boolean"
    || (transition.sourceConfigSha256 !== null
      && !SHA256_PATTERN.test(transition.sourceConfigSha256))
    || !SHA256_PATTERN.test(transition.targetConfigSha256)
    || transition.targetConfigSha256 !== sha256(targetBytes)) {
    throw invalid();
  }
  if (transition.required && transition.sourceConfigSha256 === null) throw invalid();
}

function configHashAtRoot(root, fileOperations) {
  const config = readSafeFile(safeChild(root.path, "config.toml"), fileOperations, {
    missing: true
  });
  return config === null ? null : sha256(config.bytes);
}

function assertCurrentConfig(root, expectedHash, fileOperations) {
  const actual = configHashAtRoot(root, fileOperations);
  if (actual !== expectedHash) throw conflict();
}

function publishTarget({
  root,
  targetBytes,
  publishConfig,
  sourceHash,
  targetHash,
  fileOperations,
  committedFailure = committedDegraded
}) {
  let publishResult;
  let callbackError = null;
  try {
    publishResult = publishConfig(Buffer.from(targetBytes));
  } catch (error) {
    callbackError = error;
  }
  if (callbackError !== null) {
    let actual;
    try {
      actual = configHashAtRoot(root, fileOperations);
    } catch (error) {
      throw committedFailure(error);
    }
    if (actual === targetHash) {
      return { publishResult: undefined, callbackError };
    }
    if (actual === sourceHash) throw failed(callbackError);
    throw conflict(callbackError);
  }
  if (publishResult !== null && typeof publishResult === "object"
    && typeof publishResult.then === "function") {
    throw invalid();
  }
  let actual;
  try {
    actual = configHashAtRoot(root, fileOperations);
  } catch (error) {
    throw committedFailure(error);
  }
  if (actual === sourceHash) throw failed();
  if (actual !== targetHash) throw conflict();
  return { publishResult, callbackError: null };
}

function restorePendingMarker(pending, fileOperations, createId) {
  try {
    if (lstatMaybe(pending.paths.pending, fileOperations) !== null
      || lstatMaybe(pending.paths.clearing, fileOperations) !== null) {
      return true;
    }
    const restored = writeAtomicExclusive(
      pending.paths.pending,
      pending.source.bytes,
      fileOperations,
      createId
    );
    return restored.bytes.equals(pending.source.bytes);
  } catch {
    try {
      return lstatMaybe(pending.paths.pending, fileOperations) !== null
        || lstatMaybe(pending.paths.clearing, fileOperations) !== null;
    } catch {
      return false;
    }
  }
}

function retainConfigLock(error) {
  Object.defineProperty(error, "retainConfigLock", {
    value: true,
    enumerable: false
  });
  return error;
}

function clearPending(pending, fileOperations, createId) {
  let clearingClaimed = pending.sourcePath === pending.paths.clearing;
  try {
    if (!clearingClaimed) {
      if (lstatMaybe(pending.paths.clearing, fileOperations) !== null) return false;
      fileOperations.renameSync(pending.paths.pending, pending.paths.clearing);
      syncDirectory(pending.paths.managed, fileOperations);
      clearingClaimed = true;
    }
    const clearing = readSafeFile(pending.paths.clearing, fileOperations);
    if (!sameIdentity(clearing.identity, pending.source.identity)
      || !clearing.bytes.equals(pending.source.bytes)) {
      return false;
    }
    fileOperations.rmSync(pending.paths.clearing);
    syncDirectory(pending.paths.managed, fileOperations);
    return true;
  } catch {
    if (!restorePendingMarker(pending, fileOperations, createId)) {
      throw retainConfigLock(committedDegraded());
    }
    return false;
  }
}

function callSynchronousHook(hook, binding) {
  if (hook === null) return;
  const result = hook(Object.freeze({ ...binding }));
  if (result !== null && typeof result === "object"
    && typeof result.then === "function") {
    throw invalid();
  }
}

function committedError(error) {
  return error instanceof CrpError
    && (error.code === "CODEX_HISTORY_REPAIR_COMMITTED_DEGRADED"
      || error.code === "CODEX_CONFIG_COMMITTED_DEGRADED")
    ? error
    : committedDegraded(error);
}

function emptyHistorySummary({ required, resumed }) {
  return {
    required,
    completed: false,
    resumed,
    backupCreated: false,
    rolloutFiles: 0,
    rolloutRecords: 0,
    sqliteFiles: 0,
    sqliteRows: 0,
    encryptedContentDetected: false
  };
}

export async function runCodexHistoryRepairTransition({
  codexRoot,
  currentConfigBytes,
  targetConfigBytes,
  transition,
  publishConfig,
  fileOperations: fileOverrides = {},
  databaseOperations: databaseOverrides = {},
  now = () => new Date().toISOString(),
  createId = randomUUID,
  beforeJournalPublish = null,
  beforePendingClear = null,
  assertConfigLock = null
}) {
  if (typeof publishConfig !== "function" || typeof now !== "function"
    || typeof createId !== "function"
    || ![beforeJournalPublish, beforePendingClear, assertConfigLock].every(
      (hook) => hook === null || typeof hook === "function"
    )) {
    throw invalid();
  }
  const fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...fileOverrides };
  const databaseOperations = { ...DEFAULT_DATABASE_OPERATIONS, ...databaseOverrides };
  if (typeof databaseOperations.open !== "function"
    || typeof databaseOperations.backup !== "function") {
    throw invalid();
  }
  const root = rootContext(codexRoot, fileOperations);
  const currentBytes = asBytes(currentConfigBytes);
  const targetBytes = asBytes(targetConfigBytes);
  validateTransition(transition, targetBytes);

  let configPublished = false;
  let preparedDatabases = [];

  try {
    assertRoot(root, fileOperations);
    let pending = readPending(root.path, fileOperations);
    if (pending === null && !transition.required) {
      return {
        handled: false,
        configPublished: false,
        publishResult: undefined,
        historyRepair: {
          ...emptyHistorySummary({ required: false, resumed: false }),
          completed: true
        }
      };
    }

    const resumed = pending !== null;
    let operationRoot;
    let backupCreated = false;
    let rollouts = [];
    let databaseCandidates = [];
    const targetBinding = inspectCodexProviderBinding(targetBytes.toString("utf8"));
    if (targetBinding.providerName === null || targetBinding.normalizedBaseUrl === null) {
      throw invalid();
    }

    if (pending === null) {
      if (sha256(currentBytes) !== transition.sourceConfigSha256) throw conflict();
      assertCurrentConfig(root, transition.sourceConfigSha256, fileOperations);
      rollouts = discoverRollouts(root, fileOperations, targetBinding.providerName);
      databaseCandidates = discoverDatabases(root, fileOperations);
      const initialDatabases = await inspectDatabases(
        databaseCandidates,
        databaseOperations,
        targetBinding.providerName,
        fileOperations
      );
      const historyChangesRequired = rollouts.some(
        (rollout) => rollout.transformed.records > 0
      ) || initialDatabases.some((database) => database.rows > 0);
      if (!historyChangesRequired) {
        const configOnlyBinding = {
          operationId: nextSafeId(createId),
          sourceConfigSha256: transition.sourceConfigSha256,
          targetConfigSha256: transition.targetConfigSha256,
          pendingRequired: false
        };
        callSynchronousHook(beforeJournalPublish, configOnlyBinding);
        const published = publishTarget({
          root,
          targetBytes,
          publishConfig,
          sourceHash: transition.sourceConfigSha256,
          targetHash: transition.targetConfigSha256,
          fileOperations,
          committedFailure: configCommittedDegraded
        });
        configPublished = true;
        if (published.callbackError !== null) {
          throw configCommittedDegraded(published.callbackError);
        }
        try {
          callSynchronousHook(beforePendingClear, configOnlyBinding);
          assertCurrentConfig(root, transition.targetConfigSha256, fileOperations);
        } catch (error) {
          throw configCommittedDegraded(error);
        }
        return {
          handled: true,
          configPublished: true,
          publishResult: published.publishResult,
          historyRepair: {
            required: true,
            completed: true,
            resumed: false,
            backupCreated: false,
            rolloutFiles: 0,
            rolloutRecords: 0,
            sqliteFiles: 0,
            sqliteRows: 0,
            encryptedContentDetected: rollouts.some(
              (rollout) => rollout.transformed.encryptedContentDetected
            )
          }
        };
      }
      const managed = createManagedOperation({
        root,
        transition,
        targetProvider: targetBinding.providerName,
        fileOperations,
        now,
        createId
      });
      operationRoot = managed.operationRoot;
      backupCreated = backupRollouts(rollouts, operationRoot, fileOperations, createId);
      const prepared = await prepareDatabaseSnapshots(
        databaseCandidates,
        operationRoot,
        databaseOperations,
        targetBinding.providerName,
        fileOperations,
        createId
      );
      preparedDatabases = prepared.prepared;
      backupCreated = prepared.created || backupCreated;
      assertRolloutSnapshots(rollouts, fileOperations);
      const binding = {
        ...pendingBinding({ journal: managed.journal }),
        pendingRequired: true
      };
      callSynchronousHook(beforeJournalPublish, binding);
      try {
        const source = writeAtomicExclusive(
          managed.paths.pending,
          managed.bytes,
          fileOperations,
          createId
        );
        pending = {
          source,
          sourcePath: managed.paths.pending,
          journal: managed.journal,
          paths: managed.paths
        };
      } catch (error) {
        throw error?.code === "EEXIST" ? conflict(error) : error;
      }
    }

    if (pending.journal.targetConfigSha256 !== transition.targetConfigSha256) {
      throw conflict();
    }
    const currentHash = sha256(currentBytes);
    if (currentHash !== pending.journal.sourceConfigSha256
      && currentHash !== pending.journal.targetConfigSha256) {
      throw conflict();
    }
    configPublished = currentHash === pending.journal.targetConfigSha256;
    operationRoot = assertManagedOperation(pending, fileOperations);
    backupCreated ||= operationHasBackups(operationRoot, fileOperations);
    assertCurrentConfig(root, currentHash, fileOperations);
    if (targetBinding.providerName !== pending.journal.targetProvider) throw conflict();
    const binding = { ...pendingBinding(pending), pendingRequired: true };
    callSynchronousHook(assertConfigLock, binding);

    if (resumed) {
      rollouts = discoverRollouts(root, fileOperations, targetBinding.providerName);
      databaseCandidates = discoverDatabases(root, fileOperations);
      backupCreated = backupRollouts(rollouts, operationRoot, fileOperations, createId)
        || backupCreated;
      const prepared = await prepareDatabaseSnapshots(
        databaseCandidates,
        operationRoot,
        databaseOperations,
        targetBinding.providerName,
        fileOperations,
        createId
      );
      preparedDatabases = prepared.prepared;
      backupCreated = prepared.created || backupCreated;
      assertRolloutSnapshots(rollouts, fileOperations);
      callSynchronousHook(assertConfigLock, binding);
    }

    let publishResult;
    let publishCallbackError = null;
    if (!configPublished) {
      const published = publishTarget({
        root,
        targetBytes,
        publishConfig,
        sourceHash: pending.journal.sourceConfigSha256,
        targetHash: pending.journal.targetConfigSha256,
        fileOperations
      });
      publishResult = published.publishResult;
      publishCallbackError = published.callbackError;
      configPublished = true;
    }
    callSynchronousHook(assertConfigLock, binding);
    assertCurrentConfig(root, pending.journal.targetConfigSha256, fileOperations);

    let rolloutSummary;
    let sqliteSummary;
    try {
      rolloutSummary = repairRollouts(rollouts, fileOperations, createId);
      sqliteSummary = await repairPreparedDatabases(
        preparedDatabases,
        targetBinding.providerName,
        fileOperations
      );
      preparedDatabases = [];
      const encryptedAfterVerify = await verifyHistory(
        root,
        fileOperations,
        databaseOperations,
        targetBinding.providerName
      );
      rolloutSummary.encryptedContentDetected ||= encryptedAfterVerify;
    } catch (error) {
      if (configPublished) throw committedDegraded(error);
      throw error;
    }

    if (publishCallbackError !== null) throw committedDegraded(publishCallbackError);
    callSynchronousHook(beforePendingClear, binding);
    callSynchronousHook(assertConfigLock, binding);
    const encryptedBeforeClear = await verifyHistory(
      root,
      fileOperations,
      databaseOperations,
      targetBinding.providerName
    );
    rolloutSummary.encryptedContentDetected ||= encryptedBeforeClear;
    callSynchronousHook(assertConfigLock, binding);
    assertCurrentConfig(root, pending.journal.targetConfigSha256, fileOperations);
    if (!clearPending(pending, fileOperations, createId)) throw committedDegraded();
    return {
      handled: true,
      configPublished,
      publishResult,
      historyRepair: {
        required: true,
        completed: true,
        resumed,
        backupCreated,
        rolloutFiles: rolloutSummary.rolloutFiles,
        rolloutRecords: rolloutSummary.rolloutRecords,
        sqliteFiles: sqliteSummary.sqliteFiles,
        sqliteRows: sqliteSummary.sqliteRows,
        encryptedContentDetected: rolloutSummary.encryptedContentDetected
      }
    };
  } catch (error) {
    rollbackAndClosePrepared(preparedDatabases);
    if (configPublished) throw committedError(error);
    if (error instanceof CrpError) throw error;
    throw failed(error);
  }
}
