import {
  PROTOCOL_VERSION,
  validateParentMessage
} from "../../src/worker/protocol.mjs";

const modes = new Set((process.env.CRP_FAKE_WORKER_MODES ?? "")
  .split(",")
  .map((mode) => mode.trim())
  .filter(Boolean));

let generation = 0;
let phase = "ready";
let listening = false;
let listenHost = null;
let listenPort = null;

function state() {
  return {
    phase,
    configured: generation > 0,
    generation,
    listening,
    listenHost,
    listenPort,
    inFlight: 0
  };
}

function send(message) {
  if (process.connected) process.send(message);
}

function lifecycle(type, requestId) {
  send({ version: PROTOCOL_VERSION, type, requestId, state: state() });
}

function handleMessage(rawMessage) {
  let message;
  try {
    message = validateParentMessage(rawMessage);
  } catch {
    send({
      version: PROTOCOL_VERSION,
      type: "fatal",
      requestId: "worker-fatal",
      error: {
        code: "WORKER_PROTOCOL_INVALID",
        message: "Worker protocol message is invalid."
      }
    });
    return;
  }

  if (message.type === "configure") {
    if (modes.has("no-configure")) return;
    generation = message.generation;
    phase = "running";
    listening = true;
    listenHost = message.settings.server.host;
    listenPort = message.settings.server.port;
    lifecycle("configured", message.requestId);
    if (modes.has("exit-after-configure")) process.exit(23);
    return;
  }
  if (message.type === "status") {
    lifecycle("status", message.requestId);
    return;
  }
  if (message.type === "drain") {
    if (modes.has("no-drain")) return;
    phase = "drained";
    listening = false;
    listenHost = null;
    listenPort = null;
    lifecycle("drained", message.requestId);
    return;
  }
  if (!modes.has("no-shutdown")) process.exit(0);
}

process.on("message", handleMessage);
process.on("SIGTERM", () => {
  if (!modes.has("ignore-term")) process.exit(0);
});

if (!modes.has("no-ready")) lifecycle("ready", "worker-ready");

if (modes.has("malformed-secret")) {
  setImmediate(() => {
    send({
      version: PROTOCOL_VERSION,
      type: "status",
      requestId: "malformed-secret",
      state: { ...state(), apiKey: "fixture-secret-must-not-pass" }
    });
  });
}

if (modes.has("late-message")) {
  process.once("disconnect", () => {
    lifecycle("status", "late-after-disconnect");
  });
}
