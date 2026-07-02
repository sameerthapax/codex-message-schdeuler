import { readFile } from "node:fs/promises";

import type { ScheduledJob } from "../types.js";
import { atomicWriteJson, ensureAppDirs, JOBS_FILE, pathExists } from "../utils/fs.js";

interface JobFileShape {
  jobs: ScheduledJob[];
}

export class JobStore {
  async list(): Promise<ScheduledJob[]> {
    await ensureAppDirs();
    if (!(await pathExists(JOBS_FILE))) {
      return [];
    }

    const raw = await readFile(JOBS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<JobFileShape>;
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  }

  async saveAll(jobs: ScheduledJob[]): Promise<void> {
    await atomicWriteJson(JOBS_FILE, { jobs });
  }

  async create(job: ScheduledJob): Promise<void> {
    const jobs = await this.list();
    jobs.push(job);
    await this.saveAll(jobs);
  }

  async getById(jobId: string): Promise<ScheduledJob | undefined> {
    const jobs = await this.list();
    return jobs.find((job) => job.id === jobId);
  }

  async update(jobId: string, updater: (job: ScheduledJob) => ScheduledJob): Promise<ScheduledJob> {
    const jobs = await this.list();
    const index = jobs.findIndex((job) => job.id === jobId);
    if (index === -1) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const updated = updater(jobs[index]);
    jobs[index] = updated;
    await this.saveAll(jobs);
    return updated;
  }

  async pendingDue(now = new Date()): Promise<ScheduledJob[]> {
    const jobs = await this.list();
    return jobs.filter(
      (job) => job.status === "pending" && new Date(job.scheduledAt).getTime() <= now.getTime(),
    );
  }

  async nextPending(now = new Date()): Promise<ScheduledJob | undefined> {
    const jobs = await this.list();
    return jobs
      .filter((job) => job.status === "pending")
      .sort((left, right) => {
        const leftTime = new Date(left.scheduledAt).getTime();
        const rightTime = new Date(right.scheduledAt).getTime();
        const leftAdjusted = leftTime <= now.getTime() ? now.getTime() : leftTime;
        const rightAdjusted = rightTime <= now.getTime() ? now.getTime() : rightTime;
        return leftAdjusted - rightAdjusted;
      })[0];
  }
}
