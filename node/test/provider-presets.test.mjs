import assert from "node:assert/strict";
import test from "node:test";

import { getProviderPreset, listProviderPresets } from "../src/providers/provider-presets.mjs";

test("OpenRouter built-in preset uses the maintained API v1 endpoint", () => {
  const preset = getProviderPreset("openrouter");
  assert.deepEqual(preset, {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    homepageUrl: "https://openrouter.ai",
    documentationUrl: "https://openrouter.ai/docs/api-reference/overview"
  });
});

test("provider preset callers cannot mutate the maintained catalog", () => {
  const first = listProviderPresets();
  first[0].baseUrl = "https://unsafe.example/v1";
  first[0].extraHeaders["x-test"] = "unsafe";
  assert.equal(getProviderPreset("openrouter").baseUrl, "https://openrouter.ai/api/v1");
  assert.deepEqual(getProviderPreset("openrouter").extraHeaders, {});
  assert.equal(getProviderPreset("missing"), null);
});
