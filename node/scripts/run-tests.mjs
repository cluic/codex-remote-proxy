import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const groupRunner = fileURLToPath(new URL("./run-test-group.mjs", import.meta.url));

for (const group of ["unit-core", "capture", "integration"]) {
  const result = spawnSync(process.execPath, [groupRunner, group], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
