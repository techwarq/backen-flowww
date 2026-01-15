import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Base directories - Using process.cwd() to ensure data/ is always in the root
export const PROJECT_ROOT = process.cwd();
export const DATA_DIR = process.env.VERCEL ? '/tmp' : path.join(PROJECT_ROOT, 'data');
export const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
export const ENCRYPTED_DIR = path.join(DATA_DIR, 'encrypted');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');

// Config files
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
export const OPERATORS_FILE = path.join(DATA_DIR, 'operators.json');

// Platform-specific profile directories
export function getProfileDir(platform: 'flipkart' | 'shopsy', accountId: string): string {
  return path.join(PROFILES_DIR, platform, accountId, 'userDataDir');
}

export function getEncryptedPath(platform: 'flipkart' | 'shopsy', accountId: string): string {
  return path.join(ENCRYPTED_DIR, platform, `${accountId}.zip.enc`);
}

export function getAccountLogPath(accountId: string): string {
  return path.join(LOGS_DIR, `${accountId}.log.json`);
}

// Global configuration interface
export interface GlobalConfig {
  version: string;
  maxConcurrency: number;
  healthCheckIntervalHours: number;
  jitterMs: { min: number; max: number };
  keyMetadata?: {
    salt: string;
    iterations: number;
  };
}

const DEFAULT_CONFIG: GlobalConfig = {
  version: '1.0.0',
  maxConcurrency: 5,
  healthCheckIntervalHours: 24,
  jitterMs: { min: 500, max: 2000 },
};

/**
 * Initialize all required directories
 */
export async function initDirs(): Promise<void> {
  if (process.env.VERCEL) {
    console.log('Vercel environment detected - skipping directory initialization');
    return;
  }
  await fs.ensureDir(DATA_DIR);
  await fs.ensureDir(PROFILES_DIR);
  await fs.ensureDir(path.join(PROFILES_DIR, 'flipkart'));
  await fs.ensureDir(path.join(PROFILES_DIR, 'shopsy'));
  await fs.ensureDir(ENCRYPTED_DIR);
  await fs.ensureDir(path.join(ENCRYPTED_DIR, 'flipkart'));
  await fs.ensureDir(path.join(ENCRYPTED_DIR, 'shopsy'));
  await fs.ensureDir(LOGS_DIR);
}

/**
 * Load global configuration, creating default if not exists
 */
export async function loadConfig(): Promise<GlobalConfig> {
  await initDirs();
  if (await fs.pathExists(CONFIG_FILE)) {
    return fs.readJSON(CONFIG_FILE);
  }
  await fs.writeJSON(CONFIG_FILE, DEFAULT_CONFIG, { spaces: 2 });
  return DEFAULT_CONFIG;
}

/**
 * Save global configuration
 */
export async function saveConfig(config: GlobalConfig): Promise<void> {
  await fs.writeJSON(CONFIG_FILE, config, { spaces: 2 });
}

/**
 * Add random jitter delay to avoid detection
 */
export async function randomJitter(config: GlobalConfig): Promise<void> {
  const delay = Math.floor(
    Math.random() * (config.jitterMs.max - config.jitterMs.min) + config.jitterMs.min
  );
  await new Promise(resolve => setTimeout(resolve, delay));
}
