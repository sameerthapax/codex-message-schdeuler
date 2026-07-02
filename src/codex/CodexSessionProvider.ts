import type { CodexSession } from "../types.js";

export interface CodexSessionProvider {
  readonly name: string;
  listSessions(): Promise<CodexSession[]>;
  getLatestSession(): Promise<CodexSession | undefined>;
}
