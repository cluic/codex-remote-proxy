import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync as realOpenSync,
  readFileSync,
  readlinkSync,
  renameSync as renameReal,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AutoStartService } from "../src/supervisor/autostart-service.mjs";

const CLI_ENTRY = fileURLToPath(new URL("../bin/crp.mjs", import.meta.url));

function fixture(t, suffix = "") {
  const root = mkdtempSync(join(os.tmpdir(), `crp-autostart-${suffix}`));
  const userHome = join(root, "user home");
  const crpHome = join(root, "crp home");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(crpHome, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, userHome, crpHome };
}

test("macOS start at login installs an exact private LaunchAgent and disables it in place", (t) => {
  const { userHome, crpHome } = fixture(t, "darwin-");
  const service = new AutoStartService({
    platform: "darwin",
    userHome,
    crpHome,
    nodePath: process.execPath,
    cliEntry: CLI_ENTRY,
    createId: () => "fixed"
  });
  assert.deepEqual(service.getStatus(), {
    supported: true,
    enabled: false,
    state: "disabled",
    platform: "darwin"
  });

  assert.equal(service.setEnabled(true).enabled, true);
  const path = join(
    userHome,
    "Library",
    "LaunchAgents",
    "com.cluic.codex-remote-proxy.plist"
  );
  const contents = readFileSync(path, "utf8");
  assert.match(contents, /managed-by=@cluic\/codex-remote-proxy;schema=1/);
  assert.match(contents, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(contents, /<string>start<\/string>/);
  assert.match(contents, /<string>--json<\/string>/);
  assert.ok(contents.includes(`<string>${resolve(crpHome)}</string>`));
  assert.equal(lstatSync(path).mode & 0o777, 0o600);

  assert.equal(service.setEnabled(false).enabled, false);
  assert.equal(existsSync(path), true);
  assert.doesNotMatch(readFileSync(path, "utf8"), /<key>RunAtLoad<\/key>/);
  assert.equal(service.setEnabled(true).enabled, true);
});

test("Linux start at login creates a user unit and keeps an inert managed unit when disabled", (t) => {
  const { root, userHome, crpHome } = fixture(t, "linux-");
  const configHome = join(root, "xdg config");
  const unitParent = join(configHome, "systemd", "user");
  mkdirSync(unitParent, { recursive: true, mode: 0o755 });
  const service = new AutoStartService({
    platform: "linux",
    userHome,
    crpHome,
    environment: { XDG_CONFIG_HOME: configHome },
    nodePath: process.execPath,
    cliEntry: CLI_ENTRY,
    createId: () => "fixed"
  });

  service.setEnabled(true);
  const unitPath = join(configHome, "systemd", "user", "codex-remote-proxy.service");
  const linkPath = join(
    configHome,
    "systemd",
    "user",
    "default.target.wants",
    "codex-remote-proxy.service"
  );
  assert.equal(resolve(dirname(linkPath), readlinkSync(linkPath)), resolve(unitPath));
  const contents = readFileSync(unitPath, "utf8");
  assert.ok(contents.includes(`Environment="CRP_HOME=${resolve(crpHome)}"`));
  assert.ok(contents.includes(" start --json"));
  assert.match(contents, /^# managed-by=@cluic\/codex-remote-proxy;schema=1/);
  assert.equal(lstatSync(unitParent).mode & 0o777, 0o755);
  assert.equal(service.getStatus().state, "enabled");

  writeFileSync(unitPath, `${contents}# installation drift\n`, { mode: 0o600 });
  assert.equal(service.getStatus().state, "stale");
  assert.equal(service.setEnabled(true).state, "enabled");
  service.setEnabled(false);
  assert.equal(existsSync(unitPath), true);
  assert.match(readFileSync(unitPath, "utf8"), /ExecStart=\/bin\/true/);
  assert.equal(lstatMissing(linkPath), false);
});

test("Linux enable rolls the unit back when the wants link cannot be created", (t) => {
  const { userHome, crpHome } = fixture(t, "rollback-");
  const service = new AutoStartService({
    platform: "linux",
    userHome,
    crpHome,
    nodePath: process.execPath,
    cliEntry: CLI_ENTRY,
    fileOperations: {
      symlinkSync() {
        const error = new Error("denied");
        error.code = "EACCES";
        throw error;
      }
    },
    createId: () => "fixed"
  });
  assert.throws(() => service.setEnabled(true), { code: "AUTOSTART_UPDATE_FAILED" });
  assert.equal(service.getStatus().state, "disabled");
});

test("Windows start at login writes bounded active and inert Startup commands", (t) => {
  const { root, userHome } = fixture(t, "win-");
  const crpHome = join(root, "crp%home");
  const appData = join(root, "App Data");
  mkdirSync(crpHome, { recursive: true });
  const service = new AutoStartService({
    platform: "win32",
    userHome,
    crpHome,
    environment: { APPDATA: appData },
    nodePath: process.execPath,
    cliEntry: CLI_ENTRY,
    createId: () => "fixed"
  });
  service.setEnabled(true);
  const path = join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "codex-remote-proxy.cmd"
  );
  const contents = readFileSync(path, "utf8");
  assert.match(contents, /^@REM managed-by=@cluic\/codex-remote-proxy;schema=1/);
  assert.ok(contents.includes("set \"CRP_HOME="));
  assert.ok(contents.includes("crp%%home"));
  assert.ok(contents.includes(" start --json >nul 2>&1"));
  service.setEnabled(false);
  assert.equal(existsSync(path), true);
  assert.match(readFileSync(path, "utf8"), /@exit \/b 0/);
});

test("unsupported platforms are projected as unavailable", (t) => {
  const { userHome, crpHome } = fixture(t, "unsupported-");
  const service = new AutoStartService({ platform: "aix", userHome, crpHome });
  assert.deepEqual(service.getStatus(), {
    supported: false,
    enabled: false,
    state: "unavailable",
    platform: "aix"
  });
  assert.throws(() => service.setEnabled(true), { code: "AUTOSTART_UNAVAILABLE" });
});

test("an unsafe artifact is never overwritten or removed", (t) => {
  const { root, userHome, crpHome } = fixture(t, "unsafe-");
  const target = join(root, "owned.txt");
  writeFileSync(target, "owned\n");
  const path = join(
    userHome,
    "Library",
    "LaunchAgents",
    "com.cluic.codex-remote-proxy.plist"
  );
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  const service = new AutoStartService({
    platform: "darwin",
    userHome,
    crpHome,
    nodePath: process.execPath,
    cliEntry: CLI_ENTRY
  });
  assert.equal(service.getStatus().state, "conflict");
  assert.throws(() => service.setEnabled(true), { code: "AUTOSTART_CONFLICT" });
  assert.throws(() => service.setEnabled(false), { code: "AUTOSTART_CONFLICT" });
  assert.equal(readFileSync(target, "utf8"), "owned\n");
  assert.equal(lstatSync(path).isSymbolicLink(), true);
});

test("a foreign regular startup file is never overwritten or deleted", (t) => {
  const { userHome, crpHome } = fixture(t, "foreign-file-");
  const path = join(
    userHome,
    "Library",
    "LaunchAgents",
    "com.cluic.codex-remote-proxy.plist"
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "foreign startup contents\n", { mode: 0o600 });
  const service = new AutoStartService({
    platform: "darwin",
    userHome,
    crpHome,
    nodePath: process.execPath,
    cliEntry: CLI_ENTRY
  });

  assert.equal(service.getStatus().state, "conflict");
  assert.throws(() => service.setEnabled(true), { code: "AUTOSTART_CONFLICT" });
  assert.throws(() => service.setEnabled(false), { code: "AUTOSTART_CONFLICT" });
  assert.equal(readFileSync(path, "utf8"), "foreign startup contents\n");
});

test("a foreign startup file created immediately before exclusive creation is preserved", (t) => {
  const { userHome, crpHome } = fixture(t, "create-race-");
  const path = join(
    userHome,
    "Library",
    "LaunchAgents",
    "com.cluic.codex-remote-proxy.plist"
  );
  let raced = false;
  const service = new AutoStartService({
    platform: "darwin",
    userHome,
    crpHome,
    nodePath: process.execPath,
    cliEntry: CLI_ENTRY,
    fileOperations: {
      openSync(target, flags, mode) {
        if (!raced && target === path && flags === "wx") {
          raced = true;
          writeFileSync(path, "foreign race winner\n", { mode: 0o600 });
        }
        return realOpenSync(target, flags, mode);
      }
    }
  });

  assert.throws(() => service.setEnabled(true), { code: "AUTOSTART_CONFLICT" });
  assert.equal(readFileSync(path, "utf8"), "foreign race winner\n");
});

test("a canonical replacement after descriptor open is never overwritten", (t) => {
  const { root, userHome, crpHome } = fixture(t, "replacement-race-");
  const path = join(
    userHome,
    "Library",
    "LaunchAgents",
    "com.cluic.codex-remote-proxy.plist"
  );
  const installed = new AutoStartService({
    platform: "darwin",
    userHome,
    crpHome,
    nodePath: process.execPath,
    cliEntry: CLI_ENTRY
  });
  installed.setEnabled(true);
  writeFileSync(path, `${readFileSync(path, "utf8")}<!-- drift -->\n`, { mode: 0o600 });
  const displaced = join(root, "displaced-managed.plist");
  let swapped = false;
  const raced = new AutoStartService({
    platform: "darwin",
    userHome,
    crpHome,
    nodePath: process.execPath,
    cliEntry: CLI_ENTRY,
    fileOperations: {
      openSync(target, flags, mode) {
        const descriptor = realOpenSync(target, flags, mode);
        if (!swapped && target === path && typeof flags === "number"
          && (flags & 0o2) === 0o2) {
          swapped = true;
          renameReal(path, displaced);
          writeFileSync(path, "foreign replacement\n", { mode: 0o600 });
        }
        return descriptor;
      }
    }
  });

  assert.throws(() => raced.setEnabled(true), { code: "AUTOSTART_CONFLICT" });
  assert.equal(readFileSync(path, "utf8"), "foreign replacement\n");
});

function lstatMissing(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}
