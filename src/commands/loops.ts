import { LoopService } from "../loops/LoopService.js";
import { renderLoopsTable } from "../ui/render.js";
import { theme } from "../ui/theme.js";

export async function runLoopsCommand(): Promise<void> {
  const loops = await new LoopService().listLoops();
  if (loops.length === 0) {
    console.log(theme.muted("No loops yet."));
    return;
  }

  console.log(renderLoopsTable(loops));
}
