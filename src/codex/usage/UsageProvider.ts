export interface CodexUsage {
  fiveHourReset?: Date;
  weeklyReset?: Date;
  fiveHourRemainingPercent?: number;
  weeklyRemainingPercent?: number;
  staleWarning?: boolean;
  rawStatus: string;
}

export interface UsageProvider {
  getUsageForSession(input: {
    sessionId: string;
    projectPath?: string;
  }): Promise<CodexUsage>;
}
