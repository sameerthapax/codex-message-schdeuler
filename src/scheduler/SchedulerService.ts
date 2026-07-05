import { randomUUID } from "node:crypto";

import type { CodexSession, ScheduledJob, ScheduleMode, SleepPolicy, UsageSnapshot } from "../types.js";
import { resolveResumeTarget } from "../codex/CodexRunner.js";
import { createDefaultScheduler, type SchedulerAdapter } from "../daemon/DaemonService.js";
import { LoopService } from "../loops/LoopService.js";
import { JobStore } from "./JobStore.js";
import { TmuxRunner } from "../tmux/TmuxRunner.js";
import { logLine } from "../utils/logger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SLEEP_SKIP_GRACE_MS = 15 * 60 * 1000;

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
    sleepPolicy?: SleepPolicy;
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
      sleepPolicy: input.sleepPolicy ?? "wake_mac_if_possible",
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

  async runDueJobs(
    now = new Date(),
    options: { refreshSchedule?: boolean } = {},
  ): Promise<ScheduledJob[]> {
    const dueJobs = await this.jobStore.pendingDue(now);
    const completed: ScheduledJob[] = [];

    for (const job of dueJobs) {
      if (shouldSkipForCatchUpOnWake(job, now)) {
        completed.push(await this.skipSingleJob(job, now));
        continue;
      }

      completed.push(await this.runSingleJob(job));
    }

    await this.loopService.replenishDueLoops(now, {
      refreshSchedule: options.refreshSchedule,
    }).catch(() => undefined);
    if (options.refreshSchedule !== false) {
      await this.launchdScheduler.refreshSchedule().catch(() => undefined);
    }

    return completed;
  }

  private async skipSingleJob(job: ScheduledJob, now: Date): Promise<ScheduledJob> {
    const overdueMs = Math.max(0, now.getTime() - new Date(job.scheduledAt).getTime());
    const reason = `Skipped because the job was overdue by ${formatDuration(overdueMs)} and sleep policy is catch_up_on_wake.`;
    const updated = await this.jobStore.update(job.id, (current) => ({
      ...current,
      status: "skipped_due_to_mac_sleep",
      error: reason,
    }));

    await this.tmuxRunner.persistExecutionLog({
      jobId: job.id,
      tmuxSessionName: job.tmuxSessionName || "(not started)",
      sessionId: job.sessionId,
      sessionLabel: job.sessionLabel,
      projectPath: job.projectPath,
      scheduledAt: job.scheduledAt,
      message: job.message,
      sleepPolicy: job.sleepPolicy,
      status: "skipped_due_to_mac_sleep",
      error: reason,
      skipReason: reason,
      readySnapshot: "",
      postSendSnapshot: "",
    });

    await logLine(`Skipped job ${job.id}: ${reason}`);
    return updated;
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
      const submission = await this.tmuxRunner.sendMessage(tmuxSessionName, job.message, readySnapshot);
      submitKey = submission.submitKey;
      await sleep(1000);
      const postSendSnapshot = submission.snapshot;

      if (!submission.accepted) {
        const updated = await this.jobStore.update(job.id, (current) => ({
          ...current,
          status: "not_sure",
          error: submission.acceptanceReason,
        }));

        await this.tmuxRunner.persistExecutionLog({
          jobId: job.id,
          tmuxSessionName,
          sessionId: job.sessionId,
          sessionLabel: job.sessionLabel,
          projectPath: job.projectPath,
          scheduledAt: job.scheduledAt,
          message: job.message,
          sleepPolicy: job.sleepPolicy,
          readySnapshot,
          postSendSnapshot: `${postSendSnapshot}\n\n[submitKey=${submitKey}]`,
          status: "not_sure",
          error: submission.acceptanceReason,
          deliveryEvidence: submission.acceptanceReason,
        });

        await logLine(`Not sure whether job ${job.id} was accepted by Codex: ${submission.acceptanceReason}`);
        return updated;
      }

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
        sleepPolicy: job.sleepPolicy,
        readySnapshot,
        postSendSnapshot: `${postSendSnapshot}\n\n[submitKey=${submitKey}]`,
        status: "sent",
        deliveryEvidence: submission.acceptanceReason,
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
        sleepPolicy: job.sleepPolicy,
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

function shouldSkipForCatchUpOnWake(job: ScheduledJob, now: Date): boolean {
  if (job.sleepPolicy !== "catch_up_on_wake") {
    return false;
  }

  return now.getTime() - new Date(job.scheduledAt).getTime() > SLEEP_SKIP_GRACE_MS;
}

function formatDuration(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }

  if (minutes === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
}
