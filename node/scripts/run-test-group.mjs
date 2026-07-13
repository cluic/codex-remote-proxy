import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const group = process.argv[2];
const supportedGroups = new Set(["unit", "unit-core", "capture", "integration"]);
if (!supportedGroups.has(group)) throw new Error(`Unknown test group: ${group}`);
const testRoot = resolve("test");
const selectedRoot = group === "integration" ? join(testRoot, "integration") : testRoot;
const recursive = group === "integration";

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
if (files.length === 0) throw new Error(`No ${group} test files found`);
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
