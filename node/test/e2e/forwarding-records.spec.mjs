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

test("lists, filters, inspects, and toggles metadata-only forwarding records", async ({ page, crp }) => {
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Forwarding Records", exact: true }).click();
  await expect(page).toHaveURL(/\/forwarding$/);
  await expect(page.getByRole("heading", { name: "Forwarding Records", level: 1 })).toBeVisible();
  await expect(page.locator(".forwarding-summary")).toContainText("4");
  await expect(page.locator(".records-table tbody tr")).toHaveCount(4);
  await expect(page.locator(".records-table")).toContainText("ChatGPT");
  await expect(page.locator(".records-table")).toContainText("Fallback API");

  await page.getByRole("button", { name: "Open forwarding record 3" }).click();
  const detail = page.getByRole("complementary", { name: "Request metadata" });
  await expect(detail).toContainText("chatgpt-upstream-3");
  await expect(detail).toContainText("Only bounded metadata is shown");
  await expect(detail).not.toContainText("authorization");

  await page.getByRole("button", { name: "Aborted", exact: true }).click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".records-table")).toContainText("Aborted");

  await page.getByRole("button", { name: "Rejected", exact: true }).click();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".records-table")).toContainText("429");

  await page.getByRole("button", { name: "All", exact: true }).click();
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
  await expect(page.locator(".records-table-wrap")).toBeVisible();
  await assertLayoutIntegrity(page);
  await assertNoSecrets(page, crp);
});
