import { confirm, input, select } from "@inquirer/prompts";

import type { SessionPreference } from "../config/AppConfigStore.js";
import type { CodexSession, ScheduleMode } from "../types.js";

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
