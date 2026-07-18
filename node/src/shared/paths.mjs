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
    secretFallbackPath: resolve(globalHome, "secrets.json"),
    statePath: resolve(globalHome, "state.json"),
    controlTokenPath: resolve(globalHome, "control-token"),
    activityPath: resolve(globalHome, "activity.jsonl"),
    logPath: resolve(globalHome, "supervisor.log"),
    codexConfigPath: resolve(resolvedHome, ".codex", "config.toml"),
    authPath: resolve(resolvedHome, ".codex", "auth.json")
  };
}
