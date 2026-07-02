import { SchedulerService } from "../scheduler/SchedulerService.js";
import { renderJobsTable } from "../ui/render.js";
import { theme } from "../ui/theme.js";

export async function runJobsCommand(): Promise<void> {
  const jobs = await new SchedulerService().listJobs();
  if (jobs.length === 0) {
    console.log(theme.muted("No scheduled jobs yet."));
    return;
  }

  console.log(renderJobsTable(jobs));
}
