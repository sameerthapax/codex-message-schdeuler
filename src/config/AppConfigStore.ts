import { readFile } from "node:fs/promises";
import path from "node:path";

import { APP_DIR, atomicWriteJson, pathExists } from "../utils/fs.js";

export type SessionPreference = "cli" | "app" | "auto";

export interface AppConfig {
  sessionPreference: SessionPreference;
  daemonInstalled?: boolean;
  daemonScriptPath?: string;
}

const CONFIG_FILE = path.join(APP_DIR, "config.json");

const DEFAULT_CONFIG: AppConfig = {
  sessionPreference: "auto",
};

export class AppConfigStore {
  async read(): Promise<AppConfig> {
    if (!(await pathExists(CONFIG_FILE))) {
      return DEFAULT_CONFIG;
    }

    try {
      const raw = await readFile(CONFIG_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      return {
        sessionPreference: parsed.sessionPreference || DEFAULT_CONFIG.sessionPreference,
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  async write(config: AppConfig): Promise<void> {
    await atomicWriteJson(CONFIG_FILE, config);
  }
}
