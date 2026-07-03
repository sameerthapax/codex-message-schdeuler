import { readFile } from "node:fs/promises";

import type { ScheduledLoop } from "../types.js";
import { atomicWriteJson, ensureAppDirs, LOOPS_FILE, pathExists } from "../utils/fs.js";

interface LoopFileShape {
  loops: ScheduledLoop[];
}

export class LoopStore {
  async list(): Promise<ScheduledLoop[]> {
    await ensureAppDirs();
    if (!(await pathExists(LOOPS_FILE))) {
      return [];
    }

    const raw = await readFile(LOOPS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<LoopFileShape>;
    return Array.isArray(parsed.loops) ? parsed.loops : [];
  }

  async saveAll(loops: ScheduledLoop[]): Promise<void> {
    await atomicWriteJson(LOOPS_FILE, { loops });
  }

  async create(loop: ScheduledLoop): Promise<void> {
    const loops = await this.list();
    loops.push(loop);
    await this.saveAll(loops);
  }

  async update(loopId: string, updater: (loop: ScheduledLoop) => ScheduledLoop): Promise<ScheduledLoop> {
    const loops = await this.list();
    const index = loops.findIndex((loop) => loop.id === loopId);
    if (index === -1) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    const updated = updater(loops[index]);
    loops[index] = updated;
    await this.saveAll(loops);
    return updated;
  }

  async getById(loopId: string): Promise<ScheduledLoop | undefined> {
    const loops = await this.list();
    return loops.find((loop) => loop.id === loopId);
  }
}
