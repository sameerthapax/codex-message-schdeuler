import { confirm, input, select } from "@inquirer/prompts";

import type { SessionPreference } from "../config/AppConfigStore.js";
import type { CodexSession, LoopCadence, ScheduleMode, SleepPolicy } from "../types.js";

export type ScheduleIntent = "one_time" | "loop";

export async function chooseSession(
  sessions: CodexSession[],
): Promise<CodexSession | "__manual__" | "__create__"> {
  const sessionChoices = sessions.map((session) => ({
    value: session.id,
    name: `${session.label}  ${session.projectPath ? `(${session.projectPath})` : ""}`,
    description: [
      session.sourceKind ? `Source: ${session.sourceKind}` : undefined,
      session.updatedAt ? `Updated ${session.updatedAt}` : undefined,
    ]
      .filter(Boolean)
      .join("  "),
  }));

  const choices =
    sessionChoices.length > 0
      ? [
          sessionChoices[0],
          {
            value: "__create__",
            name: "Create new session",
            description: "Open Codex now, create a new session, then return to scheduling.",
          },
          ...sessionChoices.slice(1),
        ]
      : [
          {
            value: "__create__",
            name: "Create new session",
            description: "Open Codex now, create a new session, then return to scheduling.",
          },
        ];

  choices.push({
    value: "__manual__",
    name: "Manual session id",
    description: "Use this if auto-discovery is incomplete or unavailable.",
  });

  const selectedId = await select({
    message: "Choose a Codex session",
    pageSize: 12,
    choices,
  });

  if (selectedId === "__manual__" || selectedId === "__create__") {
    return selectedId;
  }

  return sessions.find((session) => session.id === selectedId)!;
}

export async function promptManualSession(): Promise<CodexSession> {
  const sessionId = await input({
    message: "Enter the Codex session id, or type `latest` to resume the latest session",
    validate: (value) => (value.trim() ? true : "Session id is required."),
  });

  const projectPath = await input({
    message: "Optional project path to resume from",
  });

  return {
    id: sessionId.trim() === "latest" ? "__latest__" : sessionId.trim(),
    label: sessionId.trim() === "latest" ? "Resume latest session" : sessionId.trim(),
    projectPath: projectPath.trim() || undefined,
    source: "manual",
  };
}

export async function promptTimeInput(): Promise<string> {
  return input({
    message: "When should this message be sent? Use your local time, for example `05:01 pm`.",
    default: "05:01 pm",
    validate: (value) => (value.trim() ? true : "Time is required."),
  });
}

export async function promptScheduleInput(): Promise<{ timeInput: string; message: string }> {
  const timeInput = await promptTimeInput();
  const message = await promptMessage();
  return { timeInput, message };
}

export async function promptScheduleMode(): Promise<ScheduleMode> {
  return select({
    message: "Schedule timing",
    choices: [
      {
        value: "custom",
        name: "Send at custom time",
        description: "Enter a local time manually, for example 05:01 pm.",
      },
      {
        value: "five_hour_reset",
        name: "Send when my 5-hour limit resets",
        description: "Reads Codex CLI /status from the selected session and schedules for that reset.",
      },
      {
        value: "weekly_reset",
        name: "Send when my weekly limit resets",
        description: "Reads Codex CLI /status from the selected session and schedules for that reset.",
      },
    ],
  });
}

export async function promptScheduleIntent(): Promise<ScheduleIntent> {
  return select({
    message: "What do you want to do with this session?",
    choices: [
      {
        value: "one_time",
        name: "One time schedule",
        description: "Send a single scheduled message.",
      },
      {
        value: "loop",
        name: "Re run this schedule in a loop (keep session alive)",
        description: "Keep two future `hi` jobs queued automatically.",
      },
    ],
  });
}

export async function promptMessage(): Promise<string> {
  return input({
    message: "What message should Codex receive?",
    validate: (value) => (value.trim() ? true : "Message is required."),
  });
}

export async function confirmResetSchedule(dateLabel: string): Promise<boolean> {
  return confirm({
    message: `Schedule message for this reset time? ${dateLabel}`,
    default: true,
  });
}

export async function confirmUseStaleResetTime(): Promise<boolean> {
  return confirm({
    message:
      "Codex says limits may be stale. Use the parsed reset time anyway? Choose no to fall back to custom time.",
    default: true,
  });
}

export async function promptLoopCadence(): Promise<LoopCadence> {
  return select({
    message: "Loop cadence",
    choices: [
      {
        value: "every_5_hours",
        name: "Every 5 hours",
        description: "Send `hi` every 5 hours after the chosen start time.",
      },
      {
        value: "daily",
        name: "Daily",
        description: "Send `hi` every day at the chosen local time.",
      },
      {
        value: "weekly",
        name: "Weekly",
        description: "Send `hi` every week at the chosen local time.",
      },
    ],
  });
}

export async function promptLoopStartMode(): Promise<"custom" | "five_hour_reset"> {
  return select({
    message: "First loop run timing",
    choices: [
      {
        value: "custom",
        name: "Send at custom time",
        description: "Enter the first local time manually, for example 05:01 pm.",
      },
      {
        value: "five_hour_reset",
        name: "Send when my 5-hour limit resets",
        description: "Reads Codex CLI /status from the selected session and uses only the reset time-of-day.",
      },
    ],
  });
}

export async function confirmLoopCreate(): Promise<boolean> {
  return confirm({
    message: "Create this loop?",
    default: true,
  });
}

export async function promptSleepPolicy(): Promise<SleepPolicy> {
  return select({
    message: "Sleep policy",
    default: "wake_mac_if_possible",
    choices: [
      {
        value: "wake_mac_if_possible",
        name: "wake_mac_if_possible",
        description: "Default. On macOS, try to schedule a system wake with pmset for the earliest pending job.",
      },
      {
        value: "catch_up_on_wake",
        name: "catch_up_on_wake",
        description: "Do not try to wake the Mac. If asleep, send overdue jobs after wake.",
      },
    ],
  });
}

export async function confirmSchedule(): Promise<boolean> {
  return confirm({
    message: "Save this scheduled job?",
    default: true,
  });
}

export async function promptSessionPreference(): Promise<SessionPreference> {
  return select({
    message: "Which sessions do you mainly use?",
    choices: [
      {
        value: "cli",
        name: "Codex CLI",
        description: "Prioritize transcript sessions created from the terminal Codex CLI.",
      },
      {
        value: "app",
        name: "Codex app",
        description: "Prioritize sessions associated with the app / VS Code integration.",
      },
      {
        value: "auto",
        name: "Auto",
        description: "Do not prefer one source over the other.",
      },
    ],
  });
}
