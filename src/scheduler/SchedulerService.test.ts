import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("SchedulerService", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "codex-scheduler-service-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("CODEX_SCHEDULER_HOME", path.join(tempHome, ".codex-scheduler"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("runDue executes all due jobs and refreshes schedule afterward", async () => {
    const { JobStore } = await import("./JobStore.js");
    const { SchedulerService } = await import("./SchedulerService.js");

    const store = new JobStore();
    await store.saveAll([
      {
        id: "due-1",
        sessionId: "session-1",
        sessionLabel: "Due One",
        message: "hello one",
        scheduledAt: "2026-07-02T05:00:00.000Z",
        status: "pending",
        createdAt: "2026-07-02T04:00:00.000Z",
      },
      {
        id: "due-2",
        sessionId: "session-2",
        sessionLabel: "Due Two",
        message: "hello two",
        scheduledAt: "2026-07-02T05:01:00.000Z",
        status: "pending",
        createdAt: "2026-07-02T04:01:00.000Z",
      },
      {
        id: "future-1",
        sessionId: "session-3",
        sessionLabel: "Future",
        message: "hello future",
        scheduledAt: "2026-07-02T06:00:00.000Z",
        status: "pending",
        createdAt: "2026-07-02T04:02:00.000Z",
      },
    ]);

    const refreshSchedule = vi.fn(async () => undefined);
    const tmuxRunner = {
      startDetachedSession: vi.fn(async () => undefined),
      waitForReady: vi.fn(async () => "ready"),
      sendMessage: vi.fn(async () => ({ snapshot: "submitted\n›", submitKey: "C-m" })),
      capturePane: vi.fn(async () => "submitted\n›"),
      persistExecutionLog: vi.fn(async () => "/tmp/log"),
    };

    const service = new SchedulerService(
      store,
      tmuxRunner as never,
      { refreshSchedule } as never,
      { replenishDueLoops: vi.fn(async () => undefined) } as never,
    );

    const jobs = await service.runDueJobs(new Date("2026-07-02T05:02:00.000Z"));
    const saved = await store.list();

    expect(jobs).toHaveLength(2);
    expect(saved.find((job) => job.id === "due-1")?.status).toBe("sent");
    expect(saved.find((job) => job.id === "due-2")?.status).toBe("sent");
    expect(saved.find((job) => job.id === "future-1")?.status).toBe("pending");
    expect(refreshSchedule).toHaveBeenCalledTimes(1);
  });
});
