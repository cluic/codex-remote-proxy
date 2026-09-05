import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (typeof sql === "string" && sql.includes("CREATE INDEX IF NOT EXISTS idx_http_transactions_forwarding_metadata")) {
    originalExec.call(this, "BEGIN IMMEDIATE");
    writeFileSync(process.env.CRP_TEST_INDEX_STARTED, "started", { mode: 0o600 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
    try {
      return originalExec.call(this, sql);
    } finally {
      originalExec.call(this, "COMMIT");
    }
  }
  return originalExec.call(this, sql);
};
