import { randomUUID } from "node:crypto";

import type { CodexSession, ScheduledJob, ScheduleMode, UsageSnapshot } from "../types.js";
import { resolveResumeTarget } from "../codex/CodexRunner.js";
import { createDefaultScheduler, type SchedulerAdapter } from "../daemon/DaemonService.js";
import { LoopService } from "../loops/LoopService.js";
import { JobStore } from "./JobStore.js";
import { TmuxRunner } from "../tmux/TmuxRunner.js";
import { logLine } from "../utils/logger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SchedulerService {
  constructor(
    private readonly jobStore = new JobStore(),
    private readonly tmuxRunner = new TmuxRunner(),
    private readonly launchdScheduler: SchedulerAdapter = createDefaultScheduler(),
    private readonly loopService = new LoopService(),
  ) {}

  async scheduleJob(input: {
    session: CodexSession;
    message: string;
    scheduledAt: Date;
    scheduleMode?: ScheduleMode;
    usageSnapshot?: UsageSnapshot;
  }): Promise<ScheduledJob> {
    const job: ScheduledJob = {
      id: randomUUID(),
      sessionId: input.session.id,
      sessionLabel: input.session.label,
      projectPath: input.session.projectPath,
      message: input.message,
      scheduledAt: input.scheduledAt.toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
      scheduleMode: input.scheduleMode ?? "custom",
      usageSnapshot: input.usageSnapshot,
    };

    await this.jobStore.create(job);
    await this.launchdScheduler.refreshSchedule().catch(() => undefined);
    await logLine(`Scheduled job ${job.id} for session ${job.sessionId}`);
    return job;
  }

  async listJobs(): Promise<ScheduledJob[]> {
    return this.jobStore.list();
  }

  async cancelJob(jobId: string): Promise<ScheduledJob> {
    const cancelled = await this.jobStore.update(jobId, (job) => {
      if (job.status !== "pending") {
        throw new Error(`Only pending jobs can be cancelled. Current status: ${job.status}`);
      }

      return {
        ...job,
        status: "cancelled",
      };
    });
    await this.launchdScheduler.refreshSchedule().catch(() => undefined);
    return cancelled;
  }

  async runDueJobs(now = new Date()): Promise<ScheduledJob[]> {
    const dueJobs = await this.jobStore.pendingDue(now);
    const completed: ScheduledJob[] = [];

    for (const job of dueJobs) {
      completed.push(await this.runSingleJob(job));
    }

    await this.loopService.replenishDueLoops(now).catch(() => undefined);
    await this.launchdScheduler.refreshSchedule().catch(() => undefined);

    return completed;
  }

  private async runSingleJob(job: ScheduledJob): Promise<ScheduledJob> {
    const tmuxSessionName = `codex-message-schdeuler-${job.id}`;
    let readySnapshot = "";
    let submitKey = "";

    try {
      await this.jobStore.update(job.id, (current) => ({
        ...current,
        tmuxSessionName,
      }));

      const target = resolveResumeTarget({
        id: job.sessionId,
        label: job.sessionLabel,
        projectPath: job.projectPath,
        source: "job",
      });

      const codexArgs = ["resume", "--no-alt-screen"];
      if (target.mode === "last") {
        codexArgs.push("--last");
      } else if (target.sessionId) {
        codexArgs.push(target.sessionId);
      }

      await this.tmuxRunner.startDetachedSession(tmuxSessionName, codexArgs, target.projectPath);
      readySnapshot = await this.tmuxRunner.waitForReady(tmuxSessionName);
      const submission = await this.tmuxRunner.sendMessage(tmuxSessionName, job.message);
      submitKey = submission.submitKey;
      await sleep(1000);
      const postSendSnapshot = submission.snapshot;

      const updated = await this.jobStore.update(job.id, (current) => ({
        ...current,
        status: "sent",
        sentAt: new Date().toISOString(),
        error: undefined,
      }));

      await this.tmuxRunner.persistExecutionLog({
        jobId: job.id,
        tmuxSessionName,
        sessionId: job.sessionId,
        sessionLabel: job.sessionLabel,
        projectPath: job.projectPath,
        scheduledAt: job.scheduledAt,
        sentAt: updated.sentAt,
        message: job.message,
        readySnapshot,
        postSendSnapshot: `${postSendSnapshot}\n\n[submitKey=${submitKey}]`,
        status: "sent",
      });

      await logLine(`Sent job ${job.id}`);
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = await this.jobStore.update(job.id, (current) => ({
        ...current,
        status: "failed",
        error: message,
      }));

      const postFailureSnapshot = job.tmuxSessionName
        ? await this.tmuxRunner.capturePane(tmuxSessionName).catch(() => "")
        : "";

      await this.tmuxRunner.persistExecutionLog({
        jobId: job.id,
        tmuxSessionName,
        sessionId: job.sessionId,
        sessionLabel: job.sessionLabel,
        projectPath: job.projectPath,
        scheduledAt: job.scheduledAt,
        message: job.message,
        readySnapshot,
        postSendSnapshot: postFailureSnapshot,
        status: "failed",
        error: message,
      });

      await logLine(`Failed job ${job.id}: ${message}`);
      return updated;
    }
  }
}
