import ora from "ora";

import { AppConfigStore } from "../config/AppConfigStore.js";
import { createNewCodexSession } from "../codex/createSession.js";
import { discoverSessionProviderForPreference } from "../codex/discoverSessions.js";
import { LoopService, formatLoopSummary } from "../loops/LoopService.js";
import { parseScheduledTime } from "../scheduler/timeParser.js";
import { chooseSession, confirmLoopCreate, promptLoopCadence, promptManualSession, promptSessionPreference, promptTimeInput } from "../ui/prompts.js";
import { renderSessionSummary, renderWelcome } from "../ui/render.js";
import { theme } from "../ui/theme.js";

export async function runLoopCommand(): Promise<void> {
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

  const cadence = await promptLoopCadence();
  const timeInput = await promptTimeInput();
  const startAt = parseScheduledTime(timeInput).date;

  console.log(theme.info(`Loop message: hi`));
  console.log(theme.info(`Loop cadence: ${formatLoopSummary({
    id: "",
    sessionId: session.id,
    sessionLabel: session.label,
    projectPath: session.projectPath,
    cadence,
    anchorAt: startAt.toISOString(),
    message: "hi",
    status: "active",
    createdAt: new Date().toISOString(),
  })}`));

  if (!(await confirmLoopCreate())) {
    console.log(theme.warning("Loop creation cancelled."));
    return;
  }

  const loop = await new LoopService().createLoop({
    session,
    cadence,
    startAt,
  });

  console.log(theme.success(`Created loop ${loop.id}.`));
  console.log(theme.info("This loop will keep two future `hi` jobs queued automatically."));
}
