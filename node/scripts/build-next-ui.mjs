import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "..");
const uiSourceRoot = join(packageRoot, "ui-src");
const generatedUiRoot = join(packageRoot, "ui");
const manifestName = ".crp-ui-manifest.json";
const generatedBuildDirectory = ".crp-next-ui-build";
const ignoredSourceDirectories = new Set([
  ".next",
  ".crp-next-ui-build",
  "node_modules",
  "out"
]);
const ignoredSourceFiles = new Set([".DS_Store", "tsconfig.tsbuildinfo"]);
const sourceMapPattern = /(?:^|\/)\S+\.map$/;
const assetUrlPattern = /\b(?:src|href)=(["'])(.*?)\1/gi;
const cssExternalUrlPattern = /(?:@import\s+|url\(\s*["']?)((?:https?:)?\/\/[^\s"')]+)/gi;
const javascriptExternalFetchPattern = /\bfetch\(\s*["']((?:https?:)?\/\/[^"']+)/g;
const inlineScriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

function compareStableNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function usage() {
  return "Usage: node scripts/build-next-ui.mjs [--verify]";
}

function assertNoUnknownArguments(argumentsList) {
  if (argumentsList.length > 1 || argumentsList.length === 1 && argumentsList[0] !== "--verify") {
    throw new Error(usage());
  }
}

function pathWithin(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || !relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.startsWith("../");
}

async function listFiles(root, { ignoredDirectories = new Set(), ignoredFiles = new Set() } = {}) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareStableNames(left.name, right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(path);
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are prohibited: ${path}`);
      if (!entry.isFile()) throw new Error(`Unsupported filesystem entry: ${path}`);
      if (!ignoredFiles.has(entry.name)) files.push(path);
    }
  }
  await visit(root);
  return files.sort(compareStableNames);
}

export function normalizeUiSourceBytes(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

export async function sourceDigest() {
  const files = await listFiles(uiSourceRoot, {
    ignoredDirectories: ignoredSourceDirectories,
    ignoredFiles: ignoredSourceFiles
  });
  const hash = createHash("sha256");
  for (const file of files) {
    const relativePath = relative(uiSourceRoot, file).replaceAll(sep, "/");
    const bytes = normalizeUiSourceBytes(await readFile(file));
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  const lockfile = JSON.parse(await readFile(join(packageRoot, "package-lock.json"), "utf8"));
  const normalizedLockfile = JSON.stringify(normalizeLockfileForUiDigest(lockfile));
  hash.update("package-lock.json\0");
  hash.update(String(Buffer.byteLength(normalizedLockfile, "utf8")));
  hash.update("\0");
  hash.update(normalizedLockfile);
  return `crp-${hash.digest("hex")}`;
}

function buildEnvironment({ buildId, distDir }) {
  const allowed = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "NODE_OPTIONS", "PATH", "TMPDIR", "TZ"];
  const environment = Object.fromEntries(
    allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])
  );
  return {
    ...environment,
    CI: "true",
    CRP_UI_BUILD_ID: buildId,
    CRP_UI_DIST_DIR: distDir,
    NODE_ENV: "production"
  };
}

export function normalizeLockfileForUiDigest(lockfile) {
  const normalized = structuredClone(lockfile);
  const releaseVersion = "__crp_release_version__";
  normalized.version = releaseVersion;
  if (normalized.packages?.[""] && typeof normalized.packages[""] === "object") {
    normalized.packages[""].version = releaseVersion;
  }
  return normalized;
}

function hashInlineScript(source) {
  return `sha256-${createHash("sha256").update(source, "utf8").digest("base64")}`;
}

function assertSafeGeneratedHtml(html, filename) {
  assert.doesNotMatch(html, /<style(?:\s|>)/i, `${filename} contains an inline style element`);
  assert.doesNotMatch(html, /\sstyle\s*=/i, `${filename} contains an inline style attribute`);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${filename} contains an inline event handler`);
  const scripts = [];
  for (const match of html.matchAll(inlineScriptPattern)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    scripts.push(hashInlineScript(match[2]));
  }
  return [...new Set(scripts)].sort();
}

function pathnameForHtml(relativePath) {
  if (relativePath === "index.html") return ["/", "/index.html"];
  if (relativePath === "404.html" || relativePath === "_not-found.html") return [];
  if (!relativePath.endsWith(".html")) return [];
  return [`/${relativePath.slice(0, -".html".length)}`];
}

function pathnameForStaticAsset(relativePath) {
  return `/${relativePath}`;
}

function assertSafeReference(value, filename, knownPaths) {
  if (value.length === 0 || value.startsWith("#") || value.startsWith("data:")) return;
  if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("//")) {
    throw new Error(`${filename} references an external resource: ${value}`);
  }
  if (!value.startsWith("/")) throw new Error(`${filename} references a non-root resource: ${value}`);
  const pathname = value.split("?", 1)[0];
  if (!knownPaths.has(pathname)) throw new Error(`${filename} references an unknown UI resource: ${value}`);
}

export async function inspectUiAssets(outputRoot, buildId) {
  const files = await listFiles(outputRoot, { ignoredFiles: new Set([manifestName]) });
  const assets = {};
  const html = [];
  for (const file of files) {
    const relativePath = relative(outputRoot, file).replaceAll(sep, "/");
    if (sourceMapPattern.test(relativePath)) throw new Error(`Source maps are prohibited: ${relativePath}`);
    const extension = extname(relativePath).toLowerCase();
    const inlineScriptHashes = extension === ".html"
      ? assertSafeGeneratedHtml(await readFile(file, "utf8"), relativePath)
      : [];
    if (extension === ".html") html.push({ relativePath, file, inlineScriptHashes });
    if (relativePath !== "404.html" && relativePath !== "_not-found.html") {
      const paths = extension === ".html"
        ? pathnameForHtml(relativePath)
        : [pathnameForStaticAsset(relativePath)];
      for (const pathname of paths) {
        if (Object.hasOwn(assets, pathname)) throw new Error(`Duplicate UI route: ${pathname}`);
        assets[pathname] = { file: relativePath, inlineScriptHashes };
      }
    }
  }
  const notFound = html.find((entry) => entry.relativePath === "404.html")
    ?? html.find((entry) => entry.relativePath === "_not-found.html");
  if (!notFound || !Object.hasOwn(assets, "/") || !Object.hasOwn(assets, "/index.html")) {
    throw new Error("Next static export is missing a required HTML document");
  }
  const knownPaths = new Set(Object.keys(assets));
  for (const entry of html) {
    const source = await readFile(entry.file, "utf8");
    for (const match of source.matchAll(assetUrlPattern)) {
      assertSafeReference(match[2], entry.relativePath, knownPaths);
    }
  }
  for (const file of files) {
    const relativePath = relative(outputRoot, file).replaceAll(sep, "/");
    if (!/\.(?:css|js|mjs)$/i.test(relativePath)) continue;
    const source = await readFile(file, "utf8");
    const externalPattern = relativePath.endsWith(".css")
      ? cssExternalUrlPattern
      : javascriptExternalFetchPattern;
    for (const match of source.matchAll(externalPattern)) {
      throw new Error(`${relativePath} contains an external URL: ${match[0]}`);
    }
    assert.doesNotMatch(source, /sourceMappingURL=/, `${relativePath} contains a source map reference`);
  }
  const manifest = {
    version: 1,
    buildId,
    assets: Object.fromEntries(Object.entries(assets).sort(([left], [right]) => left.localeCompare(right))),
    notFound: {
      file: notFound.relativePath,
      inlineScriptHashes: notFound.inlineScriptHashes
    }
  };
  return manifest;
}

async function buildManifest(outputRoot, buildId) {
  const manifest = await inspectUiAssets(outputRoot, buildId);
  await writeFile(join(outputRoot, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function verifyCommittedUiAssets() {
  const buildId = await sourceDigest();
  const expectedManifest = await inspectUiAssets(generatedUiRoot, buildId);
  const committedManifest = JSON.parse(await readFile(join(generatedUiRoot, manifestName), "utf8"));
  assert.deepEqual(
    committedManifest,
    expectedManifest,
    "committed UI manifest does not match the source and reviewed assets"
  );
  return expectedManifest;
}

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const sourcePath of await listFiles(source)) {
    const relativePath = relative(source, sourcePath);
    const destinationPath = resolve(destination, relativePath);
    if (!pathWithin(destination, destinationPath)) throw new Error("Generated UI path escapes the staging directory");
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

async function normalizeGeneratedJavaScript(root) {
  for (const file of await listFiles(root)) {
    if (!/\.js$/i.test(file)) continue;
    const source = await readFile(file, "utf8");
    const normalized = source.replace(/[ \t]+$/gm, "");
    if (normalized !== source) await writeFile(file, normalized, "utf8");
  }
}

async function replaceGeneratedUi(outputRoot) {
  const stagingRoot = await mkdir(join(packageRoot, ".ui-next-stage"), { recursive: true })
    .then(() => join(packageRoot, ".ui-next-stage"));
  await rm(stagingRoot, { recursive: true, force: true });
  await copyTree(outputRoot, stagingRoot);
  const backupRoot = join(packageRoot, ".ui-next-backup");
  await rm(backupRoot, { recursive: true, force: true });
  let movedCurrent = false;
  try {
    await rename(generatedUiRoot, backupRoot);
    movedCurrent = true;
    await rename(stagingRoot, generatedUiRoot);
  } catch (error) {
    if (movedCurrent) {
      try { await rename(backupRoot, generatedUiRoot); } catch {}
    }
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    if (movedCurrent) await rm(backupRoot, { recursive: true, force: true });
  }
}

async function compareTrees(expectedRoot, actualRoot) {
  const [expectedFiles, actualFiles] = await Promise.all([listFiles(expectedRoot), listFiles(actualRoot)]);
  const expectedRelative = expectedFiles.map((file) => relative(expectedRoot, file).replaceAll(sep, "/"));
  const actualRelative = actualFiles.map((file) => relative(actualRoot, file).replaceAll(sep, "/"));
  assert.deepEqual(actualRelative, expectedRelative, "committed UI file paths are out of sync");
  for (const relativePath of expectedRelative) {
    const [expected, actual] = await Promise.all([
      readFile(join(expectedRoot, relativePath)),
      readFile(join(actualRoot, relativePath))
    ]);
    assert.deepEqual(actual, expected, `${relativePath} is out of sync`);
  }
}

async function main() {
  assertNoUnknownArguments(process.argv.slice(2));
  const verifyOnly = process.argv[2] === "--verify";
  const buildId = await sourceDigest();
  const outputRoot = join(uiSourceRoot, generatedBuildDirectory);
  await rm(outputRoot, { recursive: true, force: true });
  try {
    await execFileAsync(
      process.execPath,
      [join(packageRoot, "node_modules", "next", "dist", "bin", "next"), "build", uiSourceRoot, "--webpack"],
      {
        cwd: packageRoot,
        env: buildEnvironment({ buildId, distDir: generatedBuildDirectory }),
        maxBuffer: 20 * 1024 * 1024
      }
    );
    await normalizeGeneratedJavaScript(outputRoot);
    await buildManifest(outputRoot, buildId);
    if (verifyOnly) await compareTrees(outputRoot, generatedUiRoot);
    else await replaceGeneratedUi(outputRoot);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

const directExecution = typeof process.argv[1] === "string"
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) await main();
