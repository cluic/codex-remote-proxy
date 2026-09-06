import { randomBytes } from "node:crypto";

import {
  assertNoSecrets,
  expect,
  openCrp,
  probeFixtureSetupCleanup,
  test
} from "./crp-ui-fixture.mjs";

const EN = {
  pageTitle: "Set up Codex Remote Proxy",
  connect: "Connect a provider",
  name: "Provider name",
  url: "Base URL",
  key: "API key",
  save: "Save provider",
  testStage: "Verify the Responses API",
  model: "Test model",
  runTest: "Run test",
  codexStage: "Prepare the fixed Codex connection",
  prepare: "Prepare Codex",
  prepareDialog: "Prepare Codex?",
  workerStage: "Start the proxy worker",
  start: "Start proxy",
  complete: "Setup complete",
  overview: "Open overview",
  overviewTitle: "Overview",
  ready: "Codex is securely connected"
};

const ZH = {
  pageTitle: "设置 Codex Remote Proxy",
  connect: "连接提供商",
  name: "提供商名称",
  url: "基础地址",
  key: "API 密钥",
  save: "保存提供商",
  testStage: "验证 Responses API",
  model: "测试模型",
  runTest: "运行测试",
  codexStage: "配置固定的 Codex 连接",
  prepare: "配置 Codex",
  prepareDialog: "配置 Codex？",
  workerStage: "启动代理工作进程",
  start: "启动代理",
  complete: "设置完成",
  overview: "打开概览",
  overviewTitle: "概览",
  ready: "Codex 已安全接入本地代理"
};

function observePasswordValues(page) {
  return page.evaluate(() => {
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

async function stopPasswordObserver(page) {
  return await page.evaluate(() => window.__stopPasswordSnapshots?.() ?? []);
}

async function completeSetup(page, crp, copy, providerName) {
  await expect(page.getByRole("heading", { name: copy.pageTitle, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: copy.connect, level: 2 })).toBeVisible();
  await page.getByLabel(copy.name).fill(providerName);
  await page.getByLabel(copy.url).fill(crp.upstreamBaseUrl);
  await page.getByLabel(copy.key).fill(crp.credential);
  await page.getByRole("button", { name: copy.save }).click();

  await expect(page.getByRole("heading", { name: copy.testStage })).toBeVisible();
  await page.getByLabel(copy.model).fill("gpt-5.1-codex-mini");
  await page.getByRole("button", { name: copy.runTest, exact: true }).click();

  await expect(page.getByRole("heading", { name: copy.codexStage })).toBeVisible();
  await page.getByRole("button", { name: copy.prepare, exact: true }).click();
  const prepareDialog = page.getByRole("dialog", { name: copy.prepareDialog });
  await expect(prepareDialog).toBeVisible();
  await prepareDialog.getByRole("button", { name: copy.prepare, exact: true }).click();

  await expect(page.getByRole("heading", { name: copy.workerStage })).toBeVisible();
  await page.getByTestId("page-setup").getByRole("button", { name: copy.start, exact: true }).click();

  await expect(page.getByRole("heading", { name: copy.complete })).toBeVisible();
  await page.getByRole("button", { name: copy.overview }).click();
  await expect(page.getByRole("heading", { name: copy.overviewTitle, level: 1 })).toBeVisible();
  await expect(page.locator(".overview-command-bar")).toBeVisible();
}

test("the injected Admin status is healthy before the UI loads", async ({ crp }) => {
  expect(crp.backendStatus.supervisor.pid).toBe(7001);
  expect(crp.backendStatus.activeProviderId).toBeNull();
});

test("shows every refreshed Setup model and tests a non-first selection", async ({ page, crp }) => {
  await openCrp(page, crp);
  await page.getByLabel(EN.name).fill("Catalog Provider");
  await page.getByLabel(EN.url).fill(crp.upstreamBaseUrl);
  await page.getByLabel(EN.key).fill(crp.credential);
  await page.getByRole("button", { name: EN.save }).click();

  const refreshButton = page.getByRole("button", { name: "Refresh models" });
  await refreshButton.click();
  const modelSelect = page.getByLabel(EN.model);
  await expect(modelSelect).toHaveJSProperty("tagName", "SELECT");
  await expect(modelSelect.locator("option")).toHaveCount(3);
  await expect(modelSelect.locator("option").nth(0)).toHaveText("gpt-5.1-codex-mini");
  await expect(modelSelect.locator("option").nth(1)).toHaveText("fixture-model");
  const [modelBox, refreshBox] = await Promise.all([modelSelect.boundingBox(), refreshButton.boundingBox()]);
  expect(modelBox).not.toBeNull();
  expect(refreshBox).not.toBeNull();
  expect(Math.abs(modelBox.y - refreshBox.y)).toBeLessThanOrEqual(1);
  await modelSelect.selectOption("fixture-model");
  await page.getByRole("button", { name: EN.runTest, exact: true }).click();

  expect(crp.calls.findLast((call) => call.operation === "testProvider")).toMatchObject({
    model: "fixture-model",
    activateIfNone: true
  });
  expect(crp.upstreamRequests.at(-1)).toMatchObject({ model: "fixture-model", requestValid: true });
  await assertNoSecrets(page, crp);
});

test("completes a clean English install with the exact safe request order", async ({ page, crp }) => {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/v1/")) return;
    requests.push({
      path: url.pathname,
      search: url.search,
      method: request.method(),
      body: request.postData(),
      headers: request.headers()
    });
  });

  await openCrp(page, crp);
  await expect(page).not.toHaveURL(/#token=/);
  await expect(page).toHaveURL(`${crp.origin}/setup`);
  await expect(page).toHaveTitle("Set up Codex Remote Proxy | CRP");
  await expect(page.locator("input[name='fallbackConsent']")).toHaveCount(0);

  await completeSetup(page, crp, EN, "Primary OpenAI");

  const operationOrder = crp.calls
    .map((call) => call.operation)
    .filter((operation) => ["createProvider", "testProvider", "bootstrap", "activate", "startProxy"].includes(operation));
  expect(operationOrder).toEqual([
    "createProvider",
    "testProvider",
    "bootstrap",
    "startProxy"
  ]);

  const create = requests.find((request) => request.path === "/api/v1/providers" && request.method === "POST");
  expect(create).toBeDefined();
  const createBody = JSON.parse(create.body);
  const submittedCredential = createBody.credential;
  delete createBody.credential;
  expect(typeof submittedCredential).toBe("string");
  expect(submittedCredential.length).toBe(crp.credential.length);
  expect(createBody).toEqual({
    provider: {
      name: "Primary OpenAI",
      baseUrl: crp.upstreamBaseUrl,
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      modelMode: "passthrough",
      modelOverride: null,
      modelMappingGroupId: null,
      weight: 100
    }
  });

  const providerTest = requests.find((request) => request.path === "/api/v1/providers/provider-1/test");
  expect(JSON.parse(providerTest.body)).toEqual({
    model: "gpt-5.1-codex-mini",
    activateIfNone: true
  });
  const orderedPaths = requests.filter((request) => request.method !== "GET" && [
    "/api/v1/providers",
    "/api/v1/providers/provider-1/test",
    "/api/v1/codex/bootstrap",
    "/api/v1/proxy/start"
  ].includes(request.path)).map((request) => request.path);
  expect(orderedPaths).toEqual([
    "/api/v1/providers",
    "/api/v1/providers/provider-1/test",
    "/api/v1/codex/bootstrap",
    "/api/v1/proxy/start"
  ]);

  for (const path of [
    "/api/v1/codex/bootstrap",
    "/api/v1/proxy/start"
  ]) {
    const request = requests.find((candidate) => candidate.path === path);
    expect(request.body, `${path} must remain empty`).toBeNull();
    expect(request.headers["content-type"]).toBeUndefined();
  }

  const sessions = requests.filter((request) => request.path === "/api/v1/session");
  expect(sessions).toHaveLength(1);
  expect(sessions[0].body).toBeNull();
  expect(typeof sessions[0].headers.authorization).toBe("string");
  expect(sessions[0].headers.authorization.length).toBe("Bearer ".length + 43);
  expect(requests.filter((request) => request.path !== "/api/v1/session")
    .every((request) => request.headers.authorization === undefined)).toBe(true);
  expect(crp.state.activeProviderId).toBe("provider-1");
  expect(crp.calls.filter((call) => call.operation === "activate")).toHaveLength(0);
  expect(crp.state.bootstrapCount).toBe(1);
  expect(crp.state.worker.phase).toBe("running");
  expect(crp.upstreamRequests).toHaveLength(1);
  expect(crp.upstreamRequests[0]).toMatchObject({
    path: "/v1/responses",
    model: "gpt-5.1-codex-mini",
    requestValid: true,
    credentialMatched: true,
    responseShapeValid: true
  });
  await assertNoSecrets(page, crp);
});

test("completes the entire clean-install flow in Simplified Chinese", async ({ page, crp }) => {
  await openCrp(page, crp);
  await page.locator("#locale-select").selectOption("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await completeSetup(page, crp, ZH, "中文提供商");
  expect(crp.calls.map((call) => call.operation).filter((operation) => (
    ["createProvider", "testProvider", "bootstrap", "activate", "startProxy"].includes(operation)
  ))).toEqual(["createProvider", "testProvider", "bootstrap", "startProxy"]);
  expect(await page.evaluate(() => localStorage.getItem("crp.locale"))).toBe("zh-CN");
  await assertNoSecrets(page, crp);
});

test("retests and selects an existing eligible provider through compare-and-set", async ({ page, crp }) => {
  crp.seedProviders({
    providers: [{
      id: "provider-existing",
      name: "Existing Provider",
      baseUrl: crp.upstreamBaseUrl,
      lastTestStatus: "passed"
    }],
    activeProviderId: null
  });
  const testRequests = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/test")) testRequests.push(request.postDataJSON());
  });
  await openCrp(page, crp);
  await expect(page.getByRole("heading", { name: "Confirm the current provider" })).toBeVisible();
  await page.getByLabel("Test model").fill("gpt-5.1-codex-mini");
  await page.getByRole("button", { name: "Test and select" }).click();
  await expect(page.getByRole("heading", { name: "Start the proxy worker" })).toBeVisible();
  expect(testRequests).toEqual([{ model: "gpt-5.1-codex-mini", activateIfNone: true }]);
  expect(crp.state.activeProviderId).toBe("provider-existing");
  expect(crp.state.worker.phase).toBe("stopped");
  expect(crp.calls.filter((call) => call.operation === "activate")).toHaveLength(0);
  await assertNoSecrets(page, crp);
});

test("clears provider secrets before both local validation and backend failure rendering", async ({ page, crp }) => {
  const localSecret = crp.registerSecret(`local-${randomBytes(18).toString("base64url")}`);
  const backendSecret = crp.registerSecret(`backend-${randomBytes(18).toString("base64url")}`);
  await openCrp(page, crp);
  await page.getByLabel("Provider name").fill("Rejected Provider");
  await page.getByLabel("Base URL").fill(crp.upstreamBaseUrl);
  await page.getByLabel("Advanced provider settings").check();
  await page.getByLabel("Extra headers (JSON)").fill("{invalid-json");
  await page.getByLabel("API key").fill(localSecret);
  await observePasswordValues(page);
  await page.getByRole("button", { name: "Save provider" }).click();
  await expect(page.locator(".form-error")).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveValue("");
  const localSnapshots = await stopPasswordObserver(page);
  expect(JSON.stringify(localSnapshots)).not.toContain(localSecret);
  expect(crp.calls.filter((call) => call.operation === "createProvider")).toHaveLength(0);

  crp.failNextMutation({ code: "PROVIDER_DUPLICATE", status: 409 });
  await page.getByLabel("Extra headers (JSON)").fill("{}");
  await page.getByLabel("API key").fill(backendSecret);
  await observePasswordValues(page);
  await page.getByRole("button", { name: "Save provider" }).click();
  await expect(page.getByTestId("global-message").locator(".notice-danger")).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveValue("");
  const backendSnapshots = await stopPasswordObserver(page);
  expect(JSON.stringify(backendSnapshots)).not.toContain(backendSecret);
  expect(crp.state.providers).toHaveLength(0);
  await assertNoSecrets(page, crp, [localSecret, backendSecret]);
});

test("uses the first supported browser language without persisting an inferred choice", async ({ page, crp }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      get: () => ["fr-FR", "zh-CN", "en-US"]
    });
  });
  await openCrp(page, crp);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "设置 Codex Remote Proxy", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  const noscriptCopy = await page.locator("noscript").evaluate((element) => element.innerHTML);
  expect(noscriptCopy).toContain("CRP requires JavaScript");
  expect(noscriptCopy).toContain("CRP 需要启用 JavaScript");
});

test("falls back to English for unsupported locales without persistence", async ({ page, crp }) => {
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
  await expect(page.getByRole("heading", { name: "Set up Codex Remote Proxy", level: 1 })).toBeVisible();
  await expect(page.locator(".setup-eyebrow")).toHaveText("First run");
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test("persists an explicit Chinese selection across a read-only reload", async ({ page, crp }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      get: () => ["en-US", "zh-CN"]
    });
  });
  await openCrp(page, crp);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.locator("#locale-select").selectOption("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  expect(await page.evaluate(() => localStorage.getItem("crp.locale"))).toBe("zh-CN");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("#session-banner")).toContainText("只读会话");
  expect(await page.evaluate(() => localStorage.getItem("crp.locale"))).toBe("zh-CN");
});

test("removes an invalid locale and keeps a fragmentless cookie session GET-only", async ({ page, crp }) => {
  await page.addInitScript(() => localStorage.setItem("crp.locale", "invalid-locale"));
  await openCrp(page, crp);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#app-root")).toBeVisible();
  await expect(page.locator("#session-banner")).toContainText("Read-only session");
  await expect(page.getByLabel("Provider name")).toBeDisabled();
  await expect(page.getByLabel("Base URL")).toBeDisabled();
  await expect(page.getByLabel("API key")).toBeDisabled();
  await expect(page.getByLabel("Advanced provider settings")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save provider" })).toBeDisabled();
  const mutations = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/v1/")
      && !["GET", "HEAD"].includes(request.method())) mutations.push(request.method());
  });
  await page.getByRole("button", { name: "Refresh status" }).click();
  expect(mutations).toEqual([]);
  expect(crp.state.providers).toHaveLength(0);
  await assertNoSecrets(page, crp);
});

test("cleans every fixture resource after a controlled post-listen setup failure", async () => {
  expect(await probeFixtureSetupCleanup()).toEqual({
    tempRootExists: false,
    adminReachable: false,
    upstreamReachable: false,
    cleanupErrors: 0
  });
});
