import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const INDEX_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;
const COLUMN_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;

function validWorkerData(value) {
  return value && typeof value === "object"
    && typeof value.dbPath === "string" && value.dbPath.length > 0
    && typeof value.indexName === "string" && INDEX_NAME_PATTERN.test(value.indexName)
    && Array.isArray(value.columns) && value.columns.length > 0
    && value.columns.every((column) => typeof column === "string"
      && COLUMN_NAME_PATTERN.test(column));
}

function prepareIndex({ dbPath, indexName, columns }) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 30000");
    db.exec(`CREATE INDEX IF NOT EXISTS ${indexName}
      ON http_transactions (${columns.join(", ")})`);
  } finally {
    db.close();
  }
}

try {
  if (!parentPort || !validWorkerData(workerData)) {
    throw new Error("Invalid capture index worker input");
  }
  prepareIndex(workerData);
  parentPort.postMessage({ type: "complete" });
} catch {
  parentPort?.postMessage({ type: "failed" });
  process.exitCode = 1;
}
