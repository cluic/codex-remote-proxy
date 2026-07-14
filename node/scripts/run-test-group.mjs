import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const group = process.argv[2];
const supportedGroups = new Set(["unit", "unit-core", "capture", "integration", "core-chain"]);
if (!supportedGroups.has(group)) throw new Error(`Unknown test group: ${group}`);
const testRoot = resolve("test");
const integrationRoot = join(testRoot, "integration");
const coreChainPath = join(integrationRoot, "core-real-chain.test.mjs");
const selectedRoot = group === "integration" || group === "core-chain" ? integrationRoot : testRoot;
const recursive = group === "integration" || group === "core-chain";

function collect(dir, descend) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && descend) files.push(...collect(path, true));
    if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(path);
  }
  return files;
}

let files = statSync(selectedRoot, { throwIfNoEntry: false })?.isDirectory()
  ? collect(selectedRoot, recursive).sort()
  : [];
if (group === "unit-core") {
  files = files.filter((file) => file !== join(testRoot, "capture-store.test.mjs"));
}
if (group === "capture") {
  files = files.filter((file) => file === join(testRoot, "capture-store.test.mjs"));
}
if (group === "integration") {
  files = files.filter((file) => file !== coreChainPath);
}
if (group === "core-chain") {
  files = files.filter((file) => file === coreChainPath);
}
if (files.length === 0) throw new Error(`No ${group} test files found`);
const testArgs = group === "core-chain"
  ? ["--test", "--test-concurrency=1", ...files]
  : ["--test", ...files];
const result = spawnSync(process.execPath, testArgs, { stdio: "inherit" });
process.exit(result.status ?? 1);
