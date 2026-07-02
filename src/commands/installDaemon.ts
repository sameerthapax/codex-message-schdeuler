import { installDaemonForCurrentCli } from "../daemon/DaemonService.js";
import { theme } from "../ui/theme.js";

export async function runInstallDaemonCommand(): Promise<void> {
  const result = await installDaemonForCurrentCli();
  console.log(theme.success("launchd scheduling refreshed."));
  console.log(theme.info(result.message));
  console.log(theme.muted(`Plist: ${result.plistPath}`));
}
