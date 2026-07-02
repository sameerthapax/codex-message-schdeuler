import { spawn } from "node:child_process";

import type { SessionPreference } from "../config/AppConfigStore.js";
import type { CodexSession } from "../types.js";
import { discoverSessionProviderForPreference } from "./discoverSessions.js";

export async function createNewCodexSession(
  existingSessions: CodexSession[],
  preference: SessionPreference,
): Promise<CodexSession> {
  const existingIds = new Set(existingSessions.map((session) => session.id));

  await runInteractiveCodex();

  const provider = await discoverSessionProviderForPreference(preference);
  const updatedSessions = await provider.listSessions();
  const created = updatedSessions.find((session) => !existingIds.has(session.id));
  if (created) {
    return created;
  }

  const latest = updatedSessions[0];
  if (!latest) {
    throw new Error("No Codex session was detected after creating a new session.");
  }

  if (existingIds.has(latest.id)) {
    throw new Error("No new Codex session was detected. Open a new session in Codex, then return.");
  }

  return latest;
}

function runInteractiveCodex(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["--no-alt-screen"], {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if ((code ?? 0) === 0) {
        resolve();
        return;
      }

      reject(new Error(`codex exited with status ${code ?? "unknown"}`));
    });
  });
}
