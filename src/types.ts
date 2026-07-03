export type JobStatus = "pending" | "sent" | "failed" | "cancelled";
export type ScheduleMode = "custom" | "five_hour_reset" | "weekly_reset";
export type LoopCadence = "every_5_hours" | "daily" | "weekly";
export type LoopStatus = "active" | "cancelled";

export interface UsageSnapshot {
  fiveHourReset?: string;
  weeklyReset?: string;
  fiveHourRemainingPercent?: number;
  weeklyRemainingPercent?: number;
  staleWarning?: boolean;
  capturedAt: string;
}

export interface ScheduledJob {
  id: string;
  sessionId: string;
  sessionLabel: string;
  projectPath?: string;
  message: string;
  scheduledAt: string;
  status: JobStatus;
  createdAt: string;
  sentAt?: string;
  error?: string;
  tmuxSessionName?: string;
  scheduleMode?: ScheduleMode;
  usageSnapshot?: UsageSnapshot;
  loopId?: string;
  loopCadence?: LoopCadence;
  loopOccurrenceAt?: string;
}

export interface ScheduledLoop {
  id: string;
  sessionId: string;
  sessionLabel: string;
  projectPath?: string;
  cadence: LoopCadence;
  anchorAt: string;
  message: string;
  status: LoopStatus;
  createdAt: string;
  lastEnqueuedAt?: string;
}

export interface CodexSession {
  id: string;
  label: string;
  updatedAt?: string;
  projectPath?: string;
  source: string;
  sourceKind?: "cli" | "app" | "other";
}

export interface DependencyCheck {
  name: string;
  ok: boolean;
  details: string;
}
