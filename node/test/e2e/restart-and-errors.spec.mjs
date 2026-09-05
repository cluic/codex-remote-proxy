import { randomBytes } from "node:crypto";

import { assertLayoutIntegrity, assertNoSecrets, expect, openCrp, test } from "./crp-ui-fixture.mjs";

async function openProviderTest(page, name) {
  await page.getByRole("button", { name: `Test ${name}` }).click();
  const dialog = page.getByRole("dialog", { name: "Test provider" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openInactiveProviderEditor(page, name) {
  await page.getByRole("button", { name: `View ${name} details` }).click();
  const details = page.getByRole("dialog", { name });
  await details.getByRole("button", { name: `Edit ${name}` }).click();
  const editor = page.getByRole("dialog", { name: "Edit provider" });
  await expect(editor).toBeVisible();
  return editor;
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

test("restarts immediately at zero in-flight requests and keeps the supervisor stable", async ({ page, crp }) => {
  await openCrp(page, crp);
  const originalWorkerPid = crp.state.worker.pid;
  const supervisorPid = crp.state.supervisorPid;
  const commandBarY = await page.locator(".overview-command-bar").evaluate((element) => element.getBoundingClientRect().y);
  await page.getByRole("button", { name: "Restart worker" }).click();
  await expect(page.getByRole("status")).toContainText("Worker restarted");
  await expect(page.getByTestId("global-message")).toHaveCSS("position", "fixed");
  expect(await page.locator(".overview-command-bar").evaluate((element) => element.getBoundingClientRect().y)).toBe(commandBarY);
  expect(crp.state.worker.pid).not.toBe(originalWorkerPid);
  expect(crp.state.supervisorPid).toBe(supervisorPid);
  expect(crp.calls.filter((call) => call.operation === "restartProxy")).toHaveLength(1);
});

test("warns before restarting in-flight work and restores the trigger focus", async ({ page, crp }) => {
  crp.setInFlight(3);
  await openCrp(page, crp);
  const restart = page.getByRole("button", { name: "Restart worker" });
  await restart.click();
  const dialog = page.getByRole("dialog", { name: "Restart worker?" });
  await expect(dialog).toContainText("3 requests are currently in flight");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(restart).toBeFocused();
  expect(crp.calls.filter((call) => call.operation === "restartProxy")).toHaveLength(0);

  await restart.click();
  await dialog.getByRole("button", { name: "Restart anyway" }).click();
  await expect(page.getByRole("status")).toContainText("Worker restarted");
  expect(crp.calls.filter((call) => call.operation === "restartProxy")).toHaveLength(1);
});

test("returns focus to the mobile menu after cancelling an in-flight restart", async ({ page, crp }) => {
  crp.setInFlight(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await openCrp(page, crp);
  const menu = page.getByRole("button", { name: "Open navigation" });
  await menu.click();
  const drawer = page.getByRole("dialog", { name: "Primary navigation" });
  await drawer.getByRole("button", { name: "Restart worker" }).click();
  await expect(drawer).toBeHidden();
  const confirmation = page.getByRole("dialog", { name: "Restart worker?" });
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(menu).toBeFocused();
  expect(crp.calls.filter((call) => call.operation === "restartProxy")).toHaveLength(0);
});

test("stops and starts only the worker with exact empty request bodies", async ({ page, crp }) => {
  const requests = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/proxy/stop" || path === "/api/v1/proxy/start") {
      requests.push({ path, body: request.postData(), contentType: request.headers()["content-type"] });
    }
  });
  await openCrp(page, crp);
  await page.getByRole("button", { name: "Stop proxy" }).click();
  const start = page.locator(".sidebar-worker-actions").getByRole("button", { name: "Start proxy" });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.locator(".sidebar-worker-actions").getByRole("button", { name: "Stop proxy" })).toBeEnabled();
  expect(requests.map((request) => request.path)).toEqual(["/api/v1/proxy/stop", "/api/v1/proxy/start"]);
  for (const request of requests) {
    expect(request.body).toBeNull();
    expect(request.contentType).toBeUndefined();
  }
  expect(crp.state.supervisorPid).toBe(7001);
});

test("keeps Exit CRP separate from worker controls and cancels safely on mobile", async ({ page, crp }) => {
  const shutdownRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/supervisor/shutdown") {
      shutdownRequests.push(request.method());
    }
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await openCrp(page, crp);
  const menu = page.getByRole("button", { name: "Open navigation" });
  await menu.click();
  const drawer = page.getByRole("dialog", { name: "Primary navigation" });
  const exit = drawer.getByRole("button", { name: "Exit CRP" });
  expect(await exit.evaluate((element) => element.closest(".sidebar-worker-actions") === null)).toBe(true);
  await exit.click();
  await expect(drawer).toBeHidden();
  const confirmation = page.getByRole("dialog", { name: "Exit CRP?" });
  await expect(confirmation).toContainText("The local console will go offline");
  await assertLayoutIntegrity(page);
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toBeHidden();
  await expect(menu).toBeFocused();
  expect(shutdownRequests).toEqual([]);
  expect(crp.calls.filter((call) => call.operation === "shutdownSupervisor")).toEqual([]);
});

test("submits the authenticated supervisor identity and enters a quiet shutdown terminal", async ({ page, crp }) => {
  const requests = [];
  const responses = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname !== "/api/v1/supervisor/shutdown") return;
    requests.push({
      method: request.method(),
      body: request.postDataJSON(),
      contentType: request.headers()["content-type"],
      csrfLength: request.headers()["x-crp-csrf"]?.length ?? 0
    });
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/v1/supervisor/shutdown") {
      responses.push(response.status());
    }
  });
  await openCrp(page, crp);
  await page.getByRole("button", { name: "Exit CRP" }).click();
  const confirmation = page.getByRole("dialog", { name: "Exit CRP?" });
  await confirmation.getByRole("button", { name: "Exit CRP" }).click();

  const stopped = page.getByTestId("supervisor-stopped");
  await expect(stopped.getByRole("heading", { name: "CRP is shutting down" })).toBeVisible();
  await expect(stopped).toContainText("The shutdown request was accepted");
  await expect(stopped).toContainText("You may close this page.");
  await expect(page.locator("#app-root")).toHaveCount(0);
  await expect.poll(() => crp.calls.filter((call) => call.operation === "shutdownSupervisor").length).toBe(1);
  expect(crp.state.supervisorShutdownAccepted).toBe(true);
  expect(requests).toEqual([{
    method: "POST",
    body: {
      supervisorPid: crp.backendStatus.supervisor.pid,
      startedAt: crp.backendStatus.supervisor.startedAt
    },
    contentType: "application/json",
    csrfLength: 43
  }]);
  expect(responses).toEqual([202]);
  expect(page.isClosed()).toBe(false);

  const apiRequestCount = requests.length;
  await stopped.getByLabel("Language").selectOption("zh-CN");
  await expect(stopped.getByRole("heading", { name: "CRP 正在关闭" })).toBeVisible();
  await expect(stopped).toContainText("关闭请求已被接受");
  await expect(stopped).toContainText("现在可以关闭此页面。");
  expect(requests).toHaveLength(apiRequestCount);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertLayoutIntegrity(page);
});

test("keeps supervisor shutdown unavailable in a read-only session", async ({ page, crp }) => {
  const shutdownRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/supervisor/shutdown") {
      shutdownRequests.push(request.method());
    }
  });
  await openCrp(page, crp);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#session-banner")).toContainText("Read-only session");
  await expect(page.getByRole("button", { name: "Exit CRP" })).toBeDisabled();
  expect(shutdownRequests).toEqual([]);
});

test("does not enter the stopped state when the supervisor identity changed", async ({ page, crp }) => {
  await openCrp(page, crp);
  crp.replaceSupervisorIdentity({
    pid: crp.backendStatus.supervisor.pid + 1,
    startedAt: crp.backendStatus.supervisor.startedAt
  });
  await page.getByRole("button", { name: "Exit CRP" }).click();
  const confirmation = page.getByRole("dialog", { name: "Exit CRP?" });
  await confirmation.getByRole("button", { name: "Exit CRP" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("CRP could not complete the operation");
  await alert.locator("summary").click();
  await expect(alert).toContainText("SUPERVISOR_IDENTITY_CHANGED");
  await expect(page.locator("#app-root")).toBeVisible();
  await expect(page.getByTestId("supervisor-stopped")).toHaveCount(0);
  expect(crp.state.supervisorShutdownAccepted).toBe(false);
  expect(crp.calls.filter((call) => call.operation === "shutdownSupervisor")).toEqual([]);
});

test("rejects a non-minimal shutdown acceptance without going offline", async ({ page, crp }) => {
  await page.route("**/api/v1/supervisor/shutdown", async (route) => {
    const identity = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        shutdown: {
          accepted: true,
          supervisorPid: identity.supervisorPid,
          startedAt: identity.startedAt,
          unexpected: true
        }
      })
    });
  });
  await openCrp(page, crp);
  await page.getByRole("button", { name: "Exit CRP" }).click();
  const confirmation = page.getByRole("dialog", { name: "Exit CRP?" });
  await confirmation.getByRole("button", { name: "Exit CRP" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("CRP could not complete the operation");
  await alert.locator("summary").click();
  await expect(alert).toContainText("INTERNAL_ERROR");
  await expect(page.locator("#app-root")).toBeVisible();
  await expect(page.getByTestId("supervisor-stopped")).toHaveCount(0);
  expect(crp.state.supervisorShutdownAccepted).toBe(false);
});

test("projects real transitional and recovery phases in the sidebar", async ({ page, crp }) => {
  await openCrp(page, crp);
  const runtime = page.locator(".sidebar-runtime");
  for (const [phase, label] of [
    ["draining", "Stopping"],
    ["crashed", "Failed"],
    ["backoff", "Recovering"]
  ]) {
    crp.state.worker.phase = phase;
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(runtime).toContainText(label);
  }
});

test("maps provider authentication failures to actionable copy in both locales", async ({ page, crp }) => {
  crp.failProviderTestsWith("PROVIDER_TEST_AUTH");
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  await page.getByRole("button", { name: "View Provider Beta details" }).click();
  let details = page.getByRole("dialog", { name: "Provider Beta" });
  await details.getByRole("button", { name: "Test", exact: true }).click();
  let testDialog = page.getByRole("dialog", { name: "Test provider" });
  await testDialog.getByLabel("Test model").fill("gpt-5.1-codex-mini");
  await testDialog.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByText("Provider authentication failed")).toBeVisible();
  await expect(page.getByText("Check the API key and authorization scheme, then test again.")).toBeVisible();
  await testDialog.getByRole("button", { name: "Cancel" }).click();

  await page.locator("#locale-select").selectOption("zh-CN");
  await page.getByTestId("provider-card-provider-b").getByRole("button", { name: "测试并设为首选" }).click();
  testDialog = page.getByRole("dialog", { name: "测试提供商" });
  await testDialog.getByLabel("测试模型").fill("gpt-5.1-codex-mini");
  await testDialog.getByRole("button", { name: "测试并设为首选" }).click();
  await expect(page.getByText("提供商认证失败")).toBeVisible();
  await expect(page.getByText("请检查 API 密钥和认证方案，然后重新测试。")).toBeVisible();
  expect(crp.state.activeProviderId).toBe("provider-a");
  await assertNoSecrets(page, crp);
});

test("accepts the minimal production Responses shape", async ({ page, crp }) => {
  crp.setUpstreamResponsePayload({ id: "resp-minimal", object: "response", output: [] });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "Providers" }).click();
  const dialog = await openProviderTest(page, "Provider Alpha");
  await dialog.getByLabel("Test model").fill("gpt-5.1-codex-mini");
  await dialog.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByRole("status")).toContainText("Provider is compatible");
  expect(crp.state.providers.find((provider) => provider.id === "provider-a")?.lastTestStatus).toBe("passed");
  expect(crp.upstreamRequests.at(-1)?.responseShapeValid).toBe(true);
});

for (const [label, payload] of [
  ["empty response id", { id: "", object: "response", status: "completed", output: [] }],
  ["wrong response object", { id: "resp-wrong", object: "chat.completion", status: "completed", output: [] }]
]) {
  test(`rejects a Responses payload with ${label}`, async ({ page, crp }) => {
    crp.setUpstreamResponsePayload(payload);
    await openCrp(page, crp);
    await page.getByRole("link", { name: "Providers" }).click();
    const dialog = await openProviderTest(page, "Provider Alpha");
    await dialog.getByLabel("Test model").fill("gpt-5.1-codex-mini");
    await dialog.getByRole("button", { name: "Run test" }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("CRP could not complete the operation");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await alert.locator("summary").click();
    await expect(alert).toContainText("PROVIDER_TEST_INVALID_RESPONSES");
    expect(crp.state.providers.find((provider) => provider.id === "provider-a")).toMatchObject({
      lastTestStatus: "failed",
      lastTestCode: "PROVIDER_TEST_INVALID_RESPONSES"
    });
    expect(crp.upstreamRequests.at(-1)?.responseShapeValid).toBe(false);
  });
}

test("prepares Codex from System and reports bounded history-repair metadata", async ({ page, crp }) => {
  const requests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/codex/bootstrap") {
      requests.push({ body: request.postData(), contentType: request.headers()["content-type"] });
    }
  });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "System" }).click();
  await page.getByRole("button", { name: "Prepare Codex" }).click();
  const dialog = page.getByRole("dialog", { name: "Prepare Codex?" });
  await dialog.getByRole("button", { name: "Prepare Codex" }).click();
  await expect(page.getByText("History repair")).toBeVisible();
  await expect(page.getByText("No provider metadata repair was required")).toBeVisible();
  expect(requests).toEqual([{ body: null, contentType: undefined }]);
  expect(crp.state.bootstrapCount).toBe(1);
});

test("enables user-level start at login from System", async ({ page, crp }) => {
  const requests = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH"
      && new URL(request.url()).pathname === "/api/v1/settings") {
      requests.push(request.postDataJSON());
    }
  });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "System" }).click();
  const control = page.getByRole("checkbox", { name: "Start CRP at login" });
  await expect(control).not.toBeChecked();
  await control.check();
  await expect(control).toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: "Start at login enabled" })).toBeVisible();
  expect(requests).toEqual([{ autoStartEnabled: true }]);
  expect(crp.calls.findLast((call) => call.operation === "updateAutoStart")).toEqual({
    operation: "updateAutoStart",
    enabled: true
  });
});

test("folds allowlisted technical error details and omits unknown fields", async ({ page, crp }) => {
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
  await page.getByRole("link", { name: "System" }).click();
  await page.getByRole("button", { name: "Generate diagnostic summary" }).click();
  const alert = page.getByRole("alert");
  const technical = alert.locator("details");
  await expect(technical).not.toHaveAttribute("open", "");
  await technical.locator("summary").click();
  await expect(technical).toContainText("WORKER_BUSY");
  await expect(technical).toContainText("req-safe-42");
  await expect(technical).toContainText("proxy");
  await expect(technical).toContainText("7");
  await expect(technical).toContainText("409");
  await expect(alert).not.toContainText("must-not-render");

  await page.locator("#locale-select").selectOption("zh-CN");
  await expect(technical.locator("summary")).toHaveText("技术详情");
  await assertNoSecrets(page, crp);
});

test("detects a secret in raw API response bytes before display redaction", async ({ page, crp }) => {
  const reflected = `response-${randomBytes(18).toString("base64url")}`;
  await page.route("**/api/v1/diagnostics/export", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        diagnostics: { created: true, generatedAt: "2026-07-13T08:50:00.000Z", eventCount: 0 },
        credential: reflected
      })
    });
  });
  await openCrp(page, crp);
  await page.getByRole("link", { name: "System" }).click();
  await page.getByRole("button", { name: "Generate diagnostic summary" }).click();
  await expect(page.locator(".diagnostic-result")).toContainText("Summary ready");
  await crp.collectors.flush();
  const displayRecord = crp.collectors.records.findLast((record) => (
    record.type === "response" && record.url === "/api/v1/diagnostics/export"
  ));
  expect(displayRecord?.body).not.toContain(reflected);
  expect(displayRecord?.body).toContain('"credential":"[redacted]"');
  await expect(assertNoSecrets(page, crp, [reflected])).rejects.toThrow(
    "Raw API response contained sensitive data outside the session exchange."
  );
});

test("renders committed degraded guidance in both locales", async ({ page, crp }) => {
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
  await page.getByRole("link", { name: "System" }).click();
  await page.getByRole("button", { name: "Generate diagnostic summary" }).click();
  await expect(page.getByText("CRP state needs repair")).toBeVisible();
  await expect(page.getByText("The primary change may already be committed. Review Activity before another mutation.")).toBeVisible();
  await page.locator("#locale-select").selectOption("zh-CN");
  await expect(page.getByText("CRP 状态需要修复")).toBeVisible();
  await expect(page.getByText("主要更改可能已经提交。执行其他更改前请先查看活动记录。")).toBeVisible();
});

test("terminates after a second session exchange makes the open tab CSRF stale", async ({ page, crp }) => {
  const mutationRequests = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === "/api/v1/providers/provider-b") {
      mutationRequests.push(request.method());
    }
  });
  await openCrp(page, crp);
  await page.getByRole("button", { name: "Stop proxy" }).click();
  await page.getByRole("link", { name: "Providers" }).click();
  const editor = await openInactiveProviderEditor(page, "Provider Beta");
  await editor.getByLabel("Provider name").fill("Stale tab edit");
  await editor.getByLabel("Replacement API key").fill(crp.credential);
  expect(await crp.rotateBrowserSession(page)).toEqual({ status: 200, csrfTokenLength: 43 });
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#session-root")).toBeVisible();
  await expect(page.locator("#app-root")).toHaveCount(0);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(mutationRequests).toEqual(["PATCH"]);
  await assertNoSecrets(page, crp);
});

for (const status of [500, 403]) {
  test(`treats a ${status} session exchange failure as terminal even with a valid cookie`, async ({ page, crp }) => {
    await openCrp(page, crp);
    // Preserve the cookie while destroying the old document and its visibility
    // refresh handlers before observing the new failed session bootstrap.
    await page.goto("about:blank");
    const apiRequests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/")) apiRequests.push({ method: request.method(), path: url.pathname });
    });
    await page.route("**/api/v1/session", async (route) => {
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INTERNAL_ERROR", requestId: `req-exchange-${status}`, details: {} } })
      });
    }, { times: 1 });
    await page.goto(`${crp.origin}/?exchange=${status}#token=${crp.controlToken}`);
    await expect(page.locator("html")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#session-root")).toBeVisible();
    await expect(page.locator("#app-root")).toHaveCount(0);
    expect(apiRequests).toEqual([{ method: "POST", path: "/api/v1/session" }]);
    await assertNoSecrets(page, crp);
  });
}

test("fails closed after session expiry and clears an open replacement credential", async ({ page, crp }) => {
  const sessionRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/session") sessionRequests.push(request.method());
  });
  await openCrp(page, crp);
  expect(sessionRequests).toEqual(["POST"]);
  await page.getByRole("button", { name: "Stop proxy" }).click();
  await page.getByRole("link", { name: "Providers" }).click();
  const editor = await openInactiveProviderEditor(page, "Provider Beta");
  await editor.getByLabel("Replacement API key").fill(crp.credential);
  crp.expireSession();
  await editor.getByRole("button", { name: "Save changes" }).click();

  await expect(page.locator("#session-root")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Session expired" })).toBeVisible();
  await expect(page.getByText("Run crp ui again, then close this tab.")).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(sessionRequests).toEqual(["POST"]);
  expect(crp.calls.filter((call) => call.operation === "updateProvider")).toHaveLength(0);
  await assertNoSecrets(page, crp);
});
