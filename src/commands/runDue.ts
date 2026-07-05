import { isManagedLaunchdRun, rearmSchedulerAfterManagedRun } from "../daemon/DaemonService.js";
import { SchedulerService } from "../scheduler/SchedulerService.js";
import { LOG_DIR } from "../utils/fs.js";
import { theme } from "../ui/theme.js";

export async function runDueCommand(): Promise<void> {
  const managedLaunchdRun = isManagedLaunchdRun();
  const jobs = await new SchedulerService().runDueJobs(new Date(), {
    refreshSchedule: !managedLaunchdRun,
  });

  if (managedLaunchdRun) {
    await rearmSchedulerAfterManagedRun();
  }

  if (jobs.length === 0) {
    console.log(theme.muted("No due jobs right now. Automatic schedule refreshed."));
    return;
  }

  for (const job of jobs) {
    const logPath = `${LOG_DIR}/${job.id}.log`;
    if (job.status === "sent") {
      console.log(theme.success(`Sent job ${job.id} to ${job.sessionLabel}. Log: ${logPath}`));
    } else if (job.status === "not_sure") {
      console.log(
        theme.warning(`Not sure whether job ${job.id} was accepted: ${job.error || "No visible Codex acceptance detected"}. Check: ${logPath}`),
      );
    } else if (job.status === "skipped_due_to_mac_sleep") {
      console.log(
        theme.warning(`Skipped job ${job.id}: ${job.error || "Skipped due to catch_up_on_wake policy"}. Log: ${logPath}`),
      );
    } else {
      console.log(
        theme.danger(`Failed job ${job.id}: ${job.error || "Unknown error"}. Check: ${logPath}`),
      );
    }
  }
}
