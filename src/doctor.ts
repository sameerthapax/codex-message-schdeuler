import { AppConfigStore } from "./config/AppConfigStore.js";
import { createDefaultScheduler } from "./daemon/DaemonService.js";
import os from "node:os";

import type { DependencyCheck } from "./types.js";
import { CodexStatusUsageProvider } from "./codex/usage/CodexStatusUsageProvider.js";
import { discoverSessionProviderForPreference } from "./codex/discoverSessions.js";
import { JobStore } from "./scheduler/JobStore.js";
import { APP_DIR, pathIsWritable } from "./utils/fs.js";
import { commandExists, runCommand } from "./utils/shell.js";

export async function getDoctorReport(options?: {
  statusCheck?: boolean;
}): Promise<{
  checks: DependencyCheck[];
  pendingJobs: number;
  nextPendingJobTime?: string;
  providerName: string;
  sessionPreference: string;
  daemonStatus: {
    mode: string;
    armed: boolean;
    plistPath: string;
    nextRunAt?: string;
    oldPollingPlistDetected: boolean;
    scheduler: string;
  };
  statusCheck?: {
    attempted: boolean;
    ok: boolean;
    details: string;
  };
}> {
  const config = await new AppConfigStore().read();
  const jobStore = new JobStore();
  const launchdScheduler = createDefaultScheduler();
  const [nodeVersion, codexExists, tmuxExists, writable, provider] = await Promise.all([
    Promise.resolve(process.version),
    commandExists("codex"),
    commandExists("tmux"),
    pathIsWritable(APP_DIR),
    discoverSessionProviderForPreference(config.sessionPreference),
  ]);

  const providerSessions = await provider.listSessions().catch(() => []);
  const jobs = await jobStore.list();
  const pendingJobs = jobs.filter((job) => job.status === "pending").length;
  const nextPendingJob = await jobStore.nextPending();
  const initialDaemonStatus = await launchdScheduler.status();
  if (initialDaemonStatus.oldPollingPlistDetected) {
    await launchdScheduler.migrateOldPollingPlistIfNeeded().catch(() => undefined);
  }
  const daemonStatus = initialDaemonStatus.oldPollingPlistDetected
    ? { ...(await launchdScheduler.status()), oldPollingPlistDetected: true }
    : initialDaemonStatus;
  const resetSchedulingSupported = codexExists && tmuxExists;
  const automaticSchedulingSupported =
    process.platform === "darwin" || process.platform === "win32";

  const checks: DependencyCheck[] = [
    {
      name: "node",
      ok: true,
      details: nodeVersion,
    },
    {
      name: "codex",
      ok: codexExists,
      details: codexExists ? await getVersion("codex") : "Not found on PATH",
    },
    {
      name: "tmux",
      ok: tmuxExists,
      details: tmuxExists ? await getVersion("tmux") : "Not found on PATH",
    },
    {
      name: "app data",
      ok: writable,
      details: writable ? `${APP_DIR} is writable` : `${APP_DIR} is not writable`,
    },
    {
      name: "session provider",
      ok: providerSessions.length > 0,
      details:
        providerSessions.length > 0
          ? `${provider.name} found ${providerSessions.length} session(s)`
          : `${provider.name} did not return sessions; manual mode remains available`,
    },
    {
      name: "platform",
      ok: true,
      details: `${os.platform()} ${os.release()}`,
    },
    {
      name: "reset scheduling",
      ok: resetSchedulingSupported,
      details: resetSchedulingSupported
        ? "Supported via Codex CLI /status in a temporary hidden tmux session"
        : "Requires both codex and tmux on PATH",
    },
    {
      name: "automatic scheduler",
      ok: automaticSchedulingSupported,
      details:
        process.platform === "darwin"
          ? "macOS one-shot launchd"
          : process.platform === "win32"
            ? "Windows one-shot Task Scheduler"
            : "Linux currently requires manual `run-due` or external scheduling",
    },
  ];

  let statusCheck:
    | {
        attempted: boolean;
        ok: boolean;
        details: string;
      }
    | undefined;

  if (options?.statusCheck && resetSchedulingSupported) {
    const session = (await provider.getLatestSession().catch(() => undefined)) ?? providerSessions[0];
    if (!session) {
      statusCheck = {
        attempted: true,
        ok: false,
        details: "No session available for an explicit /status check.",
      };
    } else {
      try {
        const usage = await new CodexStatusUsageProvider().getUsageForSession({
          sessionId: session.id,
          projectPath: session.projectPath,
        });
        statusCheck = {
          attempted: true,
          ok: Boolean(usage.fiveHourReset || usage.weeklyReset),
          details:
            usage.fiveHourReset || usage.weeklyReset
              ? `Parsed /status for ${session.label}`
              : `Ran /status for ${session.label}, but reset lines were not parsed`,
        };
      } catch (error) {
        statusCheck = {
          attempted: true,
          ok: false,
          details: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  return {
    checks,
    pendingJobs,
    nextPendingJobTime: nextPendingJob?.scheduledAt,
    providerName: provider.name,
    sessionPreference: config.sessionPreference,
    daemonStatus,
    statusCheck,
  };
}

async function getVersion(command: string): Promise<string> {
  const versionArgs = command === "tmux" ? ["-V"] : ["--version"];
  const result = await runCommand(command, versionArgs, { timeoutMs: 5000 }).catch(() => null);
  if (!result || result.exitCode !== 0) {
    return "Installed";
  }

  return result.stdout.trim() || result.stderr.trim() || "Installed";
}
