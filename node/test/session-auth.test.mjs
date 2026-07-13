import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { SessionAuth } from "../src/supervisor/session-auth.mjs";
import { CrpError, toPublicError } from "../src/shared/errors.mjs";

const CONTROL_BYTES = Buffer.alloc(32, 0x11);
const SESSION_BYTES = Buffer.alloc(32, 0x22);
const CSRF_BYTES = Buffer.alloc(32, 0x33);
const CONTROL_TOKEN = CONTROL_BYTES.toString("base64url");
const SESSION_TOKEN = SESSION_BYTES.toString("base64url");
const CSRF_TOKEN = CSRF_BYTES.toString("base64url");
const START_MS = Date.parse("2026-07-13T00:00:00.000Z");

function makeTempAuth(t, prefix = "crp-session-auth-") {
  const dir = mkdtempSync(join(os.tmpdir(), prefix));
  const tokenPath = join(dir, "control-token");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, tokenPath };
}

function sequenceRandomBytes(...values) {
  let index = 0;
  return (size) => {
    assert.equal(size, 32);
    const value = values[index++];
    assert.ok(value, `unexpected randomBytes call ${index}`);
    return Buffer.from(value);
  };
}

function assertCrpError(code, status) {
  return (error) => {
    assert.ok(error instanceof CrpError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(typeof error.action, "string");
    assert.notEqual(error.action.length, 0);
    return true;
  };
}

test("creates one private 32-byte control token and reuses it after restart", (t) => {
  const { tokenPath } = makeTempAuth(t);
  const first = new SessionAuth({
    controlTokenPath: tokenPath,
    randomBytes: sequenceRandomBytes(CONTROL_BYTES),
    now: () => START_MS
  });

  assert.equal(readFileSync(tokenPath, "utf8"), `${CONTROL_TOKEN}\n`);
  if (process.platform !== "win32") {
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(tokenPath, "..")).mode & 0o777, 0o700);
  }
  assert.deepEqual(
    first.authorize({ authorization: `Bearer ${CONTROL_TOKEN}`, mutation: true }),
    { kind: "cli" }
  );

  const restarted = new SessionAuth({
    controlTokenPath: tokenPath,
    randomBytes: () => assert.fail("an existing control token must be reused"),
    now: () => START_MS
  });
  assert.deepEqual(
    restarted.authorize({ authorization: `Bearer ${CONTROL_TOKEN}`, mutation: true }),
    { kind: "cli" }
  );
});

test("exchanges bearer auth for an HttpOnly strict browser session and enforces CSRF", (t) => {
  const { tokenPath } = makeTempAuth(t);
  const auth = new SessionAuth({
    controlTokenPath: tokenPath,
    randomBytes: sequenceRandomBytes(CONTROL_BYTES, SESSION_BYTES, CSRF_BYTES),
    now: () => START_MS,
    sessionTtlMs: 60_000
  });

  const session = auth.createBrowserSession(`Bearer ${CONTROL_TOKEN}`);
  assert.equal(session.csrfToken, CSRF_TOKEN);
  assert.equal(session.expiresAt, "2026-07-13T00:01:00.000Z");
  assert.match(session.setCookie, new RegExp(`^crp_session=${SESSION_TOKEN};`));
  assert.match(session.setCookie, /Path=\//);
  assert.match(session.setCookie, /HttpOnly/);
  assert.match(session.setCookie, /SameSite=Strict/);
  assert.match(session.setCookie, /Max-Age=60/);
  assert.doesNotMatch(session.setCookie, /Secure/);

  const cookie = `unrelated=value; crp_session=${SESSION_TOKEN}`;
  assert.deepEqual(auth.authorize({ cookie, mutation: false }), { kind: "browser" });
  assert.deepEqual(
    auth.authorize({ cookie, csrfToken: CSRF_TOKEN, mutation: true }),
    { kind: "browser" }
  );
  assert.throws(
    () => auth.authorize({ cookie, mutation: true }),
    assertCrpError("AUTH_CSRF_INVALID", 403)
  );
  assert.throws(
    () => auth.authorize({ cookie, csrfToken: `${CSRF_TOKEN}x`, mutation: true }),
    assertCrpError("AUTH_CSRF_INVALID", 403)
  );
});

test("expired browser sessions are rejected and request cookie clearing", (t) => {
  const { tokenPath } = makeTempAuth(t);
  let now = START_MS;
  const auth = new SessionAuth({
    controlTokenPath: tokenPath,
    randomBytes: sequenceRandomBytes(CONTROL_BYTES, SESSION_BYTES, CSRF_BYTES),
    now: () => now,
    sessionTtlMs: 1_000
  });
  const session = auth.createBrowserSession(`Bearer ${CONTROL_TOKEN}`);

  now += 1_001;
  let caught;
  try {
    auth.authorize({ cookie: `crp_session=${SESSION_TOKEN}`, mutation: false });
  } catch (error) {
    caught = error;
  }
  assertCrpError("AUTH_SESSION_EXPIRED", 401)(caught);
  assert.equal(caught.clearCookie, true);
  assert.equal(auth.clearCookie(), "crp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  assert.equal(JSON.stringify(toPublicError(caught, "request-1")).includes(SESSION_TOKEN), false);
  assert.equal(JSON.stringify(toPublicError(caught, "request-1")).includes(CSRF_TOKEN), false);
  assert.equal(session.csrfToken, CSRF_TOKEN);
});

test("rejects invalid bearer, missing or duplicate cookies, and destroys sessions on close", (t) => {
  const { tokenPath } = makeTempAuth(t);
  const auth = new SessionAuth({
    controlTokenPath: tokenPath,
    randomBytes: sequenceRandomBytes(CONTROL_BYTES, SESSION_BYTES, CSRF_BYTES),
    now: () => START_MS
  });
  auth.createBrowserSession(`Bearer ${CONTROL_TOKEN}`);

  for (const authorization of [
    CONTROL_TOKEN,
    "Basic invalid",
    "Bearer",
    `Bearer ${CONTROL_TOKEN}x`
  ]) {
    assert.throws(
      () => auth.authorize({ authorization, mutation: false }),
      assertCrpError("AUTH_REQUIRED", 401)
    );
  }
  for (const cookie of [
    undefined,
    "unrelated=value",
    `crp_session=${SESSION_TOKEN}; crp_session=${SESSION_TOKEN}`,
    `crp_session=${SESSION_TOKEN}x`
  ]) {
    assert.throws(
      () => auth.authorize({ cookie, mutation: false }),
      assertCrpError("AUTH_REQUIRED", 401)
    );
  }

  auth.close();
  assert.throws(
    () => auth.authorize({ cookie: `crp_session=${SESSION_TOKEN}`, mutation: false }),
    assertCrpError("AUTH_REQUIRED", 401)
  );
});

test("rejects malformed, permissive, and symbolic-link control token files safely", (t) => {
  const secrets = ["short-control-secret", CONTROL_TOKEN];
  for (const [label, prepare] of [
    ["malformed", ({ tokenPath }) => writeFileSync(tokenPath, `${secrets[0]}\n`, { mode: 0o600 })],
    ["permissive", ({ tokenPath }) => {
      writeFileSync(tokenPath, `${CONTROL_TOKEN}\n`, { mode: 0o600 });
      chmodSync(tokenPath, 0o644);
    }],
    ["symlink", ({ dir, tokenPath }) => {
      const target = join(dir, "target-token");
      writeFileSync(target, `${CONTROL_TOKEN}\n`, { mode: 0o600 });
      symlinkSync(target, tokenPath);
    }]
  ]) {
    if (label === "permissive" && process.platform === "win32") continue;
    const paths = makeTempAuth(t, `crp-session-${label}-`);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    prepare(paths);
    let caught;
    try {
      new SessionAuth({ controlTokenPath: paths.tokenPath });
    } catch (error) {
      caught = error;
    }
    assertCrpError("AUTH_CONTROL_TOKEN_INVALID", 500)(caught);
    const serialized = JSON.stringify(toPublicError(caught, "request-1"));
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(paths.tokenPath), false);
  }
});
