import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sourceDigest, verifyCommittedUiAssets } from "../scripts/build-next-ui.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("committed UI assets bind the normalized source digest to the complete security manifest", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "ui", ".crp-ui-manifest.json"), "utf8"));
  assert.equal(manifest.buildId, await sourceDigest());
  const inspected = await verifyCommittedUiAssets();
  assert.deepEqual(manifest, inspected);
});
