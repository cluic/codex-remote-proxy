import { test, expect, openCrp, assertNoSecrets } from "./crp-ui-fixture.mjs";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function expectPngEvidence(path, secrets) {
  expect(existsSync(path), `${path} must exist`).toBe(true);
  expect(path).toContain("/output/playwright/task11/");
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(1440);
  expect(bytes.readUInt32BE(20)).toBe(900);
  for (const secret of secrets) expect(bytes.includes(Buffer.from(secret))).toBe(false);
}

test("the injected Admin status is healthy before the UI loads", async ({ crp }) => {
  expect(crp.backendStatus.supervisor.pid).toBe(7001);
  expect(crp.backendStatus.activeProviderId).toBeNull();
});

test("onboards in English, exchanges the fragment once, and finishes on Overview", async ({ page, crp }, testInfo) => {
  const requests = [];
  const responses = [];
  const responseTasks = new Set();
  const consoleMessages = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("response", (response) => {
    if (!response.url().includes("/api/v1/")) return;
    const task = (async () => {
      responses.push({
        path: new URL(response.url()).pathname,
        body: await response.text()
      });
    })();
    responseTasks.add(task);
    void task.finally(() => responseTasks.delete(task));
  });
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/")) {
      requests.push({
        path: new URL(request.url()).pathname,
        method: request.method(),
        body: request.postData(),
        headers: request.headers()
      });
    }
  });

  await openCrp(page, crp);
  await expect(page.getByRole("heading", { name: "Set up your first provider" })).toBeVisible();
  await expect(page).toHaveURL(`${crp.origin}/`);
  await expect(page).toHaveTitle("Set up your first provider | CRP Local Control");
  await expect(page.locator("input[name='fallbackConsent']")).toHaveCount(0);
  await expect(page.getByText("Allow fallback credential storage")).toHaveCount(0);

  await page.getByLabel("Provider name").fill("Primary OpenAI");
  await page.getByLabel("Base URL").fill(crp.upstreamBaseUrl);
  await page.getByLabel("API key").fill(crp.credential);
  await page.getByLabel("Test model").fill("gpt-5.1-codex-mini");
  await page.getByRole("button", { name: "Save provider" }).click();

  const createRequest = requests.find((request) => (
    request.path === "/api/v1/providers" && request.method === "POST"
  ));
  expect(createRequest).toBeDefined();
  expect(JSON.parse(createRequest.body)).toEqual({
    provider: {
      name: "Primary OpenAI",
      baseUrl: crp.upstreamBaseUrl,
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      modelMode: "passthrough",
      modelOverride: null
    },
    credential: crp.credential
  });

  await expect(page.getByLabel("API key")).toHaveValue("");
  await expect(page.getByText("Provider saved. Test compatibility next.")).toBeVisible();
  await page.getByRole("button", { name: "Test compatibility" }).click();
  await expect(page.getByText("Compatible", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Activate and start" }).click();

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Proxy is ready")).toBeVisible();
  await expect(page.getByText("Primary OpenAI", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("OpenAI", { exact: true })).toBeVisible();
  await expect(page.getByText("http://127.0.0.1:15100", { exact: true })).toBeVisible();
  expect(crp.state.bootstrapCount).toBe(1);

  const session = requests.filter((request) => request.path === "/api/v1/session");
  expect(session).toHaveLength(1);
  expect(session[0].body).toBeNull();
  expect(session[0].headers.authorization).toBe(`Bearer ${crp.controlToken}`);
  for (const path of [
    "/api/v1/providers/provider-1/activate",
    "/api/v1/codex/bootstrap",
    "/api/v1/proxy/start"
  ]) {
    const request = requests.find((candidate) => candidate.path === path);
    expect(request?.body, `${path} must use an empty body`).toBeNull();
    expect(request?.headers["content-type"]).toBeUndefined();
  }
  const statusRequests = requests.filter((request) => request.path === "/api/v1/status");
  expect(statusRequests.every((request) => request.headers.authorization === undefined)).toBe(true);
  expect(requests.filter((request) => request.path !== "/api/v1/session")
    .every((request) => request.headers.authorization === undefined)).toBe(true);
  const appSource = readFileSync(join(crp.uiRoot, "app.js"), "utf8");
  expect(appSource).toContain("let controlToken = readAndClearControlToken();");
  expect(appSource).toMatch(/finally\s*{\s*controlToken = null;/);

  await expect(page.getByRole("status")).toContainText("Proxy started");
  await expect.poll(() => responses.some((response) => response.path === "/api/v1/session")).toBe(true);
  while (responseTasks.size > 0) await Promise.allSettled([...responseTasks]);
  expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
  await expect(page.locator(".topbar")).toBeInViewport();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeInViewport();
  const sessionPayload = JSON.parse(responses.find((response) => response.path === "/api/v1/session").body);
  const csrfToken = sessionPayload.csrfToken;
  await assertNoSecrets(page, crp, [csrfToken]);
  expect(consoleMessages.join("\n")).not.toContain(crp.credential);
  expect(consoleMessages.join("\n")).not.toContain(crp.controlToken);
  for (const response of responses.filter((candidate) => candidate.path !== "/api/v1/session")) {
    expect(response.body).not.toContain(crp.credential);
    expect(response.body).not.toContain(crp.controlToken);
    expect(response.body).not.toContain(csrfToken);
  }
  const englishScreenshot = testInfo.outputPath("overview-en.png");
  await page.screenshot({ path: englishScreenshot, fullPage: false });
  crp.registerAttachment(englishScreenshot);
  await testInfo.attach("overview-en", { path: englishScreenshot, contentType: "image/png" });

  await page.locator("#locale-select").selectOption("zh-CN");
  await expect(page).toHaveTitle("概览 | CRP 本地控制台");
  await expect(page.getByRole("heading", { name: "概览" })).toBeVisible();
  await expect(page.getByText("代理已就绪")).toBeVisible();
  await expect(page.getByRole("heading", { name: "概览" })).toBeInViewport();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("crp.locale"))).toBe("zh-CN");
  await assertNoSecrets(page, crp, [csrfToken]);
  const chineseScreenshot = testInfo.outputPath("overview-zh-CN.png");
  await page.screenshot({ path: chineseScreenshot, fullPage: false });
  crp.registerAttachment(chineseScreenshot);
  await testInfo.attach("overview-zh-CN", { path: chineseScreenshot, contentType: "image/png" });
  const secrets = [crp.credential, crp.controlToken, csrfToken];
  expectPngEvidence(englishScreenshot, secrets);
  expectPngEvidence(chineseScreenshot, secrets);
  await assertNoSecrets(page, crp, [csrfToken]);
});

test("clears a duplicate-create credential before local render or backend failure handling", async ({ page, crp }) => {
  const sentinel = crp.registerSecret(`duplicate-${randomBytes(18).toString("base64url")}`);
  crp.failNextMutation({ code: "PROVIDER_DUPLICATE", status: 409 });
  await openCrp(page, crp);
  await page.getByLabel("Provider name").fill("Duplicate Provider");
  await page.getByLabel("Base URL").fill(crp.upstreamBaseUrl);
  await page.getByLabel("API key").fill(sentinel);
  await page.evaluate(() => {
    window.__passwordSnapshots = [];
    const observer = new MutationObserver(() => {
      window.__passwordSnapshots.push(
        Array.from(document.querySelectorAll("input[type=password]"), (input) => input.value)
      );
    });
    observer.observe(document.querySelector("#onboarding-content"), { childList: true, subtree: true });
    window.__stopPasswordSnapshots = () => observer.disconnect();
  });
  await page.getByRole("button", { name: "Save provider" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveValue("");
  const snapshots = await page.evaluate(() => {
    window.__stopPasswordSnapshots();
    return window.__passwordSnapshots;
  });
  expect(JSON.stringify(snapshots)).not.toContain(sentinel);
  await assertNoSecrets(page, crp, [sentinel]);
});

test("completes the full onboarding flow in Simplified Chinese", async ({ page, crp }) => {
  await openCrp(page, crp);
  await page.locator("#onboarding-locale-select").selectOption("zh-CN");
  await expect(page).toHaveTitle("设置首个提供商 | CRP 本地控制台");
  await page.getByLabel("提供商名称").fill("中文提供商");
  await page.getByLabel("基础地址").fill(crp.upstreamBaseUrl);
  await page.getByLabel("API 密钥").fill(crp.credential);
  await page.getByLabel("测试模型").fill("gpt-5.1-codex-mini");
  await page.getByRole("button", { name: "保存提供商" }).click();
  await expect(page.getByLabel("替换 API 密钥")).toHaveValue("");
  await page.getByRole("button", { name: "测试兼容性" }).click();
  await expect(page.getByText("兼容", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "激活并启动" }).click();
  await expect(page.getByRole("heading", { name: "概览" })).toBeVisible();
  await expect(page.getByText("代理已就绪")).toBeVisible();
  expect(crp.state.bootstrapCount).toBe(1);
  expect(crp.upstreamRequests).toHaveLength(1);
  await assertNoSecrets(page, crp);
});

test("supports the complete onboarding, navigation, and confirmation flow by keyboard", async ({ page, crp }) => {
  await openCrp(page, crp);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#onboarding-content")).toBeFocused();

  const language = page.locator("#onboarding-locale-select");
  await language.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "设置首个提供商" })).toBeVisible();
  await language.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Set up your first provider" })).toBeVisible();

  for (const [label, value] of [
    ["Provider name", "Keyboard Provider"],
    ["Base URL", crp.upstreamBaseUrl],
    ["API key", crp.credential],
    ["Test model", "gpt-5.1-codex-mini"]
  ]) {
    const input = page.getByLabel(label);
    await input.focus();
    await page.keyboard.type(value);
  }
  const save = page.getByRole("button", { name: "Save provider" });
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Provider saved");
  const testProvider = page.getByRole("button", { name: "Test compatibility" });
  await testProvider.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Provider is compatible");
  const activate = page.getByRole("button", { name: "Activate and start" });
  await activate.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  const providers = page.getByRole("link", { name: "Providers" });
  await providers.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
  const overview = page.getByRole("link", { name: "Overview" });
  await overview.focus();
  await page.keyboard.press("Enter");
  crp.setInFlight(2);
  const refresh = page.getByRole("button", { name: "Refresh status" });
  await refresh.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("2", { exact: true })).toBeVisible();

  const restart = page.getByRole("button", { name: "Restart worker" });
  await restart.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Restart worker?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(restart).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  const cancelRestart = dialog.getByRole("button", { name: "Cancel" });
  const confirmRestart = dialog.getByRole("button", { name: "Restart anyway" });
  await expect(cancelRestart).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirmRestart).toBeFocused();
  await confirmRestart.press("Enter");
  await expect.poll(() => crp.calls.filter((call) => call.operation === "restartProxy").length).toBe(1);
  await expect(page.getByRole("status")).toContainText("Worker restarted");
});

test("preserves the complete advanced draft and supports retry after authentication failure", async ({ page, crp }) => {
  crp.failProviderTestsWith("PROVIDER_TEST_AUTH");
  await openCrp(page, crp);
  await page.getByLabel("Provider name").fill("Advanced Provider");
  await page.getByLabel("Base URL").fill(crp.upstreamBaseUrl);
  await page.getByLabel("API key").fill(crp.credential);
  await page.getByLabel("Test model").fill("gpt-5.1-codex-mini");
  await expect(page.getByText("Allow fallback credential storage")).toHaveCount(0);
  await page.getByLabel("Advanced provider settings").check();
  await expect(page.getByLabel("Provider name")).toHaveValue("Advanced Provider");
  await expect(page.getByLabel("API key")).toHaveValue(crp.credential);
  await page.getByLabel("Authentication header").fill("x-api-key");
  await page.getByLabel("Authentication scheme").fill("Bearer");
  await page.getByLabel("Extra headers (JSON)").fill('{"x-region":"cn"}');
  await page.locator("select[name='modelMode']").selectOption("override");
  await page.getByLabel("Override model").fill("provider-model");

  await page.locator("#onboarding-locale-select").selectOption("zh-CN");
  await expect(page.getByLabel("提供商名称")).toHaveValue("Advanced Provider");
  await expect(page.getByLabel("基础地址")).toHaveValue(crp.upstreamBaseUrl);
  await expect(page.getByLabel("API 密钥")).toHaveValue(crp.credential);
  await expect(page.getByLabel("测试模型")).toHaveValue("gpt-5.1-codex-mini");
  await expect(page.getByText("允许回退凭据存储")).toHaveCount(0);
  await expect(page.getByLabel("认证请求头")).toHaveValue("x-api-key");
  await expect(page.getByLabel("额外请求头（JSON）")).toHaveValue('{"x-region":"cn"}');
  await expect(page.getByLabel("覆盖模型")).toHaveValue("provider-model");

  await page.getByRole("button", { name: "保存提供商" }).click();
  await expect(page.getByLabel("替换 API 密钥")).toHaveValue("");
  await page.getByRole("button", { name: "测试兼容性" }).click();
  await expect(page.getByText("提供商认证失败")).toBeVisible();
  expect(crp.upstreamRequests.at(-1)).toMatchObject({
    method: "POST",
    path: "/v1/responses",
    contentType: "application/json",
    model: "gpt-5.1-codex-mini",
    input: "Reply with OK.",
    stream: false,
    authHeader: "x-api-key",
    authScheme: "Bearer",
    credentialMatched: true,
    extraHeadersMatched: true
  });
  expect(crp.state.providers).toHaveLength(1);
  await expect(page.getByLabel("提供商名称")).toHaveValue("Advanced Provider");
  await expect(page.getByLabel("替换 API 密钥")).toHaveValue("");

  crp.passProviderTests();
  await page.getByRole("button", { name: "测试兼容性" }).click();
  await expect(page.getByText("兼容", { exact: true })).toBeVisible();
  await assertNoSecrets(page, crp);
});

test("locale detection skips unsupported languages and does not persist inference", async ({ page, crp }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      get: () => ["fr-FR", "zh-CN", "en-US"]
    });
  });
  await openCrp(page, crp);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "设置首个提供商" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  const noscriptCopy = await page.locator("noscript").evaluate((element) => element.innerHTML);
  expect(noscriptCopy).toContain("CRP requires JavaScript");
  expect(noscriptCopy).toContain("CRP 需要启用 JavaScript");
});

test("all unsupported navigator locales fall back to English without persistence", async ({ page, crp }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      get: () => ["fr-FR", "de-DE", "ja-JP"]
    });
    Object.defineProperty(navigator, "language", {
      configurable: true,
      get: () => "fr-FR"
    });
  });
  await openCrp(page, crp);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Set up your first provider" })).toBeVisible();
  await expect(page.locator(".onboarding-intro .eyebrow")).toHaveText("CRP / 01");
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test("a valid stored locale overrides conflicting navigator languages and survives reload", async ({ page, crp }) => {
  await page.addInitScript(() => {
    localStorage.setItem("crp.locale", "zh-CN");
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      get: () => ["en-US", "en"]
    });
    Object.defineProperty(navigator, "language", {
      configurable: true,
      get: () => "en-US"
    });
  });
  await openCrp(page, crp);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "设置首个提供商" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("crp.locale"))).toBe("zh-CN");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "设置首个提供商" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("crp.locale"))).toBe("zh-CN");
});

for (const browserLocale of ["zh-TW", "zh-HK"]) {
  test(`${browserLocale} navigator locale maps to Simplified Chinese without persistence`, async ({ page, crp }) => {
    await page.addInitScript((candidate) => {
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        get: () => [candidate]
      });
      Object.defineProperty(navigator, "language", {
        configurable: true,
        get: () => candidate
      });
    }, browserLocale);
    await openCrp(page, crp);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.getByRole("heading", { name: "设置首个提供商" })).toBeVisible();
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
  });
}

test("invalid stored locales are removed and a fragmentless reload is read-only", async ({ page, crp }) => {
  await page.addInitScript(() => localStorage.setItem("crp.locale", "invalid-locale"));
  await openCrp(page, crp);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);

  await page.reload();
  await expect(page.locator("#onboarding-session-title")).toHaveText("Read-only session");
  await expect(page.locator("#onboarding-session-action")).toHaveText("Run crp ui again to make changes.");
  await expect(page.locator("#app-root")).toBeHidden();
  await expect(page.getByRole("button", { name: "Save provider" })).toBeDisabled();
  await expect(page.getByLabel("Provider name")).toBeDisabled();
  await expect(page.getByLabel("Base URL")).toBeDisabled();
  await expect(page.getByLabel("API key")).toBeDisabled();
  await expect(page.getByLabel("Advanced provider settings")).toBeDisabled();
  await page.getByRole("button", { name: "Save provider" }).press("Enter");
  expect(crp.calls.filter((call) => call.operation === "createProvider")).toHaveLength(0);
  expect(crp.state.providers).toHaveLength(0);
  await expect(page.getByRole("heading", { name: "Set up your first provider" })).toBeVisible();
  await assertNoSecrets(page, crp);
});

test("cleans all fixture resources after a controlled post-listen setup failure", async () => {
  const fixture = await import("./crp-ui-fixture.mjs");
  expect(typeof fixture.probeFixtureSetupCleanup).toBe("function");
  const evidence = await fixture.probeFixtureSetupCleanup();
  expect(evidence).toEqual({
    tempRootExists: false,
    adminReachable: false,
    upstreamReachable: false,
    cleanupErrors: 0
  });
});
