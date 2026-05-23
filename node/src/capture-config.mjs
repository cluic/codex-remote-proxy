import os from "node:os";
import { resolve } from "node:path";

export const DEFAULT_CAPTURE_DB_PATH = resolve(os.homedir(), ".codex-remote-proxy", "traffic.sqlite3");
