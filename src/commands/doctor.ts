import { getDoctorReport } from "../doctor.js";
import { renderDependencyTable } from "../ui/render.js";
import { theme } from "../ui/theme.js";

export async function runDoctorCommand(options?: { statusCheck?: boolean }): Promise<void> {
  const report = await getDoctorReport(options);
  console.log(renderDependencyTable(report.checks));
  console.log(theme.info(`Pending jobs: ${report.pendingJobs}`));
  console.log(theme.info(`Next pending job: ${report.nextPendingJobTime || "none"}`));
  console.log(theme.info(`Session provider: ${report.providerName}`));
  console.log(theme.info(`Session preference: ${report.sessionPreference}`));
  console.log(theme.info(`Scheduler backend: ${report.daemonStatus.scheduler}`));
  console.log(theme.info(`Scheduler mode: ${report.daemonStatus.mode}`));
  console.log(theme.info(`Scheduler armed: ${report.daemonStatus.armed ? "yes" : "no"}`));
  console.log(theme.info(`Scheduler next run: ${report.daemonStatus.nextRunAt || "none"}`));
  console.log(theme.info(`Scheduler target: ${report.daemonStatus.plistPath}`));
  if (report.statusCheck) {
    console.log(
      report.statusCheck.ok
        ? theme.success(`Status check: ${report.statusCheck.details}`)
        : theme.warning(`Status check: ${report.statusCheck.details}`),
    );
  } else {
    console.log(theme.muted("Status check: skipped. Use `doctor --status-check` to run Codex /status against a real session."));
  }
  if (report.daemonStatus.oldPollingPlistDetected) {
    console.log(theme.warning("Legacy StartInterval polling plist detected; it will be replaced on refresh."));
  }
}
