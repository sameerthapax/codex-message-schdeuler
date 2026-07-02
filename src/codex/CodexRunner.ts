import type { CodexSession } from "../types.js";

export function resolveResumeTarget(session: CodexSession): {
  sessionId?: string;
  projectPath?: string;
  mode: "session-id" | "last";
} {
  if (session.id === "__latest__") {
    return {
      mode: "last",
    };
  }

  return {
    sessionId: session.id,
    projectPath: session.projectPath,
    mode: "session-id",
  };
}
