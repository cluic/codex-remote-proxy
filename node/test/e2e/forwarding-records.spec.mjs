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

test("scans, filters, loads details on demand, and toggles forwarding capture", async ({ page, crp }, testInfo) => {
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Forwarding Records", exact: true }).click();
  await expect(page).toHaveURL(/\/forwarding$/);
  await expect(page.getByRole("heading", { name: "Forwarding Records", level: 1 })).toBeVisible();
  await expect(page.locator(".forwarding-summary")).toContainText("4");
  await expect(page.locator(".records-table tbody tr")).toHaveCount(4);
  await expect(page.locator(".records-table thead th")).toHaveCount(8);
  expect(await page.locator(".records-table thead th").allTextContents()).toEqual([
    "Time", "Request", "Result", "Model", "Session ID", "Provider", "Tokens", "Duration"
  ]);
  await expect(page.locator(".records-table")).toContainText("ChatGPT");
  await expect(page.locator(".records-table")).toContainText("Fallback API");
  await expect(page.locator(".records-table")).toContainText("64");
  await expect(page.locator(".records-table")).toContainText("vendor/gpt-5.6-sol");
  await expect(page.locator(".records-table")).not.toContainText("127.0.0.1:15100");
  await expect(page.locator(".records-table")).not.toContainText("/models");

  const capture = page.getByRole("checkbox", { name: "Record forwarding metadata" });
  const captureDetails = page.getByRole("checkbox", { name: "Record request details" });
  await expect(capture).toBeChecked();
  await expect(captureDetails).not.toBeChecked();

  const capturedRow = page.locator(".records-table tbody tr").filter({ hasText: "gpt-5.6-sol" }).first();
  await capturedRow.click();
  await expect(capturedRow).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => crp.calls.filter((call) => call.operation === "getForwardingRecordDetail").length).toBe(1);
  const detail = page.getByTestId("forwarding-record-details");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("http://127.0.0.1:15100");
  await expect(page.getByTestId("forwarding-request-data")).toBeVisible();
  await expect(page.getByTestId("forwarding-response-data")).toBeVisible();
  await expect(page.getByTestId("forwarding-request-data")).toContainText("POST");
  await expect(page.getByTestId("forwarding-response-data")).toContainText("200 Response");
  await expect(page.getByTestId("forwarding-request-data").locator("details")).not.toHaveAttribute("open", "");
  await page.getByTestId("forwarding-request-data").locator("summary").click();
  await expect(page.getByTestId("forwarding-request-data")).toContainText("content-type");
  await expect(page.getByTestId("forwarding-request-data")).toContainText("[REDACTED]");
  await expect(page.getByTestId("forwarding-response-data")).toContainText("Truncated");

  const rowThree = page.locator(".records-table tbody tr").filter({ hasText: "session-fixture" });
  await rowThree.focus();
  await rowThree.press("Enter");
  await expect(rowThree).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("forwarding-response-data")).toContainText("response-fixture-3");
  const rowTwo = page.locator(".records-table tbody tr").filter({ hasText: "gpt-5.6-luna" });
  await rowTwo.focus();
  await rowTwo.press(" ");
  await expect(rowTwo).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("forwarding-request-data")).toContainText("Payload details were not collected");
  await expect(page.getByTestId("forwarding-response-data")).toContainText("Not captured");

  await rowThree.focus();
  await rowThree.press("Enter");
  await expect(page.getByTestId("forwarding-response-data")).toContainText("response-fixture-3");
  await page.route("**/api/v1/forwarding-records/4", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  const rowFour = page.locator(".records-table tbody tr").filter({ hasText: "vendor/gpt-5.6-sol" });
  await rowFour.click();
  await expect(detail).toContainText("Loading captured payload");
  await expect(detail).not.toContainText("response-fixture-3");
  await expect(detail.locator(".record-data-grid")).toHaveCount(0);
  await expect(page.getByTestId("forwarding-response-data")).toContainText("response.completed");
  await page.unroute("**/api/v1/forwarding-records/4");

  crp.failForwardingDetail(4);
  await rowThree.click();
  await rowFour.click();
  await expect(detail.locator(".record-detail-failed")).toBeVisible();
  await expect(detail).toContainText("Captured details could not be loaded");
  await expect(detail).not.toContainText("response-fixture-3");
  crp.passForwardingDetail(4);
  const detailCallsBeforeRetry = crp.calls.filter((call) => (
    call.operation === "getForwardingRecordDetail" && call.id === 4
  )).length;
  await rowFour.click();
  await expect.poll(() => crp.calls.filter((call) => (
    call.operation === "getForwardingRecordDetail" && call.id === 4
  )).length).toBe(detailCallsBeforeRetry + 1);
  await expect(page.getByTestId("forwarding-response-data")).toContainText("response.completed");

  const showModelRequests = page.getByRole("checkbox", { name: "Show /models requests" });
  await showModelRequests.check();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(6);
  await expect(page.locator(".records-table")).toContainText("/models");
  await showModelRequests.uncheck();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(4);
  await page.getByRole("button", { name: "Aborted", exact: true }).click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Rejected", exact: true }).click();
  await expect(page.locator(".records-table")).toContainText("429");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search forwarding records").fill("vendor/gpt-5.6-sol");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);

  await captureDetails.check();
  await expect.poll(() => crp.state.captureDetailsEnabled).toBe(true);
  expect(crp.calls.find((call) => call.operation === "updateCaptureDetails")).toEqual({ operation: "updateCaptureDetails", enabled: true });
  await capture.uncheck();
  await expect(captureDetails).toBeDisabled();
  await expect.poll(() => crp.state.captureEnabled).toBe(false);
  await capture.check();
  await expect(captureDetails).not.toBeChecked();
  await captureDetails.uncheck();
  await expect(captureDetails).not.toBeChecked();
  await assertLayoutIntegrity(page);
  await captureDetails.check();
  await expect(captureDetails).toBeChecked();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search forwarding records").fill("");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const reviewRow = page.locator(".records-table tbody tr").filter({ hasText: "session-fixture" });
  await reviewRow.click();
  await expect(page.getByTestId("forwarding-response-data")).toContainText("response-fixture-3");
  await assertNoSecrets(page, crp);
  await page.evaluate(() => window.scrollTo(0, 0));
  const desktopScreenshot = testInfo.outputPath("forwarding-ledger-desktop.png");
  crp.registerAttachment(desktopScreenshot);
  await page.screenshot({ path: desktopScreenshot, animations: "disabled", fullPage: true });
  await testInfo.attach("forwarding-ledger-desktop", { path: desktopScreenshot, contentType: "image/png" });
});

test("keeps the forwarding ledger usable in Chinese at 390px", async ({ page, crp }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCrp(page, crp);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Primary navigation" }).getByRole("link", { name: "Forwarding Records", exact: true }).click();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Primary navigation" }).getByLabel("Language").selectOption("zh-CN");
  await page.locator(".sidebar-open").evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
  await page.locator(".sidebar-close").click();
  await expect(page.getByRole("heading", { name: "转发记录", level: 1 })).toBeVisible();
  await expect(page.getByLabel("记录转发元数据")).toBeChecked();
  await expect(page.getByLabel("记录请求详情")).not.toBeChecked();
  await expect(page.locator(".records-table-wrap")).toBeVisible();
  expect(await page.locator(".records-table-wrap").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator(".records-table tbody tr").filter({ hasText: "session-fixture" }).click();
  await expect(page.getByTestId("forwarding-request-data")).toBeVisible();
  await expect(page.getByTestId("forwarding-response-data")).toBeVisible();
  await assertLayoutIntegrity(page);
  await assertNoSecrets(page, crp);
  await page.evaluate(() => window.scrollTo(0, 0));
  const phoneScreenshot = testInfo.outputPath("forwarding-ledger-phone-zh.png");
  crp.registerAttachment(phoneScreenshot);
  await page.screenshot({ path: phoneScreenshot, animations: "disabled", fullPage: true });
  await testInfo.attach("forwarding-ledger-phone-zh", { path: phoneScreenshot, contentType: "image/png" });
});
