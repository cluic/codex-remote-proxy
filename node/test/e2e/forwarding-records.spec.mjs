import { assertLayoutIntegrity, assertNoSecrets, expect, openCrp, test } from "./crp-ui-fixture.mjs";

test.beforeEach(async ({ crp }) => {
  crp.seedProviders({ providers: [
    { id: "provider-1", name: "Primary API", baseUrl: crp.upstreamBaseUrl },
    { id: "provider-2", name: "Fallback API", baseUrl: "https://fallback.example/v1" }
  ], activeProviderId: "provider-1" });
});

async function openRecords(page, crp) {
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Forwarding Records", exact: true }).click();
  await expect(page.getByTestId("forwarding-record-row-4")).toBeVisible();
}
async function captureEvidence(page, crp, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  crp.registerAttachment(path);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("keeps core columns visible and opens on-demand details in the current viewport", async ({ page, crp }, testInfo) => {
  await openRecords(page, crp);
  await expect(page.locator(".records-table tbody tr")).toHaveCount(4);
  await expect(page.locator(".records-table thead th")).toHaveCount(6);
  expect(await page.locator(".records-table-wrap").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.locator(".records-table")).not.toContainText("127.0.0.1:15100");
  await expect(page.locator(".records-table")).not.toContainText("session-fixture");
  await expect(page.locator(".records-table")).not.toContainText("/models");
  expect(crp.calls.filter((c) => c.operation === "getForwardingRecordDetail")).toHaveLength(0);
  await captureEvidence(page, crp, testInfo, "forwarding-list-desktop");
  const row = page.getByTestId("forwarding-record-row-4");
  await row.focus();
  await row.press("Enter");
  const drawer = page.getByTestId("forwarding-record-detail-drawer");
  await expect(drawer).toBeVisible();
  await expect.poll(() => drawer.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })).toBe(true);
  await expect.poll(() => crp.calls.filter((c) => c.operation === "getForwardingRecordDetail").length).toBe(1);
  await expect(drawer).toContainText("Account cooldown");
  await expect(drawer).toContainText("Exact model priority");
  await expect(drawer).toContainText("http://127.0.0.1:15100/responses");
  await page.getByTestId("forwarding-detail-tab-request").click();
  await expect(page.getByTestId("forwarding-request-data")).toContainText('"model"');
  const headers = page.getByTestId("forwarding-request-data").locator("details").first();
  await expect(headers).not.toHaveAttribute("open", "");
  await headers.locator("summary").click();
  await expect(headers).toContainText("[REDACTED]");
  await page.getByTestId("forwarding-detail-tab-response").click();
  await expect(page.getByTestId("forwarding-response-data")).toContainText("response.completed");
  await expect(page.getByTestId("forwarding-response-data")).toContainText(/truncat/i);
  await captureEvidence(page, crp, testInfo, "forwarding-detail-desktop");
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(row).toBeFocused();
  await assertLayoutIntegrity(page);
  await assertNoSecrets(page, crp);
});

test("clears previous payloads during slow detail changes and allows recovery from detail errors", async ({ page, crp }) => {
  await openRecords(page, crp);
  await page.getByTestId("forwarding-record-row-3").click();
  await page.getByTestId("forwarding-detail-tab-response").click();
  await expect(page.getByTestId("forwarding-response-data")).toContainText("response-fixture-3");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/v1/forwarding-records/4", async (route) => { await gate; await route.continue(); });
  try {
    await page.getByTestId("forwarding-detail-previous").click();
    await expect(page.getByTestId("forwarding-record-detail-drawer")).not.toContainText("response-fixture-3");
    release();
    await page.getByTestId("forwarding-detail-tab-response").click();
    await expect(page.getByTestId("forwarding-response-data")).toContainText("response-fixture-4");
  } finally { release(); await page.unroute("**/api/v1/forwarding-records/4"); }
  await page.keyboard.press("Escape");
  crp.failForwardingDetail(4);
  await page.getByTestId("forwarding-record-row-4").click();
  await page.getByTestId("forwarding-detail-tab-response").click();
  await expect(page.getByTestId("forwarding-record-detail-drawer")).toContainText("Captured details could not be loaded");
  await expect(page.getByTestId("forwarding-record-detail-drawer")).not.toContainText("response-fixture-4");
  crp.passForwardingDetail(4);
  await page.keyboard.press("Escape");
  await page.getByTestId("forwarding-record-row-4").click();
  await page.getByTestId("forwarding-detail-tab-response").click();
  await expect(page.getByTestId("forwarding-response-data")).toContainText("response-fixture-4");
  await page.getByTestId("forwarding-detail-next").click();
  await page.getByTestId("forwarding-detail-next").click();
  await page.getByTestId("forwarding-detail-tab-request").click();
  await expect(page.getByTestId("forwarding-request-data")).toContainText("not collected");
  await assertNoSecrets(page, crp);
});

test("combines exact filters and keeps outcome facets scoped to the same query", async ({ page, crp }) => {
  await openRecords(page, crp);
  await page.getByTestId("forwarding-model-filter").fill("gpt-5.6-sol");
  await page.getByTestId("forwarding-provider-filter").selectOption("provider-2");
  await page.getByTestId("forwarding-apply-filters").click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);
  await expect(page.getByTestId("forwarding-record-row-4")).toBeVisible();
  await expect.poll(() => crp.calls.filter((c) => c.operation === "getForwardingRecords").at(-1)?.model).toBe("gpt-5.6-sol");
  expect(crp.calls.filter((c) => c.operation === "getForwardingRecords").at(-1).providerId).toBe("provider-2");
  await page.getByTestId("forwarding-outcome-success").click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(0);
  await page.getByTestId("forwarding-outcome-aborted").click();
  await expect(page.getByTestId("forwarding-record-row-4")).toBeVisible();
  await page.getByTestId("forwarding-time-range").selectOption("custom");
  const dates = page.getByTestId("forwarding-custom-time-range").locator('input[type="datetime-local"]');
  await dates.nth(0).fill("2026-07-13T00:00");
  await dates.nth(1).fill("2026-07-14T00:00");
  await page.getByTestId("forwarding-apply-filters").click();
  await expect.poll(() => crp.calls.filter((c) => c.operation === "getForwardingRecords").at(-1)?.since).toMatch(/^2026-07-\d{2}T\d{2}:00:00\.000Z$/);
  const last = crp.calls.filter((c) => c.operation === "getForwardingRecords").at(-1);
  expect(Date.parse(last.until) - Date.parse(last.since)).toBe(86_400_000);
  await assertNoSecrets(page, crp);
});

test("filters one session from details and refreshes without blanking existing rows", async ({ page, crp }) => {
  await openRecords(page, crp);
  await page.getByTestId("forwarding-record-row-3").click();
  await page.getByTestId("forwarding-view-session").click();
  await expect(page.getByTestId("forwarding-record-detail-drawer")).not.toBeVisible();
  await expect(page.getByTestId("forwarding-session-filter")).toContainText("session-fixture");
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);
  await page.getByTestId("forwarding-clear-session-filter").click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(4);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let pending = false;
  await page.route("**/api/v1/forwarding-records?**", async (route) => { pending = true; await gate; await route.continue(); });
  try {
    await page.getByTestId("forwarding-refresh").click();
    await expect.poll(() => pending).toBe(true);
    await expect(page.locator(".records-table tbody tr")).toHaveCount(4);
    await expect(page.getByTestId("forwarding-refresh")).toBeDisabled();
    release();
    await expect(page.getByTestId("forwarding-refresh")).toBeEnabled();
  } finally { release(); await page.unroute("**/api/v1/forwarding-records?**"); }
  await page.getByTestId("forwarding-capture-settings-toggle").click();
  const capture = page.getByRole("checkbox", { name: "Record forwarding metadata" });
  const details = page.getByRole("checkbox", { name: "Record request details" });
  await details.check();
  await expect.poll(() => crp.state.captureDetailsEnabled).toBe(true);
  await capture.uncheck();
  await expect(details).toBeDisabled();
  await capture.check();
  await expect(details).not.toBeChecked();
  await assertNoSecrets(page, crp);
});

test("explains final errors separately from HTTP status", async ({ page, crp }) => {
  crp.state.forwardingRecords.find((r) => r.id === 1).responseStatus = 200;
  await openRecords(page, crp);
  await page.getByTestId("forwarding-outcome-error").click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);
  await page.getByTestId("forwarding-record-row-1").click();
  const drawer = page.getByTestId("forwarding-record-detail-drawer");
  await expect(drawer).toContainText("connection refused");
  await expect(drawer).toContainText("proxy_upstream_error");
  await expect(drawer).toContainText("200");
  await assertNoSecrets(page, crp);
});

test("copies captured JSON exactly even when the display is formatted", async ({ page, crp }) => {
  const raw = '{"id":9007199254740993,"x":1,"x":2}';
  crp.state.forwardingRecordDetails.get(3).request.body.content = raw;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: async (text) => { window.__forwardingCopiedRaw = text; } } });
  });
  await openRecords(page, crp);
  await page.getByTestId("forwarding-record-row-3").click();
  await page.getByTestId("forwarding-detail-tab-request").click();
  const request = page.getByTestId("forwarding-request-data");
  await expect(request).toContainText("9007199254740993");
  await request.getByRole("button", { name: "Formatted preview", exact: true }).click();
  await request.getByRole("button", { name: "Copy raw body", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__forwardingCopiedRaw)).toBe(raw);
  await assertNoSecrets(page, crp);
});

test("keeps long-list pagination near the viewport and restores the selected row's scroll position", async ({ page, crp }) => {
  const template = crp.state.forwardingRecords.find((r) => r.id === 3);
  crp.state.forwardingRecords = Array.from({ length: 64 }, (_, index) => ({
    ...structuredClone(template), id: 64 - index, detailsAvailable: false,
    requestId: `long-list-${64 - index}`
  }));
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Forwarding Records", exact: true }).click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(50);
  await expect.poll(() => page.locator(".records-pagination").evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  const wrap = page.locator(".records-table-wrap");
  const row = page.getByTestId("forwarding-record-row-40");
  await row.click();
  await expect(page.getByTestId("forwarding-record-detail-drawer")).toBeVisible();
  const scrollTop = await wrap.evaluate((el) => el.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  expect(await wrap.evaluate((el) => el.scrollTop)).toBe(scrollTop);
  await page.locator(".records-pagination").getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(14);
  await assertNoSecrets(page, crp);
});

test("uses Chinese mobile cards and an unobstructed full-screen detail flow", async ({ page, crp }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCrp(page, crp);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Primary navigation" }).getByLabel("Language").selectOption("zh-CN");
  await page.getByRole("link", { name: "转发记录", exact: true }).click();
  await page.locator(".sidebar").evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const mobile = page.getByTestId("forwarding-mobile-list");
  await expect(mobile).toBeVisible();
  await expect(page.locator(".records-table-wrap")).not.toBeVisible();
  const card = page.getByTestId("forwarding-record-card-3");
  await expect(card).toContainText("成功");
  await expect(card).toContainText("gpt-5.6-sol");
  await expect(card).toContainText("ChatGPT");
  expect(await mobile.evaluate((el) => el.getBoundingClientRect().top < innerHeight - 240)).toBe(true);
  await assertLayoutIntegrity(page);
  await captureEvidence(page, crp, testInfo, "forwarding-cards-mobile-zh");
  await card.click();
  const drawer = page.getByTestId("forwarding-record-detail-drawer");
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate((el) => el.getBoundingClientRect().width <= innerWidth)).toBe(true);
  await page.getByTestId("forwarding-detail-tab-response").click();
  await expect(page.getByTestId("forwarding-response-data")).toContainText("response-fixture-3");
  await captureEvidence(page, crp, testInfo, "forwarding-detail-mobile-zh");
  await page.keyboard.press("Escape");
  await expect(card).toBeFocused();
  await page.getByTestId("forwarding-capture-settings-toggle").click();
  const capture = page.getByRole("checkbox", { name: "记录转发元数据" });
  await capture.uncheck();
  await expect.poll(() => crp.state.captureEnabled).toBe(false);
  await capture.check();
  await expect.poll(() => crp.state.captureEnabled).toBe(true);
  await assertLayoutIntegrity(page);
  await assertNoSecrets(page, crp);
});
