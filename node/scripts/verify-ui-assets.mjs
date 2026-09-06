import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

import { loadUiAssets } from "../src/supervisor/ui-assets.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(packageRoot, "ui");
const manifest = JSON.parse(readFileSync(join(uiRoot, ".crp-ui-manifest.json"), "utf8"));
const assetEntries = [
  ...Object.values(manifest.assets),
  manifest.notFound
];
const assetFiles = new Set([
  ...assetEntries.map((entry) => entry.file),
  "404.html",
  "_not-found.html"
]);
const inlineScriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const sourceMapPattern = /sourceMappingURL=/;
const cssExternalUrlPattern = /(?:@import\s+|url\(\s*["']?)((?:https?:)?\/\/[^\s"')]+)/gi;
const javascriptExternalFetchPattern = /\bfetch\(\s*["']((?:https?:)?\/\/[^"']+)/g;

function listFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        assert.equal(entry.isFile(), true, `Unsupported UI entry: ${path}`);
        files.push(relative(root, path).replaceAll(sep, "/"));
      }
    }
  }
  visit(root);
  return files;
}

function hashInlineScript(source) {
  return `sha256-${createHash("sha256").update(source, "utf8").digest("base64")}`;
}

function htmlScriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(inlineScriptPattern)) {
    if (!/\bsrc\s*=/i.test(match[1])) hashes.push(hashInlineScript(match[2]));
  }
  return [...new Set(hashes)].sort();
}

loadUiAssets(uiRoot);
assert.deepEqual(
  listFiles(uiRoot).filter((file) => file !== ".crp-ui-manifest.json").sort(),
  [...assetFiles].sort(),
  "committed UI files must match the manifest"
);

for (const entry of assetEntries) {
  const file = join(uiRoot, entry.file);
  const extension = extname(entry.file).toLowerCase();
  const source = readFileSync(file, "utf8");
  if (extension === ".html") {
    assert.deepEqual(
      htmlScriptHashes(source),
      [...entry.inlineScriptHashes].sort(),
      `${entry.file} CSP hashes are out of sync`
    );
  }
  if (extension === ".css" || extension === ".js" || extension === ".mjs") {
    const externalPattern = extension === ".css"
      ? cssExternalUrlPattern
      : javascriptExternalFetchPattern;
    assert.doesNotMatch(source, externalPattern, `${entry.file} contains an external URL`);
    assert.doesNotMatch(source, sourceMapPattern, `${entry.file} contains a source map reference`);
  }
  assert.equal(lstatSync(file).isSymbolicLink(), false, `${entry.file} must not be a symlink`);
}

console.log("Committed UI assets match the manifest and security policy.");
