import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("SchedulerService", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "codex-message-scheduler-service-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("CODEX_MESSAGE_SCHEDULER_HOME", path.join(tempHome, ".codex-message-scheduler"));
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
      sendMessage: vi.fn(async () => ({
        snapshot: "› hello one\n\n• Working (2s • esc to interrupt)\n\n›",
        submitKey: "C-m",
        accepted: true,
        acceptanceReason: "Codex shows a working state after the submitted message.",
      })),
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

  test("runDue skips stale catch_up_on_wake jobs", async () => {
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
        sleepPolicy: "catch_up_on_wake",
      },
    ]);

    const refreshSchedule = vi.fn(async () => undefined);
    const loopService = {
      replenishDueLoops: vi.fn(async () => undefined),
    };
    const tmuxRunner = {
      startDetachedSession: vi.fn(async () => undefined),
      waitForReady: vi.fn(async () => "ready"),
      sendMessage: vi.fn(async () => ({
        snapshot: "› hello one\n\n• Working (2s • esc to interrupt)\n\n›",
        submitKey: "C-m",
        accepted: true,
        acceptanceReason: "Codex shows a working state after the submitted message.",
      })),
      capturePane: vi.fn(async () => "submitted\n›"),
      persistExecutionLog: vi.fn(async () => "/tmp/log"),
    };

    const service = new SchedulerService(
      store,
      tmuxRunner as never,
      { refreshSchedule } as never,
      loopService as never,
    );

    const jobs = await service.runDueJobs(new Date("2026-07-02T07:30:00.000Z"));
    const saved = await store.list();

    expect(jobs).toHaveLength(1);
    expect(saved.find((job) => job.id === "due-1")?.status).toBe("skipped_due_to_mac_sleep");
    expect(tmuxRunner.startDetachedSession).not.toHaveBeenCalled();
  });

  test("runDue can skip scheduler refresh for managed daemon runs", async () => {
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
    ]);

    const refreshSchedule = vi.fn(async () => undefined);
    const replenishDueLoops = vi.fn(async () => undefined);
    const tmuxRunner = {
      startDetachedSession: vi.fn(async () => undefined),
      waitForReady: vi.fn(async () => "ready"),
      sendMessage: vi.fn(async () => ({
        snapshot: "› hello one\n\n• Working (2s • esc to interrupt)\n\n›",
        submitKey: "C-m",
        accepted: true,
        acceptanceReason: "Codex shows a working state after the submitted message.",
      })),
      capturePane: vi.fn(async () => "submitted\n›"),
      persistExecutionLog: vi.fn(async () => "/tmp/log"),
    };

    const service = new SchedulerService(
      store,
      tmuxRunner as never,
      { refreshSchedule } as never,
      { replenishDueLoops } as never,
    );

    await service.runDueJobs(new Date("2026-07-02T05:02:00.000Z"), {
      refreshSchedule: false,
    });

    expect(replenishDueLoops).toHaveBeenCalledWith(new Date("2026-07-02T05:02:00.000Z"), {
      refreshSchedule: false,
    });
    expect(refreshSchedule).not.toHaveBeenCalled();
  });

  test("runDue marks ambiguous submission as not_sure", async () => {
    const { JobStore } = await import("./JobStore.js");
    const { SchedulerService } = await import("./SchedulerService.js");

    const store = new JobStore();
    await store.saveAll([
      {
        id: "due-1",
        sessionId: "session-1",
        sessionLabel: "Due One",
        message: "hi",
        scheduledAt: "2026-07-02T05:00:00.000Z",
        status: "pending",
        createdAt: "2026-07-02T04:00:00.000Z",
      },
    ]);

    const tmuxRunner = {
      startDetachedSession: vi.fn(async () => undefined),
      waitForReady: vi.fn(async () => "ready"),
      sendMessage: vi.fn(async () => ({
        snapshot: "› hi",
        submitKey: "C-m",
        accepted: false,
        acceptanceReason: "Only the submitted prompt is visible; no Codex reply or working state appeared.",
      })),
      capturePane: vi.fn(async () => "› hi"),
      persistExecutionLog: vi.fn(async () => "/tmp/log"),
    };

    const service = new SchedulerService(
      store,
      tmuxRunner as never,
      { refreshSchedule: vi.fn(async () => undefined) } as never,
      { replenishDueLoops: vi.fn(async () => undefined) } as never,
    );

    const jobs = await service.runDueJobs(new Date("2026-07-02T05:02:00.000Z"));
    const saved = await store.list();

    expect(jobs[0]?.status).toBe("not_sure");
    expect(saved.find((job) => job.id === "due-1")?.status).toBe("not_sure");
    expect(saved.find((job) => job.id === "due-1")?.error).toContain("Only the submitted prompt");
  });
});
