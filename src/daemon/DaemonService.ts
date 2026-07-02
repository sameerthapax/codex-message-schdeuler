import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JobStore } from "../scheduler/JobStore.js";
import type { ScheduledJob } from "../types.js";
import { APP_DIR, atomicWriteFile, pathExists } from "../utils/fs.js";
import { logLine } from "../utils/logger.js";
import { runCommand, type CommandResult } from "../utils/shell.js";

const DAEMON_LABEL = "com.codex-message-schdeuler.agent";
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
  mode: "one-shot" | "unsupported";
  armed: boolean;
  plistPath: string;
  nextRunAt?: string;
  oldPollingPlistDetected: boolean;
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

export class LaunchdScheduler {
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
      mode: this.platform === "darwin" ? "one-shot" : "unsupported",
      armed: false,
      plistPath: this.plistPath,
      oldPollingPlistDetected: false,
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

export async function ensureDaemonInstalledForCurrentCli(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const scheduler = new LaunchdScheduler();
  await scheduler.migrateOldPollingPlistIfNeeded();
}

export async function installDaemonForCurrentCli(): Promise<{
  plistPath: string;
  message: string;
}> {
  const scheduler = new LaunchdScheduler();
  await scheduler.refreshSchedule();
  const nextJob = await new JobStore().nextPending();

  return {
    plistPath: getPlistPath(),
    message: nextJob
      ? `launchd armed for ${nextJob.scheduledAt}`
      : "No pending jobs. launchd will be armed automatically when you schedule one.",
  };
}

export function createDefaultLaunchdScheduler(): LaunchdScheduler {
  return new LaunchdScheduler();
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
