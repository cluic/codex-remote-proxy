import { assertNoSecrets, expect, test } from "./crp-ui-fixture.mjs";

async function openRoute(page, crp, route = "overview") {
  await page.goto(`${crp.origin}/${route}#token=${crp.controlToken}`);
  await expect(page.locator("html")).toHaveAttribute("aria-busy", "false");
}

async function observeCspViolations(page) {
  await page.evaluate(() => {
    window.__crpCspViolations = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      window.__crpCspViolations.push({
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective
      });
    });
  });
}

async function cspViolations(page) {
  return await page.evaluate(() => window.__crpCspViolations ?? []);
}

test.beforeEach(async ({ crp }) => {
  crp.seedProviders({
    providers: [{ id: "provider-1", name: "Primary API", baseUrl: crp.upstreamBaseUrl }],
    activeProviderId: "provider-1"
  });
});

test("keeps one browser session and in-memory management state across Next Flight navigation", async ({ page, crp }) => {
  const sessionRequests = [];
  const unexpectedOrigins = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== crp.origin) unexpectedOrigins.push(url.origin);
    if (url.pathname === "/api/v1/session") sessionRequests.push(request);
  });

  await openRoute(page, crp);
  await observeCspViolations(page);
  await expect(page).toHaveURL(`${crp.origin}/overview`);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  const documentIdentity = await page.evaluate(() => {
    window.__crpDocumentIdentity ??= crypto.randomUUID();
    return window.__crpDocumentIdentity;
  });

  const flight = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/providers.txt"
      && response.status() === 200
      && response.headers()["content-type"]?.startsWith("text/x-component") === true
  ));
  await page.getByRole("link", { name: "Providers", exact: true }).click();
  await flight;
  await expect(page).toHaveURL(`${crp.origin}/providers`);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  expect(await page.evaluate(() => window.__crpDocumentIdentity)).toBe(documentIdentity);
  await page.goBack();
  await expect(page).toHaveURL(`${crp.origin}/overview`);
  expect(await page.evaluate(() => window.__crpDocumentIdentity)).toBe(documentIdentity);
  await page.goForward();
  await expect(page).toHaveURL(`${crp.origin}/providers`);
  expect(await page.evaluate(() => window.__crpDocumentIdentity)).toBe(documentIdentity);
  expect(sessionRequests).toHaveLength(1);
  expect(unexpectedOrigins).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
  await assertNoSecrets(page, crp);
});

test("hard reload without a fragment remains read-only and never resumes management automatically", async ({ page, crp }) => {
  const nonGetRequests = [];
  await openRoute(page, crp);
  const sessionCallsBeforeReload = crp.calls.filter((call) => call.operation === "session").length;
  page.on("request", (request) => {
    if (new URL(request.url()).origin === crp.origin && request.method() !== "GET") {
      nonGetRequests.push({ pathname: new URL(request.url()).pathname, method: request.method() });
    }
  });

  await page.goto(`${crp.origin}/overview`);
  await expect(page.locator("html")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("Read-only session", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore management", exact: true })).toBeVisible();
  expect(crp.calls.filter((call) => call.operation === "session")).toHaveLength(sessionCallsBeforeReload);
  expect(nonGetRequests).toEqual([]);
  await assertNoSecrets(page, crp);
});

test("Next route metadata never overrides the localized client title after navigation", async ({ page, crp }) => {
  await openRoute(page, crp, "setup");
  await expect(page).toHaveTitle("Set up Codex Remote Proxy | CRP");
  await page.locator("#locale-select").selectOption("zh-CN");
  await expect(page).toHaveTitle("设置 Codex Remote Proxy | CRP");
  await page.getByRole("link", { name: "概览", exact: true }).click();
  await expect(page).toHaveTitle("概览 | CRP");
  await assertNoSecrets(page, crp);
});

test("mobile navigation opens and closes without CSP violations or stale focus restoration", async ({ page, crp }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRoute(page, crp);
  await observeCspViolations(page);
  const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
  await trigger.click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "Close navigation", exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await cspViolations(page)).toEqual([]);
  await assertNoSecrets(page, crp);
});

test("Base UI tooltip and dropdown keep their portal interactions inside the strict CSP", async ({ page, crp }) => {
  await openRoute(page, crp);
  await observeCspViolations(page);
  const refresh = page.getByRole("button", { name: "Refresh status", exact: true });
  await refresh.hover();
  await expect(page.locator("[data-slot='tooltip-content']")).toHaveText("Refresh status");
  const more = page.getByRole("button", { name: "More console actions", exact: true });
  await more.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "System", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  expect(await cspViolations(page)).toEqual([]);
  await assertNoSecrets(page, crp);
});
