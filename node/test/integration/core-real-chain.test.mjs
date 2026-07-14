import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { join } from "node:path";

import { createSupervisor } from "../../src/supervisor/supervisor.mjs";
import { SupervisorClient } from "../../src/supervisor/supervisor-client.mjs";

const PROXY_PORT = 15100;
const ADMIN_PORT = 15101;
const EXPECTED_CONFIG = [
  'model_provider = "OpenAI"',
  "",
  "[model_providers.OpenAI]",
  'name = "OpenAI"',
  'base_url = "http://127.0.0.1:15100"',
  'wire_api = "responses"',
  "requires_openai_auth = true",
  ""
].join("\n");

class MemoryCredentialStore {
  backend = "memory";
  values = new Map();

  async set(ref, secret) {
    this.values.set(ref, secret);
  }

  async get(ref) {
    return this.values.get(ref) ?? null;
  }

  async has(ref) {
    return this.values.has(ref);
  }

  async delete(ref) {
    return this.values.delete(ref);
  }
}

async function confirmPortIdle(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    probe.once("error", onError);
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.off("error", onError);
      resolve();
    });
  });
  await new Promise((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
}

test("real core chain bootstraps the fixed Codex config from an empty HOME", async (t) => {
  const home = mkdtempSync(join(os.tmpdir(), "crp-core-real-chain-"));
  const codexDir = join(home, ".codex");
  const configPath = join(codexDir, "config.toml");
  let supervisor;

  t.after(async () => {
    try {
      await supervisor?.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  assert.equal(existsSync(codexDir), false);
  await confirmPortIdle(PROXY_PORT);
  await confirmPortIdle(ADMIN_PORT);

  supervisor = await createSupervisor({
    home,
    credentialStoreFactory: () => new MemoryCredentialStore()
  });
  const address = await supervisor.listen();
  assert.equal(address.port, ADMIN_PORT);

  const client = new SupervisorClient({
    origin: address.origin,
    controlTokenPath: supervisor.paths.controlTokenPath
  });
  const first = await client.request("POST", "/codex/bootstrap");

  assert.deepEqual(first, {
    result: { changed: true, backupCreated: false }
  });
  assert.equal(readFileSync(configPath, "utf8"), EXPECTED_CONFIG);
  assert.deepEqual(
    readdirSync(codexDir).filter((name) => name.endsWith(".bak")),
    []
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(codexDir).mode & 0o777, 0o700);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  }

  const second = await client.request("POST", "/codex/bootstrap");
  assert.deepEqual(second, {
    result: { changed: false, backupCreated: false }
  });
  assert.equal(readFileSync(configPath, "utf8"), EXPECTED_CONFIG);
  assert.deepEqual(
    readdirSync(codexDir).filter((name) => name.endsWith(".bak")),
    []
  );
});
