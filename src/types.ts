export type JobStatus = "pending" | "sent" | "failed" | "cancelled";
export type ScheduleMode = "custom" | "five_hour_reset" | "weekly_reset";

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
