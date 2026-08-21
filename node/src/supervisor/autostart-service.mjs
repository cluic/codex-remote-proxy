import {
  closeSync,
  constants as FS_CONSTANTS,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeSync
} from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CrpError } from "../shared/errors.mjs";

const LABEL = "com.cluic.codex-remote-proxy";
const MANAGED_MARKER = "managed-by=@cluic/codex-remote-proxy;schema=1";
const MAX_ARTIFACT_BYTES = 64 * 1_024;
const CLI_ENTRY = fileURLToPath(new URL("../../bin/crp.mjs", import.meta.url));
const DEFAULT_FILE_OPERATIONS = {
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeSync
};

function serviceError(code, cause) {
  const unavailable = code === "AUTOSTART_UNAVAILABLE";
  const conflict = code === "AUTOSTART_CONFLICT";
  const committed = code === "AUTOSTART_COMMITTED_DEGRADED";
  return new CrpError(
    code,
    unavailable
      ? "Start at login is unavailable on this system."
      : conflict
        ? "The startup path is owned by another file."
        : committed
          ? "The startup item changed, but durability could not be confirmed."
        : "Start at login could not be updated.",
    unavailable
      ? "Start CRP manually after signing in."
      : conflict
        ? "Move or rename the conflicting startup item, then try again."
        : committed
          ? "Inspect the startup item before making another change."
        : "Check the user startup directory permissions and try again.",
    {
      status: unavailable || conflict ? 409 : 500,
      cause,
      details: committed ? { committed: true, degraded: true } : {}
    }
  );
}

function assertSafeText(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw serviceError("AUTOSTART_UNAVAILABLE");
  }
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) {
      throw serviceError("AUTOSTART_UNAVAILABLE");
    }
  }
  return value;
}

function xml(value) {
  return assertSafeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdArgument(value) {
  return `"${assertSafeText(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")}"`;
}

function batchArgument(value) {
  const safe = assertSafeText(value);
  if (safe.includes('"')) throw serviceError("AUTOSTART_UNAVAILABLE");
  return `"${safe.replaceAll("%", "%%")}"`;
}

function resolveExecutable(path, fileOperations) {
  try {
    const resolved = fileOperations.realpathSync(assertSafeText(path));
    const stats = fileOperations.lstatSync(resolved);
    if (!stats.isFile()) throw new Error("Startup executable is not a regular file.");
    return resolved;
  } catch (error) {
    throw serviceError("AUTOSTART_UNAVAILABLE", error);
  }
}

function artifactFor({ platform, userHome, environment }) {
  if (platform === "darwin") {
    return {
      kind: "launch-agent",
      path: join(userHome, "Library", "LaunchAgents", `${LABEL}.plist`),
      linkPath: null
    };
  }
  if (platform === "linux") {
    const configRoot = typeof environment.XDG_CONFIG_HOME === "string"
      && environment.XDG_CONFIG_HOME.length > 0
      ? resolve(assertSafeText(environment.XDG_CONFIG_HOME))
      : join(userHome, ".config");
    const unitPath = join(configRoot, "systemd", "user", "codex-remote-proxy.service");
    return {
      kind: "systemd-user",
      path: unitPath,
      linkPath: join(dirname(unitPath), "default.target.wants", basename(unitPath))
    };
  }
  if (platform === "win32") {
    const appData = typeof environment.APPDATA === "string" && environment.APPDATA.length > 0
      ? resolve(assertSafeText(environment.APPDATA))
      : join(userHome, "AppData", "Roaming");
    return {
      kind: "windows-startup",
      path: join(
        appData,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "codex-remote-proxy.cmd"
      ),
      linkPath: null
    };
  }
  return null;
}

function artifactContents({ artifact, nodePath, cliEntry, crpHome, logPath, enabled = true }) {
  if (artifact.kind === "launch-agent") {
    if (!enabled) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MANAGED_MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${LABEL}.disabled</string></dict></plist>
`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MANAGED_MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(cliEntry)}</string>
    <string>start</string>
    <string>--json</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>CRP_HOME</key><string>${xml(crpHome)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
  }
  if (artifact.kind === "systemd-user") {
    if (!enabled) {
      return `# ${MANAGED_MARKER}
[Unit]
Description=Codex Remote Proxy login startup (disabled)

[Service]
Type=oneshot
ExecStart=/bin/true
`;
    }
    return `# ${MANAGED_MARKER}
[Unit]
Description=Codex Remote Proxy login startup
After=network-online.target

[Service]
Type=oneshot
Environment=${systemdArgument(`CRP_HOME=${crpHome}`)}
ExecStart=${systemdArgument(nodePath)} ${systemdArgument(cliEntry)} start --json

[Install]
WantedBy=default.target
`;
  }
  if (!enabled) return `@REM ${MANAGED_MARKER}\r\n@exit /b 0\r\n`;
  const safeCrpHome = batchArgument(crpHome).slice(1, -1);
  return `@REM ${MANAGED_MARKER}\r\n@echo off\r\nset "CRP_HOME=${safeCrpHome}"\r\nstart "" /b ${batchArgument(nodePath)} ${batchArgument(cliEntry)} start --json >nul 2>&1\r\n`;
}

function identityOf(stats) {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function managedPrefix(kind) {
  if (kind === "launch-agent") {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${MANAGED_MARKER} -->\n`;
  }
  if (kind === "systemd-user") return `# ${MANAGED_MARKER}\n`;
  return `@REM ${MANAGED_MARKER}\r\n`;
}

function isManagedArtifact(bytes, kind) {
  return Buffer.isBuffer(bytes)
    && bytes.subarray(0, Buffer.byteLength(managedPrefix(kind))).equals(
      Buffer.from(managedPrefix(kind), "utf8")
    );
}

function lstatResult(path, fileOperations) {
  try {
    return { kind: "present", stats: fileOperations.lstatSync(path) };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    return { kind: "unsafe", error };
  }
}

function inspectRegular(path, fileOperations) {
  const current = lstatResult(path, fileOperations);
  if (current.kind !== "present") return current;
  try {
    if (!current.stats.isFile() || current.stats.isSymbolicLink()
      || current.stats.nlink !== 1 || current.stats.size > MAX_ARTIFACT_BYTES) {
      return { kind: "unsafe" };
    }
    return {
      kind: "file",
      bytes: Buffer.from(fileOperations.readFileSync(path)),
      identity: identityOf(current.stats)
    };
  } catch (error) {
    return { kind: "unsafe", error };
  }
}

function inspectLink(path, target, fileOperations) {
  if (path === null) return { kind: "not-required" };
  const current = lstatResult(path, fileOperations);
  if (current.kind !== "present") return current;
  try {
    if (!current.stats.isSymbolicLink()) return { kind: "unsafe" };
    const linked = resolve(dirname(path), fileOperations.readlinkSync(path));
    return linked === resolve(target)
      ? { kind: "valid", identity: identityOf(current.stats) }
      : { kind: "unsafe" };
  } catch (error) {
    return { kind: "unsafe", error };
  }
}

function ensureSafeDirectory(path, fileOperations) {
  try {
    fileOperations.mkdirSync(path, { recursive: true, mode: 0o700 });
    const stats = fileOperations.lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Startup directory is not a regular directory.");
    }
  } catch (error) {
    throw serviceError("AUTOSTART_UPDATE_FAILED", error);
  }
}

function fsyncDirectory(path, fileOperations) {
  let descriptor;
  try {
    const directoryFlag = typeof FS_CONSTANTS.O_DIRECTORY === "number"
      ? FS_CONSTANTS.O_DIRECTORY
      : 0;
    descriptor = fileOperations.openSync(path, FS_CONSTANTS.O_RDONLY | directoryFlag);
    fileOperations.fsyncSync(descriptor);
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileOperations.closeSync(descriptor); } catch {}
    }
    if (process.platform === "win32"
      && ["EACCES", "EINVAL", "EPERM"].includes(error?.code)) return;
    throw error;
  }
}

function writeBuffer(descriptor, bytes, fileOperations) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fileOperations.writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset
    );
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error("Startup artifact write did not make progress.");
    }
    offset += written;
  }
}

function writeExistingManaged(path, current, contents, artifactKind, fileOperations) {
  const noFollow = typeof FS_CONSTANTS.O_NOFOLLOW === "number" ? FS_CONSTANTS.O_NOFOLLOW : 0;
  let descriptor;
  let changed = false;
  try {
    descriptor = fileOperations.openSync(path, FS_CONSTANTS.O_RDWR | noFollow);
    const stats = fileOperations.fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1
      || !sameIdentity(identityOf(stats), current.identity)) {
      throw serviceError("AUTOSTART_CONFLICT");
    }
    const bytes = Buffer.from(fileOperations.readFileSync(descriptor));
    if (!bytes.equals(current.bytes) || !isManagedArtifact(bytes, artifactKind)) {
      throw serviceError("AUTOSTART_CONFLICT");
    }
    fileOperations.ftruncateSync(descriptor, 0);
    changed = true;
    writeBuffer(descriptor, Buffer.from(contents, "utf8"), fileOperations);
    try { fileOperations.fchmodSync(descriptor, 0o600); } catch {}
    fileOperations.fsyncSync(descriptor);
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
    const committed = inspectRegular(path, fileOperations);
    if (committed.kind !== "file"
      || !sameIdentity(committed.identity, current.identity)) {
      throw serviceError("AUTOSTART_CONFLICT");
    }
    if (!committed.bytes.equals(Buffer.from(contents, "utf8"))) {
      throw serviceError("AUTOSTART_UPDATE_FAILED");
    }
    return current.bytes;
  } catch (error) {
    let restoreFailure = null;
    if (descriptor !== undefined) {
      if (changed) {
        try {
          fileOperations.ftruncateSync(descriptor, 0);
          writeBuffer(descriptor, current.bytes, fileOperations);
          fileOperations.fsyncSync(descriptor);
        } catch (caught) {
          restoreFailure = caught;
        }
      }
      try { fileOperations.closeSync(descriptor); } catch {}
    }
    if (restoreFailure) {
      throw serviceError("AUTOSTART_COMMITTED_DEGRADED", restoreFailure);
    }
    if (error instanceof CrpError) throw error;
    throw serviceError("AUTOSTART_UPDATE_FAILED", error);
  }
}

function publishManaged(path, contents, recoveryContents, artifactKind, fileOperations) {
  const parent = dirname(path);
  let descriptor;
  let identity = null;
  try {
    descriptor = fileOperations.openSync(path, "wx", 0o600);
    const stats = fileOperations.fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1) throw new Error("Startup artifact is unsafe.");
    identity = identityOf(stats);
    const bytes = Buffer.from(contents, "utf8");
    writeBuffer(descriptor, bytes, fileOperations);
    try { fileOperations.fchmodSync(descriptor, 0o600); } catch {}
    fileOperations.fsyncSync(descriptor);
    fileOperations.closeSync(descriptor);
    descriptor = undefined;
    const committed = inspectRegular(path, fileOperations);
    if (committed.kind !== "file"
      || !sameIdentity(committed.identity, identity)
      || !committed.bytes.equals(bytes)
      || !isManagedArtifact(committed.bytes, artifactKind)) {
      throw serviceError("AUTOSTART_CONFLICT");
    }
    fsyncDirectory(parent, fileOperations);
    return null;
  } catch (error) {
    if (descriptor !== undefined) {
      let recoveryFailure = null;
      try {
        const recoveryBytes = Buffer.from(recoveryContents, "utf8");
        fileOperations.ftruncateSync(descriptor, 0);
        writeBuffer(descriptor, recoveryBytes, fileOperations);
        fileOperations.fsyncSync(descriptor);
      } catch (caught) {
        recoveryFailure = caught;
      }
      try { fileOperations.closeSync(descriptor); } catch {}
      if (recoveryFailure) {
        throw serviceError("AUTOSTART_COMMITTED_DEGRADED", recoveryFailure);
      }
    }
    if (error instanceof CrpError) throw error;
    if (error?.code === "EEXIST") throw serviceError("AUTOSTART_CONFLICT", error);
    if (identity !== null && descriptor === undefined) {
      throw serviceError("AUTOSTART_COMMITTED_DEGRADED", error);
    }
    throw serviceError("AUTOSTART_UPDATE_FAILED", error);
  }
}

function writeManaged(path, contents, recoveryContents, artifactKind, fileOperations) {
  const parent = dirname(path);
  ensureSafeDirectory(parent, fileOperations);
  const current = inspectRegular(path, fileOperations);
  if (current.kind === "missing") {
    return publishManaged(path, contents, recoveryContents, artifactKind, fileOperations);
  }
  if (current.kind !== "file" || !isManagedArtifact(current.bytes, artifactKind)) {
    throw serviceError("AUTOSTART_CONFLICT", current.error);
  }
  return writeExistingManaged(path, current, contents, artifactKind, fileOperations);
}

export class AutoStartService {
  constructor({
    platform = process.platform,
    userHome = os.homedir(),
    crpHome = userHome,
    environment = process.env,
    nodePath = process.execPath,
    cliEntry = CLI_ENTRY,
    logPath = join(crpHome, ".codex-remote-proxy", "autostart.log"),
    fileOperations: overrides = {}
  } = {}) {
    this.fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...overrides };
    this.platform = platform;
    const resolvedUserHome = resolve(assertSafeText(userHome));
    const resolvedCrpHome = resolve(assertSafeText(crpHome));
    this.artifact = artifactFor({
      platform,
      userHome: resolvedUserHome,
      environment
    });
    if (this.artifact === null) {
      this.contents = null;
      this.disabledContents = null;
      return;
    }
    const resolvedNodePath = resolveExecutable(nodePath, this.fileOperations);
    const resolvedCliEntry = resolveExecutable(cliEntry, this.fileOperations);
    this.contents = artifactContents({
      artifact: this.artifact,
      nodePath: resolvedNodePath,
      cliEntry: resolvedCliEntry,
      crpHome: resolvedCrpHome,
      logPath: resolve(assertSafeText(logPath))
    });
    this.disabledContents = artifactContents({
      artifact: this.artifact,
      nodePath: resolvedNodePath,
      cliEntry: resolvedCliEntry,
      crpHome: resolvedCrpHome,
      logPath: resolve(assertSafeText(logPath)),
      enabled: false
    });
  }

  getStatus() {
    if (this.artifact === null || this.contents === null || this.disabledContents === null) {
      return { supported: false, enabled: false, state: "unavailable", platform: this.platform };
    }
    const file = inspectRegular(this.artifact.path, this.fileOperations);
    const link = inspectLink(this.artifact.linkPath, this.artifact.path, this.fileOperations);
    const fileMatches = file.kind === "file"
      && Buffer.compare(file.bytes, Buffer.from(this.contents, "utf8")) === 0;
    const fileManaged = file.kind === "file"
      && isManagedArtifact(file.bytes, this.artifact.kind);
    const disabledMatches = file.kind === "file"
      && Buffer.compare(file.bytes, Buffer.from(this.disabledContents, "utf8")) === 0;
    const linkMatches = link.kind === "not-required" || link.kind === "valid";
    const conflict = file.kind === "unsafe"
      || file.kind === "file" && !fileManaged
      || link.kind === "unsafe";
    const disabled = !conflict && (file.kind === "missing" || disabledMatches);
    return {
      supported: true,
      enabled: fileMatches && linkMatches,
      state: fileMatches && linkMatches
        ? "enabled"
        : disabled
          ? "disabled"
          : conflict ? "conflict" : "stale",
      platform: this.platform
    };
  }

  setEnabled(enabled) {
    if (typeof enabled !== "boolean") throw serviceError("AUTOSTART_UPDATE_FAILED");
    if (this.artifact === null || this.contents === null || this.disabledContents === null) {
      throw serviceError("AUTOSTART_UNAVAILABLE");
    }
    if (enabled) {
      const link = inspectLink(this.artifact.linkPath, this.artifact.path, this.fileOperations);
      if (link.kind === "unsafe") throw serviceError("AUTOSTART_CONFLICT", link.error);
      if (this.artifact.linkPath !== null) {
        ensureSafeDirectory(dirname(this.artifact.linkPath), this.fileOperations);
      }
      writeManaged(
        this.artifact.path,
        this.contents,
        this.disabledContents,
        this.artifact.kind,
        this.fileOperations
      );
      if (this.artifact.linkPath !== null && link.kind === "missing") {
        try {
          this.fileOperations.symlinkSync(this.artifact.path, this.artifact.linkPath);
          fsyncDirectory(dirname(this.artifact.linkPath), this.fileOperations);
        } catch (error) {
          try {
            writeManaged(
              this.artifact.path,
              this.disabledContents,
              this.disabledContents,
              this.artifact.kind,
              this.fileOperations
            );
          } catch {}
          if (error?.code === "EEXIST") throw serviceError("AUTOSTART_CONFLICT", error);
          throw serviceError("AUTOSTART_UPDATE_FAILED", error);
        }
      }
    } else {
      const file = inspectRegular(this.artifact.path, this.fileOperations);
      const link = inspectLink(this.artifact.linkPath, this.artifact.path, this.fileOperations);
      if (file.kind === "unsafe"
        || file.kind === "file" && !isManagedArtifact(file.bytes, this.artifact.kind)
        || link.kind === "unsafe") {
        throw serviceError("AUTOSTART_CONFLICT", file.error ?? link.error);
      }
      if (file.kind !== "missing" || link.kind === "valid") {
        writeManaged(
          this.artifact.path,
          this.disabledContents,
          this.disabledContents,
          this.artifact.kind,
          this.fileOperations
        );
      }
    }
    return this.getStatus();
  }
}
