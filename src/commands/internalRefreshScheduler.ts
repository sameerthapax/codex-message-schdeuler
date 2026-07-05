import { installDaemonForCurrentCli } from "../daemon/DaemonService.js";
import { logLine } from "../utils/logger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runInternalRefreshSchedulerCommand(): Promise<void> {
  await sleep(1000);
  try {
    const result = await installDaemonForCurrentCli();
    await logLine(`Detached scheduler refresh completed: ${result.message}`);
  } catch (error) {
    await logLine(
      `Detached scheduler refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}
