import { SchedulerService } from "../scheduler/SchedulerService.js";
import { LOG_DIR } from "../utils/fs.js";
import { theme } from "../ui/theme.js";

export async function runDueCommand(): Promise<void> {
  const jobs = await new SchedulerService().runDueJobs();

  if (jobs.length === 0) {
    console.log(theme.muted("No due jobs right now. Launchd schedule refreshed."));
    return;
  }

  for (const job of jobs) {
    const logPath = `${LOG_DIR}/${job.id}.log`;
    if (job.status === "sent") {
      console.log(theme.success(`Sent job ${job.id} to ${job.sessionLabel}. Log: ${logPath}`));
    } else {
      console.log(
        theme.danger(`Failed job ${job.id}: ${job.error || "Unknown error"}. Check: ${logPath}`),
      );
    }
  }
}
