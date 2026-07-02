#!/usr/bin/env node
import { Command } from "commander";

import { AppConfigStore } from "./config/AppConfigStore.js";
import { runCancelCommand } from "./commands/cancel.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runInstallDaemonCommand } from "./commands/installDaemon.js";
import { runJobsCommand } from "./commands/jobs.js";
import { runDueCommand } from "./commands/runDue.js";
import { runScheduleCommand } from "./commands/schedule.js";
import { ensureDaemonInstalledForCurrentCli } from "./daemon/DaemonService.js";
import { promptSessionPreference } from "./ui/prompts.js";
import { ensureAppDirs } from "./utils/fs.js";

async function main(): Promise<void> {
  await ensureAppDirs();
  await ensureInitialized();

  const program = new Command();
  program
    .name("codex-message-schdeuler")
    .description("Unofficial local scheduler for Codex CLI sessions using tmux.")
    .action(runScheduleCommand);

  program.command("schedule").description("Open the interactive scheduling flow.").action(runScheduleCommand);
  program.command("jobs").description("List scheduled jobs.").action(runJobsCommand);
  program.command("cancel").description("Cancel a pending job.").argument("<jobId>").action(runCancelCommand);
  program.command("run-due").description("Send all pending jobs whose scheduled time has arrived.").action(runDueCommand);
  program
    .command("doctor")
    .description("Check dependencies and scheduler health.")
    .option("--status-check", "Run Codex /status against a real session to verify reset-based scheduling.")
    .action(runDoctorCommand);
  program.command("install-daemon").description("Refresh one-shot macOS launchd scheduling for the next pending job.").action(runInstallDaemonCommand);

  await program.parseAsync(process.argv);
}

async function ensureInitialized(): Promise<void> {
  if (!process.stdin.isTTY || process.argv.includes("run-due")) {
    return;
  }

  const configStore = new AppConfigStore();
  const config = await configStore.read();
  if (config.sessionPreference === "auto") {
    const sessionPreference = await promptSessionPreference();
    await configStore.write({ ...config, sessionPreference });
  }

  if (process.platform === "darwin" && !process.argv.includes("install-daemon")) {
    await ensureDaemonInstalledForCurrentCli().catch(() => null);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`codex-message-schdeuler error: ${message}`);
  process.exitCode = 1;
});
