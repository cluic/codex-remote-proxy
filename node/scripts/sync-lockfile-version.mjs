import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseJsonObject(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value;
}

export function syncLockfileVersion({
  packagePath = resolve(import.meta.dirname, "..", "package.json"),
  lockPath = resolve(import.meta.dirname, "..", "package-lock.json")
} = {}) {
  const packageJson = parseJsonObject(packagePath, "package.json");
  const packageLock = parseJsonObject(lockPath, "package-lock.json");
  const lockRoot = packageLock.packages?.[""];

  if (typeof packageJson.name !== "string" || packageJson.name.length === 0
    || typeof packageJson.version !== "string" || packageJson.version.length === 0
    || packageLock.name !== packageJson.name
    || lockRoot === null || typeof lockRoot !== "object" || Array.isArray(lockRoot)
    || lockRoot.name !== packageJson.name) {
    throw new Error("Package and lockfile root metadata do not match.");
  }

  if (packageLock.version === packageJson.version
    && lockRoot.version === packageJson.version) {
    return { changed: false, version: packageJson.version };
  }

  packageLock.version = packageJson.version;
  lockRoot.version = packageJson.version;
  writeFileSync(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
  return { changed: true, version: packageJson.version };
}

const directExecution = typeof process.argv[1] === "string"
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  const result = syncLockfileVersion();
  process.stdout.write(
    result.changed
      ? `Synchronized package-lock.json to ${result.version}.\n`
      : `package-lock.json is already synchronized at ${result.version}.\n`
  );
}
