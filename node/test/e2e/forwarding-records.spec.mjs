import {
  assertLayoutIntegrity,
  assertNoSecrets,
  expect,
  openCrp,
  test
} from "./crp-ui-fixture.mjs";

test.beforeEach(async ({ crp }) => {
  crp.seedProviders({
    providers: [
      { id: "provider-1", name: "Primary API", baseUrl: crp.upstreamBaseUrl },
      { id: "provider-2", name: "Fallback API", baseUrl: "https://fallback.example/v1" }
    ],
    activeProviderId: "provider-1"
  });
});

test("lists, filters, inspects, and toggles metadata-only forwarding records", async ({ page, crp }, testInfo) => {
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Forwarding Records", exact: true }).click();
  await expect(page).toHaveURL(/\/forwarding$/);
  await expect(page.getByRole("heading", { name: "Forwarding Records", level: 1 })).toBeVisible();
  await expect(page.locator(".forwarding-summary")).toContainText("4");
  await expect(page.locator(".records-table tbody tr")).toHaveCount(4);
  await expect(page.locator(".records-table")).toContainText("ChatGPT");
  await expect(page.locator(".records-table")).toContainText("Fallback API");
  await expect(page.locator(".records-table")).toContainText("gpt-5.6-sol");
  await expect(page.locator(".records-table")).toContainText("vendor/gpt-5.6-sol");
  await expect(page.locator(".records-table")).not.toContainText("127.0.0.1:15100");
  await expect(page.locator(".records-table")).not.toContainText("/models");
  await expect(page.locator(".records-table thead th")).toHaveCount(6);
  const showModelRequests = page.getByRole("checkbox", { name: "Show /models requests" });
  await expect(showModelRequests).not.toBeChecked();

  await page.getByRole("button", { name: "Open forwarding record 4" }).click();
  const detail = page.getByRole("complementary", { name: "Request metadata" });
  await expect(detail).toContainText("fallback-upstream-4");
  await expect(detail).toContainText("http://127.0.0.1:15100/responses");
  await expect(detail).toContainText("gpt-5.6-sol");
  await expect(detail).toContainText("vendor/gpt-5.6-sol");
  await expect(detail).toContainText("Only bounded metadata is shown");
  await expect(detail).not.toContainText("authorization");
  expect(await page.locator(".records-table-wrap").evaluate((element) => (
    element.scrollWidth <= element.clientWidth + 1
  ))).toBe(true);
  const screenshot = testInfo.outputPath("forwarding-models-1440x900.png");
  crp.registerAttachment(screenshot);
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("forwarding-models-1440x900", {
    path: screenshot,
    contentType: "image/png"
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(await page.locator(".records-table-wrap").evaluate((element) => (
    element.scrollWidth <= element.clientWidth + 1
  ))).toBe(true);
  await assertLayoutIntegrity(page);

  await showModelRequests.check();
  await expect(page.locator(".forwarding-summary")).toContainText("6");
  await expect(page.locator(".records-table tbody tr")).toHaveCount(6);
  await expect(page.locator(".records-table")).toContainText("/models");
  await expect(page.locator(".records-table")).toContainText("/v1/models?refresh=1");
  await showModelRequests.uncheck();
  await expect(page.locator(".forwarding-summary")).toContainText("4");
  await expect(page.locator(".records-table tbody tr")).toHaveCount(4);

  await page.getByRole("button", { name: "Aborted", exact: true }).click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".records-table")).toContainText("Aborted");

  await page.getByRole("button", { name: "Rejected", exact: true }).click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".records-table")).toContainText("429");

  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search forwarding records").fill("vendor/gpt-5.6-sol");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".records-table")).toContainText("Fallback API");

  await page.getByLabel("Search forwarding records").fill("req-fixture-1");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".records-table")).toContainText("Error");

  const capture = page.getByRole("checkbox", { name: "Record forwarding metadata" });
  await expect(capture).toBeChecked();
  await capture.uncheck();
  await expect(capture).not.toBeChecked();
  await expect.poll(() => crp.state.captureEnabled).toBe(false);
  expect(crp.calls.find((call) => call.operation === "updateCapture")).toEqual({
    operation: "updateCapture",
    enabled: false
  });
  await assertLayoutIntegrity(page);
  await assertNoSecrets(page, crp);
});

test("keeps the forwarding workflow usable in Chinese on a phone viewport", async ({ page, crp }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCrp(page, crp);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Primary navigation" })
    .getByRole("link", { name: "Forwarding Records", exact: true }).click();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Primary navigation" })
    .getByLabel("Language").selectOption("zh-CN");
  await page.locator(".sidebar-open").evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  await expect(page.getByRole("heading", { name: "转发记录", level: 1 })).toBeVisible();
  await expect(page.getByLabel("记录转发元数据")).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "显示 /models 请求" })).not.toBeChecked();
  await expect(page.locator(".records-table-wrap")).toBeVisible();
  await assertLayoutIntegrity(page);
  await assertNoSecrets(page, crp);
});
