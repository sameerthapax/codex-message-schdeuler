import { AppConfigStore } from "../config/AppConfigStore.js";
import ora from "ora";

import { createNewCodexSession } from "../codex/createSession.js";
import { discoverSessionProviderForPreference } from "../codex/discoverSessions.js";
import { CodexStatusUsageProvider } from "../codex/usage/CodexStatusUsageProvider.js";
import { SchedulerService } from "../scheduler/SchedulerService.js";
import { formatScheduledTime, parseScheduledTime } from "../scheduler/timeParser.js";
import { renderJobConfirmation, renderJobSaved, renderSessionSummary, renderWelcome } from "../ui/render.js";
import { chooseSession, confirmResetSchedule, confirmSchedule, confirmUseStaleResetTime, promptManualSession, promptMessage, promptScheduleInput, promptScheduleMode, promptSessionPreference, promptTimeInput } from "../ui/prompts.js";
import { theme } from "../ui/theme.js";
import type { CodexSession, ScheduleMode, UsageSnapshot } from "../types.js";

export async function runScheduleCommand(): Promise<void> {
  console.log(renderWelcome());

  const configStore = new AppConfigStore();
  const config = await configStore.read();
  const sessionPreference =
    config.sessionPreference === "auto" ? await promptSessionPreference() : config.sessionPreference;

  if (sessionPreference !== config.sessionPreference) {
    await configStore.write({ ...config, sessionPreference });
  }

  const providerSpinner = ora("Loading Codex sessions").start();
  const provider = await discoverSessionProviderForPreference(sessionPreference);
  const discoveredSessions = await provider.listSessions().catch(() => []);
  providerSpinner.succeed(
    `Loaded session provider: ${provider.name} (${sessionPreference} preference)`,
  );

  const selected = discoveredSessions.length > 0 ? await chooseSession(discoveredSessions) : "__manual__";
  let session;
  if (selected === "__manual__") {
    session = await promptManualSession();
  } else if (selected === "__create__") {
    console.log(theme.info("Open or create the new Codex session now. Exit back here when ready."));
    session = await createNewCodexSession(discoveredSessions, sessionPreference);
  } else {
    session = selected;
  }

  console.log(renderSessionSummary(session));

  const scheduleMode = await promptScheduleMode();
  const resolvedTiming = await resolveScheduledTiming(session, scheduleMode);
  const message = resolvedTiming.message ?? await promptMessage();
  const scheduledAt = resolvedTiming.date;

  console.log(
    renderJobConfirmation({
      sessionLabel: session.label,
      sessionId: session.id,
      scheduledAt: scheduledAt.date,
      message,
      scheduleMode: resolvedTiming.scheduleMode,
    }),
  );

  if (!(await confirmSchedule())) {
    console.log(theme.warning("Schedule cancelled."));
    return;
  }

  const service = new SchedulerService();
  const job = await service.scheduleJob({
    session,
    message,
    scheduledAt: scheduledAt.date,
    scheduleMode: resolvedTiming.scheduleMode,
    usageSnapshot: resolvedTiming.usageSnapshot,
  });

  console.log(renderJobSaved(job));
  console.log(
    theme.info("On macOS, launchd is refreshed automatically for the next pending job."),
  );
}

async function resolveScheduledTiming(
  session: CodexSession,
  scheduleMode: ScheduleMode,
): Promise<{
  date: ReturnType<typeof parseScheduledTime>;
  usageSnapshot?: UsageSnapshot;
  message?: string;
  scheduleMode: ScheduleMode;
}> {
  if (scheduleMode === "custom") {
    const { timeInput, message } = await promptScheduleInput();
    return {
      date: parseScheduledTime(timeInput),
      message,
      scheduleMode: "custom",
    };
  }

  const usageSpinner = ora("Reading Codex /status…").start();

  try {
    const usage = await new CodexStatusUsageProvider().getUsageForSession({
      sessionId: session.id,
      projectPath: session.projectPath,
    });
    usageSpinner.succeed("Read Codex /status");

    const resetDate =
      scheduleMode === "five_hour_reset" ? usage.fiveHourReset : usage.weeklyReset;

    if (!resetDate) {
      console.log(theme.warning("Could not parse the requested reset time from Codex /status."));
      const relevantSnippet = usage.rawStatus
        .split("\n")
        .filter((line) => /5h limit:|weekly limit:|stale/i.test(line))
        .join("\n");
      if (relevantSnippet) {
        console.log(theme.muted(relevantSnippet));
      }
      console.log(theme.info("Falling back to custom time input."));
      const timeInput = await promptTimeInput();
      return {
        date: parseScheduledTime(timeInput),
        scheduleMode: "custom",
      };
    }

    const label = formatScheduledTime(resetDate);
    console.log(
      theme.info(
        `${scheduleMode === "five_hour_reset" ? "5-hour" : "Weekly"} reset detected: ${label}`,
      ),
    );

    if (usage.staleWarning) {
      console.log(
        theme.warning(
          "Codex says limits may be stale. This scheduler will use the parsed reset time, but you can run /status again or choose custom time.",
        ),
      );
      const continueWithReset = await confirmUseStaleResetTime();
      if (!continueWithReset) {
        const timeInput = await promptTimeInput();
        return {
          date: parseScheduledTime(timeInput),
          scheduleMode: "custom",
        };
      }
    }

    const confirmed = await confirmResetSchedule(label);
    if (!confirmed) {
      const timeInput = await promptTimeInput();
      return {
        date: parseScheduledTime(timeInput),
        scheduleMode: "custom",
      };
    }

    return {
      date: {
        date: resetDate,
        display: label,
      },
      scheduleMode,
      usageSnapshot: {
        fiveHourReset: usage.fiveHourReset?.toISOString(),
        weeklyReset: usage.weeklyReset?.toISOString(),
        fiveHourRemainingPercent: usage.fiveHourRemainingPercent,
        weeklyRemainingPercent: usage.weeklyRemainingPercent,
        staleWarning: usage.staleWarning,
        capturedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    usageSpinner.fail("Could not read Codex /status");
    const message = error instanceof Error ? error.message : String(error);
    console.log(theme.warning(message));
    console.log(theme.info("Falling back to custom time input."));
    const timeInput = await promptTimeInput();
    return {
      date: parseScheduledTime(timeInput),
      scheduleMode: "custom",
    };
  }
}
