import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JobStore } from "../scheduler/JobStore.js";
import type { ScheduledJob } from "../types.js";
import { APP_DIR, atomicWriteFile, pathExists } from "../utils/fs.js";
import { logLine } from "../utils/logger.js";
import { runCommand, type CommandResult } from "../utils/shell.js";

const DAEMON_LABEL = "com.codex-message-schdeuler.agent";
const WINDOWS_TASK_NAME = "codex-message-schdeuler-agent";
const LEGACY_DAEMONS = [
  {
    label: "com.codex-tmux-scheduler.agent",
    plistPath: path.join(os.homedir(), "Library", "LaunchAgents", "com.codex-tmux-scheduler.agent.plist"),
  },
  {
    label: "com.codex.scheduler",
    plistPath: path.join(os.homedir(), "Library", "LaunchAgents", "com.codex.scheduler.plist"),
  },
];

export interface DaemonStatus {
  mode: "one-shot" | "manual";
  armed: boolean;
  plistPath: string;
  nextRunAt?: string;
  oldPollingPlistDetected: boolean;
  scheduler: "launchd" | "schtasks" | "manual";
}

export interface SchedulerAdapter {
  refreshSchedule(): Promise<void>;
  armNextRun(nextRunAt: Date): Promise<void>;
  disarm(): Promise<void>;
  status(): Promise<DaemonStatus>;
  migrateOldPollingPlistIfNeeded(): Promise<boolean>;
}

interface LaunchdPlistData {
  nextRunAt?: Date;
  isPolling: boolean;
}

interface LaunchdSchedulerOptions {
  scriptPath?: string;
  plistPath?: string;
  jobStore?: JobStore;
  platform?: NodeJS.Platform;
  nodePath?: string;
  runCommandFn?: (
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<CommandResult>;
  logFn?: (message: string) => Promise<void>;
}

export class LaunchdScheduler implements SchedulerAdapter {
  private readonly jobStore: JobStore;
  private readonly scriptPath: string;
  private readonly plistPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly nodePath: string;
  private readonly runCommandFn: (
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<CommandResult>;
  private readonly logFn: (message: string) => Promise<void>;

  constructor(options: LaunchdSchedulerOptions = {}) {
    this.jobStore = options.jobStore ?? new JobStore();
    this.scriptPath = options.scriptPath ?? process.argv[1];
    this.plistPath = options.plistPath ?? getPlistPath();
    this.platform = options.platform ?? process.platform;
    this.nodePath = options.nodePath ?? process.execPath;
    this.runCommandFn = options.runCommandFn ?? runCommand;
    this.logFn = options.logFn ?? logLine;
  }

  async refreshSchedule(): Promise<void> {
    if (this.platform !== "darwin") {
      return;
    }

    const nextJob = await this.jobStore.nextPending();
    if (!nextJob) {
      await this.disarm();
      await this.logFn("launchd scheduler disarmed: no pending jobs");
      return;
    }

    const nextRunAt = getArmTimeForJob(nextJob);
    await this.armNextRun(nextRunAt);
    await this.logFn(`launchd scheduler armed for ${nextRunAt.toISOString()} (${nextJob.id})`);
  }

  async armNextRun(nextRunAt: Date): Promise<void> {
    if (this.platform !== "darwin") {
      return;
    }

    await this.bootoutManagedDaemons();
    await atomicWriteFile(this.plistPath, buildLaunchdPlist(this.nodePath, this.scriptPath, nextRunAt));

    const domain = getLaunchdDomain();
    const bootstrap = await this.runCommandFn(
      "launchctl",
      ["bootstrap", domain, this.plistPath],
      { timeoutMs: 10000 },
    ).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error) }));

    if (bootstrap.exitCode !== 0) {
      await this.logFn(`launchctl bootstrap failed: ${bootstrap.stderr.trim() || "unknown error"}`);
      throw new Error(bootstrap.stderr.trim() || "Failed to bootstrap launchd scheduler.");
    }
  }

  async disarm(): Promise<void> {
    if (this.platform !== "darwin") {
      return;
    }

    await this.bootoutManagedDaemons();

    if (await pathExists(this.plistPath)) {
      await rm(this.plistPath, { force: true }).catch(() => undefined);
    }
    for (const legacy of LEGACY_DAEMONS) {
      if (await pathExists(legacy.plistPath)) {
        await rm(legacy.plistPath, { force: true }).catch(() => undefined);
      }
    }
  }

  async status(): Promise<DaemonStatus> {
    const defaultStatus: DaemonStatus = {
      mode: this.platform === "darwin" ? "one-shot" : "manual",
      armed: false,
      plistPath: this.plistPath,
      oldPollingPlistDetected: false,
      scheduler: "launchd",
    };

    if (this.platform !== "darwin") {
      return defaultStatus;
    }

    const currentRaw = (await pathExists(this.plistPath))
      ? await readFile(this.plistPath, "utf8").catch(() => "")
      : "";
    const currentParsed = parseLaunchdPlist(currentRaw);
    let oldPollingPlistDetected = currentParsed.isPolling;

    for (const legacy of LEGACY_DAEMONS) {
      if (!(await pathExists(legacy.plistPath))) {
        continue;
      }
      const raw = await readFile(legacy.plistPath, "utf8").catch(() => "");
      if (parseLaunchdPlist(raw).isPolling || raw.length > 0) {
        oldPollingPlistDetected = true;
      }
    }

    if (!currentRaw && !oldPollingPlistDetected) {
      return defaultStatus;
    }

    const printResult = await this.runCommandFn(
      "launchctl",
      ["print", `${getLaunchdDomain()}/${DAEMON_LABEL}`],
      { timeoutMs: 5000 },
    ).catch(() => null);

    return {
      mode: "one-shot",
      armed: Boolean(printResult && printResult.exitCode === 0),
      plistPath: this.plistPath,
      nextRunAt: currentParsed.nextRunAt?.toISOString(),
      oldPollingPlistDetected,
      scheduler: "launchd",
    };
  }

  async migrateOldPollingPlistIfNeeded(): Promise<boolean> {
    if (this.platform !== "darwin") {
      return false;
    }

    let shouldMigrate = false;

    if (await pathExists(this.plistPath)) {
      const raw = await readFile(this.plistPath, "utf8").catch(() => "");
      shouldMigrate = parseLaunchdPlist(raw).isPolling;
    }

    for (const legacy of LEGACY_DAEMONS) {
      if (await pathExists(legacy.plistPath)) {
        shouldMigrate = true;
      }
    }

    if (!shouldMigrate) {
      return false;
    }

    await this.logFn("detected legacy launchd scheduler; migrating to one-shot launchd scheduling");
    await this.refreshSchedule();
    return true;
  }

  private async bootoutManagedDaemons(): Promise<void> {
    const labels = [DAEMON_LABEL, ...LEGACY_DAEMONS.map((daemon) => daemon.label)];

    for (const label of labels) {
      const target = `${getLaunchdDomain()}/${label}`;
      const result = await this.runCommandFn("launchctl", ["bootout", target], {
        timeoutMs: 10000,
      }).catch(() => null);

      if (result && result.exitCode !== 0) {
        const stderr = result.stderr.trim();
        if (stderr && !stderr.includes("No such process") && !stderr.includes("not found")) {
          await this.logFn(`launchctl bootout warning for ${label}: ${stderr}`);
        }
      }
    }
  }
}

interface WindowsTaskSchedulerOptions {
  scriptPath?: string;
  jobStore?: JobStore;
  platform?: NodeJS.Platform;
  nodePath?: string;
  runCommandFn?: (
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<CommandResult>;
  logFn?: (message: string) => Promise<void>;
  taskName?: string;
}

export class WindowsTaskScheduler implements SchedulerAdapter {
  private readonly jobStore: JobStore;
  private readonly scriptPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly nodePath: string;
  private readonly runCommandFn: (
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<CommandResult>;
  private readonly logFn: (message: string) => Promise<void>;
  private readonly taskName: string;

  constructor(options: WindowsTaskSchedulerOptions = {}) {
    this.jobStore = options.jobStore ?? new JobStore();
    this.scriptPath = options.scriptPath ?? process.argv[1];
    this.platform = options.platform ?? process.platform;
    this.nodePath = options.nodePath ?? process.execPath;
    this.runCommandFn = options.runCommandFn ?? runCommand;
    this.logFn = options.logFn ?? logLine;
    this.taskName = options.taskName ?? WINDOWS_TASK_NAME;
  }

  async refreshSchedule(): Promise<void> {
    if (this.platform !== "win32") {
      return;
    }

    const nextJob = await this.jobStore.nextPending();
    if (!nextJob) {
      await this.disarm();
      await this.logFn("windows scheduler disarmed: no pending jobs");
      return;
    }

    const nextRunAt = getArmTimeForJob(nextJob);
    await this.armNextRun(nextRunAt);
    await this.logFn(`windows scheduler armed for ${nextRunAt.toISOString()} (${nextJob.id})`);
  }

  async armNextRun(nextRunAt: Date): Promise<void> {
    if (this.platform !== "win32") {
      return;
    }

    await this.disarm();

    const runTarget = buildWindowsTaskRunTarget(this.nodePath, this.scriptPath);
    const result = await this.runCommandFn(
      "schtasks",
      [
        "/Create",
        "/TN",
        this.taskName,
        "/SC",
        "ONCE",
        "/SD",
        formatWindowsDate(nextRunAt),
        "/ST",
        formatWindowsTime(nextRunAt),
        "/TR",
        runTarget,
        "/F",
      ],
      { timeoutMs: 10000 },
    ).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error) }));

    if (result.exitCode !== 0) {
      await this.logFn(`schtasks create failed: ${result.stderr.trim() || "unknown error"}`);
      throw new Error(result.stderr.trim() || "Failed to create Windows scheduled task.");
    }
  }

  async disarm(): Promise<void> {
    if (this.platform !== "win32") {
      return;
    }

    const result = await this.runCommandFn(
      "schtasks",
      ["/Delete", "/TN", this.taskName, "/F"],
      { timeoutMs: 10000 },
    ).catch(() => null);

    if (result && result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      if (stderr && !/cannot find the file|cannot find the task|cannot find/i.test(stderr)) {
        await this.logFn(`schtasks delete warning: ${stderr}`);
      }
    }
  }

  async status(): Promise<DaemonStatus> {
    const defaultStatus: DaemonStatus = {
      mode: this.platform === "win32" ? "one-shot" : "manual",
      armed: false,
      plistPath: `Task Scheduler\\${this.taskName}`,
      oldPollingPlistDetected: false,
      scheduler: "schtasks",
    };

    if (this.platform !== "win32") {
      return defaultStatus;
    }

    const result = await this.runCommandFn(
      "schtasks",
      ["/Query", "/TN", this.taskName, "/FO", "LIST", "/V"],
      { timeoutMs: 10000 },
    ).catch(() => null);

    if (!result || result.exitCode !== 0) {
      return defaultStatus;
    }

    return {
      mode: "one-shot",
      armed: true,
      plistPath: `Task Scheduler\\${this.taskName}`,
      nextRunAt: parseWindowsNextRunTime(result.stdout)?.toISOString(),
      oldPollingPlistDetected: false,
      scheduler: "schtasks",
    };
  }

  async migrateOldPollingPlistIfNeeded(): Promise<boolean> {
    return false;
  }
}

class ManualScheduler implements SchedulerAdapter {
  async refreshSchedule(): Promise<void> {}
  async armNextRun(_nextRunAt: Date): Promise<void> {}
  async disarm(): Promise<void> {}
  async status(): Promise<DaemonStatus> {
    return {
      mode: "manual",
      armed: false,
      plistPath: "manual",
      oldPollingPlistDetected: false,
      scheduler: "manual",
    };
  }
  async migrateOldPollingPlistIfNeeded(): Promise<boolean> {
    return false;
  }
}

export async function ensureDaemonInstalledForCurrentCli(): Promise<void> {
  const scheduler = createDefaultScheduler();
  await scheduler.migrateOldPollingPlistIfNeeded();
}

export async function installDaemonForCurrentCli(): Promise<{
  plistPath: string;
  message: string;
}> {
  const scheduler = createDefaultScheduler();
  await scheduler.refreshSchedule();
  const nextJob = await new JobStore().nextPending();
  const status = await scheduler.status();

  return {
    plistPath: status.plistPath,
    message: nextJob
      ? `${status.scheduler} armed for ${nextJob.scheduledAt}`
      : "No pending jobs. automatic scheduling will be armed automatically when you schedule one.",
  };
}

export function createDefaultLaunchdScheduler(): LaunchdScheduler {
  return new LaunchdScheduler();
}

export function createDefaultScheduler(): SchedulerAdapter {
  if (process.platform === "darwin") {
    return new LaunchdScheduler();
  }
  if (process.platform === "win32") {
    return new WindowsTaskScheduler();
  }
  return new ManualScheduler();
}

export function getPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
}

export function buildLaunchdPlist(nodePath: string, scriptPath: string, nextRunAt: Date): string {
  const local = {
    year: nextRunAt.getFullYear(),
    month: nextRunAt.getMonth() + 1,
    day: nextRunAt.getDate(),
    hour: nextRunAt.getHours(),
    minute: nextRunAt.getMinutes(),
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>run-due</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${buildLaunchdPath()}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Year</key><integer>${local.year}</integer>
    <key>Month</key><integer>${local.month}</integer>
    <key>Day</key><integer>${local.day}</integer>
    <key>Hour</key><integer>${local.hour}</integer>
    <key>Minute</key><integer>${local.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${path.join(APP_DIR, "launchd.stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(APP_DIR, "launchd.stderr.log")}</string>
</dict>
</plist>
`;
}

export function parseLaunchdPlist(raw: string): LaunchdPlistData {
  const isPolling = raw.includes("<key>StartInterval</key>");
  const year = extractInteger(raw, "Year");
  const month = extractInteger(raw, "Month");
  const day = extractInteger(raw, "Day");
  const hour = extractInteger(raw, "Hour");
  const minute = extractInteger(raw, "Minute");

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return { isPolling };
  }

  return {
    isPolling,
    nextRunAt: new Date(year, month - 1, day, hour, minute, 0, 0),
  };
}

export function findEarliestPendingJob(jobs: ScheduledJob[]): ScheduledJob | undefined {
  return jobs
    .filter((job) => job.status === "pending")
    .sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime())[0];
}

function extractInteger(raw: string, key: string): number | undefined {
  const match = raw.match(new RegExp(`<key>${key}<\\/key>\\s*<integer>(\\d+)<\\/integer>`));
  return match ? Number(match[1]) : undefined;
}

function getLaunchdDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("launchd scheduling requires a local macOS user id.");
  }
  return `gui/${uid}`;
}

function getArmTimeForJob(job: ScheduledJob, now = new Date()): Date {
  const scheduledAt = new Date(job.scheduledAt);
  if (scheduledAt.getTime() > now.getTime()) {
    return scheduledAt;
  }

  const nextMinute = new Date(now);
  nextMinute.setSeconds(0, 0);
  nextMinute.setMinutes(nextMinute.getMinutes() + 1);
  return nextMinute;
}

function buildLaunchdPath(): string {
  const parts = [
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];

  return [...new Set(parts)].join(path.delimiter);
}

function buildWindowsTaskRunTarget(nodePath: string, scriptPath: string): string {
  return `"${nodePath}" "${scriptPath}" run-due`;
}

function formatWindowsDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const year = `${date.getFullYear()}`;
  return `${month}/${day}/${year}`;
}

function formatWindowsTime(date: Date): string {
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${hour}:${minute}`;
}

function parseWindowsNextRunTime(output: string): Date | undefined {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => /^Next Run Time:/i.test(entry));

  if (!line) {
    return undefined;
  }

  const value = line.replace(/^Next Run Time:\s*/i, "").trim();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
