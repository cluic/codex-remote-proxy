import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSupervisor } from "./supervisor.mjs";

export function isDirectExecution(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  return resolve(fileURLToPath(metaUrl)) === resolve(argv1);
}

export async function runSupervisor({
  processRef = process,
  createSupervisorImpl = createSupervisor,
  supervisorOptions = {}
} = {}) {
  const supervisor = await createSupervisorImpl(supervisorOptions);
  let shutdownPromise = null;

  const removeSignalHandlers = () => {
    processRef.off("SIGTERM", onSignal);
    processRef.off("SIGINT", onSignal);
  };
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = Promise.resolve(supervisor.close())
      .then(
        () => {
          removeSignalHandlers();
          processRef.exitCode = 0;
        },
        () => {
          removeSignalHandlers();
          processRef.exitCode = 1;
        }
      );
    return shutdownPromise;
  };
  const onSignal = () => {
    void shutdown();
  };

  processRef.once("SIGTERM", onSignal);
  processRef.once("SIGINT", onSignal);
  try {
    await supervisor.listen();
    return supervisor;
  } catch (error) {
    removeSignalHandlers();
    await supervisor.close().catch(() => {});
    throw error;
  }
}

if (isDirectExecution()) {
  const home = typeof process.env.CRP_HOME === "string" && process.env.CRP_HOME.length > 0
    ? process.env.CRP_HOME
    : undefined;
  void runSupervisor({ supervisorOptions: { home } }).catch(() => {
    process.stderr.write("CRP supervisor failed to start.\n");
    process.exitCode = 1;
  });
}
