import { SchedulerService } from "../scheduler/SchedulerService.js";
import { theme } from "../ui/theme.js";

export async function runCancelCommand(jobId: string): Promise<void> {
  const job = await new SchedulerService().cancelJob(jobId);
  console.log(theme.success(`Cancelled job ${job.id} (${job.sessionLabel}).`));
}
