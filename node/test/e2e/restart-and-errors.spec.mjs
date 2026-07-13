import { test, expect, openCrp, assertNoSecrets } from "./crp-ui-fixture.mjs";
import { randomBytes } from "node:crypto";

test.beforeEach(async ({ crp }) => {
  crp.seedProviders({
    providers: [
      { id: "provider-a", name: "Provider Alpha", baseUrl: crp.upstreamBaseUrl },
      { id: "provider-b", name: "Provider Beta", baseUrl: crp.upstreamBaseUrl }
    ],
    activeProviderId: "provider-a"
  });
});

test("restarts immediately at zero in-flight requests and keeps the supervisor stable", async ({ page, crp }) => {
  await openCrp(page, crp);
  const originalWorkerPid = crp.state.worker.pid;
  const supervisorPid = crp.state.supervisorPid;
  await page.getByRole("button", { name: "Restart worker" }).click();
  await expect(page.getByRole("dialog", { name: "Restart worker?" })).toBeHidden();
  await expect(page.getByRole("status")).toContainText("Worker restarted");
  expect(crp.state.worker.pid).not.toBe(originalWorkerPid);
  expect(crp.state.supervisorPid).toBe(supervisorPid);
});

test("warns before restarting with in-flight work and restores trigger focus", async ({ page, crp }) => {
  crp.setInFlight(3);
  await openCrp(page, crp);
  const restart = page.getByRole("button", { name: "Restart worker" });
  await restart.click();
  const dialog = page.getByRole("dialog", { name: "Restart worker?" });
  await expect(dialog).toContainText("3 requests are still in flight");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(restart).toBeFocused();
  expect(crp.calls.filter((call) => call.operation === "restartProxy")).toHaveLength(0);

  await restart.click();
  await dialog.getByRole("button", { name: "Restart anyway" }).click();
  await expect(page.getByRole("status")).toContainText("Worker restarted");
  expect(crp.calls.filter((call) => call.operation === "restartProxy")).toHaveLength(1);
});

test("maps provider authentication failures to actionable copy in both locales", async ({ page, crp }) => {
  crp.failProviderTestsWith("PROVIDER_TEST_AUTH");
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  await page.getByRole("button", { name: "Test Provider Beta" }).click();
  const testDialog = page.getByRole("dialog", { name: "Test provider" });
  await testDialog.getByLabel("Test model").fill("gpt-5.1-codex-mini");
  await testDialog.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByText("Provider authentication failed")).toBeVisible();
  await expect(page.getByText("Check the API key and authorization scheme, then test again.")).toBeVisible();

  await page.locator("#locale-select").selectOption("zh-CN");
  await page.getByRole("button", { name: "测试 Provider Beta" }).click();
  const zhDialog = page.getByRole("dialog", { name: "测试提供商" });
  await zhDialog.getByLabel("测试模型").fill("gpt-5.1-codex-mini");
  await zhDialog.getByRole("button", { name: "运行测试" }).click();
  await expect(page.getByText("提供商认证失败")).toBeVisible();
  await expect(page.getByText("请检查 API 密钥和认证方案，然后重新测试。")).toBeVisible();
  await assertNoSecrets(page, crp);
});

test("folds localized allowlisted technical error details without raw reasons", async ({ page, crp }) => {
  await page.route("**/api/v1/diagnostics/export", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "WORKER_BUSY",
          requestId: "req-safe-42",
          details: {
            field: "proxy",
            reason: "Internal daemon exploded in English",
            committed: true,
            degraded: false,
            generation: 7,
            httpStatus: 409,
            ignored: "must-not-render"
          }
        }
      })
    });
  });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Export diagnostics" }).click();
  const alert = page.getByRole("alert");
  const technical = alert.locator("details");
  await expect(technical).not.toHaveAttribute("open", "");
  await expect(technical.locator("summary")).toHaveText("Technical details");
  await technical.locator("summary").click();
  await expect(technical).toContainText("Error code");
  await expect(technical).toContainText("WORKER_BUSY");
  await expect(technical).toContainText("Request ID");
  await expect(technical).toContainText("req-safe-42");
  await expect(technical).toContainText("Field");
  await expect(technical).toContainText("Generation");
  await expect(technical).toContainText("HTTP status");
  await expect(alert).not.toContainText("Internal daemon exploded in English");
  await expect(alert).not.toContainText("must-not-render");

  await page.locator("#locale-select").selectOption("zh-CN");
  const translated = page.getByRole("alert").locator("details");
  await expect(translated.locator("summary")).toHaveText("技术详情");
  await translated.locator("summary").click();
  await expect(translated).toContainText("错误代码");
  await expect(translated).toContainText("请求 ID");
  await expect(translated).toContainText("字段");
  await expect(translated).toContainText("代次");
  await expect(translated).toContainText("HTTP 状态");
  await assertNoSecrets(page, crp);
});

test("detects a secret in raw API response bytes before display redaction", async ({ page, crp }) => {
  const reflected = `response-${randomBytes(18).toString("base64url")}`;
  await page.route("**/api/v1/diagnostics/export", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        diagnostics: {
          created: true,
          generatedAt: "2026-07-13T08:50:00.000Z",
          eventCount: 0
        },
        credential: reflected
      })
    });
  });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Export diagnostics" }).click();
  await expect(page.locator("#main-content").getByText("Diagnostics exported", { exact: true })).toBeVisible();
  await crp.collectors.flush();
  const displayRecord = crp.collectors.records.findLast((record) => (
    record.type === "response" && record.url === "/api/v1/diagnostics/export"
  ));
  expect(displayRecord?.body).toContain('"credential":"[redacted]"');
  await expect(assertNoSecrets(page, crp, [reflected])).rejects.toThrow(
    "Raw API response contained sensitive data outside the session exchange."
  );
});

test("renders migration rollback degraded errors as stop-and-repair guidance in both locales", async ({ page, crp }) => {
  await page.route("**/api/v1/diagnostics/export", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "MIGRATION_ROLLBACK_DEGRADED",
          requestId: "req-degraded",
          details: { degraded: true, committed: false }
        }
      })
    });
  });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Export diagnostics" }).click();
  await expect(page.getByText("CRP state needs repair")).toBeVisible();
  await expect(page.getByText("Stop CRP, review Activity, and repair local state before any further operation.")).toBeVisible();
  await expect(page.getByText("CRP could not complete the operation")).toHaveCount(0);
  await page.locator("#locale-select").selectOption("zh-CN");
  await expect(page.getByText("CRP 状态需要修复")).toBeVisible();
  await expect(page.getByText("请停止 CRP、查看活动记录并修复本地状态，然后再执行任何操作。")).toBeVisible();
});

test("terminates after a real second session exchange makes the open tab CSRF stale", async ({ page, crp }) => {
  const mutationRequests = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === "/api/v1/providers/provider-b") {
      mutationRequests.push(request);
    }
  });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  await page.getByRole("button", { name: "Edit Provider Beta" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit provider" });
  await dialog.getByLabel("Provider name").fill("Stale tab edit");
  await dialog.getByLabel("Replacement API key").fill(crp.credential);
  expect(await crp.rotateBrowserSession(page)).toEqual({ status: 200, csrfTokenLength: 43 });
  const rejected = page.waitForResponse((response) => (
    response.request().method() === "PATCH"
      && new URL(response.url()).pathname === "/api/v1/providers/provider-b"
  ));
  await dialog.getByRole("button", { name: "Save changes" }).click();
  const response = await rejected;
  expect(response.status()).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ error: { code: "AUTH_CSRF_INVALID" } });
  await expect(page.locator("#session-root")).toBeVisible();
  await expect(page.locator("#app-root")).toBeHidden();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.waitForTimeout(250);
  expect(mutationRequests).toHaveLength(1);
  await assertNoSecrets(page, crp);
});

for (const status of [500, 403]) {
  test(`treats a ${status} session exchange failure as terminal even with a valid cookie`, async ({ page, crp }) => {
    await openCrp(page, crp);
    const apiRequests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/")) {
        apiRequests.push({ method: request.method(), path: url.pathname });
      }
    });
    await page.route("**/api/v1/session", async (route) => {
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "INTERNAL_ERROR", requestId: `req-exchange-${status}`, details: {} }
        })
      });
    }, { times: 1 });

    await page.goto(`${crp.origin}/?exchange=${status}#token=${crp.controlToken}`);
    await expect(page.locator("html")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#session-root")).toBeVisible();
    await expect(page.locator("#app-root")).toBeHidden();
    await expect(page.locator("#onboarding-root")).toBeHidden();
    expect(apiRequests).toEqual([{ method: "POST", path: "/api/v1/session" }]);
    await assertNoSecrets(page, crp);
  });
}

test("renders real failed and degraded activity without green or raw fallback keys", async ({ page, crp }) => {
  crp.state.activities = [
    { timestamp: "2026-07-13T08:00:05.000Z", category: "proxy", action: "start", providerId: "provider-a", result: "success", errorCode: null, details: {} },
    { timestamp: "2026-07-13T08:00:04.000Z", category: "proxy", action: "stop", providerId: "provider-a", result: "failed", errorCode: "WORKER_STOP_FAILED", details: {} },
    { timestamp: "2026-07-13T08:00:03.000Z", category: "proxy", action: "restart", providerId: "provider-a", result: "degraded", errorCode: "WORKER_RESTART_DEGRADED", details: {} },
    { timestamp: "2026-07-13T08:00:02.000Z", category: "provider", action: "update", providerId: "provider-b", result: "failed", errorCode: "PROVIDER_UPDATE_FAILED", details: {} },
    { timestamp: "2026-07-13T08:00:01.000Z", category: "migration", action: "legacy-config", providerId: null, result: "failed", errorCode: "MIGRATION_ROLLBACK_DEGRADED", details: { rollbackDegraded: true } }
  ];
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page.getByText("Proxy started")).toBeVisible();
  await expect(page.getByText("Proxy stopped")).toBeVisible();
  await expect(page.getByText("Worker restarted")).toBeVisible();
  await expect(page.getByText("Provider updated")).toBeVisible();
  await expect(page.getByText("Legacy configuration migration")).toBeVisible();
  await expect(page.locator(".activity-result.is-failure")).toHaveCount(3);
  await expect(page.locator(".activity-result.is-degraded")).toHaveCount(1);
  const migration = page.locator(".activity-row").filter({ hasText: "Legacy configuration migration" });
  await expect(migration.locator(".activity-result.is-failure")).toHaveText("Failed");
  await expect(migration.getByText("Stop CRP and review Activity before making more changes.")).toBeVisible();
  await expect(page.getByText(/activity\.(start|stop|restart|legacy-config)/)).toHaveCount(0);
  const degradedRows = page.locator(".activity-row").filter({ has: page.locator(".activity-result.is-degraded") });
  await expect(degradedRows.getByText("Complete")).toHaveCount(0);
});

test("fails closed after session expiry without retrying authentication", async ({ page, crp }) => {
  const sessionRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/session") sessionRequests.push(request);
  });
  await openCrp(page, crp);
  expect(sessionRequests).toHaveLength(1);

  crp.expireSession();
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Session expired")).toBeVisible();
  await expect(page.getByText("Run crp ui again to make changes.")).toBeVisible();
  await expect(page.locator("#session-root")).toBeVisible();
  await expect(page.locator("#app-root")).toBeHidden();
  await expect(page.locator("#onboarding-root")).toBeHidden();
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.locator(".session-terminal .eyebrow")).toHaveText("CRP / SESSION");
  await page.evaluate(() => {
    const locale = document.querySelector("#locale-select");
    locale.value = "zh-CN";
    locale.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator(".session-terminal .eyebrow")).toHaveText("CRP / 会话");
  await page.waitForTimeout(250);
  expect(sessionRequests).toHaveLength(1);
});

test("clears an open replacement credential when the session expires", async ({ page, crp }) => {
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  await page.getByRole("button", { name: "Edit Provider Beta" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit provider" });
  await dialog.getByLabel("Replacement API key").fill(crp.credential);
  crp.expireSession();
  await dialog.getByRole("button", { name: "Save changes" }).click();

  await expect(page.locator("#session-root")).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveCount(0);
  await assertNoSecrets(page, crp);
});

test("supports keyboard navigation, live announcements, diagnostics, and 1024px layout", async ({ page, crp }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openCrp(page, crp);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  await page.getByRole("link", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Export diagnostics" }).click();
  await expect(page.getByRole("status")).toContainText("Diagnostics exported");
  expect(crp.calls.filter((call) => call.operation === "diagnostics")).toHaveLength(1);
  const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasOverflow).toBe(false);
  await assertNoSecrets(page, crp);
});
