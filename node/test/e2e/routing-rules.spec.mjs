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
    models: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]
  });
});

test("manages provider models and hot-applies per-model routing rules", async ({ page, crp }, testInfo) => {
  await openCrp(page, crp);
  await navigate(page, "Providers");

  await page.getByRole("button", { name: "View Provider Beta details" }).click();
  let dialog = page.getByRole("dialog", { name: "Provider Beta" });
  await dialog.getByRole("button", { name: "Manage models" }).click();
  dialog = page.getByRole("dialog", { name: "Provider model availability" });
  await dialog.getByLabel("Availability mode").selectOption("custom");
  await dialog.getByLabel("Supported model names").fill("gpt-5.6-luna\ngpt-5.6-sol");
  await dialog.getByRole("button", { name: "Apply model list" }).click();

  const providerB = crp.state.providers.find(({ id }) => id === "provider-b");
  expect(providerB.supportedModelsMode).toBe("custom");
  expect(providerB.supportedModels).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
  await expect(page.getByTestId("provider-card-provider-b")).toContainText("2 configured");
  await page.keyboard.press("Escape");

  await navigate(page, "Routing Rules");
  await expect(page.getByText("No routing rule groups")).toBeVisible();
  await page.getByRole("button", { name: "Add rule group" }).first().click();
  dialog = page.getByRole("dialog", { name: "Create routing rule group" });
  await dialog.getByLabel("Group name").fill("Sol and Luna split");

  const firstRule = dialog.locator(".routing-rule-card").nth(0);
  await firstRule.getByLabel("Requested model").fill("gpt-5.6-sol");
  await firstRule.getByLabel("Add provider to priority").selectOption("provider-a");
  await firstRule.getByLabel("Add provider to priority").selectOption("provider-b");

  await dialog.getByRole("button", { name: "Add model rule" }).click();
  const secondRule = dialog.locator(".routing-rule-card").nth(1);
  await secondRule.getByLabel("Requested model").fill("gpt-5.6-luna");
  await secondRule.getByLabel("Add provider to priority").selectOption("provider-b");
  await secondRule.getByLabel("Add provider to priority").selectOption("provider-a");
  await dialog.getByRole("button", { name: "Create group" }).click();

  await expect(page.getByRole("heading", { name: "Sol and Luna split", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText("Applied to new requests")).toBeVisible();
  expect(crp.state.routingRuleGroups[0].active).toBe(true);
  expect(crp.state.routingRuleGroups[0].rules).toEqual([
    { model: "gpt-5.6-sol", providerIds: ["provider-a", "provider-b"] },
    { model: "gpt-5.6-luna", providerIds: ["provider-b", "provider-a"] }
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
