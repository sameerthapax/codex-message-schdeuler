import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("LoopService", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "codex-message-scheduler-loop-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("CODEX_MESSAGE_SCHEDULER_HOME", path.join(tempHome, ".codex-message-scheduler"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("createLoop enqueues two future jobs", async () => {
    const { LoopService } = await import("./LoopService.js");
    const { LoopStore } = await import("./LoopStore.js");
    const { JobStore } = await import("../scheduler/JobStore.js");

    const service = new LoopService(
      new LoopStore(),
      new JobStore(),
      { refreshSchedule: vi.fn(async () => undefined) } as never,
    );

    const loop = await service.createLoop({
      session: {
        id: "session-1",
        label: "Session 1",
        projectPath: "/tmp/project",
        source: "test",
      },
      cadence: "daily",
      startAt: new Date("2026-07-03T10:00:00.000Z"),
    });

    const jobs = await new JobStore().list();
    const loopJobs = jobs.filter((job) => job.loopId === loop.id);

    expect(loopJobs).toHaveLength(2);
    expect(loopJobs[0]?.message).toBe("hi");
    expect(loopJobs.every((job) => job.status === "pending")).toBe(true);
  });

  test("replenishDueLoops keeps two future pending jobs", async () => {
    const { LoopService } = await import("./LoopService.js");
    const { LoopStore } = await import("./LoopStore.js");
    const { JobStore } = await import("../scheduler/JobStore.js");

    const loopStore = new LoopStore();
    const jobStore = new JobStore();
    const service = new LoopService(
      loopStore,
      jobStore,
      { refreshSchedule: vi.fn(async () => undefined) } as never,
    );

    const loop = await service.createLoop({
      session: {
        id: "session-1",
        label: "Session 1",
        source: "test",
      },
      cadence: "every_5_hours",
      startAt: new Date("2026-07-02T10:00:00.000Z"),
    });

    const jobs = await jobStore.list();
    const firstJobId = jobs.find((job) => job.loopId === loop.id)?.id;
    await jobStore.update(firstJobId!, (job) => ({ ...job, status: "sent", sentAt: "2026-07-02T10:00:00.000Z" }));

    await service.replenishDueLoops(new Date("2026-07-02T10:01:00.000Z"));

    const refreshedJobs = await jobStore.list();
    const futurePending = refreshedJobs.filter(
      (job) =>
        job.loopId === loop.id &&
        job.status === "pending" &&
        new Date(job.scheduledAt).getTime() > new Date("2026-07-02T10:01:00.000Z").getTime(),
    );

    expect(futurePending).toHaveLength(2);
  });

  test("cancelLoop cancels pending loop jobs", async () => {
    const { LoopService } = await import("./LoopService.js");
    const { LoopStore } = await import("./LoopStore.js");
    const { JobStore } = await import("../scheduler/JobStore.js");

    const loopStore = new LoopStore();
    const jobStore = new JobStore();
    const service = new LoopService(
      loopStore,
      jobStore,
      { refreshSchedule: vi.fn(async () => undefined) } as never,
    );

    const loop = await service.createLoop({
      session: {
        id: "session-1",
        label: "Session 1",
        source: "test",
      },
      cadence: "weekly",
      startAt: new Date("2026-07-03T10:00:00.000Z"),
    });

    await service.cancelLoop(loop.id);

    const loops = await loopStore.list();
    const jobs = await jobStore.list();
    expect(loops.find((entry) => entry.id === loop.id)?.status).toBe("cancelled");
    expect(jobs.filter((job) => job.loopId === loop.id).every((job) => job.status === "cancelled")).toBe(true);
  });
});
