import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetryableProviderResponse,
  isRetryableProviderTransportError,
  ProviderScheduler
} from "../src/routing/provider-scheduler.mjs";

const providers = [
  { id: "preferred", weight: 100 },
  { id: "high", weight: 300 },
  { id: "equal", weight: 100 }
];

test("orders healthy providers by weight while preserving snapshot tie order", () => {
  const scheduler = new ProviderScheduler({ now: () => 1_000 });
  assert.deepEqual(
    scheduler.ordered(providers).map(({ id }) => id),
    ["high", "preferred", "equal"]
  );
  assert.equal(scheduler.explain(providers).primaryReason, "weight");

  const tied = scheduler.plan([
    { id: "first", weight: 100 },
    { id: "second", weight: 100 }
  ]);
  assert.equal(tied.primaryReason, "runtime_order");
  assert.deepEqual(tied.providers.map(({ id }) => id), ["first", "second"]);
});

test("cools retryable responses and restores a provider after the deadline", () => {
  let now = 1_000;
  const scheduler = new ProviderScheduler({ now: () => now });
  assert.equal(scheduler.markResponse("high", 503), true);
  assert.deepEqual(
    scheduler.ordered(providers).map(({ id }) => id),
    ["preferred", "equal"]
  );
  assert.deepEqual(scheduler.state("high"), { failures: 1, blockedUntilMs: 31_000 });
  now = 31_000;
  assert.deepEqual(
    scheduler.ordered(providers).map(({ id }) => id),
    ["high", "preferred", "equal"]
  );
  scheduler.markSuccess("high");
  assert.deepEqual(scheduler.state("high"), { failures: 0, blockedUntilMs: null });
});

test("honors bounded Retry-After and keeps one probe when every provider is cooling", () => {
  let now = 10_000;
  const scheduler = new ProviderScheduler({ now: () => now });
  scheduler.markResponse("preferred", 429, { "retry-after": "120" });
  scheduler.markResponse("high", 500);
  scheduler.markTransportFailure("equal", Object.assign(new Error("offline"), { code: "ECONNREFUSED" }));
  assert.deepEqual(scheduler.ordered(providers).map(({ id }) => id), ["equal"]);
  assert.equal(scheduler.state("preferred").blockedUntilMs, 130_000);
  now = 25_000;
  assert.deepEqual(scheduler.ordered(providers).map(({ id }) => id), ["equal"]);
});

test("classifies only explicit provider availability failures", () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableProviderResponse(status), true);
  }
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isRetryableProviderResponse(status), false);
  }
  assert.equal(isRetryableProviderTransportError({ code: "ECONNREFUSED" }), true);
  assert.equal(isRetryableProviderTransportError({ cause: { code: "ENOTFOUND" } }), true);
  assert.equal(isRetryableProviderTransportError({ code: "ETIMEDOUT" }), true);
  assert.equal(isRetryableProviderTransportError({ code: "CERT_HAS_EXPIRED" }), false);
  assert.equal(isRetryableProviderTransportError(new Error("generic")), false);
});

test("orders providers per exact model rule and enforces custom model availability", () => {
  const scheduler = new ProviderScheduler({ now: () => 1_000 });
  const providers = [
    {
      id: "provider-a",
      weight: 900,
      supportedModels: ["gpt-5.6-sol"],
      disabledModels: [],
      proxy: { modelMode: "passthrough", modelOverride: null, modelMappings: [] }
    },
    {
      id: "provider-b",
      weight: 100,
      supportedModels: ["gpt-5.6-luna", "vendor/sol"],
      disabledModels: [],
      proxy: {
        modelMode: "passthrough",
        modelOverride: null,
        modelMappings: [{ sourceModel: "gpt-5.6-sol", targetModel: "vendor/sol" }]
      }
    },
    {
      id: "provider-c",
      weight: 500,
      supportedModels: null,
      disabledModels: ["gpt-5.6-terra"],
      proxy: { modelMode: "passthrough", modelOverride: null, modelMappings: [] }
    }
  ];
  const priorityRules = [
    { model: "gpt-5.6-sol", providerIds: ["provider-b", "provider-a"] },
    { model: "gpt-5.6-luna", providerIds: ["provider-b"] }
  ];

  assert.deepEqual(
    scheduler.ordered(providers, { model: "gpt-5.6-sol", priorityRules }).map(({ id }) => id),
    ["provider-b", "provider-a", "provider-c"]
  );
  assert.deepEqual(
    scheduler.ordered(providers, { model: "gpt-5.6-luna", priorityRules }).map(({ id }) => id),
    ["provider-b", "provider-c"]
  );
  assert.deepEqual(
    scheduler.ordered(providers, { model: "gpt-5.6-terra", priorityRules }).map(({ id }) => id),
    []
  );
  assert.deepEqual(
    scheduler.ordered(providers, { model: "gpt-5.6-nova", priorityRules }).map(({ id }) => id),
    ["provider-c"]
  );
});

test("explains the exact ordered route without exposing provider configuration", () => {
  const scheduler = new ProviderScheduler({ now: () => 1_000 });
  const candidates = [
    {
      id: "provider-a",
      name: "Provider A",
      weight: 500,
      supportedModels: ["model-a"],
      disabledModels: [],
      proxy: { modelMode: "passthrough", modelOverride: null, modelMappings: [] },
      upstream: { apiKey: "must-not-be-projected" }
    },
    {
      id: "provider-b",
      name: "Provider B",
      weight: 100,
      supportedModels: ["vendor/model-a"],
      disabledModels: [],
      proxy: {
        modelMode: "passthrough",
        modelOverride: null,
        modelMappings: [{ sourceModel: "model-a", targetModel: "vendor/model-a" }]
      },
      upstream: { apiKey: "also-private" }
    },
    {
      id: "provider-c",
      name: "Provider C",
      weight: 900,
      supportedModels: null,
      disabledModels: ["model-a"],
      proxy: { modelMode: "passthrough", modelOverride: null, modelMappings: [] }
    }
  ];
  scheduler.markResponse("provider-b", 503);
  const explanation = scheduler.explain(candidates, {
    model: "model-a",
    priorityRules: [{ model: "model-a", providerIds: ["provider-b", "provider-a"] }]
  });
  const serialized = JSON.stringify(explanation);
  assert.equal(serialized.includes("must-not-be-projected"), false);
  assert.equal(serialized.includes("also-private"), false);

  assert.equal(explanation.matchedPriorityRule, true);
  assert.equal(explanation.primaryReason, "sole_eligible");
  assert.deepEqual(explanation.candidates, [
    {
      providerId: "provider-a",
      providerName: "Provider A",
      weight: 500,
      targetModel: null,
      transformation: "passthrough",
      support: "supported",
      cooling: false,
      blockedUntilMs: null,
      order: 1
    },
    {
      providerId: "provider-b",
      providerName: "Provider B",
      weight: 100,
      targetModel: "vendor/model-a",
      transformation: "mapping",
      support: "supported",
      cooling: true,
      blockedUntilMs: 31_000,
      order: null
    },
    {
      providerId: "provider-c",
      providerName: "Provider C",
      weight: 900,
      targetModel: null,
      transformation: "passthrough",
      support: "disabled",
      cooling: false,
      blockedUntilMs: null,
      order: null
    }
  ]);
});
