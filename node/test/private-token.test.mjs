import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadOrCreatePrivateToken } from "../src/shared/private-token.mjs";

test("private local-access tokens are created once with a private canonical encoding", (t) => {
  const root = mkdtempSync(join(tmpdir(), "crp-private-token-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "local-access-token");
  const expected = Buffer.alloc(32, 7).toString("base64url");
  const first = loadOrCreatePrivateToken({
    path,
    randomBytes: () => Buffer.alloc(32, 7)
  });
  const second = loadOrCreatePrivateToken({
    path,
    randomBytes: () => {
      throw new Error("existing token must be reused");
    }
  });
  assert.equal(first, expected);
  assert.equal(second, expected);
  assert.equal(readFileSync(path, "utf8"), `${expected}\n`);
  if (process.platform !== "win32") {
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test("private local-access tokens reject permissive files and symbolic links", (t) => {
  const root = mkdtempSync(join(tmpdir(), "crp-private-token-unsafe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const token = Buffer.alloc(32, 9).toString("base64url");
  writeFileSync(target, `${token}\n`, { mode: 0o600 });
  const linked = join(root, "linked-token");
  symlinkSync(target, linked);
  assert.throws(() => loadOrCreatePrivateToken({ path: linked }), /unsafe/);

  if (process.platform !== "win32") {
    const permissive = join(root, "permissive-token");
    writeFileSync(permissive, `${token}\n`, { mode: 0o600 });
    chmodSync(permissive, 0o644);
    assert.throws(() => loadOrCreatePrivateToken({ path: permissive }), /unsafe/);
  }
});
