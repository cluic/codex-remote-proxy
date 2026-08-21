import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
const packageDocument = JSON.parse(readFileSync(packagePath, "utf8"));

function publicUrl(value) {
  return typeof value === "string" && /^https:\/\//.test(value) ? value : null;
}

function repositoryUrl(value) {
  const raw = typeof value === "string" ? value : value?.url;
  if (typeof raw !== "string") return null;
  return publicUrl(raw.replace(/^git\+/, "").replace(/\.git$/, ""));
}

export const BUILD_INFO = Object.freeze({
  name: typeof packageDocument.name === "string" ? packageDocument.name : "crp",
  version: typeof packageDocument.version === "string" ? packageDocument.version : "0.0.0",
  repositoryUrl: repositoryUrl(packageDocument.repository),
  homepageUrl: publicUrl(packageDocument.homepage),
  issuesUrl: publicUrl(packageDocument.bugs?.url)
});

export function getPublicBuildInfo() {
  return { ...BUILD_INFO };
}
