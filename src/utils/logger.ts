import { appendFile } from "node:fs/promises";
import path from "node:path";

import { APP_DIR } from "./fs.js";

const RUNTIME_LOG = path.join(APP_DIR, "runtime.log");

export async function logLine(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await appendFile(RUNTIME_LOG, line, "utf8");
  } catch {
    // Logging should never break command execution.
  }
}
