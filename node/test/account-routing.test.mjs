import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_429_FALLBACK_COOLDOWN_MS,
  accountSupportsModel,
  accountSupportsOperation,
  account429Cooldown,
  buildChatGptAccountTarget,
  buildChatGptResponsesTarget,
  decideUpstreamRoute,
  isValidAccountRoutingState,
  parseCodexQuotaHeaders,
  projectAccountRoutingState,
  requestOperation
} from "../src/routing/account-routing.mjs";

const NOW_MS = Date.parse("2026-08-20T00:00:00.000Z");
const ACCOUNT_HEADERS = [
  "Authorization", "Bearer opaque-token",
  "ChatGPT-Account-ID", "account-1"
];
const UNKNOWN_STATE = {
  authMode: null,
  quotaStatus: "unknown",
  blockedUntil: null,
  updatedAt: null
};

test("maps only canonical Responses request targets to the ChatGPT Codex endpoint", () => {
  assert.equal(
    buildChatGptResponsesTarget("/responses?stream=true").href,
    "https://chatgpt.com/backend-api/codex/responses?stream=true"
  );
  assert.equal(buildChatGptResponsesTarget("/v1/responses").pathname, "/backend-api/codex/responses");
  for (const target of [
    "responses",
    "/responses/",
    "/other/responses",
    "/models",
    "https://chatgpt.com/responses"
  ]) {
    assert.equal(buildChatGptResponsesTarget(target), null);
  }
});

test("maps canonical Image API request targets to the ChatGPT Codex account base", () => {
  assert.equal(
    buildChatGptAccountTarget("/images/generations?output_format=png").href,
    "https://chatgpt.com/backend-api/codex/images/generations?output_format=png"
  );
  assert.equal(
    buildChatGptAccountTarget("/v1/images/generations").pathname,
    "/backend-api/codex/images/generations"
  );
  assert.equal(
    buildChatGptAccountTarget("/images/edits?quality=high").href,
    "https://chatgpt.com/backend-api/codex/images/edits?quality=high"
  );
  assert.equal(
    buildChatGptAccountTarget("/v1/images/edits").pathname,
    "/backend-api/codex/images/edits"
  );
  assert.equal(buildChatGptAccountTarget("/chat/completions"), null);
});

test("routes account-first requests only with an eligible method, path, and unique account auth", () => {
  assert.equal(decideUpstreamRoute({
    mode: "account_first",
    method: "POST",
    requestUrl: "/responses",
    rawHeaders: ACCOUNT_HEADERS,
    accountState: UNKNOWN_STATE,
    nowMs: NOW_MS
  }).route, "account");

  const cases = [
    { mode: "custom_only", method: "POST", requestUrl: "/responses", headers: ACCOUNT_HEADERS },
    { mode: "account_first", method: "GET", requestUrl: "/responses", headers: ACCOUNT_HEADERS },
    { mode: "account_first", method: "POST", requestUrl: "/models", headers: ACCOUNT_HEADERS },
    { mode: "account_first", method: "POST", requestUrl: "/responses", headers: [] },
    {
      mode: "account_first",
      method: "POST",
      requestUrl: "/responses",
      headers: [...ACCOUNT_HEADERS, "Authorization", "Bearer duplicate"]
    }
  ];
  for (const candidate of cases) {
    assert.equal(decideUpstreamRoute({
      mode: candidate.mode,
      method: candidate.method,
      requestUrl: candidate.requestUrl,
      rawHeaders: candidate.headers,
      accountState: UNKNOWN_STATE,
      nowMs: NOW_MS
    }).route, "custom");
  }
});

test("classifies operations separately from models and exposes account capability limits", () => {
  assert.equal(requestOperation("/v1/responses?stream=true"), "responses");
  assert.equal(requestOperation("/chat/completions"), "chat/completions");
  assert.equal(requestOperation("/v1/images/generations"), "images/generations");
  assert.equal(requestOperation("/images/edits"), "images/edits");
  assert.equal(accountSupportsOperation("responses"), true);
  assert.equal(accountSupportsOperation("images/generations"), true);
  assert.equal(accountSupportsOperation("images/edits"), true);
  assert.equal(accountSupportsModel("responses", "gpt-5.6"), true);
  assert.equal(accountSupportsModel("responses", "gpt-image-2"), false);
  assert.equal(accountSupportsModel("images/generations", "gpt-image-2"), true);
  assert.equal(accountSupportsModel("images/generations", "gpt-5.6"), false);
  assert.equal(accountSupportsModel("images/generations", null), false);
  assert.equal(accountSupportsModel("images/generations", null, { allowUnknown: true }), true);
  assert.equal(accountSupportsModel("images/edits", "gpt-image-2"), true);
  assert.equal(accountSupportsModel("images/edits", "gpt-5.6"), false);

  const decide = (requestUrl, model) => decideUpstreamRoute({
    mode: "account_first",
    method: "POST",
    requestUrl,
    rawHeaders: ACCOUNT_HEADERS,
    accountState: UNKNOWN_STATE,
    model,
    nowMs: NOW_MS
  });
  assert.equal(decide("/images/generations", "gpt-image-2").reason,
    "account_eligible");
  assert.equal(decide("/images/edits", "gpt-image-2").reason,
    "account_eligible");
  assert.equal(decide("/chat/completions", "gpt-5.6").reason,
    "unsupported_operation");
  assert.equal(decide("/responses", "gpt-image-2").reason,
    "unsupported_account_model");
  assert.equal(decide("/responses", "gpt-5.6").reason, "account_eligible");
  assert.equal(decideUpstreamRoute({
    mode: "account_first",
    method: "POST",
    requestUrl: "/images/generations",
    rawHeaders: ACCOUNT_HEADERS,
    accountState: UNKNOWN_STATE,
    model: null,
    modelKnown: true,
    nowMs: NOW_MS
  }).reason, "unsupported_account_model");
});

test("honors authoritative auth and fresh quota state while allowing stale probes", () => {
  const decide = (accountState) => decideUpstreamRoute({
    mode: "account_first",
    method: "POST",
    requestUrl: "/responses",
    rawHeaders: ACCOUNT_HEADERS,
    accountState,
    nowMs: NOW_MS
  });
  assert.equal(decide({ ...UNKNOWN_STATE, authMode: "apikey" }).reason, "not_chatgpt_auth");
  assert.equal(decide({ ...UNKNOWN_STATE, authMode: "headers" }).reason, "not_chatgpt_auth");
  assert.equal(decide({
    authMode: "chatgpt",
    quotaStatus: "exhausted",
    blockedUntil: null,
    updatedAt: "2026-08-19T23:55:00.000Z"
  }).reason, "account_quota_exhausted");
  assert.equal(decide({
    authMode: "chatgpt",
    quotaStatus: "exhausted",
    blockedUntil: null,
    updatedAt: "2026-08-19T23:40:00.000Z"
  }).route, "account");
  assert.equal(decide({
    authMode: "chatgpt",
    quotaStatus: "exhausted",
    blockedUntil: Math.floor(NOW_MS / 1_000) + 60,
    updatedAt: "2026-08-19T23:40:00.000Z"
  }).route, "custom");
});

test("projects only bounded routing state from the account monitor", () => {
  const projected = projectAccountRoutingState({
    authMode: "chatgpt",
    email: "ignored@example.test",
    updatedAt: "2026-08-20T00:00:00.000Z",
    quota: {
      status: "exhausted",
      windows: [
        { usedPercent: 100, resetsAt: 1_800_000_100 },
        { usedPercent: 100, resetsAt: 1_800_000_000 }
      ]
    }
  });
  assert.deepEqual(projected, {
    authMode: "chatgpt",
    quotaStatus: "exhausted",
    blockedUntil: 1_800_000_100,
    updatedAt: "2026-08-20T00:00:00.000Z"
  });
  assert.equal(isValidAccountRoutingState(projected), true);
  assert.equal(JSON.stringify(projected).includes("ignored"), false);
  assert.equal(isValidAccountRoutingState({ ...projected, blockedUntil: -1 }), false);
  assert.equal(isValidAccountRoutingState({ ...projected, extra: true }), false);

  assert.equal(projectAccountRoutingState({
    authMode: "chatgpt",
    updatedAt: "2026-08-20T00:00:00.000Z",
    quota: {
      status: "exhausted",
      windows: [],
      spendControlReached: true,
      spendControlResetsAt: 1_800_000_300
    }
  }).blockedUntil, 1_800_000_300);
});

test("parses bounded Codex windows and derives explicit or generic 429 cooldowns", () => {
  const quota = parseCodexQuotaHeaders({
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-reset-after-seconds": "120",
    "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-used-percent": "62",
    "x-codex-secondary-window-minutes": "10080"
  }, NOW_MS);
  assert.equal(quota.status, "exhausted");
  assert.equal(quota.blockedUntilMs, NOW_MS + 120_000);
  assert.equal(quota.windows[1].usedPercent, 62);
  assert.equal(parseCodexQuotaHeaders({
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-reset-after-seconds": "120",
    "x-codex-secondary-used-percent": "100",
    "x-codex-secondary-reset-after-seconds": "240"
  }, NOW_MS).blockedUntilMs, NOW_MS + 240_000);
  assert.deepEqual(account429Cooldown({
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-reset-after-seconds": "120"
  }, NOW_MS), {
    untilMs: NOW_MS + 120_000,
    explicit: true,
    quota: {
      status: "exhausted",
      windows: [{
        kind: "primary",
        usedPercent: 100,
        resetAfterSeconds: 120,
        windowDurationMins: null
      }],
      blockedUntilMs: NOW_MS + 120_000
    }
  });
  assert.equal(
    account429Cooldown({}, NOW_MS).untilMs,
    NOW_MS + ACCOUNT_429_FALLBACK_COOLDOWN_MS
  );
  assert.equal(account429Cooldown({
    "x-codex-primary-reset-after-seconds": "45"
  }, NOW_MS).untilMs, NOW_MS + 45_000);
  assert.equal(parseCodexQuotaHeaders({
    "x-codex-primary-used-percent": "101",
    "x-codex-primary-reset-after-seconds": "999999999"
  }, NOW_MS), null);
});
