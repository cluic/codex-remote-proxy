import {
  assertLayoutIntegrity,
  assertNoSecrets,
  expect,
  openCrp,
  test
} from "./crp-ui-fixture.mjs";

test("traces the live model route and its conditional account fallback", async ({ page, crp }, testInfo) => {
  crp.seedProviders({
    providers: [
      {
        id: "provider-a",
        name: "Provider Alpha",
        baseUrl: crp.upstreamBaseUrl,
        weight: 100
      },
      {
        id: "provider-b",
        name: "Provider Beta",
        baseUrl: crp.upstreamBaseUrl,
        weight: 100,
        modelMappingGroupId: "mapping-sol",
        supportedModelsMode: "custom",
        supportedModels: ["vendor/gpt-5.6-sol"],
        customModels: ["vendor/gpt-5.6-sol"]
      }
    ],
    activeProviderId: "provider-a",
    generation: 8
  });
  crp.state.modelMappingGroups = [{
    id: "mapping-sol",
    name: "Provider Beta aliases",
    rules: [{ sourceModel: "gpt-5.6-sol", targetModel: "vendor/gpt-5.6-sol" }],
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-13T08:00:00.000Z"
  }];
  crp.state.routingRuleGroups = [{
    id: "routing-interactive",
    name: "Interactive workloads",
    rules: [{ models: ["gpt-5.6-sol"], providerIds: ["provider-b", "provider-a"] }],
    active: true,
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-13T08:00:00.000Z"
  }];
  crp.state.routingMode = "custom_only";

  await openCrp(page, crp);
  const board = page.locator(".route-preview-board");
  await expect(board).toBeVisible();
  await page.getByLabel("Inspect model").fill("gpt-5.6-sol");
  await expect(board.getByText("Live runtime")).toBeVisible();
  await expect(board.getByText("Custom route")).toBeVisible();

  const primaryLane = board.locator(".route-preview-primary-lane");
  await expect(primaryLane).toContainText("Interactive workloads");
  await expect(primaryLane).toContainText("Provider Beta");
  await expect(primaryLane).toContainText("Provider Beta aliases");
  await expect(primaryLane).toContainText("vendor/gpt-5.6-sol");
  const candidates = board.locator(".route-preview-candidate");
  await expect(candidates).toHaveCount(2);
  await expect(candidates.nth(0)).toContainText("#1");
  await expect(candidates.nth(0)).toContainText("Provider Beta");
  await expect(candidates.nth(1)).toContainText("#2");
  await expect(candidates.nth(1)).toContainText("Provider Alpha");
  expect(await board.locator(".route-path-connector").first().evaluate((element) => (
    getComputedStyle(element, "::after").animationName
  ))).toBe("route-pulse-x");

  const customScreenshot = testInfo.outputPath("route-preview-custom-1440x900.png");
  crp.registerAttachment(customScreenshot);
  await board.screenshot({ path: customScreenshot, animations: "disabled" });
  await testInfo.attach("route-preview-custom-1440x900", {
    path: customScreenshot,
    contentType: "image/png"
  });

  await page.locator(".overview-routing-segment input").check();
  await expect.poll(() => crp.state.routingMode).toBe("account_first");
  await expect(board.getByText("ChatGPT route")).toBeVisible();
  await expect(board.locator(".route-preview-primary-lane")).toContainText("ChatGPT account");
  const fallbackLane = board.locator(".route-preview-fallback-lane");
  await expect(fallbackLane).toBeVisible();
  await expect(fallbackLane).toContainText("Interactive workloads");
  await expect(fallbackLane).toContainText("Provider Beta aliases");

  const desktopScreenshot = testInfo.outputPath("route-preview-account-fallback-1440x900.png");
  crp.registerAttachment(desktopScreenshot);
  await board.screenshot({ path: desktopScreenshot, animations: "disabled" });
  await testInfo.attach("route-preview-account-fallback-1440x900", {
    path: desktopScreenshot,
    contentType: "image/png"
  });
  await assertLayoutIntegrity(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(board).toBeVisible();
  const connectorSize = await board.locator(".route-path-connector").first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(connectorSize.height).toBeGreaterThan(connectorSize.width);
  await assertLayoutIntegrity(page);
  const mobileScreenshot = testInfo.outputPath("route-preview-account-fallback-390x844.png");
  crp.registerAttachment(mobileScreenshot);
  await board.screenshot({ path: mobileScreenshot, animations: "disabled" });
  await testInfo.attach("route-preview-account-fallback-390x844", {
    path: mobileScreenshot,
    contentType: "image/png"
  });
  await assertNoSecrets(page, crp);
});
