import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (!settled) {
              settled = true;
              child.kill("SIGTERM");
              reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`));
            }
          }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(error);
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
        });
      }
    });
  });
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    await resolveExecutable(command);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExecutable(command: string): Promise<string> {
  if (path.isAbsolute(command)) {
    await assertExecutable(command);
    return command;
  }

  const envPath = process.env.PATH || "";
  const searchDirs = [
    ...envPath.split(path.delimiter).filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];

  const uniqueDirs = [...new Set(searchDirs)];
  for (const dir of uniqueDirs) {
    const candidate = path.join(dir, command);
    try {
      await assertExecutable(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(`Executable not found: ${command}`);
}

async function assertExecutable(filePath: string): Promise<void> {
  await access(filePath);
}
