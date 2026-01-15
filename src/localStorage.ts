import fs from 'fs-extra';
import path from 'path';
import { DATA_DIR } from './config.js';
import { pushLocalStorage } from './cloud.js';

const STORAGE_DIR = path.join(DATA_DIR, 'storage');

export async function ensureStorageDir() {
    await fs.ensureDir(STORAGE_DIR);
}

export function getStorageFilePath(accountId: string, platform: 'flipkart' | 'shopsy' = 'flipkart') {
    const id = accountId.toLowerCase().trim();
    return path.join(STORAGE_DIR, `${id}_${platform}.json`);
}

/**
 * Save Local Storage data to disk
 */
export async function saveLocalStorage(accountId: string, data: Record<string, string>, platform: 'flipkart' | 'shopsy' = 'flipkart') {
    await ensureStorageDir();
    const file = getStorageFilePath(accountId, platform);
    await fs.writeJSON(file, data, { spaces: 2 });
    // Attempt cloud sync
    // pushLocalStorage(accountId, platform); // DISABLED
}

/**
 * Load Local Storage data from disk
 */
export async function loadLocalStorage(accountId: string, platform: 'flipkart' | 'shopsy' = 'flipkart'): Promise<Record<string, string> | null> {
    const file = getStorageFilePath(accountId, platform);
    if (await fs.pathExists(file)) {
        return await fs.readJSON(file);
    }
    return null;
}
