import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 90_000;
const RETRY_DELAY_MS = 15_000;
const MAX_AUDIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const AUDIT_SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const AUDIT_DEPENDENCY_COUNTS = ["prod", "dev", "optional", "peer", "peerOptional", "total"];
const RETRYABLE_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT"
]);
const RETRYABLE_HTTP_STATUS = /^(?:408|425|429|500|502|503|504)\b/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedExitCode(value, fallback = 1) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseJsonObject(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return null;
  }
  return isObject(parsed) ? parsed : null;
}

export function completedAuditReport(stdout) {
  const report = parseJsonObject(stdout);
  const metadata = report?.metadata;
  const counts = isObject(metadata) ? metadata.vulnerabilities : null;
  const dependencies = isObject(metadata) ? metadata.dependencies : null;
  if (report?.auditReportVersion !== 2
    || !isObject(report.vulnerabilities)
    || !isObject(counts)
    || !isObject(dependencies)
    || AUDIT_DEPENDENCY_COUNTS.some((name) => (
      !Number.isSafeInteger(dependencies[name]) || dependencies[name] < 0
    ))) {
    return null;
  }
  const severityCounts = AUDIT_SEVERITIES.map((severity) => counts[severity]);
  if (severityCounts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || !Number.isSafeInteger(counts.total)
    || counts.total < 0
    || severityCounts.reduce((sum, count) => sum + count, 0) !== counts.total) {
    return null;
  }
  const vulnerabilityNames = Object.keys(report.vulnerabilities);
  if ((counts.total === 0) !== (vulnerabilityNames.length === 0)) return null;
  const total = counts.total;
  return { total };
}

export function auditCommandError(stdout) {
  const report = parseJsonObject(stdout);
  if (!report || completedAuditReport(stdout)) return null;
  const details = isObject(report.error) ? report.error : null;
  const message = typeof report.message === "string" ? report.message.trim() : "";
  const code = typeof details?.code === "string"
    ? details.code.trim().toUpperCase()
    : typeof report.code === "string"
      ? report.code.trim().toUpperCase()
      : "";
  return message || code ? { code, message } : null;
}

export function isRetryableAuditTransportError(error) {
  if (!error) return false;
  if (RETRYABLE_TRANSPORT_CODES.has(error.code)) return true;
  if (RETRYABLE_HTTP_STATUS.test(error.message)) return true;
  return /\b(?:EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|ETIMEDOUT)\b/.test(
    error.message
  ) || error.message.startsWith("network timeout at:");
}

export function classifyAuditAttempt({
  exitCode = null,
  spawnErrorCode = "",
  timedOut = false,
  stdout = ""
} = {}) {
  const report = completedAuditReport(stdout);
  if (report?.total > 0) {
    return { kind: "audit_failure", exitCode: normalizedExitCode(exitCode) };
  }
  if (timedOut) {
    return { kind: "retryable", exitCode: 124 };
  }
  if (report) {
    return exitCode === 0
      ? { kind: "success", exitCode: 0 }
      : { kind: "execution_failure", exitCode: normalizedExitCode(exitCode) };
  }
  if (spawnErrorCode) {
    return { kind: "execution_failure", exitCode: normalizedExitCode(exitCode) };
  }
  return isRetryableAuditTransportError(auditCommandError(stdout))
    ? { kind: "retryable", exitCode: normalizedExitCode(exitCode) }
    : { kind: "execution_failure", exitCode: normalizedExitCode(exitCode) };
}

export function executeAuditAttempt({
  platform = process.platform,
  spawnCommand = spawnSync,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const command = platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnCommand(command, [
    "audit",
    "--omit=dev",
    "--json",
    "--fetch-retries=0",
    "--fetch-timeout=60000"
  ], {
    encoding: "utf8",
    killSignal: "SIGTERM",
    maxBuffer: MAX_AUDIT_OUTPUT_BYTES,
    timeout: timeoutMs
  });
  const spawnErrorCode = typeof result.error?.code === "string"
    ? result.error.code.toUpperCase()
    : "";
  const timedOut = spawnErrorCode === "ETIMEDOUT";
  let stderr = result.stderr ?? "";
  if (result.error) {
    const detail = timedOut
      ? `npm audit exceeded ${timeoutMs} ms.`
      : `npm audit could not complete (${result.error.code ?? "unknown"}).`;
    stderr += `${stderr.length > 0 && !stderr.endsWith("\n") ? "\n" : ""}${detail}\n`;
  }
  return {
    exitCode: result.status,
    spawnErrorCode,
    stderr,
    stdout: result.stdout ?? "",
    timedOut
  };
}

function wait(delayMs) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

export async function runAuditWithRetries({
  attempts = DEFAULT_ATTEMPTS,
  runAttempt = executeAuditAttempt,
  sleep = wait,
  stderr = process.stderr,
  stdout = process.stdout,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("Audit attempts must be an integer from 1 through 10.");
  }

  let finalExitCode = 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runAttempt({ attempt, timeoutMs });
    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);

    const classification = classifyAuditAttempt(result);
    finalExitCode = classification.exitCode;
    if (classification.kind === "success") return 0;
    if (classification.kind !== "retryable") return finalExitCode;
    if (attempt === attempts) return finalExitCode;

    stderr.write(
      `npm audit did not produce a complete report on attempt ${attempt}/${attempts}; retrying.\n`
    );
    await sleep(attempt * RETRY_DELAY_MS);
  }
  return finalExitCode;
}

const directExecution = typeof process.argv[1] === "string"
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  process.exitCode = await runAuditWithRetries();
}
