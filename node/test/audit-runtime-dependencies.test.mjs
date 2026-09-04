import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyAuditAttempt,
  completedAuditReport,
  runAuditWithRetries
} from "../scripts/audit-runtime-dependencies.mjs";

function auditReport(total, vulnerabilities = {}) {
  return JSON.stringify({
    auditReportVersion: 2,
    metadata: {
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
  assert.equal(completedAuditReport('{"metadata":{"vulnerabilities":{"total":-1}}}'), null);
  assert.equal(completedAuditReport("not json"), null);
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
    classifyAuditAttempt({ exitCode: 1, stdout: '{"error":"Service Unavailable"}' }),
    { kind: "retryable", exitCode: 1 }
  );
  assert.deepEqual(
    classifyAuditAttempt({ exitCode: null, timedOut: true, stdout: auditReport(0) }),
    { kind: "retryable", exitCode: 124 }
  );
});

test("audit retries incomplete reports exactly three times and preserves the final code", async () => {
  const attempts = [
    { exitCode: null, timedOut: true, stdout: "", stderr: "timeout\n" },
    { exitCode: 70, timedOut: false, stdout: '{"error":"offline"}', stderr: "" },
    { exitCode: 72, timedOut: false, stdout: "", stderr: "unavailable\n" }
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
