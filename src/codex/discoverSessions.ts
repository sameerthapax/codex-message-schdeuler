import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SessionPreference } from "../config/AppConfigStore.js";
import type { CodexSession } from "../types.js";
import type { CodexSessionProvider } from "./CodexSessionProvider.js";

interface SessionIndexEntry {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

interface SessionEnvelope {
  timestamp?: string;
  type?: string;
  payload?: SessionMetaPayload;
}

interface SessionMetaPayload {
  id?: string;
  session_id?: string;
  cwd?: string;
  timestamp?: string;
  source?: string;
  originator?: string;
}

interface SessionRecord {
  id: string;
  updatedAt?: string;
  projectPath?: string;
  source?: string;
  originator?: string;
}

export class FileSystemCodexSessionProvider implements CodexSessionProvider {
  readonly name = "filesystem-session-transcripts";
  private readonly codexHome = path.join(os.homedir(), ".codex");
  private readonly sessionIndexPath = path.join(this.codexHome, "session_index.jsonl");
  private readonly sessionsDir = path.join(this.codexHome, "sessions");

  constructor(private readonly preference: SessionPreference = "auto") {}

  async listSessions(): Promise<CodexSession[]> {
    const [records, sessionIndex] = await Promise.all([
      this.readSessionRecords(),
      this.readSessionIndex(),
    ]);

    return records
      .map((record) => {
        const indexEntry = sessionIndex.get(record.id);
        const sourceKind = classifySourceKind(record);
        return {
          id: record.id,
          label: this.buildLabel(record, indexEntry),
          updatedAt: record.updatedAt || indexEntry?.updated_at,
          projectPath: record.projectPath,
          source: record.source || this.name,
          sourceKind,
        } satisfies CodexSession;
      })
      .sort((left, right) => {
        const sourceOrder = compareByPreference(left.sourceKind, right.sourceKind, this.preference);
        if (sourceOrder !== 0) {
          return sourceOrder;
        }

        const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
        const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
        return rightTime - leftTime;
      });
  }

  async getLatestSession(): Promise<CodexSession | undefined> {
    return (await this.listSessions())[0];
  }

  private async readSessionIndex(): Promise<Map<string, SessionIndexEntry>> {
    try {
      const raw = await readFile(this.sessionIndexPath, "utf8");
      const entries = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionIndexEntry);

      return new Map(entries.map((entry) => [entry.id, entry]));
    } catch {
      return new Map();
    }
  }

  private async readSessionRecords(): Promise<SessionRecord[]> {
    const files = await collectFiles(this.sessionsDir);
    const records = new Map<string, SessionRecord>();

    for (const file of files) {
      const firstLine = await readFirstLine(file);
      if (!firstLine) {
        continue;
      }

      try {
        const envelope = JSON.parse(firstLine) as SessionEnvelope;
        const payload = envelope.payload;
        const id = payload?.session_id || payload?.id;
        if (!id || records.has(id)) {
          continue;
        }

        records.set(id, {
          id,
          updatedAt: payload?.timestamp || envelope.timestamp,
          projectPath: payload?.cwd,
          source: payload?.source,
          originator: payload?.originator,
        });
      } catch {
        continue;
      }
    }

    return [...records.values()];
  }

  private buildLabel(record: SessionRecord, indexEntry?: SessionIndexEntry): string {
    const indexedName = indexEntry?.thread_name?.trim();
    if (indexedName) {
      return indexedName;
    }

    const sourceLabel =
      record.source === "cli"
        ? "CLI session"
        : record.source === "vscode"
          ? "App session"
          : record.originator || "Codex session";

    if (record.projectPath) {
      return `${path.basename(record.projectPath)} (${sourceLabel})`;
    }

    return `${sourceLabel} ${record.id.slice(0, 8)}`;
  }
}

export class FallbackCodexSessionProvider implements CodexSessionProvider {
  readonly name = "fallback";

  async listSessions(): Promise<CodexSession[]> {
    const latest = await this.getLatestSession();
    return latest ? [latest] : [];
  }

  async getLatestSession(): Promise<CodexSession | undefined> {
    return {
      id: "__latest__",
      label: "Resume latest session",
      source: this.name,
    };
  }
}

export async function discoverSessionProvider(): Promise<CodexSessionProvider> {
  try {
    const provider = new FileSystemCodexSessionProvider();
    const sessions = await provider.listSessions();
    if (sessions.length > 0) {
      return provider;
    }
  } catch {
    // Fall through to explicit fallback mode.
  }

  return new FallbackCodexSessionProvider();
}

export async function discoverSessionProviderForPreference(
  preference: SessionPreference,
): Promise<CodexSessionProvider> {
  try {
    const provider = new FileSystemCodexSessionProvider(preference);
    const sessions = await provider.listSessions();
    if (sessions.length > 0) {
      return provider;
    }
  } catch {
    // Fall through to explicit fallback mode.
  }

  return new FallbackCodexSessionProvider();
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && fullPath.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function readFirstLine(filePath: string): Promise<string | undefined> {
  const content = await readFile(filePath, "utf8");
  return content.split("\n", 1)[0];
}

function classifySourceKind(record: SessionRecord): "cli" | "app" | "other" {
  if (record.source === "cli" || record.originator === "codex-tui") {
    return "cli";
  }

  if (record.source === "vscode" || record.originator === "Codex Desktop") {
    return "app";
  }

  return "other";
}

function compareByPreference(
  left: CodexSession["sourceKind"],
  right: CodexSession["sourceKind"],
  preference: SessionPreference,
): number {
  if (preference === "auto") {
    return 0;
  }

  const preferredKind = preference;
  if (left === preferredKind && right !== preferredKind) {
    return -1;
  }
  if (right === preferredKind && left !== preferredKind) {
    return 1;
  }

  return 0;
}
