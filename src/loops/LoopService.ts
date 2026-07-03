import { randomUUID } from "node:crypto";
import { addDays, addHours, addWeeks } from "date-fns";

import { createDefaultScheduler, type SchedulerAdapter } from "../daemon/DaemonService.js";
import { JobStore } from "../scheduler/JobStore.js";
import { formatScheduledTime } from "../scheduler/timeParser.js";
import type { CodexSession, LoopCadence, ScheduledJob, ScheduledLoop } from "../types.js";
import { logLine } from "../utils/logger.js";
import { LoopStore } from "./LoopStore.js";

export class LoopService {
  constructor(
    private readonly loopStore = new LoopStore(),
    private readonly jobStore = new JobStore(),
    private readonly launchdScheduler: SchedulerAdapter = createDefaultScheduler(),
  ) {}

  async createLoop(input: {
    session: CodexSession;
    cadence: LoopCadence;
    startAt: Date;
  }): Promise<ScheduledLoop> {
    const loop: ScheduledLoop = {
      id: randomUUID(),
      sessionId: input.session.id,
      sessionLabel: input.session.label,
      projectPath: input.session.projectPath,
      cadence: input.cadence,
      anchorAt: input.startAt.toISOString(),
      message: "hi",
      status: "active",
      createdAt: new Date().toISOString(),
    };

    await this.loopStore.create(loop);
    await this.ensureFutureJobsForLoop(loop, new Date());
    await this.launchdScheduler.refreshSchedule().catch(() => undefined);
    await logLine(
      `Created loop ${loop.id} (${loop.cadence}) for session ${loop.sessionId} starting ${loop.anchorAt}`,
    );
    return (await this.loopStore.getById(loop.id)) ?? loop;
  }

  async listLoops(): Promise<ScheduledLoop[]> {
    return this.loopStore.list();
  }

  async cancelLoop(loopId: string): Promise<ScheduledLoop> {
    const loop = await this.loopStore.update(loopId, (current) => ({
      ...current,
      status: "cancelled",
    }));

    const jobs = await this.jobStore.list();
    let changed = false;
    const updatedJobs = jobs.map((job) => {
      if (job.loopId === loopId && job.status === "pending") {
        changed = true;
        return {
          ...job,
          status: "cancelled" as const,
          error: "Loop cancelled.",
        };
      }

      return job;
    });

    if (changed) {
      await this.jobStore.saveAll(updatedJobs);
    }

    await this.launchdScheduler.refreshSchedule().catch(() => undefined);
    await logLine(`Cancelled loop ${loop.id}`);
    return loop;
  }

  async replenishDueLoops(now = new Date()): Promise<void> {
    const loops = await this.loopStore.list();
    for (const loop of loops) {
      if (loop.status !== "active") {
        continue;
      }
      await this.ensureFutureJobsForLoop(loop, now);
    }
    await this.launchdScheduler.refreshSchedule().catch(() => undefined);
  }

  private async ensureFutureJobsForLoop(loop: ScheduledLoop, now: Date): Promise<void> {
    const jobs = await this.jobStore.list();
    const loopJobs = jobs
      .filter((job) => job.loopId === loop.id)
      .sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime());
    const pendingFutureJobs = loopJobs.filter(
      (job) => job.status === "pending" && new Date(job.scheduledAt).getTime() > now.getTime(),
    );

    let latestOccurrence = loopJobs
      .map((job) => job.loopOccurrenceAt || job.scheduledAt)
      .map((value) => new Date(value))
      .sort((left, right) => left.getTime() - right.getTime())
      .at(-1);
    const anchorAt = new Date(loop.anchorAt);

    let pendingCount = pendingFutureJobs.length;
    while (pendingCount < 2) {
      const nextOccurrence = latestOccurrence
        ? computeNextOccurrence(loop.cadence, latestOccurrence, now)
        : anchorAt;

      const job = createLoopJob(loop, nextOccurrence);
      await this.jobStore.create(job);
      latestOccurrence = nextOccurrence;
      pendingCount += 1;
      await this.loopStore.update(loop.id, (current) => ({
        ...current,
        lastEnqueuedAt: nextOccurrence.toISOString(),
      }));
      await logLine(`Enqueued loop job ${job.id} for loop ${loop.id} at ${job.scheduledAt}`);
    }
  }
}

function createLoopJob(loop: ScheduledLoop, scheduledAt: Date): ScheduledJob {
  return {
    id: randomUUID(),
    sessionId: loop.sessionId,
    sessionLabel: loop.sessionLabel,
    projectPath: loop.projectPath,
    message: loop.message,
    scheduledAt: scheduledAt.toISOString(),
    status: "pending",
    createdAt: new Date().toISOString(),
    scheduleMode: "custom",
    loopId: loop.id,
    loopCadence: loop.cadence,
    loopOccurrenceAt: scheduledAt.toISOString(),
  };
}

function computeNextOccurrence(
  cadence: LoopCadence,
  latestOccurrence: Date,
  now: Date,
): Date {
  let candidate = latestOccurrence;

  do {
    candidate =
      cadence === "every_5_hours"
        ? addHours(candidate, 5)
        : cadence === "daily"
          ? addDays(candidate, 1)
          : addWeeks(candidate, 1);
  } while (candidate.getTime() <= now.getTime());

  return candidate;
}

export function formatLoopCadence(cadence: LoopCadence): string {
  switch (cadence) {
    case "every_5_hours":
      return "Every 5 hours";
    case "daily":
      return "Daily";
    case "weekly":
      return "Weekly";
  }
}

export function formatLoopSummary(loop: ScheduledLoop): string {
  return `${formatLoopCadence(loop.cadence)} from ${formatScheduledTime(new Date(loop.anchorAt))}`;
}
