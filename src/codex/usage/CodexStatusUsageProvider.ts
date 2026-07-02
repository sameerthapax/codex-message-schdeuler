import { randomUUID } from "node:crypto";

import { resolveResumeTarget } from "../CodexRunner.js";
import type { CodexSession } from "../../types.js";
import { logLine } from "../../utils/logger.js";
import { TmuxRunner } from "../../tmux/TmuxRunner.js";
import { parseCodexStatus } from "./parseCodexStatus.js";
import type { CodexUsage, UsageProvider } from "./UsageProvider.js";

export class CodexStatusUsageProvider implements UsageProvider {
  constructor(
    private readonly tmuxRunner = new TmuxRunner(),
    private readonly debug = process.env.CODEX_SCHEDULER_DEBUG_TMUX === "1",
  ) {}

  async getUsageForSession(input: {
    sessionId: string;
    projectPath?: string;
  }): Promise<CodexUsage> {
    const tmuxSessionName = `codex-message-schdeuler-status-${randomUUID().slice(0, 8)}`;
    const session: CodexSession = {
      id: input.sessionId,
      label: input.sessionId,
      projectPath: input.projectPath,
      source: "usage-provider",
    };
    const target = resolveResumeTarget(session);
    const codexArgs = ["resume", "--no-alt-screen"];
    if (target.mode === "last") {
      codexArgs.push("--last");
    } else if (target.sessionId) {
      codexArgs.push(target.sessionId);
    }

    let snapshot = "";

    try {
      await logLine(`Reading /status via temporary tmux session ${tmuxSessionName}`);
      await this.tmuxRunner.startDetachedSession(tmuxSessionName, codexArgs, target.projectPath);
      await this.tmuxRunner.waitForReady(tmuxSessionName);
      const submitResult = await this.tmuxRunner.sendPromptCommand(tmuxSessionName, "/status");
      await logLine(
        `Submitted /status via ${tmuxSessionName} using ${submitResult.submitKey}`,
      );
      snapshot = await this.tmuxRunner.waitForPaneMatch(
        tmuxSessionName,
        /5h limit:|weekly limit:|limits may be stale/i,
        45000,
      );
      const usage = parseCodexStatus(snapshot);

      if (!usage.fiveHourReset && !usage.weeklyReset) {
        throw new Error(
          `Could not parse reset times from Codex /status output.\n${extractRelevantStatusSnippet(snapshot)}`,
        );
      }

      return usage;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latestSnapshot =
        snapshot || (await this.tmuxRunner.capturePane(tmuxSessionName).catch(() => ""));
      await logLine(
        [
          `Status capture failed for session ${input.sessionId} via tmux ${tmuxSessionName}: ${message}`,
          "Status snapshot:",
          latestSnapshot.trim() || "(empty)",
        ].join("\n"),
      );
      throw error;
    } finally {
      if (!this.debug) {
        await this.tmuxRunner.killSession(tmuxSessionName).catch(() => undefined);
      }
    }
  }
}

function extractRelevantStatusSnippet(snapshot: string): string {
  const relevant = snapshot
    .split("\n")
    .filter((line) => /5h limit:|weekly limit:|stale/i.test(line))
    .slice(-4);

  return relevant.length > 0 ? relevant.join("\n") : "(no /status lines found)";
}
