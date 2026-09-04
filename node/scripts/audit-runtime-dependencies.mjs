import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 90_000;
const RETRY_DELAY_MS = 15_000;
const MAX_AUDIT_OUTPUT_BYTES = 8 * 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedExitCode(value, fallback = 1) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function completedAuditReport(stdout) {
  let report;
  try {
    report = JSON.parse(String(stdout));
  } catch {
    return null;
  }
  const vulnerabilities = isObject(report) && isObject(report.metadata)
    ? report.metadata.vulnerabilities
    : null;
  const total = isObject(vulnerabilities) ? vulnerabilities.total : null;
  if (!Number.isSafeInteger(total) || total < 0) return null;
  return { total };
}

export function classifyAuditAttempt({ exitCode = null, timedOut = false, stdout = "" } = {}) {
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
      : { kind: "audit_failure", exitCode: normalizedExitCode(exitCode) };
  }
  return { kind: "retryable", exitCode: normalizedExitCode(exitCode) };
}

export function executeAuditAttempt({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, [
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
  const timedOut = result.error?.code === "ETIMEDOUT";
  let stderr = result.stderr ?? "";
  if (result.error) {
    const detail = timedOut
      ? `npm audit exceeded ${timeoutMs} ms.`
      : `npm audit could not complete (${result.error.code ?? "unknown"}).`;
    stderr += `${stderr.length > 0 && !stderr.endsWith("\n") ? "\n" : ""}${detail}\n`;
  }
  return {
    exitCode: result.status,
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
    if (classification.kind === "audit_failure") return finalExitCode;
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
