import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeSettingsSource } from "../src/worker/runtime-settings.mjs";

function makeSettings(label = "a") {
  return {
    configPath: `/private/${label}/proxy-config.json`,
    server: {
      host: "127.0.0.1",
      port: 15100,
      logLevel: "info"
    },
    upstream: {
      baseUrl: `https://${label}.example.test/v1`,
      apiKey: `${label}-super-secret-api-key`,
      timeoutMs: 5000,
      verifySsl: true,
      authHeader: "x-provider-api-key",
      authScheme: "Bearer",
      extraHeaders: {
        "x-provider-region": `${label}-region`
      }
    },
    proxy: {
      overrideAuthorization: true,
      requestIdHeader: "x-client-request-id"
    },
    capture: {
      enabled: false,
      dbPath: `/private/${label}/traffic.sqlite3`,
      ignoredPaths: ["/_proxy/health"]
    }
  };
}

test("RuntimeSettingsSource reports an allowlisted unconfigured public state", () => {
  const source = new RuntimeSettingsSource();

  assert.deepEqual(source.publicState(), {
    configured: false,
    generation: 0
  });
  assert.throws(
    () => source.current(),
    (error) => error?.code === "RUNTIME_SETTINGS_UNAVAILABLE"
  );
});

test("RuntimeSettingsSource accepts only strictly increasing generations", () => {
  const source = new RuntimeSettingsSource();
  const settingsA = makeSettings("a");
  const settingsB = makeSettings("b");

  source.apply({ generation: 2, settings: settingsA });
  const first = source.current();
  assert.equal(first.generation, 2);

  for (const generation of [2, 1]) {
    assert.throws(
      () => source.apply({ generation, settings: settingsB }),
      (error) => error?.code === "STALE_SNAPSHOT"
    );
    assert.strictEqual(source.current(), first);
  }

  source.apply({ generation: 3, settings: settingsB });
  assert.equal(source.current().generation, 3);
  assert.equal(source.current().settings.upstream.baseUrl, settingsB.upstream.baseUrl);
});

test("RuntimeSettingsSource rejects invalid input without replacing the current snapshot", () => {
  const source = new RuntimeSettingsSource();
  source.apply({ generation: 3, settings: makeSettings("stable") });
  const stable = source.current();

  const invalidSnapshots = [
    null,
    {},
    { generation: -1, settings: makeSettings("negative") },
    { generation: 0, settings: makeSettings("zero") },
    { generation: 1.5, settings: makeSettings("fraction") },
    { generation: Number.NaN, settings: makeSettings("nan") },
    { generation: Number.POSITIVE_INFINITY, settings: makeSettings("infinity") },
    { generation: Number.MAX_SAFE_INTEGER + 1, settings: makeSettings("unsafe") },
    { generation: 4 },
    { generation: 4, settings: null },
    { generation: 4, settings: [] },
    { generation: 4, settings: { nested: () => "not cloneable" } },
    { generation: 4, settings: { nested: Number.POSITIVE_INFINITY } }
  ];

  for (const snapshot of invalidSnapshots) {
    assert.throws(
      () => source.apply(snapshot),
      (error) => error?.code === "RUNTIME_SETTINGS_INVALID"
    );
    assert.strictEqual(source.current(), stable);
  }
});

test("RuntimeSettingsSource clones input and deeply freezes the active snapshot", () => {
  const source = new RuntimeSettingsSource();
  const input = {
    generation: 1,
    settings: makeSettings("clone")
  };

  source.apply(input);
  const active = source.current();

  input.generation = 99;
  input.settings.upstream.baseUrl = "https://mutated.example.test";
  input.settings.upstream.extraHeaders["x-provider-region"] = "mutated";
  input.settings.capture.ignoredPaths.push("/mutated");

  assert.equal(active.generation, 1);
  assert.equal(active.settings.upstream.baseUrl, "https://clone.example.test/v1");
  assert.equal(active.settings.upstream.extraHeaders["x-provider-region"], "clone-region");
  assert.deepEqual(active.settings.capture.ignoredPaths, ["/_proxy/health"]);
  assert.equal(Object.isFrozen(active), true);
  assert.equal(Object.isFrozen(active.settings), true);
  assert.equal(Object.isFrozen(active.settings.upstream), true);
  assert.equal(Object.isFrozen(active.settings.upstream.extraHeaders), true);
  assert.equal(Object.isFrozen(active.settings.capture.ignoredPaths), true);
  assert.throws(() => {
    active.settings.upstream.extraHeaders["x-provider-region"] = "changed";
  }, TypeError);
});

test("RuntimeSettingsSource public state never projects settings or secret values", () => {
  const source = new RuntimeSettingsSource();
  const settings = makeSettings("public-state-sentinel");
  source.apply({ generation: 7, settings });

  const publicState = source.publicState();
  assert.deepEqual(publicState, {
    configured: true,
    generation: 7
  });
  assert.equal(Object.isFrozen(publicState), true);

  const serialized = JSON.stringify(publicState);
  for (const forbidden of [
    "settings",
    "apiKey",
    "authHeader",
    settings.upstream.apiKey,
    settings.upstream.authHeader,
    settings.upstream.extraHeaders["x-provider-region"]
  ]) {
    assert.equal(serialized.includes(forbidden), false, `public state leaked ${forbidden}`);
  }
});
