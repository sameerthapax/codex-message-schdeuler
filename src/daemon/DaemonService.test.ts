import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

describe("DaemonService", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "codex-message-scheduler-daemon-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("CODEX_MESSAGE_SCHEDULER_HOME", path.join(tempHome, ".codex-message-scheduler"));
    vi.resetModules();
  });

  test("finds earliest pending job", async () => {
    const { findEarliestPendingJob } = await import("./DaemonService.js");
    const job = findEarliestPendingJob([
      {
        id: "b",
        sessionId: "s",
        sessionLabel: "two",
        message: "x",
        scheduledAt: "2026-07-03T12:00:00.000Z",
        status: "pending",
        createdAt: "2026-07-02T00:00:00.000Z",
      },
      {
        id: "a",
        sessionId: "s",
        sessionLabel: "one",
        message: "x",
        scheduledAt: "2026-07-02T12:00:00.000Z",
        status: "pending",
        createdAt: "2026-07-02T00:00:00.000Z",
      },
      {
        id: "c",
        sessionId: "s",
        sessionLabel: "three",
        message: "x",
        scheduledAt: "2026-07-01T12:00:00.000Z",
        status: "sent",
        createdAt: "2026-07-02T00:00:00.000Z",
      },
    ]);

    expect(job?.id).toBe("a");
  });

  test("builds StartCalendarInterval plist and not StartInterval", async () => {
    const { buildLaunchdPlist, parseLaunchdPlist } = await import("./DaemonService.js");
    const date = new Date(2026, 6, 2, 5, 1, 0, 0);
    const plist = buildLaunchdPlist("/node", "/script.js", date);

    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).not.toContain("<key>StartInterval</key>");

    const parsed = parseLaunchdPlist(plist);
    expect(parsed.isPolling).toBe(false);
    expect(parsed.nextRunAt?.getFullYear()).toBe(2026);
    expect(parsed.nextRunAt?.getMonth()).toBe(6);
    expect(parsed.nextRunAt?.getDate()).toBe(2);
    expect(parsed.nextRunAt?.getHours()).toBe(5);
    expect(parsed.nextRunAt?.getMinutes()).toBe(1);
  });

  test("refreshSchedule arms when a pending job exists", async () => {
    vi.stubGlobal("process", {
      ...process,
      getuid: () => 501,
    });

    const { JobStore } = await import("../scheduler/JobStore.js");
    const { LaunchdScheduler, parseLaunchdPlist } = await import("./DaemonService.js");
    const plistPath = path.join(tempHome, "LaunchAgents", "com.codex.scheduler.plist");
    const commands: string[] = [];
    const store = new JobStore();
    await store.saveAll([
      {
        id: "job-1",
        sessionId: "session-1",
        sessionLabel: "Session 1",
        message: "hello",
        scheduledAt: "2026-07-02T10:01:00.000Z",
        status: "pending",
        createdAt: "2026-07-02T09:00:00.000Z",
      },
    ]);

    const scheduler = new LaunchdScheduler({
      platform: "darwin",
      plistPath,
      scriptPath: "/tmp/codex-message-scheduler.js",
      nodePath: "/usr/local/bin/node",
      jobStore: store,
      runCommandFn: async (_command, args) => {
        commands.push(args.join(" "));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      logFn: async () => undefined,
    });

    await scheduler.refreshSchedule();

    const plist = await readFile(plistPath, "utf8");
    const parsed = parseLaunchdPlist(plist);
    expect(parsed.nextRunAt).toBeDefined();
    expect(commands.some((entry) => entry.startsWith("bootstrap"))).toBe(true);
    expect(plist).not.toContain("StartInterval");
  });

  test("refreshSchedule disarms when no pending jobs exist", async () => {
    vi.stubGlobal("process", {
      ...process,
      getuid: () => 501,
    });

    const { JobStore } = await import("../scheduler/JobStore.js");
    const { LaunchdScheduler, buildLaunchdPlist } = await import("./DaemonService.js");
    const launchAgents = path.join(tempHome, "LaunchAgents");
    const plistPath = path.join(launchAgents, "com.codex.scheduler.plist");
    await mkdir(launchAgents, { recursive: true });
    await writeFile(plistPath, buildLaunchdPlist("/node", "/script", new Date(2026, 6, 2, 5, 1)), "utf8");
    const commands: string[] = [];

    const scheduler = new LaunchdScheduler({
      platform: "darwin",
      plistPath,
      jobStore: new JobStore(),
      runCommandFn: async (_command, args) => {
        commands.push(args.join(" "));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      logFn: async () => undefined,
    });

    await scheduler.refreshSchedule();

    await expect(readFile(plistPath, "utf8")).rejects.toThrow();
    expect(commands.some((entry) => entry.startsWith("bootout"))).toBe(true);
  });

  test("detects old StartInterval polling plist", async () => {
    vi.stubGlobal("process", {
      ...process,
      getuid: () => 501,
    });

    const { LaunchdScheduler } = await import("./DaemonService.js");
    const launchAgents = path.join(tempHome, "LaunchAgents");
    const plistPath = path.join(launchAgents, "com.codex.scheduler.plist");
    await mkdir(launchAgents, { recursive: true });
    await writeFile(
      plistPath,
      `<?xml version="1.0"?><plist><dict><key>StartInterval</key><integer>60</integer></dict></plist>`,
      "utf8",
    );

    const scheduler = new LaunchdScheduler({
      platform: "darwin",
      plistPath,
      runCommandFn: async () => ({ exitCode: 1, stdout: "", stderr: "not loaded" }),
      logFn: async () => undefined,
    });

    const status = await scheduler.status();
    expect(status.oldPollingPlistDetected).toBe(true);
  });

  test("migrates old polling plist on refresh", async () => {
    vi.stubGlobal("process", {
      ...process,
      getuid: () => 501,
    });

    const { JobStore } = await import("../scheduler/JobStore.js");
    const { LaunchdScheduler } = await import("./DaemonService.js");
    const launchAgents = path.join(tempHome, "LaunchAgents");
    const plistPath = path.join(launchAgents, "com.codex.scheduler.plist");
    await mkdir(launchAgents, { recursive: true });
    await writeFile(
      plistPath,
      `<?xml version="1.0"?><plist><dict><key>StartInterval</key><integer>60</integer></dict></plist>`,
      "utf8",
    );
    const store = new JobStore();
    await store.saveAll([
      {
        id: "job-1",
        sessionId: "session-1",
        sessionLabel: "Session 1",
        message: "hello",
        scheduledAt: "2026-07-02T10:01:00.000Z",
        status: "pending",
        createdAt: "2026-07-02T09:00:00.000Z",
      },
    ]);

    const scheduler = new LaunchdScheduler({
      platform: "darwin",
      plistPath,
      scriptPath: "/tmp/codex-message-scheduler.js",
      nodePath: "/usr/local/bin/node",
      jobStore: store,
      runCommandFn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      logFn: async () => undefined,
    });

    const migrated = await scheduler.migrateOldPollingPlistIfNeeded();
    const plist = await readFile(plistPath, "utf8");
    expect(migrated).toBe(true);
    expect(plist).toContain("StartCalendarInterval");
    expect(plist).not.toContain("StartInterval");
  });

  test("windows scheduler creates one-shot schtasks entry", async () => {
    const { JobStore } = await import("../scheduler/JobStore.js");
    const { WindowsTaskScheduler } = await import("./DaemonService.js");
    const commands: string[] = [];
    const store = new JobStore();
    await store.saveAll([
      {
        id: "job-win-1",
        sessionId: "session-1",
        sessionLabel: "Session 1",
        message: "hello",
        scheduledAt: "2026-07-03T10:01:00.000Z",
        status: "pending",
        createdAt: "2026-07-03T09:00:00.000Z",
      },
    ]);

    const scheduler = new WindowsTaskScheduler({
      platform: "win32",
      scriptPath: "C:\\codex-message-schdeuler\\dist\\cli.js",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      jobStore: store,
      runCommandFn: async (_command, args) => {
        commands.push(args.join(" "));
        return { exitCode: 0, stdout: "SUCCESS", stderr: "" };
      },
      logFn: async () => undefined,
    });

    await scheduler.refreshSchedule();

    expect(commands.some((entry) => entry.includes("/Create"))).toBe(true);
    expect(commands.some((entry) => entry.includes("/SC ONCE"))).toBe(true);
    expect(commands.some((entry) => entry.includes("/TR"))).toBe(true);
  });
});
