import { readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const MANIFEST_NAME = ".crp-ui-manifest.json";
const HASH_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;
const ASSET_PATH_PATTERN = /^\/[A-Za-z0-9._/-]*$/;
const FILE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/x-component; charset=utf-8"],
  [".webp", "image/webp"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".avif", "image/avif"]
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, context) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new TypeError(`${context} is invalid`);
  }
}

function normalizeAssetPath(pathname, context) {
  if (typeof pathname !== "string"
    || !ASSET_PATH_PATTERN.test(pathname)
    || pathname.includes("//")
    || pathname.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError(`${context} path is invalid`);
  }
  return pathname;
}

function normalizeFilePath(file, context) {
  if (typeof file !== "string"
    || !FILE_PATH_PATTERN.test(file)
    || file.startsWith("/")
    || file.includes("//")
    || file.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError(`${context} file is invalid`);
  }
  const contentType = CONTENT_TYPES.get(extname(file).toLowerCase());
  if (!contentType) throw new TypeError(`${context} file type is invalid`);
  return { file, contentType };
}

function normalizeHashes(value, context) {
  if (!Array.isArray(value)
    || value.some((hash) => typeof hash !== "string" || !HASH_PATTERN.test(hash))
    || new Set(value).size !== value.length) {
    throw new TypeError(`${context} inline script hashes are invalid`);
  }
  return Object.freeze([...value].sort());
}

function parseAsset(pathname, value, root) {
  assertExactKeys(value, ["file", "inlineScriptHashes"], `UI asset ${pathname}`);
  const { file, contentType } = normalizeFilePath(value.file, `UI asset ${pathname}`);
  const resolved = resolve(root, file);
  if (!resolved.startsWith(`${root}${sep}`)) throw new TypeError(`UI asset ${pathname} escapes the UI root`);
  let stats;
  try {
    stats = statSync(resolved);
  } catch (error) {
    throw new TypeError(`UI asset ${pathname} is missing`, { cause: error });
  }
  if (!stats.isFile()) throw new TypeError(`UI asset ${pathname} is not a file`);
  return Object.freeze({
    file,
    path: resolved,
    contentType,
    inlineScriptHashes: normalizeHashes(value.inlineScriptHashes, `UI asset ${pathname}`)
  });
}

function rawAssetPath(requestTarget) {
  if (typeof requestTarget !== "string" || !requestTarget.startsWith("/")) return null;
  const queryIndex = requestTarget.indexOf("?");
  const pathname = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex);
  if (!ASSET_PATH_PATTERN.test(pathname)
    || pathname.includes("//")
    || pathname.split("/").some((part) => part === "." || part === "..")) {
    return null;
  }
  return pathname;
}

export function createUiContentSecurityPolicy(inlineScriptHashes = []) {
  const hashes = normalizeHashes(inlineScriptHashes, "UI CSP");
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length > 0 ? ` ${hashes.map((hash) => `'${hash}'`).join(" ")}` : ""}`,
    "script-src-attr 'none'",
    "style-src-elem 'self'",
    "style-src-attr 'none'",
    "connect-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join("; ");
}

export function loadUiAssets(uiDir) {
  if (typeof uiDir !== "string" || uiDir.length === 0) {
    throw new TypeError("UI directory is invalid");
  }
  const root = resolve(uiDir);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(root, MANIFEST_NAME), "utf8"));
  } catch (error) {
    throw new TypeError("UI manifest is unavailable", { cause: error });
  }
  assertExactKeys(manifest, ["version", "buildId", "assets", "notFound"], "UI manifest");
  if (manifest.version !== 1
    || typeof manifest.buildId !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/.test(manifest.buildId)
    || !isPlainObject(manifest.assets)) {
    throw new TypeError("UI manifest is invalid");
  }

  const assets = new Map();
  for (const [pathname, value] of Object.entries(manifest.assets)) {
    const normalizedPath = normalizeAssetPath(pathname, "UI asset");
    if (normalizedPath === "/.crp-ui-manifest.json") throw new TypeError("UI manifest must not be public");
    const asset = parseAsset(normalizedPath, value, root);
    assets.set(normalizedPath, asset);
  }
  if (!assets.has("/") || !assets.has("/index.html")) {
    throw new TypeError("UI manifest is missing the root document");
  }
  const notFound = parseAsset("notFound", manifest.notFound, root);
  if (assets.get("/")?.contentType !== "text/html; charset=utf-8"
    || assets.get("/index.html")?.contentType !== "text/html; charset=utf-8"
    || notFound.contentType !== "text/html; charset=utf-8") {
    throw new TypeError("UI manifest documents must be HTML");
  }

  return Object.freeze({
    buildId: manifest.buildId,
    resolve(requestTarget) {
      const pathname = rawAssetPath(requestTarget);
      if (pathname === null) return null;
      return assets.get(pathname) ?? null;
    },
    notFound,
    contentSecurityPolicy(asset) {
      return createUiContentSecurityPolicy(asset.inlineScriptHashes);
    }
  });
}
