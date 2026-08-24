import os from "node:os";
import { resolve } from "node:path";

export function getPaths(home = os.homedir()) {
  const resolvedHome = resolve(home);
  const globalHome = resolve(resolvedHome, ".codex-remote-proxy");

  return {
    globalHome,
    registryPath: resolve(globalHome, "providers.json"),
    modelCachePath: resolve(globalHome, "provider-model-cache.json"),
    metricsPath: resolve(globalHome, "metrics.json"),
    accessKeyDbPath: resolve(globalHome, "access-keys.sqlite3"),
    localAccessTokenPath: resolve(globalHome, "local-access-token"),
    cliPreferencesPath: resolve(globalHome, "cli-preferences.json"),
    secretFallbackPath: resolve(globalHome, "secrets.json"),
    statePath: resolve(globalHome, "state.json"),
    controlTokenPath: resolve(globalHome, "control-token"),
    activityPath: resolve(globalHome, "activity.jsonl"),
    logPath: resolve(globalHome, "supervisor.log"),
    codexConfigPath: resolve(resolvedHome, ".codex", "config.toml"),
    authPath: resolve(resolvedHome, ".codex", "auth.json")
  };
}
