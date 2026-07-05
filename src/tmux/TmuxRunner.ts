import { writeFile } from "node:fs/promises";
import os from "node:os";

import { LOG_DIR } from "../utils/fs.js";
import { resolveExecutable, runCommand } from "../utils/shell.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TmuxRunner {
  async startDetachedSession(
    tmuxSessionName: string,
    codexArgs: string[],
    cwd?: string,
  ): Promise<void> {
    const tmuxPath = await resolveExecutable("tmux");
    const codexPath = await resolveExecutable("codex");
    const args = ["new-session", "-d", "-s", tmuxSessionName];
    if (cwd) {
      args.push("-c", cwd);
    } else {
      args.push("-c", os.homedir());
    }
    args.push(codexPath, ...codexArgs);

    const result = await runCommand(tmuxPath, args, { timeoutMs: 10000 });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to start tmux session.");
    }
  }

  async waitForReady(tmuxSessionName: string, timeoutMs = 30000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let previousCapture = "";
    let stableCount = 0;
    let lastCapture = "";

    while (Date.now() < deadline) {
      await sleep(2000);
      lastCapture = await this.capturePane(tmuxSessionName);

      if (lastCapture.trim().length === 0) {
        continue;
      }

      if (lastCapture === previousCapture) {
        stableCount += 1;
      } else {
        stableCount = 0;
      }

      if (stableCount >= 1) {
        return lastCapture;
      }

      previousCapture = lastCapture;
    }

    return lastCapture;
  }

  async sendMessage(
    tmuxSessionName: string,
    message: string,
    baselineSnapshot = "",
  ): Promise<{ snapshot: string; submitKey: string; accepted: boolean; acceptanceReason: string }> {
    const submitted = await this.sendPromptCommand(tmuxSessionName, message);
    const verified = await this.verifyAcceptedSubmission(tmuxSessionName, message, baselineSnapshot, submitted.snapshot);
    return {
      snapshot: verified.snapshot,
      submitKey: submitted.submitKey,
      accepted: verified.accepted,
      acceptanceReason: verified.reason,
    };
  }

  async sendLiteral(tmuxSessionName: string, text: string): Promise<void> {
    const tmuxPath = await resolveExecutable("tmux");
    const literalResult = await runCommand(
      tmuxPath,
      ["send-keys", "-t", tmuxSessionName, "-l", "--", text],
      { timeoutMs: 10000 },
    );
    if (literalResult.exitCode !== 0) {
      throw new Error(literalResult.stderr.trim() || "Failed to send tmux message text.");
    }
  }

  async submit(tmuxSessionName: string, key = "Enter"): Promise<void> {
    const tmuxPath = await resolveExecutable("tmux");
    const submitResult = await runCommand(
      tmuxPath,
      ["send-keys", "-t", tmuxSessionName, key],
      { timeoutMs: 10000 },
    );
    if (submitResult.exitCode !== 0) {
      throw new Error(submitResult.stderr.trim() || "Failed to submit tmux message.");
    }
  }

  async capturePane(tmuxSessionName: string): Promise<string> {
    const tmuxPath = await resolveExecutable("tmux");
    const result = await runCommand(
      tmuxPath,
      ["capture-pane", "-p", "-S", "-200", "-t", tmuxSessionName],
      { timeoutMs: 10000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to capture tmux pane.");
    }
    return result.stdout;
  }

  async waitForPaneChange(tmuxSessionName: string, timeoutMs = 12000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const baseline = await this.capturePane(tmuxSessionName).catch(() => "");
    let lastCapture = baseline;

    while (Date.now() < deadline) {
      await sleep(1000);
      lastCapture = await this.capturePane(tmuxSessionName);
      if (lastCapture.trim() && lastCapture !== baseline) {
        return lastCapture;
      }
    }

    return lastCapture;
  }

  async waitForPaneMatch(
    tmuxSessionName: string,
    matcher: RegExp,
    timeoutMs = 20000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastCapture = await this.capturePane(tmuxSessionName).catch(() => "");

    while (Date.now() < deadline) {
      if (matcher.test(lastCapture)) {
        return lastCapture;
      }

      await sleep(1000);
      lastCapture = await this.capturePane(tmuxSessionName);
    }

    return lastCapture;
  }

  async killSession(tmuxSessionName: string): Promise<void> {
    const tmuxPath = await resolveExecutable("tmux");
    const result = await runCommand(
      tmuxPath,
      ["kill-session", "-t", tmuxSessionName],
      { timeoutMs: 10000 },
    );
    if (result.exitCode !== 0 && !/can't find session|no such session/i.test(result.stderr)) {
      throw new Error(result.stderr.trim() || "Failed to stop tmux session.");
    }
  }

  async persistLog(jobId: string, tmuxSessionName: string): Promise<string> {
    const logOutput = await this.capturePane(tmuxSessionName);
    const logPath = `${LOG_DIR}/${jobId}.log`;
    await writeFile(logPath, logOutput, "utf8");
    return logPath;
  }

  async persistExecutionLog(input: {
    jobId: string;
    tmuxSessionName: string;
    sessionId: string;
    sessionLabel: string;
    projectPath?: string;
    scheduledAt: string;
    sentAt?: string;
    message: string;
    sleepPolicy?: string;
    readySnapshot?: string;
    postSendSnapshot?: string;
    status: "sent" | "failed" | "skipped_due_to_mac_sleep" | "not_sure";
    error?: string;
    skipReason?: string;
    deliveryEvidence?: string;
  }): Promise<string> {
    const logPath = `${LOG_DIR}/${input.jobId}.log`;
    const sections = [
      `jobId: ${input.jobId}`,
      `status: ${input.status}`,
      `sessionId: ${input.sessionId}`,
      `sessionLabel: ${input.sessionLabel}`,
      `tmuxSessionName: ${input.tmuxSessionName}`,
      `projectPath: ${input.projectPath || "(none)"}`,
      `scheduledAt: ${input.scheduledAt}`,
      `sentAt: ${input.sentAt || "(not sent)"}`,
      `sleepPolicy: ${input.sleepPolicy || "(default)"}`,
      `message: ${input.message}`,
      input.error ? `error: ${input.error}` : undefined,
      input.skipReason ? `skipReason: ${input.skipReason}` : undefined,
      input.deliveryEvidence ? `deliveryEvidence: ${input.deliveryEvidence}` : undefined,
      "",
      "=== Ready Snapshot ===",
      input.readySnapshot?.trimEnd() || "(empty)",
      "",
      "=== Post-Send Snapshot ===",
      input.postSendSnapshot?.trimEnd() || "(empty)",
      "",
    ].filter((value): value is string => value !== undefined);

    await writeFile(logPath, sections.join("\n"), "utf8");
    return logPath;
  }

  async sendPromptCommand(
    tmuxSessionName: string,
    command: string,
  ): Promise<{ snapshot: string; submitKey: string }> {
    await this.sendLiteral(tmuxSessionName, command);

    const submitKeys = ["C-m", "Enter", "C-j"];
    let lastSnapshot = "";

    for (const submitKey of submitKeys) {
      await this.submit(tmuxSessionName, submitKey);

      await sleep(1500);
      lastSnapshot = await this.capturePane(tmuxSessionName);
      if (!draftStillVisible(lastSnapshot, command)) {
        return {
          snapshot: lastSnapshot,
          submitKey,
        };
      }
    }

    throw new Error(
      `Message was typed but does not appear to have been submitted. Draft is still visible after submit attempts. Last snapshot:\n${lastSnapshot}`,
    );
  }

  private async verifyAcceptedSubmission(
    tmuxSessionName: string,
    message: string,
    baselineSnapshot: string,
    initialSnapshot: string,
    timeoutMs = 15000,
  ): Promise<{ snapshot: string; accepted: boolean; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot = initialSnapshot;
    let lastReason = analyzeSubmissionSnapshot(initialSnapshot, baselineSnapshot, message).reason;

    while (Date.now() < deadline) {
      const analysis = analyzeSubmissionSnapshot(lastSnapshot, baselineSnapshot, message);
      if (analysis.accepted) {
        return {
          snapshot: lastSnapshot,
          accepted: true,
          reason: analysis.reason,
        };
      }

      lastReason = analysis.reason;
      await sleep(1000);
      lastSnapshot = await this.capturePane(tmuxSessionName);
    }

    return {
      snapshot: lastSnapshot,
      accepted: false,
      reason: lastReason,
    };
  }
}

function draftStillVisible(snapshot: string, message: string): boolean {
  const lines = snapshot.split("\n");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("›") || trimmed.startsWith(">")) {
      const promptValue = trimmed.slice(1).trim();
      return promptValue === message.trim();
    }
  }

  return false;
}

export function analyzeSubmissionSnapshot(
  snapshot: string,
  baselineSnapshot: string,
  message: string,
): { accepted: boolean; reason: string } {
  const trimmedSnapshot = snapshot.trim();
  const trimmedMessage = message.trim();

  if (!trimmedSnapshot) {
    return {
      accepted: false,
      reason: "Pane snapshot is empty after submit.",
    };
  }

  if (snapshot === baselineSnapshot) {
    return {
      accepted: false,
      reason: "Pane snapshot did not change after submit.",
    };
  }

  if (/\bWorking\b/i.test(snapshot) || /esc to interrupt/i.test(snapshot)) {
    return {
      accepted: true,
      reason: "Codex shows a working state after the submitted message.",
    };
  }

  const lines = snapshot.split("\n").map((line) => line.trimEnd());
  const messagePromptIndex = findLastPromptIndex(lines, trimmedMessage);
  const tailLines = (messagePromptIndex >= 0 ? lines.slice(messagePromptIndex + 1) : lines.slice(-8))
    .map((line) => line.trim())
    .filter(Boolean);

  const assistantReply = tailLines.find((line) => {
    if (!/^•\s+/.test(line)) {
      return false;
    }

    const reply = line.replace(/^•\s+/, "").trim();
    return reply.length > 0 && reply.toLowerCase() !== trimmedMessage.toLowerCase();
  });

  if (assistantReply) {
    return {
      accepted: true,
      reason: `Codex replied after the submitted message: ${assistantReply}`,
    };
  }

  const nonPromptReply = tailLines.find((line) => {
    if (isPromptLine(line)) {
      return false;
    }

    if (/^tab to queue message/i.test(line) || /context left$/i.test(line)) {
      return false;
    }

    return line.toLowerCase() !== trimmedMessage.toLowerCase();
  });

  if (nonPromptReply) {
    return {
      accepted: true,
      reason: `Codex output appeared after the submitted message: ${nonPromptReply}`,
    };
  }

  if (messagePromptIndex >= 0) {
    return {
      accepted: false,
      reason: "Only the submitted prompt is visible; no Codex reply or working state appeared.",
    };
  }

  return {
    accepted: false,
    reason: "Could not find visible evidence that Codex accepted the submitted message.",
  };
}

function findLastPromptIndex(lines: string[], message: string): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!isPromptLine(lines[index])) {
      continue;
    }

    if (stripPrompt(lines[index]).trim() === message) {
      return index;
    }
  }

  return -1;
}

function isPromptLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("›") || trimmed.startsWith(">");
}

function stripPrompt(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("›") || trimmed.startsWith(">")) {
    return trimmed.slice(1).trim();
  }
  return trimmed;
}
