import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "..");
const committedRoot = join(packageRoot, "ui");
const expectedFiles = ["app.js", "index.html", "styles.css"];
const budgets = {
  "app.js": 300 * 1024,
  "index.html": 20 * 1024,
  "styles.css": 50 * 1024
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function assertAllowedAbsoluteUrl(rawUrl, context) {
  if (rawUrl === "http://" || rawUrl === "https://" || rawUrl.startsWith("http://$") || rawUrl.startsWith("https://$")) {
    return;
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    assert.fail(`${context} contains an invalid absolute URL: ${rawUrl}`);
  }
  assert.ok(LOOPBACK_HOSTS.has(parsed.hostname), `${context} contains a non-loopback absolute URL: ${rawUrl}`);
}

function assertNoHardcodedRemoteUrls(source, context) {
  for (const match of source.matchAll(/https?:\/\/(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._~-]+)(?::\d+)?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*)?/g)) {
    assertAllowedAbsoluteUrl(match[0], context);
  }
}

function assertNoForbiddenMarkup(html) {
  assert.doesNotMatch(html, /<style(?:\s|>)/i, "inline style elements are prohibited");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, "inline scripts are prohibited");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "inline event handlers are prohibited");
  for (const match of html.matchAll(/\b(?:src|href|action|poster)=["'](https?:\/\/[^"']+)["']/gi)) {
    assertAllowedAbsoluteUrl(match[1], "built HTML resource");
  }
}

async function assertUiSourceUrls(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertUiSourceUrls(path);
    else if (/\.(?:ts|tsx|html)$/.test(entry.name)) {
      assertNoHardcodedRemoteUrls(await readFile(path, "utf8"), `UI source ${entry.name}`);
    }
  }
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "crp-ui-build-"));
const temporaryOutput = join(temporaryRoot, "ui");

try {
  await assertUiSourceUrls(join(packageRoot, "ui-src"));
  await execFileAsync(
    process.execPath,
    [
      join(packageRoot, "node_modules", "vite", "bin", "vite.js"),
      "build",
      "--config",
      join(packageRoot, "vite.config.mjs"),
      "--outDir",
      temporaryOutput,
      "--emptyOutDir"
    ],
    { cwd: packageRoot }
  );

  const actualFiles = (await readdir(temporaryOutput)).sort();
  assert.deepEqual(actualFiles, expectedFiles, "the UI build must contain exactly three files");

  for (const filename of expectedFiles) {
    const [generated, committed] = await Promise.all([
      readFile(join(temporaryOutput, filename)),
      readFile(join(committedRoot, filename))
    ]);
    assert.deepEqual(generated, committed, `${filename} is not synchronized with ui-src`);
    assert.equal((await stat(join(temporaryOutput, filename))).isFile(), true);
    assert.ok(gzipSync(generated).length <= budgets[filename], `${filename} exceeds its gzip budget`);
  }

  assertNoForbiddenMarkup(await readFile(join(temporaryOutput, "index.html"), "utf8"));
  const javascript = await readFile(join(temporaryOutput, "app.js"), "utf8");
  assert.doesNotMatch(javascript, /sourceMappingURL=/, "source maps are prohibited");
  for (const match of javascript.matchAll(/\bfetch\(["'](https?:\/\/[^"']+)["']/g)) {
    assertAllowedAbsoluteUrl(match[1], "runtime request");
  }
  assert.match(javascript, /SPDX-License-Identifier: MIT AND ISC/, "bundled license notice is required");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("UI build matches the committed three-file output and size/security policy.");
