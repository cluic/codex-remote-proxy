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
});

test("creates, assigns, and edits an exact model mapping group", async ({ page, crp }, testInfo) => {
  const mutations = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.pathname === "/api/v1/model-mappings" && request.method() === "POST")
      || (url.pathname === "/api/v1/model-mappings/mapping-1" && request.method() === "PATCH")
      || (url.pathname === "/api/v1/providers/provider-b" && request.method() === "PATCH")) {
      mutations.push({
        method: request.method(),
        path: url.pathname,
        body: request.postDataJSON()
      });
    }
  });

  await openCrp(page, crp);
  await navigate(page, "Model Mappings");
  await expect(page.getByText("No model mapping groups")).toBeVisible();
  await page.getByRole("button", { name: "Add mapping group" }).first().click();

  const createDialog = page.getByRole("dialog", { name: "Create mapping group" });
  await createDialog.getByLabel("Group name").fill("OpenRouter");
  await createDialog.getByLabel("Requested model for rule 1").fill("gpt-5");
  await createDialog.getByLabel("Upstream model for rule 1").fill("openai/gpt-5");
  await createDialog.getByRole("button", { name: "Create group" }).click();

  await expect(page.getByRole("heading", { name: "OpenRouter", level: 2 })).toBeVisible();
  await expect(page.locator(".mapping-rules-table")).toContainText("gpt-5");
  await expect(page.locator(".mapping-rules-table")).toContainText("openai/gpt-5");
  expect(crp.calls.findLast((call) => call.operation === "createModelMappingGroup")).toEqual({
    operation: "createModelMappingGroup",
    input: {
      name: "OpenRouter",
      rules: [{ sourceModel: "gpt-5", targetModel: "openai/gpt-5" }]
    }
  });

  await page.getByRole("button", { name: "Stop proxy" }).click();
  await expect.poll(() => crp.state.worker.phase).toBe("stopped");
  await navigate(page, "Providers");
  await page.getByRole("button", { name: "View Provider Beta details" }).click();
  const details = page.getByRole("dialog", { name: "Provider Beta" });
  await details.getByRole("button", { name: "Edit Provider Beta" }).click();

  const editProvider = page.getByRole("dialog", { name: "Edit provider" });
  await editProvider.getByLabel("Model mapping group").selectOption({ label: "OpenRouter" });
  await editProvider.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("provider-card-provider-b")).toContainText("Mapping: OpenRouter");
  expect(crp.state.providers.find(({ id }) => id === "provider-b")?.modelMappingGroupId).toBe("mapping-1");

  await navigate(page, "Model Mappings");
  await expect(page.locator(".mapping-assignment-strip")).toContainText("Provider Beta");
  await page.locator(".mapping-detail-actions").getByRole("button", { name: "Edit" }).click();
  const editMapping = page.getByRole("dialog", { name: "Edit mapping group" });
  await editMapping.getByLabel("Upstream model for rule 1").fill("openai/gpt-5.1");
  await editMapping.getByRole("button", { name: "Save" }).click();

  await expect(page.locator(".mapping-rules-table")).toContainText("openai/gpt-5.1");
  await expect(page.locator(".mapping-detail-actions").getByRole("button", { name: "Delete" })).toBeDisabled();
  expect(mutations).toEqual([
    {
      method: "POST",
      path: "/api/v1/model-mappings",
      body: {
        mappingGroup: {
          name: "OpenRouter",
          rules: [{ sourceModel: "gpt-5", targetModel: "openai/gpt-5" }]
        }
      }
    },
    {
      method: "PATCH",
      path: "/api/v1/providers/provider-b",
      body: {
        patch: {
          name: "Provider Beta",
          baseUrl: crp.upstreamBaseUrl,
          authHeader: "authorization",
          authScheme: "Bearer",
          extraHeaders: {},
          weight: 100,
          modelMode: "passthrough",
          modelOverride: null,
          modelMappingGroupId: "mapping-1"
        }
      }
    },
    {
      method: "PATCH",
      path: "/api/v1/model-mappings/mapping-1",
      body: {
        mappingGroup: {
          name: "OpenRouter",
          rules: [{ sourceModel: "gpt-5", targetModel: "openai/gpt-5.1" }]
        }
      }
    }
  ]);

  await assertLayoutIntegrity(page);
  await assertNoSecrets(page, crp);
  await page.getByTestId("global-message").getByRole("button", { name: "Close" }).click();
  const screenshotPath = testInfo.outputPath("model-mappings-1440x900.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach("model-mappings-1440x900", { path: screenshotPath, contentType: "image/png" });
});
