import test from "node:test";
import assert from "node:assert/strict";

import {
  auditCommandError,
  classifyAuditAttempt,
  completedAuditReport,
  executeAuditAttempt,
  isRetryableAuditTransportError,
  runAuditWithRetries
} from "../scripts/audit-runtime-dependencies.mjs";

function auditReport(total, vulnerabilities = total > 0 ? { package: {} } : {}) {
  return JSON.stringify({
    auditReportVersion: 2,
    metadata: {
      dependencies: {
        prod: 2,
        dev: 134,
        optional: 0,
        peer: 0,
        peerOptional: 0,
        total: 136
      },
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: total,
        critical: 0,
        total
      }
    },
    vulnerabilities
  });
}

function outputCollector() {
  let content = "";
  return {
    stream: { write: (value) => { content += String(value); } },
    value: () => content
  };
}

test("completed audit reports require bounded vulnerability totals", () => {
  assert.deepEqual(completedAuditReport(auditReport(0)), { total: 0 });
  assert.equal(completedAuditReport('{"metadata":{}}'), null);
  assert.equal(
    completedAuditReport('{"metadata":{"vulnerabilities":{"total":0}}}'),
    null
  );
  const mismatched = JSON.parse(auditReport(0));
  mismatched.metadata.vulnerabilities.high = 1;
  assert.equal(completedAuditReport(JSON.stringify(mismatched)), null);
  const contradictory = JSON.parse(auditReport(0));
  contradictory.vulnerabilities.package = {};
  assert.equal(completedAuditReport(JSON.stringify(contradictory)), null);
  assert.equal(completedAuditReport("not json"), null);
});

test("only structured npm transport errors are retryable", () => {
  const unavailable = JSON.stringify({
    message: "503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick",
    error: { summary: "", detail: "" }
  });
  const badLockfile = JSON.stringify({
    message: "loadVirtual requires existing shrinkwrap file",
    error: { code: "ELOCKVERIFY" }
  });
  assert.deepEqual(auditCommandError(unavailable), {
    code: "",
    message: "503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick"
  });
  assert.equal(isRetryableAuditTransportError(auditCommandError(unavailable)), true);
  assert.equal(isRetryableAuditTransportError(auditCommandError(badLockfile)), false);
  assert.equal(auditCommandError("not json"), null);
});

test("completed vulnerability reports fail immediately without log keyword classification", () => {
  const stdout = auditReport(1, {
    ECONNRESET: { title: "503 Service Unavailable" }
  });
  assert.deepEqual(
    classifyAuditAttempt({ exitCode: 124, timedOut: false, stdout }),
    { kind: "audit_failure", exitCode: 124 }
  );
  assert.deepEqual(
    classifyAuditAttempt({ exitCode: 1, timedOut: true, stdout }),
    { kind: "audit_failure", exitCode: 1 }
  );
});

test("clean reports succeed while incomplete or timed-out reports remain retryable", () => {
  assert.deepEqual(
    classifyAuditAttempt({ exitCode: 0, stdout: auditReport(0) }),
    { kind: "success", exitCode: 0 }
  );
  assert.deepEqual(
    classifyAuditAttempt({
      exitCode: 1,
      stdout: JSON.stringify({
        message: "503 Service Unavailable - POST https://registry.npmjs.org/audit",
        error: { summary: "", detail: "" }
      })
    }),
    { kind: "retryable", exitCode: 1 }
  );
  assert.deepEqual(
    classifyAuditAttempt({ exitCode: null, timedOut: true, stdout: auditReport(0) }),
    { kind: "retryable", exitCode: 124 }
  );
  assert.deepEqual(
    classifyAuditAttempt({ exitCode: 1, stdout: "not json" }),
    { kind: "execution_failure", exitCode: 1 }
  );
  assert.deepEqual(
    classifyAuditAttempt({ exitCode: null, spawnErrorCode: "ENOENT", stdout: "" }),
    { kind: "execution_failure", exitCode: 1 }
  );
});

test("audit retries structured transport failures exactly three times and preserves the final code", async () => {
  const transportError = (status) => ({
    exitCode: status,
    timedOut: false,
    stdout: JSON.stringify({
      message: "503 Service Unavailable - POST https://registry.npmjs.org/audit",
      error: { summary: "", detail: "" }
    }),
    stderr: ""
  });
  const attempts = [
    { exitCode: null, timedOut: true, stdout: "", stderr: "timeout\n" },
    transportError(70),
    transportError(72)
  ];
  const delays = [];
  const stdout = outputCollector();
  const stderr = outputCollector();
  let calls = 0;
  const exitCode = await runAuditWithRetries({
    runAttempt: async () => attempts[calls++],
    sleep: async (delayMs) => { delays.push(delayMs); },
    stderr: stderr.stream,
    stdout: stdout.stream
  });

  assert.equal(exitCode, 72);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [15_000, 30_000]);
  assert.equal(stderr.value().match(/retrying\./g)?.length, 2);
});

test("audit execution failures stop immediately", async () => {
  let calls = 0;
  const exitCode = await runAuditWithRetries({
    runAttempt: async () => {
      calls += 1;
      return { exitCode: 2, spawnErrorCode: "ENOENT", stdout: "", stderr: "missing\n" };
    },
    sleep: async () => { throw new Error("must not retry"); },
    stderr: outputCollector().stream,
    stdout: outputCollector().stream
  });
  assert.equal(exitCode, 2);
  assert.equal(calls, 1);
});

test("audit stops after the first completed vulnerability or clean report", async () => {
  for (const expected of [
    { result: { exitCode: 1, stdout: auditReport(1), stderr: "" }, exitCode: 1 },
    { result: { exitCode: 0, stdout: auditReport(0), stderr: "" }, exitCode: 0 }
  ]) {
    let calls = 0;
    const exitCode = await runAuditWithRetries({
      runAttempt: async () => { calls += 1; return expected.result; },
      sleep: async () => { throw new Error("must not retry"); },
      stderr: outputCollector().stream,
      stdout: outputCollector().stream
    });
    assert.equal(exitCode, expected.exitCode);
    assert.equal(calls, 1);
  }
});

test("audit execution passes exact npm arguments and maps spawn failures", () => {
  const calls = [];
  const clean = executeAuditAttempt({
    platform: "linux",
    timeoutMs: 1_234,
    spawnCommand: (...args) => {
      calls.push(args);
      return { status: 0, stdout: auditReport(0), stderr: "" };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "npm");
  assert.deepEqual(calls[0][1], [
    "audit",
    "--omit=dev",
    "--json",
    "--fetch-retries=0",
    "--fetch-timeout=60000"
  ]);
  assert.equal(calls[0][2].timeout, 1_234);
  assert.equal(calls[0][2].killSignal, "SIGTERM");
  assert.equal(calls[0][2].encoding, "utf8");
  assert.equal(calls[0][2].maxBuffer, 8 * 1024 * 1024);
  assert.deepEqual(classifyAuditAttempt(clean), { kind: "success", exitCode: 0 });

  const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  const timedOut = executeAuditAttempt({
    platform: "win32",
    spawnCommand: (command) => {
      assert.equal(command, "npm.cmd");
      return { status: null, stdout: "", stderr: "", error: timeoutError };
    }
  });
  assert.equal(timedOut.spawnErrorCode, "ETIMEDOUT");
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.stderr, /npm audit exceeded 90000 ms\./);

  const missingError = Object.assign(new Error("missing"), { code: "ENOENT" });
  const missing = executeAuditAttempt({
    spawnCommand: () => ({ status: null, stdout: "", stderr: "", error: missingError })
  });
  assert.equal(missing.spawnErrorCode, "ENOENT");
  assert.equal(missing.timedOut, false);
  assert.match(missing.stderr, /npm audit could not complete \(ENOENT\)\./);

  const bufferError = Object.assign(new Error("too large"), { code: "ENOBUFS" });
  const tooLarge = executeAuditAttempt({
    spawnCommand: () => ({ status: null, stdout: "", stderr: "", error: bufferError })
  });
  assert.deepEqual(
    classifyAuditAttempt(tooLarge),
    { kind: "execution_failure", exitCode: 1 }
  );
});
