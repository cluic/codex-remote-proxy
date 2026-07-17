import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createStartupFailureMessage } from "../shared/errors.mjs";
import { createSupervisor } from "./supervisor.mjs";

const STARTUP_SEND_TIMEOUT_MS = 250;

function disconnectStartupChannel(processRef) {
  if (typeof processRef.disconnect !== "function" || processRef.connected === false) return;
  try { processRef.disconnect(); } catch {}
}

async function reportStartupFailure(processRef, error) {
  if (typeof processRef.send !== "function" || processRef.connected === false) return;
  const message = createStartupFailureMessage(error);
  await new Promise((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(finish, STARTUP_SEND_TIMEOUT_MS);
    try {
      processRef.send(message, undefined, undefined, finish);
    } catch {
      finish();
    }
  });
}

export function isDirectExecution(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  return resolve(fileURLToPath(metaUrl)) === resolve(argv1);
}

export async function runSupervisor({
  processRef = process,
  createSupervisorImpl = createSupervisor,
  supervisorOptions = {}
} = {}) {
  let supervisor;
  try {
    supervisor = await createSupervisorImpl(supervisorOptions);
  } catch (error) {
    await reportStartupFailure(processRef, error);
    disconnectStartupChannel(processRef);
    throw error;
  }
  let shutdownPromise = null;

  const removeSignalHandlers = () => {
    processRef.off("SIGTERM", onSignal);
    processRef.off("SIGINT", onSignal);
  };
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    let requested;
    try {
      requested = typeof supervisor.requestShutdown === "function"
        ? supervisor.requestShutdown()
        : supervisor.close();
    } catch (error) {
      requested = Promise.reject(error);
    }
    shutdownPromise = Promise.resolve(requested)
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
    disconnectStartupChannel(processRef);
    return supervisor;
  } catch (error) {
    removeSignalHandlers();
    await supervisor.close().catch(() => {});
    await reportStartupFailure(processRef, error);
    disconnectStartupChannel(processRef);
    throw error;
  }
}

if (isDirectExecution()) {
  const home = typeof process.env.CRP_HOME === "string" && process.env.CRP_HOME.length > 0
    ? process.env.CRP_HOME
    : undefined;
  void runSupervisor({ supervisorOptions: { home } }).catch((error) => {
    const code = createStartupFailureMessage(error).error.code;
    process.stderr.write(`CRP supervisor failed to start (${code}).\n`);
    process.exitCode = 1;
  });
}
