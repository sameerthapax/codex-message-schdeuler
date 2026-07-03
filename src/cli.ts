#!/usr/bin/env node
import { Command } from "commander";

import { AppConfigStore } from "./config/AppConfigStore.js";
import { runCancelCommand } from "./commands/cancel.js";
import { runCancelLoopCommand } from "./commands/cancelLoop.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runInstallDaemonCommand } from "./commands/installDaemon.js";
import { runJobsCommand } from "./commands/jobs.js";
import { runLoopCommand } from "./commands/loop.js";
import { runLoopsCommand } from "./commands/loops.js";
import { runDueCommand } from "./commands/runDue.js";
import { runScheduleCommand } from "./commands/schedule.js";
import { ensureDaemonInstalledForCurrentCli } from "./daemon/DaemonService.js";
import { renderDependencyTable } from "./ui/render.js";
import { promptSessionPreference } from "./ui/prompts.js";
import { theme } from "./ui/theme.js";
import { ensureAppDirs } from "./utils/fs.js";
import { commandExists } from "./utils/shell.js";

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
  program.command("loop").description("Create an automatic recurring `hi` loop.").action(runLoopCommand);
  program.command("loops").description("List configured loops.").action(runLoopsCommand);
  program.command("cancel").description("Cancel a pending job.").argument("<jobId>").action(runCancelCommand);
  program.command("cancel-loop").description("Cancel a loop and its pending jobs.").argument("<loopId>").action(runCancelLoopCommand);
  program.command("run-due").description("Send all pending jobs whose scheduled time has arrived.").action(runDueCommand);
  program
    .command("doctor")
    .description("Check dependencies and scheduler health.")
    .option("--status-check", "Run Codex /status against a real session to verify reset-based scheduling.")
    .action(runDoctorCommand);
  program.command("install-daemon").description("Refresh one-shot automatic scheduling for the next pending job.").action(runInstallDaemonCommand);

  await program.parseAsync(process.argv);
}

async function ensureInitialized(): Promise<void> {
  if (!process.stdin.isTTY || process.argv.includes("run-due")) {
    return;
  }

  if (shouldSkipStartupChecks(process.argv)) {
    return;
  }

  await ensureRequiredDependencies();

  const configStore = new AppConfigStore();
  const config = await configStore.read();
  if (config.sessionPreference === "auto") {
    const sessionPreference = await promptSessionPreference();
    await configStore.write({ ...config, sessionPreference });
  }

  if ((process.platform === "darwin" || process.platform === "win32") && !process.argv.includes("install-daemon")) {
    await ensureDaemonInstalledForCurrentCli().catch(() => null);
  }
}

async function ensureRequiredDependencies(): Promise<void> {
  const checks = [
    {
      name: "codex",
      ok: await commandExists("codex"),
      details:
        process.platform === "win32"
          ? "Required for session resume and /status capture on Windows."
          : "Required for session resume and /status capture.",
    },
    {
      name: "tmux",
      ok: await commandExists("tmux"),
      details:
        process.platform === "win32"
          ? "Required for local execution. Native Windows usually needs WSL or another Unix-like tmux environment."
          : "Required for local execution and hidden session control.",
    },
  ];

  const missing = checks.filter((check) => !check.ok);
  if (missing.length === 0) {
    return;
  }

  console.log(renderDependencyTable(checks));
  console.log(
    theme.warning(
      process.platform === "win32"
        ? "codex-message-schdeuler cannot run until the required Windows runtime dependencies are installed."
        : process.platform === "darwin"
          ? "codex-message-schdeuler cannot run until the required macOS runtime dependencies are installed."
          : "codex-message-schdeuler cannot run until the required runtime dependencies are installed.",
    ),
  );
  console.log(theme.info("Run `codex-message-schdeuler doctor` for a full environment report."));
  throw new Error(`Missing required dependencies: ${missing.map((check) => check.name).join(", ")}`);
}

function shouldSkipStartupChecks(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h") || argv.includes("doctor");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`codex-message-schdeuler error: ${message}`);
  process.exitCode = 1;
});
