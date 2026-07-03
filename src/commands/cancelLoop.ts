import { LoopService } from "../loops/LoopService.js";
import { theme } from "../ui/theme.js";

export async function runCancelLoopCommand(loopId: string): Promise<void> {
  const loop = await new LoopService().cancelLoop(loopId);
  console.log(theme.success(`Cancelled loop ${loop.id} (${loop.sessionLabel}).`));
}
