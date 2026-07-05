import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { JobStore } from "../scheduler/JobStore.js";
import type { ScheduledJob } from "../types.js";
import { APP_DIR, atomicWriteFile, atomicWriteJson, pathExists, WAKE_EVENT_FILE } from "../utils/fs.js";
import { logLine } from "../utils/logger.js";
import { runCommand, type CommandResult } from "../utils/shell.js";

const DAEMON_LABEL = "com.codex-message-schdeuler.agent";
const WINDOWS_TASK_NAME = "codex-message-schdeuler-agent";
export const MANAGED_RUN_CONTEXT_ENV = "CODEX_MESSAGE_SCHEDULER_RUN_CONTEXT";
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
    await this.refreshWakePolicy(nextJob, nextRunAt);
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
    await this.clearWakeEvent().catch(() => undefined);
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

  private async refreshWakePolicy(job: ScheduledJob, nextRunAt: Date): Promise<void> {
    if (job.sleepPolicy !== "wake_mac_if_possible") {
      await this.clearWakeEvent();
      return;
    }

    try {
      await this.scheduleWakeEvent(nextRunAt);
    } catch (error) {
      await this.logFn(
        `pmset wake scheduling failed for ${nextRunAt.toISOString()}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async scheduleWakeEvent(nextRunAt: Date): Promise<void> {
    await this.clearWakeEvent();
    const dateTime = formatPmsetDateTime(nextRunAt);
    const owner = DAEMON_LABEL;
    const result = await this.runCommandFn(
      "pmset",
      ["schedule", "wakeorpoweron", dateTime, owner],
      { timeoutMs: 10000 },
    ).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error) }));

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to schedule pmset wake event.");
    }

    await atomicWriteJson(WAKE_EVENT_FILE, {
      type: "wakeorpoweron",
      owner,
      at: nextRunAt.toISOString(),
    });
  }

  private async clearWakeEvent(): Promise<void> {
    if (!(await pathExists(WAKE_EVENT_FILE))) {
      return;
    }

    const raw = await readFile(WAKE_EVENT_FILE, "utf8").catch(() => "");
    if (!raw) {
      await rm(WAKE_EVENT_FILE, { force: true }).catch(() => undefined);
      return;
    }

    const parsed = JSON.parse(raw) as { type?: string; owner?: string; at?: string };
    if (parsed.type && parsed.at) {
      const result = await this.runCommandFn(
        "pmset",
        ["schedule", "cancel", parsed.type, formatPmsetDateTime(new Date(parsed.at)), parsed.owner || DAEMON_LABEL],
        { timeoutMs: 10000 },
      ).catch(() => null);

      if (result && result.exitCode !== 0) {
        const stderr = result.stderr.trim();
        if (stderr && !/not found|no scheduled events|unable/i.test(stderr)) {
          await this.logFn(`pmset cancel warning: ${stderr}`);
        }
      }
    }

    await rm(WAKE_EVENT_FILE, { force: true }).catch(() => undefined);
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

export function isManagedLaunchdRun(): boolean {
  return process.platform === "darwin" && process.env[MANAGED_RUN_CONTEXT_ENV] === "launchd";
}

export async function rearmSchedulerAfterManagedRun(): Promise<void> {
  if (!isManagedLaunchdRun()) {
    return;
  }

  const scriptPath = process.argv[1];
  if (!scriptPath) {
    await logLine("Could not re-arm launchd after managed run: CLI script path is unavailable.");
    return;
  }

  const child = spawn(process.execPath, [scriptPath, "internal-refresh-scheduler"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      [MANAGED_RUN_CONTEXT_ENV]: "refresh-helper",
    },
  });
  child.unref();

  await logLine(`Spawned detached scheduler refresh helper (pid=${child.pid ?? "unknown"}) after launchd run.`);
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
    <key>${MANAGED_RUN_CONTEXT_ENV}</key>
    <string>launchd</string>
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

function formatPmsetDateTime(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const year = `${date.getFullYear()}`.slice(-2);
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  const second = `${date.getSeconds()}`.padStart(2, "0");
  return `${month}/${day}/${year} ${hour}:${minute}:${second}`;
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
