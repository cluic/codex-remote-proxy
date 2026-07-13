import {
  test,
  expect,
  openCrp,
  assertNoSecrets,
  assertLayoutIntegrity
} from "./crp-ui-fixture.mjs";
import { randomBytes } from "node:crypto";

async function collectSubmittedPasswordSnapshots(page) {
  await page.evaluate(() => {
    window.__passwordSnapshots = [];
    const capture = () => {
      window.__passwordSnapshots.push(
        Array.from(document.querySelectorAll("input[type=password]"), (input) => input.value)
      );
    };
    const observer = new MutationObserver(capture);
    observer.observe(document, { childList: true, subtree: true, attributes: true });
    window.__stopPasswordSnapshots = () => {
      observer.disconnect();
      return window.__passwordSnapshots;
    };
  });
}

test.beforeEach(async ({ crp }) => {
  crp.seedProviders({
    providers: [
      { id: "provider-a", name: "Provider Alpha", baseUrl: crp.upstreamBaseUrl },
      { id: "provider-b", name: "Provider Beta", baseUrl: crp.upstreamBaseUrl }
    ],
    activeProviderId: "provider-a"
  });
});

test("switches providers and exposes all four workspace pages", async ({ page, crp }) => {
  await openCrp(page, crp);
  await expect(page.getByText("Generation 4")).toBeVisible();
  await page.getByLabel("Quick switch").selectOption("provider-b");
  await page.getByRole("button", { name: "Switch provider" }).click();
  await expect(page.getByText("Provider Beta", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Generation 5")).toBeVisible();
  expect(crp.state.activeProviderId).toBe("provider-b");

  await page.getByRole("link", { name: "Providers" }).click();
  await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
  await expect(page.locator("input[type=password]")).toHaveCount(0);

  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export diagnostics" })).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Read-only while CRP is running")).toBeVisible();
  await expect(page.getByText("127.0.0.1:15100", { exact: true })).toBeVisible();
  await expect(page.getByText("Native keyring")).toBeVisible();
  await expect(page.getByText("OpenAI", { exact: true })).toBeVisible();
  await expect(page.locator("main input, main select, main textarea")).toHaveCount(0);

  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await assertNoSecrets(page, crp);
});

test("replaces an inactive credential without refilling it", async ({ page, crp }) => {
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  await page.getByRole("button", { name: "Edit Provider Beta" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit provider" });
  await expect(dialog.getByLabel("Replacement API key")).toHaveValue("");
  await dialog.getByLabel("Provider name").fill("Provider Beta Updated");
  await dialog.getByLabel("Replacement API key").fill(crp.credential);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Provider Beta Updated")).toBeVisible();

  await page.getByRole("button", { name: "Edit Provider Beta Updated" }).click();
  await expect(page.getByRole("dialog", { name: "Edit provider" }).getByLabel("Replacement API key")).toHaveValue("");
  await page.getByRole("dialog", { name: "Edit provider" }).getByRole("button", { name: "Cancel" }).click();
  expect(crp.calls.find((call) => call.operation === "updateProvider")?.replacedCredential).toBe(true);
  await assertNoSecrets(page, crp);
});

test("clears replacement credentials before local JSON and backend failures", async ({ page, crp }) => {
  const localSentinel = crp.registerSecret(`local-${randomBytes(18).toString("base64url")}`);
  const backendSentinel = crp.registerSecret(`backend-${randomBytes(18).toString("base64url")}`);
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  await page.getByRole("button", { name: "Edit Provider Beta" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit provider" });
  await dialog.getByLabel("Replacement API key").fill(localSentinel);
  await dialog.getByLabel("Extra headers (JSON)").fill("{invalid-json");
  await collectSubmittedPasswordSnapshots(page);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Replacement API key")).toHaveValue("");
  const localSnapshots = await page.evaluate(() => window.__stopPasswordSnapshots());
  expect(JSON.stringify(localSnapshots)).not.toContain(localSentinel);
  await assertNoSecrets(page, crp, [localSentinel]);

  crp.failNextMutation({ code: "INTERNAL_ERROR", status: 500 });
  await dialog.getByLabel("Extra headers (JSON)").fill("{}");
  await dialog.getByLabel("Replacement API key").fill(backendSentinel);
  await collectSubmittedPasswordSnapshots(page);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByLabel("Replacement API key")).toHaveValue("");
  const backendSnapshots = await page.evaluate(() => window.__stopPasswordSnapshots());
  expect(JSON.stringify(backendSnapshots)).not.toContain(backendSentinel);
  await assertNoSecrets(page, crp, [localSentinel, backendSentinel]);
});

test("invalidates compatibility after operational edits but not name-only edits", async ({ page, crp }) => {
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  const beta = () => page.locator(".provider-row").filter({ hasText: "Provider Beta" });
  await expect(beta().getByRole("button", { name: "Activate" })).toBeEnabled();

  await page.getByRole("button", { name: "Edit Provider Beta" }).click();
  let dialog = page.getByRole("dialog", { name: "Edit provider" });
  await dialog.getByLabel("Provider name").fill("Provider Beta Renamed");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  const renamed = page.locator(".provider-row").filter({ hasText: "Provider Beta Renamed" });
  await expect(renamed.getByText("Passed")).toBeVisible();
  await expect(renamed.getByRole("button", { name: "Activate" })).toBeEnabled();

  await page.getByRole("button", { name: "Edit Provider Beta Renamed" }).click();
  dialog = page.getByRole("dialog", { name: "Edit provider" });
  await dialog.getByLabel("Base URL").fill(`${crp.upstreamBaseUrl}/`);
  await dialog.getByLabel("Authentication header").fill("x-api-key");
  await dialog.getByLabel("Authentication scheme").fill("Token");
  await dialog.getByLabel("Extra headers (JSON)").fill('{"x-region":"cn"}');
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(renamed.getByText("Untested")).toBeVisible();
  await expect(renamed.getByRole("button", { name: "Activate" })).toBeDisabled();

  await page.getByRole("button", { name: "Test Provider Beta Renamed" }).click();
  const testDialog = page.getByRole("dialog", { name: "Test provider" });
  await testDialog.getByLabel("Test model").fill("gpt-5.1-codex-mini");
  await testDialog.getByRole("button", { name: "Run test" }).click();
  await expect(renamed.getByText("Passed")).toBeVisible();
  await expect(renamed.getByRole("button", { name: "Activate" })).toBeEnabled();
  expect(crp.upstreamRequests.at(-1)).toMatchObject({
    method: "POST",
    path: "/v1/responses",
    contentType: "application/json",
    model: "gpt-5.1-codex-mini",
    input: "Reply with OK.",
    stream: false,
    authHeader: "x-api-key",
    authScheme: "Token",
    credentialMatched: true,
    extraHeadersMatched: true,
    responseShapeValid: true
  });
  await assertNoSecrets(page, crp);
});

test("accepts the minimal production Responses shape without a status field", async ({ page, crp }) => {
  crp.setUpstreamResponsePayload({ id: "resp-minimal", object: "response", output: [] });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  await page.getByRole("button", { name: "Test Provider Beta" }).click();
  const dialog = page.getByRole("dialog", { name: "Test provider" });
  await dialog.getByLabel("Test model").fill("gpt-5.1-codex-mini");
  await dialog.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByRole("status")).toContainText("Provider is compatible");
  expect(crp.state.providers.find((provider) => provider.id === "provider-b")?.lastTestStatus).toBe("passed");
  expect(crp.upstreamRequests.at(-1)?.responseShapeValid).toBe(true);
});

for (const [label, payload] of [
  ["empty response id", { id: "", object: "response", status: "completed", output: [] }],
  ["wrong response object", { id: "resp-wrong", object: "chat.completion", status: "completed", output: [] }]
]) {
  test(`rejects a Responses payload with ${label}`, async ({ page, crp }) => {
    crp.setUpstreamResponsePayload(payload);
    await openCrp(page, crp);
    await page.getByRole("link", { name: "Providers" }).click();
    await page.getByRole("button", { name: "Test Provider Beta" }).click();
    const dialog = page.getByRole("dialog", { name: "Test provider" });
    await dialog.getByLabel("Test model").fill("gpt-5.1-codex-mini");
    await dialog.getByRole("button", { name: "Run test" }).click();
    await expect(page.getByText("Provider response is incompatible")).toBeVisible();
    expect(crp.state.providers.find((provider) => provider.id === "provider-b")).toMatchObject({
      lastTestStatus: "failed",
      lastTestCode: "PROVIDER_TEST_INVALID_RESPONSES"
    });
    expect(crp.upstreamRequests.at(-1)?.responseShapeValid).toBe(false);
  });
}

test("rebuilds dynamic provider fields in place and preserves the full translated draft", async ({ page, crp }) => {
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  await page.getByRole("button", { name: "Edit Provider Beta" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit provider" });
  await dialog.getByLabel("Provider name").fill("Provider Beta Draft");
  await expect(dialog.getByLabel("Authentication header")).toHaveValue("authorization");
  await expect(dialog.getByLabel("Authentication scheme")).toHaveValue("Bearer");
  await expect(dialog.getByLabel("Extra headers (JSON)")).toHaveValue("{}");
  await expect(dialog.locator("select[name='modelMode']")).toHaveValue("passthrough");
  await expect(dialog.getByLabel("Override model")).toHaveCount(0);
  await dialog.getByLabel("Replacement API key").fill(crp.credential);
  await dialog.getByLabel("Authentication header").fill("x-api-key");
  await dialog.getByLabel("Extra headers (JSON)").fill('{"x-region":"cn"}');
  await dialog.locator("select[name='modelMode']").selectOption("override");
  await expect(dialog.getByLabel("Override model")).toBeVisible();
  await dialog.getByLabel("Override model").fill("provider-model");
  await dialog.getByLabel("Advanced provider settings").uncheck();
  await expect(dialog.getByLabel("Authentication header")).toHaveCount(0);
  await expect(dialog.getByLabel("Extra headers (JSON)")).toHaveCount(0);
  await expect(dialog.getByLabel("Override model")).toHaveCount(0);
  await expect(dialog.getByLabel("Provider name")).toHaveValue("Provider Beta Draft");
  await expect(dialog.getByLabel("Replacement API key")).toHaveValue(crp.credential);

  await page.evaluate(() => {
    const locale = document.querySelector("#locale-select");
    locale.value = "zh-CN";
    locale.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const translated = page.getByRole("dialog", { name: "编辑提供商" });
  await expect(translated.getByLabel("提供商名称")).toHaveValue("Provider Beta Draft");
  await expect(translated.getByLabel("基础地址")).toHaveValue(crp.upstreamBaseUrl);
  await expect(translated.getByLabel("替换 API 密钥")).toHaveValue(crp.credential);
  await expect(translated.getByLabel("高级提供商设置")).not.toBeChecked();
  await translated.getByLabel("高级提供商设置").check();
  await expect(translated.getByLabel("认证请求头")).toHaveValue("x-api-key");
  await expect(translated.getByLabel("额外请求头（JSON）")).toHaveValue('{"x-region":"cn"}');
  await expect(translated.locator("select[name='modelMode']")).toHaveValue("override");
  await expect(translated.getByLabel("覆盖模型")).toHaveValue("provider-model");
  await expect(translated.getByLabel("替换 API 密钥")).toHaveValue(crp.credential);
  await translated.getByRole("button", { name: "取消" }).click();
  await assertNoSecrets(page, crp);
});

test("does not let stale field rebuilds steal advanced input focus or retain a submitted secret", async ({ page, crp }) => {
  const replacement = crp.registerSecret(`focus-${randomBytes(18).toString("base64url")}`);
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  await page.getByRole("button", { name: "Edit Provider Beta" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit provider" });
  await dialog.getByLabel("Replacement API key").fill(replacement);

  await page.evaluate(() => {
    const mode = document.querySelector("dialog[open] select[name='modelMode']");
    if (!(mode instanceof HTMLSelectElement)) throw new Error("model mode is unavailable");
    mode.focus();
    mode.value = "override";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    const extraHeaders = document.querySelector("dialog[open] textarea[name='extraHeaders']");
    if (!(extraHeaders instanceof HTMLTextAreaElement)) throw new Error("extra headers are unavailable");
    extraHeaders.value = "";
    extraHeaders.dispatchEvent(new Event("input", { bubbles: true }));
    extraHeaders.focus();
  });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  const extraHeaders = dialog.getByLabel("Extra headers (JSON)");
  await expect(extraHeaders).toBeFocused();
  await extraHeaders.pressSequentially('{"x-region":"cn"}');
  const modelOverride = dialog.getByLabel("Override model");
  await modelOverride.pressSequentially("provider-model");
  await expect(dialog.getByLabel("Replacement API key")).toHaveValue(replacement);

  await collectSubmittedPasswordSnapshots(page);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  const passwordSnapshots = await page.evaluate(() => window.__stopPasswordSnapshots());
  expect(JSON.stringify(passwordSnapshots)).not.toContain(replacement);
  expect(crp.state.providers.find((provider) => provider.id === "provider-b")).toMatchObject({
    extraHeaders: { "x-region": "cn" },
    modelMode: "override",
    modelOverride: "provider-model"
  });
  await assertNoSecrets(page, crp, [replacement]);
});

test("keeps a fragmentless cookie session GET-only and disables every mutation", async ({ page, crp }) => {
  crp.seedActivity(55);
  await openCrp(page, crp);
  const mutationRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/") && !["GET", "HEAD"].includes(request.method())) {
      mutationRequests.push(request);
    }
  });
  await page.reload();
  await expect(page.locator("#app-root")).toBeVisible();
  await expect(page.locator("#session-root")).toBeHidden();
  await expect(page.locator("#session-banner-title")).toHaveText("Read-only session");
  await expect(page.locator("#session-banner-action")).toHaveText("Run crp ui again to make changes.");
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Add provider" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop proxy" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Restart worker" })).toBeDisabled();
  await expect(page.getByLabel("Quick switch")).toBeDisabled();
  await page.getByRole("button", { name: "Refresh status" }).click();
  await page.getByRole("link", { name: "Providers" }).click();
  await expect(page.locator(".provider-actions button:enabled")).toHaveCount(0);
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page.getByRole("button", { name: "Export diagnostics" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator(".activity-row")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Previous" })).toBeEnabled();
  expect(mutationRequests).toHaveLength(0);
  await assertNoSecrets(page, crp);
});

test("keeps all four pages unclipped in both locales from mobile through desktop widths", async ({ page, crp }) => {
  crp.seedActivity(5);
  await openCrp(page, crp);
  const locales = [
    {
      value: "en",
      pages: [["Overview", "Overview"], ["Providers", "Providers"], ["Activity", "Activity"], ["Settings", "Settings"]]
    },
    {
      value: "zh-CN",
      pages: [["概览", "概览"], ["提供商", "提供商"], ["活动", "活动"], ["设置", "设置"]]
    }
  ];
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    for (const language of locales) {
      await page.locator("#locale-select").selectOption(language.value);
      for (const [navigation, heading] of language.pages) {
        await page.getByRole("link", { name: navigation }).click();
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        await assertLayoutIntegrity(page);
      }
    }
  }
});

test("activates an inactive provider and starts and stops the worker with empty bodies", async ({ page, crp }) => {
  const requests = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/api/v1/")) {
      requests.push({ path, body: request.postData(), contentType: request.headers()["content-type"] });
    }
  });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  await expect(page.getByText("Activate another provider before editing this active provider.")).toBeVisible();
  const beta = page.locator(".provider-row").filter({ hasText: "Provider Beta" });
  await beta.getByRole("button", { name: "Activate" }).click();
  expect(crp.state.activeProviderId).toBe("provider-b");

  await page.getByRole("link", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Stop proxy" }).click();
  await expect(page.getByRole("button", { name: "Start proxy" })).toBeVisible();
  await page.getByRole("button", { name: "Start proxy" }).click();
  await expect(page.getByRole("button", { name: "Stop proxy" })).toBeVisible();

  for (const path of [
    "/api/v1/providers/provider-b/activate",
    "/api/v1/proxy/stop",
    "/api/v1/proxy/start"
  ]) {
    const request = requests.find((candidate) => candidate.path === path);
    expect(request?.body, `${path} must remain empty`).toBeNull();
    expect(request?.contentType).toBeUndefined();
  }
});

test("paginates sanitized activity in both directions without duplicate loads and shows diagnostics metadata", async ({ page, crp }) => {
  crp.seedActivity(105);
  const activityRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/activity") activityRequests.push(url.search);
  });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page.locator(".activity-row")).toHaveCount(50);
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  const next = page.getByRole("button", { name: "Next" });
  await expect(next).toBeEnabled();
  await next.dblclick();
  await expect(page.locator(".activity-row")).toHaveCount(50);
  await expect.poll(() => activityRequests.filter((search) => search.includes("offset=50")).length).toBe(1);
  await expect(page.getByRole("button", { name: "Previous" })).toBeEnabled();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator(".activity-row")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.locator(".activity-row")).toHaveCount(50);
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
  for (const category of ["Proxy", "Provider", "Migration"]) {
    await expect(page.getByText(`Category: ${category}`).first()).toBeVisible();
  }
  await expect(page.getByText(/Provider ID: provider-/).first()).toBeVisible();
  await expect(page.getByText("Error: PROVIDER_TEST_TIMEOUT").first()).toBeVisible();

  await page.locator("#locale-select").selectOption("zh-CN");
  for (const category of ["代理", "提供商", "迁移"]) {
    await expect(page.getByText(`类别：${category}`).first()).toBeVisible();
  }

  await page.getByRole("button", { name: "导出诊断信息" }).click();
  await expect(page.locator("#main-content").getByText("诊断信息已导出", { exact: true })).toBeVisible();
  await expect(page.getByText("105 条已脱敏事件")).toBeVisible();
  await assertNoSecrets(page, crp);
});

test("confirms inactive deletion, blocks active deletion, and restores focus on Escape", async ({ page, crp }) => {
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();

  const deleteBeta = page.getByRole("button", { name: "Delete Provider Beta" });
  await deleteBeta.focus();
  await deleteBeta.click();
  const dialog = page.getByRole("dialog", { name: "Delete provider?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(deleteBeta).toBeFocused();

  await deleteBeta.click();
  await dialog.getByRole("button", { name: "Delete provider" }).click();
  await expect(page.getByText("Provider Beta", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete Provider Alpha" })).toBeDisabled();
  expect(crp.calls.filter((call) => call.operation === "deleteProvider")).toHaveLength(1);
  await assertNoSecrets(page, crp);
});
