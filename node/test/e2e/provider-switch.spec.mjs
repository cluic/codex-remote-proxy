import { randomBytes } from "node:crypto";

import {
  assertLayoutIntegrity,
  assertNoSecrets,
  expect,
  openCrp,
  test
} from "./crp-ui-fixture.mjs";

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

async function openProviderDetails(page, name) {
  await page.getByRole("button", { name: `View ${name} details` }).click();
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function navigate(page, name, mobile = false) {
  if (mobile) {
    await page.getByRole("button", { name: /Open navigation|打开导航/ }).click();
    await expect(page.getByRole("dialog", { name: /Primary navigation|主导航/ })).toBeVisible();
  }
  await page.getByRole("link", { name, exact: true }).click();
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

test("switches from the sidebar route control and opens Forwarding Records", async ({ page, crp }) => {
  const mutations = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v1/") && !["GET", "HEAD"].includes(request.method())) {
      mutations.push({ path: url.pathname, body: request.postData(), contentType: request.headers()["content-type"] });
    }
  });

  await openCrp(page, crp);
  await expect(page.locator(".overview-command-bar")).toBeVisible();
  await page.getByRole("button", { name: "Stop proxy" }).click();
  await expect.poll(() => crp.state.worker.phase).toBe("stopped");
  const routeSelect = page.getByLabel("Preferred provider");
  await expect(routeSelect).toHaveAttribute("title", /Provider Alpha · Make preferred and start/);
  await routeSelect.selectOption("provider-b");
  await expect(routeSelect).toHaveValue("provider-b");
  expect(crp.state.activeProviderId).toBe("provider-b");
  expect(crp.state.generation).toBe(5);
  expect(crp.state.worker.phase).toBe("running");
  expect(crp.calls.filter((call) => call.operation === "startProxy")).toHaveLength(0);
  expect(crp.calls.find((call) => call.operation === "activate")).toMatchObject({ workerStarted: true });

  const activation = mutations.find((request) => request.path === "/api/v1/providers/provider-b/activate");
  expect(activation.body).toBeNull();
  expect(activation.contentType).toBeUndefined();

  await navigate(page, "Providers");

  const forwarding = page.getByTestId("nav-forwarding-records");
  await expect(forwarding).toHaveAttribute("href", "/forwarding");
  await forwarding.click();
  await expect(page).toHaveURL(/\/forwarding$/);
  await expect(page.getByTestId("page-forwarding-records")).toBeVisible();

  await navigate(page, "Activity");
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  await navigate(page, "System");
  await expect(page.getByRole("heading", { name: "System", level: 1 })).toBeVisible();
  await navigate(page, "Overview");
  await expect(page.locator(".overview-routing-segment")).toContainText("Provider Beta");
  await expect(page.locator(".sidebar-runtime")).toContainText("Running");
  await assertNoSecrets(page, crp);
});

test("updates provider priority weights without changing the preferred provider", async ({ page, crp }) => {
  await openCrp(page, crp);
  await navigate(page, "Providers");
  const preferred = page.getByTestId("provider-card-provider-a");
  const fallback = page.getByTestId("provider-card-provider-b");

  await fallback.getByLabel("Priority weight for Provider Beta").fill("350");
  await fallback.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => crp.state.providers.find(({ id }) => id === "provider-b")?.weight).toBe(350);
  expect(crp.state.activeProviderId).toBe("provider-a");
  await expect(fallback.getByLabel("Priority weight for Provider Beta")).toHaveValue("350");

  await preferred.getByLabel("Priority weight for Provider Alpha").fill("500");
  await preferred.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => crp.state.providers.find(({ id }) => id === "provider-a")?.weight).toBe(500);
  expect(crp.calls.filter((call) => call.operation === "setProviderWeight")).toEqual([
    { operation: "setProviderWeight", id: "provider-b", weight: 350 },
    { operation: "setProviderWeight", id: "provider-a", weight: 500 }
  ]);
  expect(crp.state.activeProviderId).toBe("provider-a");
  await assertNoSecrets(page, crp);
});

test("closes the mobile drawer after a sidebar mutation so feedback stays operable", async ({ page, crp }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCrp(page, crp);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Primary navigation" });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("Preferred provider").selectOption("provider-b");
  await expect(drawer).toBeHidden();
  const message = page.getByTestId("global-message");
  await expect(message).toContainText("Provider switched");
  await expect(message.getByRole("button", { name: "Close" })).toBeVisible();
  await message.getByRole("button", { name: "Close" }).click();
  await expect(message).toHaveCount(0);
  expect(crp.state.activeProviderId).toBe("provider-b");
  await assertNoSecrets(page, crp);
});

test("does not expose an untested provider as a sidebar route", async ({ page, crp }) => {
  crp.seedProviders({
    providers: [
      { id: "provider-a", name: "Provider Alpha", baseUrl: crp.upstreamBaseUrl },
      {
        id: "provider-b",
        name: "Provider Beta",
        baseUrl: crp.upstreamBaseUrl,
        lastTestAt: null,
        lastTestStatus: "untested",
        lastTestCode: null
      }
    ],
    activeProviderId: "provider-a"
  });
  await openCrp(page, crp);
  const option = page.getByLabel("Preferred provider").locator('option[value="provider-b"]');
  await expect(option).toHaveAttribute("disabled", "");
  await expect(option).toHaveText("Provider Beta · Untested");
  expect(crp.calls.filter((call) => call.operation === "activate")).toHaveLength(0);
});

test("renders populated Metrics and changes the aggregate window without stale data", async ({ page, crp }, testInfo) => {
  crp.state.metrics.summary.responseStart = {
    p50UpperBoundMs: 250,
    p95UpperBoundMs: null,
    overflowRequests: 2
  };
  const sevenDay = crp.emptyMetrics("7d");
  sevenDay.summary = {
    requests: 777,
    results: {
      success: 700,
      upstreamRejected: 30,
      upstreamError: 20,
      timeout: 10,
      networkError: 7,
      clientAbort: 10
    },
    tokens: { input: 5_000_000, output: 1_000_000, observedRequests: 650 },
    latency: { p50UpperBoundMs: 1000, p95UpperBoundMs: 5000, overflowRequests: 0 },
    responseStart: { p50UpperBoundMs: 250, p95UpperBoundMs: 1000, overflowRequests: 0 }
  };
  sevenDay.series = crp.metricSeries("7d", sevenDay.summary);
  sevenDay.providers = [{
    providerId: "provider-a",
    requests: 777,
    successfulRequests: 700,
    tokens: { input: 5_000_000, output: 1_000_000, observedRequests: 650 },
    latency: { p50UpperBoundMs: 1000, p95UpperBoundMs: 5000, overflowRequests: 0 }
  }];
  sevenDay.models = [{
    model: "gpt-5.1-codex-mini",
    requests: 777,
    tokens: { input: 5_000_000, output: 1_000_000, observedRequests: 650 }
  }];
  crp.setMetrics(sevenDay, { window: "7d" });

  await openCrp(page, crp);
  await expect(page.getByTestId("metrics-loaded")).toBeVisible();
  const requests = page.locator(".metric-card").filter({ hasText: "Requests" });
  await expect(requests.locator("strong")).toHaveText("128");
  const responseStart = page.locator(".metric-card").filter({ hasText: "P95 response start" });
  await expect(responseStart.locator("strong")).toHaveText("> 300 s");
  const heatmap = page.getByTestId("token-heatmap");
  await expect(heatmap).toBeVisible();
  await expect(heatmap.getByRole("button")).toHaveCount(84);
  await expect(heatmap.locator(".token-heatmap-cell.is-unobserved").first()).toBeVisible();
  await expect(heatmap.locator(".token-heatmap-cell.is-partial").first()).toBeVisible();
  await expect(heatmap.locator(".token-heatmap-cell-level-4").first()).toBeVisible();
  const heatmapSelection = heatmap.locator(".token-heatmap-selection");
  await expect(heatmapSelection).toContainText("Jul 13, 2026");
  await expect(heatmapSelection).toContainText("105,000");
  await heatmap.locator(".token-heatmap-cell.is-unobserved").first().focus();
  await expect(heatmapSelection).toContainText("Token usage was not reported");
  await heatmap.getByRole("button").last().focus();
  await expect(heatmapSelection).toContainText("105,000");
  await expect(page.locator(".overview-model-summary")).toContainText("gpt-5.1-codex-mini");
  await expect(page.locator(".overview-provider-summary")).toContainText("Provider Alpha");
  const screenshotPath = testInfo.outputPath("overview-hardening-1440x900.png");
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach("overview-hardening-1440x900", {
    path: screenshotPath,
    contentType: "image/png"
  });

  await page.getByRole("button", { name: "7 days" }).click();
  await expect(page.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
  await expect(requests.locator("strong")).toHaveText("777");
  await expect.poll(() => crp.calls.filter((call) => call.operation === "getMetrics" && call.window === "7d").length).toBe(1);
  expect(crp.calls.filter((call) => call.operation === "getTokenHeatmap" && call.window === "12w")).toHaveLength(1);

  await page.getByRole("button", { name: "24 hours" }).click();
  await expect(requests.locator("strong")).toHaveText("128");
  await assertNoSecrets(page, crp);
});

test("discloses incomplete Metrics rates and conserves the visible model remainder", async ({ page, crp }) => {
  crp.state.metrics.models = [
    ...Array.from({ length: 8 }, (_, index) => ({
      model: `visible-model-${index + 1}`,
      requests: 10 - index,
      tokens: { input: 0, output: 0, observedRequests: 0 }
    }))
  ];
  crp.state.metrics.modelOtherRequests = 76;
  crp.state.metrics.providers[0].requests -= 3;
  crp.state.metrics.providerOtherRequests = 3;
  crp.state.metrics.dataQuality = {
    unknownModelRequests: 5,
    modelOverflowRequests: 4,
    providerOverflowRequests: 3,
    droppedObservations: 2
  };

  await openCrp(page, crp);
  const successRate = page.locator(".metric-card").filter({ hasText: "Service reliability" });
  await expect(successRate.locator("strong")).toHaveText("-");
  await expect(successRate).toContainText("Unavailable because 2 metric updates were dropped");
  await expect(page.locator(".overview-provider-summary tbody td").filter({ hasText: /^-$/ }).first())
    .toBeVisible();

  const quality = page.getByRole("complementary", { name: "Data quality" });
  await expect(quality).toContainText("These counters are independent signals and may overlap.");
  await expect(quality).toContainText("Unknown-model requests5");
  await expect(quality).toContainText("Grouped model requests4");
  await expect(quality).toContainText("Grouped provider requests3");
  await expect(quality).toContainText("Dropped metric updates2");
  await expect(page.getByText("Data quality: 14")).toHaveCount(0);

  const distribution = page.locator(".overview-model-summary");
  await expect(distribution).toContainText("Unknown model");
  await expect(distribution).toContainText("Other grouped models");
  await expect(distribution.locator("li").filter({ hasText: "Unknown model" }).locator("strong")).toHaveText("5");
  await expect(distribution.locator("li").filter({ hasText: "Other grouped models" }).locator("strong")).toHaveText("71");
  await distribution.getByRole("button", { name: "Show all 10" }).click();
  await expect(distribution).toContainText("visible-model-8");
  await expect(page.getByText("This view contains 24 UTC hourly buckets, including the current partial hour."))
    .toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator(".token-heatmap-scroll").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.scrollWidth > element.clientWidth
      && rect.left >= -0.5
      && rect.right <= innerWidth + 0.5;
  })).toBe(true);
  await assertLayoutIntegrity(page);
  await assertNoSecrets(page, crp);
});

test("shows empty and degraded Metrics without affecting proxy readiness", async ({ page, crp }) => {
  crp.setMetrics(crp.emptyMetrics());
  crp.setTokenHeatmap(crp.emptyTokenHeatmap());
  await openCrp(page, crp);
  await expect(page.getByTestId("metrics-empty")).toBeVisible();
  await expect(page.getByRole("heading", { name: "No proxy traffic in this window" })).toBeVisible();
  await expect(page.locator(".overview-command-bar")).toBeVisible();
  await page.getByRole("button", { name: "7 days" }).click();
  await expect(page.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("metrics-empty")).toBeVisible();
  await expect.poll(() => crp.calls.filter((call) => (
    call.operation === "getMetrics" && call.window === "7d"
  )).length).toBe(1);

  const degraded = crp.emptyMetrics();
  degraded.storageState = "degraded";
  crp.setMetrics(degraded);
  const degradedHeatmap = crp.emptyTokenHeatmap();
  degradedHeatmap.storageState = "degraded";
  crp.setTokenHeatmap(degradedHeatmap);
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Metrics storage is degraded. Proxy traffic is not affected.")).toBeVisible();
  await expect(page.getByText("Daily history is not being saved reliably")).toBeVisible();
  await expect(page.getByTestId("token-heatmap")).toBeVisible();
});

test("keeps the 12-week Token heatmap visible when the current window is empty", async ({ page, crp }) => {
  crp.setMetrics(crp.emptyMetrics());
  await openCrp(page, crp);
  await expect(page.getByTestId("token-heatmap")).toBeVisible();
  await expect(page.getByTestId("metrics-empty")).toHaveCount(0);
  await expect(page.locator(".overview-model-summary")).toHaveCount(0);
  await expect(page.locator(".overview-provider-summary")).toHaveCount(0);
  await assertNoSecrets(page, crp);
});

test("isolates a Metrics API failure from the rest of the workspace", async ({ page, crp }) => {
  await page.route("**/api/v1/metrics/overview?window=24h", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "METRICS_UNAVAILABLE", details: {} } })
    });
  });
  await openCrp(page, crp);
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page.locator(".overview-command-bar")).toBeVisible();
  await expect(page.getByText("Metrics are currently unavailable").first()).toBeVisible();
  await expect(page.getByTestId("metrics-empty")).toHaveCount(0);
  await expect(page.getByTestId("token-heatmap")).toBeVisible();
  await expect(page.locator(".token-heatmap-selection")).toContainText("105,000");
  await expect(page.locator(".overview-routing-segment")).toContainText("Provider Alpha");
  expect(crp.calls.filter((call) => call.operation === "getStatus").length).toBeGreaterThan(0);
});

test("isolates a Token heatmap API failure from current-window Metrics", async ({ page, crp }) => {
  await page.route("**/api/v1/metrics/token-heatmap?window=12w", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "METRICS_UNAVAILABLE", details: {} } })
    });
  });
  await openCrp(page, crp);
  await expect(page.locator(".metric-card").filter({ hasText: "Requests" }).locator("strong")).toHaveText("128");
  await expect(page.getByText("Daily token heatmap is unavailable")).toBeVisible();
  await expect(page.locator(".overview-model-summary")).toContainText("gpt-5.1-codex-mini");
  await expect(page.locator(".overview-provider-summary")).toContainText("Provider Alpha");
  await assertNoSecrets(page, crp);
});

test("OpenRouter built-in preset fills the maintained v1 endpoint", async ({ page, crp }) => {
  await openCrp(page, crp);
  await navigate(page, "Providers");
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog", { name: "Add provider" });
  await dialog.getByLabel("Provider type").selectOption("openrouter");
  await expect(dialog.getByLabel("Provider name")).toHaveValue("OpenRouter");
  await expect(dialog.getByLabel("Base URL")).toHaveValue("https://openrouter.ai/api/v1");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await assertNoSecrets(page, crp);
});

test("creates, discovers models, tests, switches, edits, and deletes a provider safely", async ({ page, crp }) => {
  const replacement = crp.registerSecret(`replacement-${randomBytes(18).toString("base64url")}`);
  await openCrp(page, crp);
  await navigate(page, "Providers");

  await page.getByRole("button", { name: "Add provider" }).click();
  const createDialog = page.getByRole("dialog", { name: "Add provider" });
  await createDialog.getByLabel("Provider name").fill("Provider Gamma");
  await createDialog.getByLabel("Base URL").fill(crp.upstreamBaseUrl);
  await createDialog.getByLabel("API key").fill(crp.credential);
  await collectSubmittedPasswordSnapshots(page);
  await createDialog.getByRole("button", { name: "Save provider" }).click();
  const createSnapshots = await page.evaluate(() => window.__stopPasswordSnapshots());
  expect(JSON.stringify(createSnapshots)).not.toContain(crp.credential);
  const gamma = page.getByTestId("provider-card-provider-3");
  await expect(gamma).toContainText("Untested");

  await gamma.getByRole("button", { name: "Test and make preferred" }).click();
  const testDialog = page.getByRole("dialog", { name: "Test provider" });
  await testDialog.getByRole("button", { name: "Refresh models" }).click();
  const modelSelect = testDialog.getByLabel("Test model");
  await expect(modelSelect.locator("option")).toHaveCount(3);
  await modelSelect.selectOption({ label: "Enter a model manually" });
  const manualModel = testDialog.locator("#test-model-manual");
  await manualModel.fill("manual-fixture-model");
  await testDialog.getByRole("button", { name: "Refresh models" }).click();
  await expect(manualModel).toHaveValue("manual-fixture-model");
  await modelSelect.selectOption("fixture-model");
  await testDialog.getByRole("button", { name: "Test and make preferred" }).click();
  await expect(gamma.getByText("Preferred", { exact: true })).toBeVisible();
  expect(crp.state.activeProviderId).toBe("provider-3");
  expect(crp.upstreamRequests.at(-1)).toMatchObject({
    path: "/v1/responses",
    model: "fixture-model",
    requestValid: true,
    credentialMatched: true
  });

  await page.getByTestId("provider-card-provider-a").getByRole("button", { name: "Make preferred" }).click();
  const detailsTrigger = page.getByRole("button", { name: "View Provider Gamma details" });
  await detailsTrigger.focus();
  await detailsTrigger.click();
  let details = page.getByRole("dialog", { name: "Provider Gamma" });
  await expect(details.getByText("Fresh catalog")).toBeVisible();
  await expect(details.getByText("gpt-5.1-codex-mini", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detailsTrigger).toBeFocused();

  details = await openProviderDetails(page, "Provider Gamma");
  await details.getByRole("button", { name: "Edit Provider Gamma" }).click();
  let editDialog = page.getByRole("dialog", { name: "Edit provider" });
  await editDialog.getByLabel("Provider name").fill("Provider Gamma Renamed");
  await editDialog.getByRole("button", { name: "Save changes" }).click();
  const renamed = page.getByTestId("provider-card-provider-3");
  await expect(renamed).toContainText("Passed");

  details = await openProviderDetails(page, "Provider Gamma Renamed");
  await details.getByRole("button", { name: "Edit Provider Gamma Renamed" }).click();
  editDialog = page.getByRole("dialog", { name: "Edit provider" });
  await editDialog.getByLabel("Advanced provider settings").check();
  await editDialog.getByLabel("Authentication header").fill("x-api-key");
  await editDialog.getByLabel("Extra headers (JSON)").fill('{"x-region":"cn"}');
  await editDialog.getByLabel("Replacement API key").fill(replacement);
  await collectSubmittedPasswordSnapshots(page);
  await editDialog.getByRole("button", { name: "Save changes" }).click();
  const editSnapshots = await page.evaluate(() => window.__stopPasswordSnapshots());
  expect(JSON.stringify(editSnapshots)).not.toContain(replacement);
  await expect(renamed).toContainText("Passed");
  expect(crp.calls.findLast((call) => call.operation === "updateProvider")).toMatchObject({
    id: "provider-3",
    replacedCredential: true,
    replacementLength: replacement.length
  });

  details = await openProviderDetails(page, "Provider Gamma Renamed");
  await details.getByRole("button", { name: "Delete Provider Gamma Renamed" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete provider?" });
  await deleteDialog.getByRole("button", { name: "Delete provider" }).click();
  await expect(page.getByTestId("provider-card-provider-3")).toHaveCount(0);
  expect(crp.calls.filter((call) => call.operation === "deleteProvider")).toHaveLength(1);
  await assertNoSecrets(page, crp, [replacement]);
});

test("ordinary provider test selects the first provider through no-start compare-and-set", async ({ page, crp }) => {
  crp.seedProviders({
    providers: [{ id: "provider-a", name: "Provider Alpha", baseUrl: crp.upstreamBaseUrl }],
    activeProviderId: null
  });
  crp.seedProviderModels("provider-a", { models: ["fixture-model"] });
  await openCrp(page, crp);
  await navigate(page, "Providers");

  const card = page.getByTestId("provider-card-provider-a");
  const details = await openProviderDetails(page, "Provider Alpha");
  await expect(details.getByRole("button", { name: "Test", exact: true })).toHaveCount(0);
  await details.getByRole("button", { name: "Test and select", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Test provider" });
  const modelSelect = dialog.locator("select#test-model");
  await expect(modelSelect).toBeVisible();
  await modelSelect.selectOption("fixture-model");
  await dialog.getByRole("button", { name: "Test and select" }).click();

  await expect(card.getByText("Preferred", { exact: true })).toBeVisible();
  expect(crp.state.activeProviderId).toBe("provider-a");
  expect(crp.state.worker.phase).toBe("stopped");
  expect(crp.calls.filter((call) => call.operation === "testProvider")).toEqual([
    { operation: "testProvider", id: "provider-a", model: "fixture-model", activateIfNone: true }
  ]);
  expect(crp.calls.filter((call) => call.operation === "activate")).toEqual([]);
  await assertNoSecrets(page, crp);
});

test("duplicates a provider configuration without copying credentials or state", async ({ page, crp }) => {
  const duplicateSecret = crp.registerSecret(`duplicate-${randomBytes(18).toString("base64url")}`);
  crp.seedProviders({
    providers: [
      { id: "provider-a", name: "Provider Alpha", baseUrl: crp.upstreamBaseUrl },
      {
        id: "provider-b",
        name: "Provider Beta",
        baseUrl: crp.upstreamBaseUrl,
        authHeader: "x-api-key",
        authScheme: "",
        extraHeaders: { "x-region": "cn" },
        modelMode: "override",
        modelOverride: "beta-model"
      }
    ],
    activeProviderId: "provider-a"
  });
  await openCrp(page, crp);
  await navigate(page, "Providers");

  await page.getByTestId("provider-card-provider-b")
    .getByRole("button", { name: "Duplicate Provider Beta" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Duplicate provider" });
  await expect(dialog.getByLabel("Provider name")).toHaveValue("Provider Beta copy");
  await expect(dialog.getByLabel("Base URL")).toHaveValue(crp.upstreamBaseUrl);
  await expect(dialog.getByLabel("API key")).toHaveValue("");
  await expect(dialog.getByLabel("API key")).toHaveAttribute("required", "");
  await dialog.getByLabel("Advanced provider settings").check();
  await expect(dialog.getByLabel("Authentication header")).toHaveValue("x-api-key");
  await expect(dialog.getByLabel("Authentication scheme")).toHaveValue("");
  await expect(dialog.getByLabel("Extra headers (JSON)")).toHaveValue('{\n  "x-region": "cn"\n}');
  await expect(dialog.getByLabel("Model routing")).toHaveValue("override");
  await expect(dialog.getByLabel("Override model")).toHaveValue("beta-model");

  await dialog.getByRole("button", { name: "Save duplicate" }).click();
  expect(crp.calls.filter((call) => call.operation === "createProvider")).toHaveLength(0);
  await dialog.getByLabel("API key").fill(duplicateSecret);
  await collectSubmittedPasswordSnapshots(page);
  await dialog.getByRole("button", { name: "Save duplicate" }).click();
  const snapshots = await page.evaluate(() => window.__stopPasswordSnapshots());
  expect(JSON.stringify(snapshots)).not.toContain(duplicateSecret);

  const duplicated = page.getByTestId("provider-card-provider-3");
  await expect(duplicated).toContainText("Provider Beta copy");
  await expect(duplicated).toContainText("Untested");
  await expect(page.getByTestId("provider-card-provider-b")).toContainText("Provider Beta");
  expect(crp.calls.findLast((call) => call.operation === "createProvider")).toMatchObject({
    input: {
      name: "Provider Beta copy",
      baseUrl: crp.upstreamBaseUrl,
      authHeader: "x-api-key",
      authScheme: "",
      extraHeaders: { "x-region": "cn" },
      modelMode: "override",
      modelOverride: "beta-model",
      modelMappingGroupId: null
    },
    credentialLength: duplicateSecret.length
  });
  await assertNoSecrets(page, crp, [duplicateSecret]);
});

test("paginates sanitized Activity and exposes diagnostics on System", async ({ page, crp }) => {
  crp.seedActivity(105);
  const activityRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/activity") activityRequests.push(url.search);
  });
  await openCrp(page, crp);
  await navigate(page, "Activity");
  await expect(page.locator(".activity-event")).toHaveCount(50);
  await expect(page.getByText("Unknown", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  await page.getByRole("button", { name: "Next" }).dblclick();
  await expect(page.locator(".activity-event")).toHaveCount(50);
  await expect.poll(() => activityRequests.filter((search) => search.includes("offset=50")).length).toBe(1);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator(".activity-event")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.locator(".activity-event")).toHaveCount(50);
  await page.locator(".activity-event summary").first().click();
  await expect(page.locator(".activity-event[open] .activity-detail")).toBeVisible();
  await expect(page.locator(".activity-event[open]")).toContainText(/Provider ID: provider-/);

  await navigate(page, "System");
  await expect(page.getByText("Native keyring")).toBeVisible();
  await expect(page.getByText("http://127.0.0.1:15100", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Generate diagnostic summary" }).click();
  const diagnostics = page.locator(".diagnostic-result");
  await expect(diagnostics).toContainText("Summary ready");
  await expect(diagnostics).toContainText("105 sanitized events");

  await page.locator("#locale-select").selectOption("zh-CN");
  await expect(page.getByRole("heading", { name: "系统", level: 1 })).toBeVisible();
  await expect(diagnostics).toContainText("摘要已生成");
  await assertNoSecrets(page, crp);
});

test("shows ChatGPT quota and hot-updates account-first routing", async ({ page, crp }) => {
  crp.seedProviders({
    providers: [{ id: "provider-account-fallback", name: "Fallback API" }],
    activeProviderId: "provider-account-fallback",
    generation: 8
  });
  crp.state.account.quota.windows = crp.state.account.quota.windows.filter(
    (window) => window.windowDurationMins === 10_080
  );
  await openCrp(page, crp);

  await expect(page.getByText("ChatGPT signed in")).toBeVisible();
  await expect(page.getByText("5-hour window")).toHaveCount(0);
  await expect(page.getByText("7-day window")).toBeVisible();
  await expect(page.getByText("38% remaining")).toBeVisible();

  const accountFirst = page.getByRole("checkbox", { name: /Use ChatGPT quota first/ });
  await expect(accountFirst).not.toBeChecked();
  await accountFirst.check();
  await expect(accountFirst).toBeChecked();
  expect(crp.state.routingMode).toBe("account_first");
  expect(crp.state.generation).toBe(9);
  expect(crp.calls.findLast((call) => call.operation === "updateRoutingMode")).toEqual({
    operation: "updateRoutingMode",
    mode: "account_first"
  });

  await page.getByRole("button", { name: "Refresh account quota" }).click();
  await expect.poll(() => crp.calls.filter((call) => call.operation === "refreshAccount").length).toBe(1);
  await navigate(page, "System");
  await expect(page.getByText("ChatGPT signed in")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Use ChatGPT quota first" })).toBeChecked();
  await expect(page.getByText("7-day window")).toHaveCount(0);
  await expect(page.getByText("5-hour window")).toHaveCount(0);
  await navigate(page, "Activity");
  await expect(page.locator(".activity-event").first()).toContainText("Routing preference changed");
  await assertNoSecrets(page, crp);
});

test("explains a Codex model-catalog account-monitor failure in both locales", async ({ page, crp }) => {
  crp.state.account = {
    phase: "unavailable",
    authMode: null,
    planType: null,
    quotaSupported: null,
    quota: null,
    updatedAt: "2026-07-13T08:45:00.000Z",
    errorCode: "CODEX_MODEL_CATALOG_INVALID"
  };
  await openCrp(page, crp);
  await navigate(page, "System");
  await expect(page.getByText("CODEX_MODEL_CATALOG_INVALID")).toBeVisible();
  await expect(page.getByText(/could not load model_catalog_json/)).toBeVisible();

  await page.locator("#locale-select").selectOption("zh-CN");
  await expect(page.getByText(/无法加载 model_catalog_json/)).toBeVisible();
  await assertNoSecrets(page, crp);
});

test("keeps fragmentless reload GET-only until explicit same-origin management recovery", async ({ page, crp }) => {
  crp.seedActivity(55);
  await openCrp(page, crp);
  const mutations = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/v1/")
      && !["GET", "HEAD"].includes(request.method())) mutations.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        resumeHeader: request.headers()["x-crp-session-resume"]
      });
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#session-banner")).toContainText("Read-only session");
  await expect(page.getByRole("button", { name: "Stop proxy" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Restart worker" })).toBeDisabled();
  await expect(page.getByLabel("Preferred provider")).toBeDisabled();
  await page.getByRole("button", { name: "Refresh status" }).click();
  await navigate(page, "Providers");
  await expect(page.getByRole("button", { name: "Add provider" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Duplicate Provider Beta" })).toBeDisabled();
  await expect(page.getByTestId("provider-card-provider-b").getByRole("button", { name: "Make preferred" })).toBeDisabled();
  await navigate(page, "Activity");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator(".activity-event")).toHaveCount(5);
  await navigate(page, "System");
  await expect(page.getByRole("button", { name: "Generate diagnostic summary" })).toBeDisabled();
  expect(mutations).toEqual([]);

  await page.getByRole("button", { name: "Restore management" }).click();
  await expect(page.locator("#session-banner")).toHaveCount(0);
  await expect(page.getByLabel("Preferred provider")).toBeEnabled();
  await page.getByLabel("Preferred provider").selectOption("provider-b");
  await expect(page.getByLabel("Preferred provider")).toHaveValue("provider-b");
  expect(crp.state.activeProviderId).toBe("provider-b");
  expect(mutations).toEqual([
    { method: "POST", path: "/api/v1/session/resume", resumeHeader: "1" },
    { method: "POST", path: "/api/v1/providers/provider-b/activate", resumeHeader: undefined }
  ]);
  await assertNoSecrets(page, crp);
});

test("keeps every V8 page unclipped in both locales at desktop, tablet, and mobile widths", async ({ page, crp }) => {
  crp.seedActivity(5);
  await openCrp(page, crp);
  const matrices = [
    {
      locale: "en",
      pages: [["Overview", "Overview"], ["Providers", "Providers"], ["Model Mappings", "Model Mappings"], ["Routing Rules", "Routing Rules"], ["Activity", "Activity"], ["System", "System"]]
    },
    {
      locale: "zh-CN",
      pages: [["概览", "概览"], ["提供商", "提供商"], ["模型映射", "模型映射"], ["路由规则", "路由规则"], ["活动", "活动"], ["系统", "系统"]]
    }
  ];
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    const mobile = viewport.width <= 840;
    if (mobile) {
      const menu = page.getByRole("button", { name: /Open navigation|打开导航/ });
      await menu.click();
      const mobileDrawer = page.getByRole("dialog", { name: /Primary navigation|主导航/ });
      await expect(mobileDrawer.locator(".sidebar-close")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();
    }
    for (const matrix of matrices) {
      if (mobile) {
        await page.getByRole("button", { name: /Open navigation|打开导航/ }).click();
        const mobileDrawer = page.getByRole("dialog", { name: /Primary navigation|主导航/ });
        await mobileDrawer.getByLabel(/Language|语言/).selectOption(matrix.locale);
        await mobileDrawer.locator(".sidebar-close").click();
      } else {
        await page.locator("#locale-select").selectOption(matrix.locale);
      }
      for (const [navigation, heading] of matrix.pages) {
        await test.step(`${viewport.width}x${viewport.height} ${matrix.locale} ${heading}`, async () => {
          await navigate(page, navigation, mobile);
          await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
          if (heading === "Activity" || heading === "活动") {
            await expect(page.getByText(heading === "Activity" ? "Unknown" : "未知", { exact: true }))
              .toHaveCount(0);
          }
          await assertLayoutIntegrity(page);
        });
      }
      await test.step(`${viewport.width}x${viewport.height} ${matrix.locale} setup`, async () => {
        await page.goto(new URL("/setup", page.url()).href);
        await expect(page.getByTestId("page-setup")).toBeVisible();
        await assertLayoutIntegrity(page);
      });
    }
  }
});
