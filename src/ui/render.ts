import boxen from "boxen";
import chalk from "chalk";
import Table from "cli-table3";

import type { CodexSession, DependencyCheck, ScheduledJob, ScheduleMode } from "../types.js";
import { formatScheduledTime } from "../scheduler/timeParser.js";
import { theme } from "./theme.js";

export function renderWelcome(): string {
  const title = theme.title("codex-message-schdeuler");
  const subtitle = theme.muted("Schedule a future message for a Codex session.");
  return boxen(`${title}\n${subtitle}`, {
    borderStyle: "round",
    borderColor: "cyan",
    padding: 1,
  });
}

export function renderDependencyTable(checks: DependencyCheck[]): string {
  const table = new Table({
    head: ["Dependency", "Status", "Details"],
    style: { head: ["cyan"] },
    wordWrap: true,
  });

  for (const check of checks) {
    table.push([
      check.name,
      check.ok ? theme.success("OK") : theme.danger("Missing"),
      check.details,
    ]);
  }

  return table.toString();
}

export function renderSessionSummary(session: CodexSession): string {
  return boxen(
    `${theme.accent(session.label)}\n${chalk.white(session.id)}\n${theme.muted(session.projectPath || "No known project path")}`,
    {
      borderStyle: "round",
      borderColor: "yellow",
      padding: 1,
    },
  );
}

export function renderJobConfirmation(input: {
  sessionLabel: string;
  sessionId: string;
  scheduledAt: Date;
  message: string;
  scheduleMode?: ScheduleMode;
}): string {
  return boxen(
    [
      `${theme.accent("Session")}  ${input.sessionLabel}`,
      `${theme.muted("ID")}       ${input.sessionId}`,
      input.scheduleMode ? `${theme.accent("Mode")}     ${formatScheduleMode(input.scheduleMode)}` : undefined,
      `${theme.accent("Send at")}  ${formatScheduledTime(input.scheduledAt)}`,
      `${theme.accent("Message")}  ${input.message}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    {
      borderStyle: "double",
      borderColor: "green",
      padding: 1,
    },
  );
}

export function renderJobSaved(job: ScheduledJob): string {
  return boxen(
    `${theme.success("Scheduled successfully")}\n${theme.muted("Job ID")} ${job.id}\n${theme.muted("Due")} ${formatScheduledTime(new Date(job.scheduledAt))}`,
    {
      borderStyle: "round",
      borderColor: "green",
      padding: 1,
    },
  );
}

export function renderJobsTable(jobs: ScheduledJob[]): string {
  const table = new Table({
    head: ["Job ID", "Status", "Session", "Scheduled", "Message"],
    style: { head: ["cyan"] },
    wordWrap: true,
    colWidths: [38, 12, 28, 28, 44],
  });

  for (const job of jobs) {
    table.push([
      job.id,
      job.status,
      job.sessionLabel,
      formatScheduledTime(new Date(job.scheduledAt)),
      truncate(job.message, 40),
    ]);
  }

  return table.toString();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function formatScheduleMode(mode: ScheduleMode): string {
  switch (mode) {
    case "five_hour_reset":
      return "5-hour reset";
    case "weekly_reset":
      return "Weekly reset";
    default:
      return "Custom time";
  }
}
