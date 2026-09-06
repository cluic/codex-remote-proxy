import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "..");

await execFileAsync(
  process.execPath,
  [join(packageRoot, "scripts", "build-next-ui.mjs"), "--verify"],
  { cwd: packageRoot, maxBuffer: 20 * 1024 * 1024 }
);

console.log("Next static UI output matches the committed manifest and security policy.");
