import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const configuredAppDir =
  process.env.CODEX_MESSAGE_SCHEDULER_HOME?.trim() ||
  process.env.CODEX_TMUX_SCHEDULER_HOME?.trim() ||
  process.env.CODEX_SCHEDULER_HOME?.trim();

const modernDefaultAppDir = path.join(os.homedir(), ".codex-message-scheduler");
const legacyDefaultAppDir = path.join(os.homedir(), ".codex-scheduler");

const resolvedAppDir = configuredAppDir
  ? path.resolve(configuredAppDir)
  : legacyDirShouldBeUsed()
    ? legacyDefaultAppDir
    : modernDefaultAppDir;

export const APP_DIR = resolvedAppDir;
export const JOBS_FILE = path.join(resolvedAppDir, "jobs.json");
export const LOOPS_FILE = path.join(resolvedAppDir, "loops.json");
export const LOG_DIR = path.join(resolvedAppDir, "logs");
export const TMP_DIR = path.join(resolvedAppDir, ".tmp");
export const WAKE_EVENT_FILE = path.join(resolvedAppDir, "wake-event.json");

export async function ensureAppDirs(): Promise<void> {
  await mkdir(APP_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(TMP_DIR, { recursive: true });
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await ensureAppDirs();
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    TMP_DIR,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

export async function pathIsWritable(targetPath: string): Promise<boolean> {
  try {
    await ensureAppDirs();
    const probeFile = path.join(targetPath, `.write-test-${process.pid}-${Date.now()}`);
    await writeFile(probeFile, "ok", "utf8");
    await rm(probeFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function legacyDirShouldBeUsed(): boolean {
  return existsSync(legacyDefaultAppDir) && !existsSync(modernDefaultAppDir);
}
