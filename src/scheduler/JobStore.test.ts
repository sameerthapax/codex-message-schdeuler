import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("JobStore", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "codex-scheduler-test-"));
    vi.stubEnv("HOME", tempHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("persists jobs safely", async () => {
    const { JobStore } = await import("./JobStore.js");
    const store = new JobStore();
    await store.create({
      id: "job-1",
      sessionId: "session-1",
      sessionLabel: "Session 1",
      message: "hello",
      scheduledAt: new Date("2026-07-02T12:00:00.000Z").toISOString(),
      status: "pending",
      createdAt: new Date("2026-07-01T12:00:00.000Z").toISOString(),
    });

    const jobs = await store.list();
    expect(jobs).toHaveLength(1);

    const file = path.join(tempHome, ".codex-scheduler", "jobs.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as { jobs: Array<{ id: string }> };
    expect(raw.jobs[0]?.id).toBe("job-1");
  });
});
