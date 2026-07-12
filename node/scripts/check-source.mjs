import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const roots = [join(root, "bin"), join(root, "src"), join(root, "scripts"), join(root, "ui")];
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) files.push(path);
  }
}

for (const dir of roots) {
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) walk(dir);
}

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`${relative(root, file)}\n${result.stderr}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`Syntax checked ${files.length} source files.`);
