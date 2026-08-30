import assert from "node:assert/strict";
import test from "node:test";

import { ProviderScheduler } from "../src/routing/provider-scheduler.mjs";
import {
  buildRoutePreview,
  isRoutePreviewModel,
  isValidRoutePreview
} from "../src/routing/route-preview.mjs";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const accountState = {
  authMode: "chatgpt",
  quotaStatus: "available",
  blockedUntil: null,
  updatedAt: "2030-01-01T00:00:00.000Z"
};

function settings(mode = "account_first") {
  return {
    providers: [
      {
        id: "provider-a",
        name: "Provider A",
        weight: 500,
        supportedModels: ["model-a"],
        disabledModels: [],
        proxy: { modelMode: "passthrough", modelOverride: null, modelMappings: [] }
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
        }
      }
    ],
    routing: {
      mode,
      providerPriorityRules: [{ model: "model-a", providerIds: ["provider-b", "provider-a"] }]
    }
  };
}

test("builds a live account-first preview with an exact custom fallback chain", () => {
  const scheduler = new ProviderScheduler({ now: () => NOW });
  scheduler.markResponse("provider-b", 503);
  const preview = buildRoutePreview({
    source: "live",
    generation: 12,
    settings: settings(),
    accountState,
    providerScheduler: scheduler,
    nowMs: NOW,
    model: "model-a"
  });

  assert.equal(isValidRoutePreview(preview), true);
  assert.deepEqual(preview, {
    source: "live",
    generation: 12,
    evaluatedAt: "2030-01-01T00:00:00.000Z",
    operation: "responses",
    route: "account",
    reason: "account_eligible",
    account: {
      enabled: true,
      selected: true,
      reason: "account_eligible",
      operationSupported: true,
      fallbackAvailable: true
    },
    matchedPriorityRule: true,
    customSelectionReason: "sole_eligible",
    customPrimaryProviderId: "provider-a",
    candidates: [
      {
        providerId: "provider-a",
        providerName: "Provider A",
        weight: 500,
        targetModel: null,
        transformation: "passthrough",
        availability: "ready",
        coolingUntil: null,
        order: 1
      },
      {
        providerId: "provider-b",
        providerName: "Provider B",
        weight: 100,
        targetModel: "vendor/model-a",
        transformation: "mapping",
        availability: "cooling",
        coolingUntil: "2030-01-01T00:00:30.000Z",
        order: null
      }
    ]
  });
});

test("uses the real operation and model capability gates for image previews", () => {
  const scheduler = new ProviderScheduler({ now: () => NOW });
  const imageEndpoint = buildRoutePreview({
    source: "live",
    generation: 2,
    settings: settings(),
    accountState,
    providerScheduler: scheduler,
    nowMs: NOW,
    model: "model-a",
    operation: "images/generations"
  });
  assert.equal(imageEndpoint.operation, "images/generations");
  assert.equal(imageEndpoint.route, "custom");
  assert.equal(imageEndpoint.reason, "unsupported_operation");
  assert.equal(imageEndpoint.account.reason, "unsupported_operation");
  assert.equal(imageEndpoint.account.operationSupported, false);
  assert.equal(imageEndpoint.customPrimaryProviderId, "provider-b");

  const directImageModel = buildRoutePreview({
    source: "live",
    generation: 2,
    settings: {
      ...settings(),
      providers: settings().providers.map((provider) => ({
        ...provider,
        supportedModels: null
      }))
    },
    accountState,
    providerScheduler: scheduler,
    nowMs: NOW,
    model: "gpt-image-2",
    operation: "responses"
  });
  assert.equal(directImageModel.route, "custom");
  assert.equal(directImageModel.reason, "unsupported_account_model");
  assert.equal(directImageModel.account.operationSupported, true);
  assert.equal(isValidRoutePreview(directImageModel), true);
});

test("reports configured custom routing and an unavailable exact model", () => {
  const scheduler = new ProviderScheduler({ now: () => NOW });
  const custom = buildRoutePreview({
    source: "configured",
    generation: 0,
    settings: settings("custom_only"),
    accountState,
    providerScheduler: scheduler,
    nowMs: NOW,
    model: "model-a"
  });
  assert.equal(custom.route, "custom");
  assert.equal(custom.reason, "custom_only");
  assert.equal(custom.customPrimaryProviderId, "provider-b");
  assert.equal(custom.candidates[0].targetModel, "vendor/model-a");

  const unavailable = buildRoutePreview({
    source: "configured",
    generation: 0,
    settings: settings("custom_only"),
    accountState,
    providerScheduler: scheduler,
    nowMs: NOW,
    model: "unknown-model"
  });
  assert.equal(unavailable.route, "unavailable");
  assert.equal(unavailable.reason, "custom_model_unavailable");
  assert.equal(unavailable.customPrimaryProviderId, null);
});

test("keeps an eligible ChatGPT route available without a custom Provider pool", () => {
  const accountOnly = buildRoutePreview({
    source: "live",
    generation: 1,
    settings: {
      providers: [],
      routing: { mode: "account_first", providerPriorityRules: [] }
    },
    accountState,
    providerScheduler: new ProviderScheduler({ now: () => NOW }),
    nowMs: NOW,
    model: "model-a"
  });
  assert.equal(accountOnly.route, "account");
  assert.equal(accountOnly.reason, "account_eligible");
  assert.equal(accountOnly.account.fallbackAvailable, false);
  assert.equal(accountOnly.customPrimaryProviderId, null);
  assert.deepEqual(accountOnly.candidates, []);
  assert.equal(isValidRoutePreview(accountOnly), true);
});

test("route preview validation rejects unbounded models and malformed public output", () => {
  assert.equal(isRoutePreviewModel("model-a"), true);
  assert.equal(isRoutePreviewModel(" model-a"), false);
  assert.equal(isRoutePreviewModel("x".repeat(257)), false);
  assert.equal(isRoutePreviewModel("line\nbreak"), false);

  const preview = buildRoutePreview({
    source: "configured",
    generation: 0,
    settings: settings("custom_only"),
    accountState,
    providerScheduler: new ProviderScheduler({ now: () => NOW }),
    nowMs: NOW,
    model: "model-a"
  });
  assert.equal(isValidRoutePreview({ ...preview, unexpected: true }), false);
  assert.equal(isValidRoutePreview({ ...preview, generation: 1 }), false);
  assert.equal(isValidRoutePreview({ ...preview, operation: "images/edits" }), false);
  assert.equal(isValidRoutePreview({ ...preview, reason: "account_eligible" }), false);
  assert.equal(isValidRoutePreview({
    ...preview,
    candidates: preview.candidates.map((candidate, index) => (
      index === 0 ? { ...candidate, weight: 1_001 } : candidate
    ))
  }), false);
});
