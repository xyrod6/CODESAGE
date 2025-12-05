import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface GitConfig {
  enabled: boolean;
  historyDepth: number;
  sampleWindowDays: number;
  gitBinary: string;
}

export interface Config {
  redis: {
    url: string;
    keyPrefix: string;
  };
  indexer: {
    include: string[];
    exclude: string[];
    maxFileSize: number;
  };
  pagerank: {
    damping: number;
    iterations: number;
    tolerance: number;
  };
  watcher: {
    enabled: boolean;
    debounceMs: number;
  };
  git: GitConfig;
}

const defaultGitConfig: GitConfig = {
  enabled: true,
  historyDepth: 100,
  sampleWindowDays: 90,
  gitBinary: 'git',
};

function loadConfig(): Config {
  const configPath = process.env.CODESAGE_CONFIG ||
    resolve(__dirname, '../codesage.config.json');

  try {
    const configContent = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(configContent) as Partial<Config>;

    return {
      ...parsed,
      git: {
        ...defaultGitConfig,
        ...(parsed.git || {}),
      },
    } as Config;
  } catch (error) {
    console.error(`Failed to load config from ${configPath}:`, error);
    process.exit(1);
  }
}

export const config = loadConfig();
