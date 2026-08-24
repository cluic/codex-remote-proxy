import {
  assertLayoutIntegrity,
  assertNoSecrets,
  expect,
  openCrp,
  test
} from "./crp-ui-fixture.mjs";

async function navigate(page, name) {
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
  crp.seedProviderModels("provider-b", {
    models: ["M1", "M2", "M3", "M4", "M5"]
  });
});

test("manages provider model paths and states and groups many models into two routing rules", async ({ page, crp }, testInfo) => {
  await openCrp(page, crp);
  await navigate(page, "Providers");

  await page.getByRole("button", { name: "View Provider Beta details" }).click();
  let dialog = page.getByRole("dialog", { name: "Provider Beta" });
  await dialog.getByRole("button", { name: "Manage models" }).click();
  dialog = page.getByRole("dialog", { name: "Provider model availability" });
  await expect(dialog.getByText("5 enabled of 5")).toBeVisible();

  const [addModelInputBox, addModelButtonBox] = await Promise.all([
    dialog.getByLabel("Add a model name").boundingBox(),
    dialog.getByRole("button", { name: "Add model", exact: true }).boundingBox()
  ]);
  expect(addModelInputBox).not.toBeNull();
  expect(addModelButtonBox).not.toBeNull();
  expect(addModelButtonBox.y).toBe(addModelInputBox.y);
  expect(addModelButtonBox.height).toBe(addModelInputBox.height);

  const modelM2 = dialog.locator(".model-management-row").filter({ hasText: "M2" });
  await modelM2.getByRole("checkbox").uncheck();
  await dialog.getByLabel("Add a model name").fill("custom-temporary");
  await dialog.getByRole("button", { name: "Add model", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete custom model custom-temporary" }).click();
  await dialog.getByLabel("Add a model name").fill("M6");
  await dialog.getByRole("button", { name: "Add model", exact: true }).click();
  await expect(dialog.getByText("Save changes before refreshing")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Refresh models" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Save model settings" }).click();

  const providerB = crp.state.providers.find(({ id }) => id === "provider-b");
  expect(providerB.supportedModelsMode).toBe("auto");
  expect(providerB.supportedModels).toEqual(["M2"]);
  expect(providerB.customModels).toEqual(["M6"]);
  await expect(page.getByTestId("provider-card-provider-b")).toContainText("new discoveries enabled · 1 custom");

  const modelScreenshotPath = testInfo.outputPath("provider-models-1440x900.png");
  await page.screenshot({ path: modelScreenshotPath, fullPage: true });
  await testInfo.attach("provider-models-1440x900", {
    path: modelScreenshotPath,
    contentType: "image/png"
  });

  await dialog.getByLabel("Models endpoint path").fill("/catalog/models");
  await expect(dialog.getByText("Save changes before refreshing")).toBeVisible();
  await dialog.getByRole("button", { name: "Save model settings" }).click();
  expect(providerB.modelsPath).toBe("/catalog/models");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.keyboard.press("Escape");

  await navigate(page, "Routing Rules");
  await expect(page.getByText("No routing rule groups")).toBeVisible();
  await page.getByRole("button", { name: "Add rule group" }).first().click();
  dialog = page.getByRole("dialog", { name: "Create routing rule group" });
  await dialog.getByLabel("Group name").fill("Five-model split");

  const firstRule = dialog.locator(".routing-rule-card").nth(0);
  await firstRule.getByLabel("Add model names").fill("M1, M3, M5");
  await firstRule.getByLabel("Add model names").press("Enter");
  await firstRule.getByLabel("Add provider to priority").selectOption("provider-a");
  await firstRule.getByLabel("Add provider to priority").selectOption("provider-b");

  await dialog.getByRole("button", { name: "Add model rule" }).click();
  const secondRule = dialog.locator(".routing-rule-card").nth(1);
  await secondRule.getByLabel("Add model names").fill("M2, M4");
  await secondRule.getByLabel("Add model names").press("Enter");
  await secondRule.getByLabel("Add provider to priority").selectOption("provider-b");
  await secondRule.getByLabel("Add provider to priority").selectOption("provider-a");
  await dialog.getByRole("button", { name: "Create group" }).click();

  await expect(page.getByRole("heading", { name: "Five-model split", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText("Applied to new requests")).toBeVisible();
  expect(crp.state.routingRuleGroups[0].active).toBe(true);
  expect(crp.state.routingRuleGroups[0].rules).toEqual([
    { models: ["M1", "M3", "M5"], providerIds: ["provider-a", "provider-b"] },
    { models: ["M2", "M4"], providerIds: ["provider-b", "provider-a"] }
  ]);

  const generationBeforeEdit = crp.state.generation;
  await page.locator(".routing-detail-actions").getByRole("button", { name: "Edit" }).click();
  dialog = page.getByRole("dialog", { name: "Edit routing rule group" });
  await dialog.getByLabel("Group name").fill("Production model split");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Production model split", level: 2 })).toBeVisible();
  expect(crp.state.generation).toBeGreaterThan(generationBeforeEdit);

  await navigate(page, "Activity");
  await expect(page.locator(".activity-event").first()).toContainText("Routing rule group updated");
  await navigate(page, "Routing Rules");

  await assertLayoutIntegrity(page);
  await assertNoSecrets(page, crp);
  const screenshotPath = testInfo.outputPath("routing-rules-1440x900.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach("routing-rules-1440x900", {
    path: screenshotPath,
    contentType: "image/png"
  });
});
