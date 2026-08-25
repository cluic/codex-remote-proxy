import {
  assertLayoutIntegrity,
  assertNoSecrets,
  expect,
  openCrp,
  test
} from "./crp-ui-fixture.mjs";

test.beforeEach(async ({ crp }) => {
  crp.seedProviders({
    providers: [{ id: "provider-a", name: "Provider Alpha", baseUrl: crp.upstreamBaseUrl }],
    activeProviderId: null
  });
});

test("manages write-only client keys and locks authentication for public listening", async ({
  page,
  crp
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "System" }).click();

  const authToggle = page.getByRole("checkbox", { name: "Require client API keys" });
  await expect(authToggle).not.toBeChecked();
  const listenAddress = page.getByRole("combobox", { name: "Proxy listen address" });
  await expect(listenAddress).toHaveValue("127.0.0.1");

  await page.getByRole("button", { name: "Add API key" }).click();
  const editor = page.getByRole("dialog", { name: "Add client API key" });
  await editor.getByLabel("Name").fill("Automation");
  await editor.getByRole("button", { name: "Generate key" }).click();
  const secretInput = editor.getByLabel("API key value");
  const generatedSecret = await secretInput.inputValue();
  expect(generatedSecret).toMatch(/^crp_[A-Za-z0-9_-]{43}$/);
  crp.registerSecret(generatedSecret);
  await editor.getByLabel("Expires").fill("2030-01-01T12:00");
  await editor.getByLabel("Request limit").fill("2");

  const inputBox = await secretInput.boundingBox();
  const buttonBox = await editor.getByRole("button", { name: "Generate key" }).boundingBox();
  expect(inputBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox.y).toBe(inputBox.y);
  expect(buttonBox.height).toBe(inputBox.height);

  let releaseRequest;
  let markRequestStarted;
  const requestStarted = new Promise((resolvePromise) => { markRequestStarted = resolvePromise; });
  const requestRelease = new Promise((resolvePromise) => { releaseRequest = resolvePromise; });
  await page.route("**/api/v1/access-keys", async (route) => {
    if (route.request().method() === "POST") {
      markRequestStarted();
      await requestRelease;
    }
    await route.continue();
  });
  await editor.getByRole("button", { name: "Add API key" }).click();
  await requestStarted;
  await expect(secretInput).toHaveValue("");
  releaseRequest();
  await expect(editor).toBeHidden();

  const row = page.locator(".access-key-table tbody tr").filter({ hasText: "Automation" });
  await expect(row).toContainText("0 / 2");
  await expect(row).toContainText("Active");
  await expect(row).not.toContainText(generatedSecret);
  expect(crp.state.accessKeys[0].expiresAt).not.toBeNull();

  await row.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit client API key" });
  await edit.getByLabel("Name").fill("Automation revised");
  await edit.getByLabel("Request limit").fill("5");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText("Automation revised");
  await expect(row).toContainText("0 / 5");

  await row.getByRole("button", { name: "Disable API key" }).click();
  await expect(row).toContainText("Disabled");
  await row.getByRole("button", { name: "Enable API key" }).click();
  await expect(row).toContainText("Active");

  await authToggle.check();
  await expect(authToggle).toBeChecked();
  await listenAddress.selectOption("0.0.0.0");
  await expect(listenAddress).toHaveValue("0.0.0.0");
  await expect(authToggle).toBeChecked();
  await expect(authToggle).toBeDisabled();
  await expect(page.getByText("Required while listening on 0.0.0.0 and cannot be disabled.")).toBeVisible();

  await assertLayoutIntegrity(page);
  await assertNoSecrets(page, crp, [generatedSecret]);
  const screenshotPath = testInfo.outputPath("system-access-keys-1440x900.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach("system-access-keys-1440x900", {
    path: screenshotPath,
    contentType: "image/png"
  });

  await row.getByRole("button", { name: "Delete" }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete API key?" });
  await expect(confirmation).toContainText("Automation revised will stop authorizing requests immediately");
  await confirmation.getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
  expect(crp.state.accessKeys).toEqual([]);
  expect(crp.calls.filter((call) => call.operation === "createAccessKey")).toEqual([
    { operation: "createAccessKey", id: "access-key-1", name: "Automation" }
  ]);
  expect(crp.calls.filter((call) => call.operation === "updateAccessKey")).toEqual([
    {
      operation: "updateAccessKey",
      id: "access-key-1",
      patch: { name: "Automation revised", requestLimit: 5 }
    },
    { operation: "updateAccessKey", id: "access-key-1", patch: { enabled: false } },
    { operation: "updateAccessKey", id: "access-key-1", patch: { enabled: true } }
  ]);
});
