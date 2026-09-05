import { assertNoSecrets, expect, test } from "./crp-ui-fixture.mjs";

test.beforeEach(async ({ crp }) => {
  crp.seedProviders({
    providers: [{ id: "provider-1", name: "Primary API", baseUrl: crp.upstreamBaseUrl }],
    activeProviderId: "provider-1"
  });
});

test("opens forwarding directly without loading unrelated charts, then loads them on Overview", async ({ page, crp }) => {
  const chartRequests = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/v1/metrics/")) chartRequests.push(pathname);
  });
  await page.goto(`${crp.origin}/forwarding#token=${crp.controlToken}`);
  await expect(page.locator("html")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("page-forwarding-records")).toBeVisible();
  await expect(page.locator(".records-table tbody tr")).toHaveCount(4);
  expect(chartRequests).toEqual([]);

  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect.poll(() => chartRequests.includes("/api/v1/metrics/overview")).toBe(true);
  await expect.poll(() => chartRequests.includes("/api/v1/metrics/token-heatmap")).toBe(true);
  await assertNoSecrets(page, crp);
});

test("slow Overview charts do not hold the whole workspace on its initialization screen", async ({ page, crp }) => {
  let releaseCharts;
  const chartGate = new Promise((resolve) => { releaseCharts = resolve; });
  const chartRequests = [];
  await page.route("**/api/v1/metrics/**", async (route) => {
    chartRequests.push(new URL(route.request().url()).pathname);
    await chartGate;
    await route.continue();
  });
  try {
    await page.goto(`${crp.origin}/#token=${crp.controlToken}`);
    await expect(page.locator("html")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("link", { name: "Forwarding Records", exact: true })).toBeVisible();
    await expect.poll(() => chartRequests.length).toBe(2);
    expect(crp.calls.some((call) => call.operation === "getMetrics")).toBe(false);
    releaseCharts();
    await expect.poll(() => crp.calls.some((call) => call.operation === "getMetrics")).toBe(true);
    await expect.poll(() => crp.calls.some((call) => call.operation === "getTokenHeatmap")).toBe(true);
    await assertNoSecrets(page, crp);
  } finally {
    releaseCharts();
  }
});
