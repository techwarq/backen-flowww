import { BrowserContext } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import { ACCOUNTS_FILE, DATA_DIR, PROFILES_DIR, ENCRYPTED_DIR } from './config.js';
import { pushAccounts, pushAccount, pushCookies, deleteCloudAccount } from './cloud.js';

const COOKIES_DIR = path.join(DATA_DIR, 'cookies');

export type Platform = 'flipkart' | 'shopsy';
export type LoginType = 'email' | 'mobile';
export type AccountStatus =
    | 'New'           // Not yet initialized
    | 'Healthy'       // Session is valid
    | 'NeedsRefresh'  // Session may be stale
    | 'OTPRequired'   // Re-login needed
    | 'Locked'        // Account locked/suspended
    | 'Error';        // Unknown error state

export interface Account {
    id: string;
    userId?: string;            // Added for user isolation
    platform: Platform;
    loginType: LoginType;
    identifier: string;         // email or mobile number
    status: AccountStatus;
    assignedTo?: string;        // operator name
    lastLoginAt?: string;       // ISO timestamp
    lastValidateAt?: string;    // ISO timestamp
    errorCode?: string;         // last error reason
    createdAt: string;          // ISO timestamp
    updatedAt: string;          // ISO timestamp
    // For automated recovery
    emailConfig?: {
        user: string;
        passEncrypted: string;
        host: string;
    };
}

export interface AccountsData {
    accounts: Account[];
}

/**
 * Simple Promise-based queue to serialize database operations
 */
let saveQueue: Promise<void> = Promise.resolve();

/**
 * Load all accounts from accounts.json
 */
export async function loadAccounts(): Promise<AccountsData> {
    const operation = async () => {
        if (await fs.pathExists(ACCOUNTS_FILE)) {
            const raw = await fs.readJSON(ACCOUNTS_FILE);
            // Migration: Handle legacy array format
            if (Array.isArray(raw)) {
                const migrated = { accounts: raw };
                await fs.writeJSON(ACCOUNTS_FILE, migrated, { spaces: 2 });
                return migrated as unknown as AccountsData;
            }
            if (!raw.accounts) return { accounts: [] };
            return raw;
        }
        const defaultData: AccountsData = { accounts: [] };
        await fs.writeJSON(ACCOUNTS_FILE, defaultData, { spaces: 2 });
        return defaultData;
    };

    // We don't necessarily need to queue reads, but let's queue EVERYTHING to be 100% safe
    const result = saveQueue.then(operation);
    saveQueue = result.then(() => { }, () => { }); // Catch errors to not block the queue
    return result;
}

/**
 * Save accounts data safely using a temporary file
 */
export async function saveAccounts(data: AccountsData): Promise<void> {
    const operation = async () => {
        const tmpFile = `${ACCOUNTS_FILE}.tmp`;
        try {
            await fs.writeJSON(tmpFile, data, { spaces: 2 });
            await fs.move(tmpFile, ACCOUNTS_FILE, { overwrite: true });
        } catch (e) {
            console.error('[Database] Failed to save accounts atomically:', e);
            throw e;
        }
    };

    saveQueue = saveQueue.then(operation).then(() => {
        // Attempt cloud sync in background
        pushAccounts();
    }).catch(err => {
        console.error('[Database] Critical error in save queue:', err);
    });
    return saveQueue;
}

/**
 * Get a single account by ID
 */
export async function getAccount(accountId: string): Promise<Account | undefined> {
    const data = await loadAccounts();
    const id = accountId.toLowerCase().trim();
    return data.accounts.find(a => a.id.toLowerCase() === id);
}

/**
 * Create or update an account
 */
export async function upsertAccount(account: Partial<Account> & { id: string; platform: Platform }): Promise<Account> {
    const data = await loadAccounts();
    const id = account.id.toLowerCase().trim();
    const existingIndex = data.accounts.findIndex(a => a.id.toLowerCase() === id);
    const now = new Date().toISOString();

    if (existingIndex >= 0) {
        // Update existing
        const existing = data.accounts[existingIndex];
        const updated: Account = {
            ...existing,
            ...account,
            updatedAt: now,
            // Preserve userId if not provided in update
            userId: account.userId || existing.userId
        };
        data.accounts[existingIndex] = updated;
        await saveAccounts(data);
        return updated;
    } else {
        // Create new
        const newAccount: Account = {
            loginType: 'mobile',
            identifier: '',
            status: 'New',
            createdAt: now,
            updatedAt: now,

            ...account,
            id: id // Force standardized ID
        };
        data.accounts.push(newAccount);
        await saveAccounts(data);
        await pushAccount(newAccount); // Ensure cloud has it immediately
        return newAccount;
    }
}

/**
 * Update account status
 */
export async function updateAccountStatus(
    accountId: string,
    status: AccountStatus,
    errorCode?: string
): Promise<void> {
    const data = await loadAccounts();
    const id = accountId.toLowerCase().trim();
    const account = data.accounts.find(a => a.id.toLowerCase() === id);
    if (account) {
        account.status = status;
        account.updatedAt = new Date().toISOString();
        if (status === 'Healthy') {
            account.lastValidateAt = account.updatedAt;
            delete account.errorCode;
        } else if (errorCode) {
            account.errorCode = errorCode;
        }
        await saveAccounts(data);
        await pushAccount(account); // Sync status change
    }
}

/**
 * Update last login timestamp
 */
export async function updateLastLogin(accountId: string): Promise<void> {
    const data = await loadAccounts();
    const id = accountId.toLowerCase().trim();
    const account = data.accounts.find(a => a.id.toLowerCase() === id);
    if (account) {
        account.lastLoginAt = new Date().toISOString();
        account.lastValidateAt = account.lastLoginAt;
        account.updatedAt = account.lastLoginAt;
        account.lastValidateAt = account.lastLoginAt;
        account.status = 'Healthy';
        account.updatedAt = account.lastLoginAt;
        delete account.errorCode;
        await saveAccounts(data);
        await pushAccount(account); // Sync health/login time
    }
}

/**
 * Get all accounts for a specific platform
 */
export async function getAccountsByPlatform(platform: Platform): Promise<Account[]> {
    const data = await loadAccounts();
    return data.accounts.filter(a => a.platform === platform);
}

/**
 * Get all account IDs
 */
export async function getAllAccountIds(): Promise<string[]> {
    const data = await loadAccounts();
    return data.accounts.map(a => a.id);
}

/**
 * Delete an account
 */
export async function deleteAccount(accountId: string): Promise<boolean> {
    const data = await loadAccounts();
    const id = accountId.toLowerCase().trim();
    const index = data.accounts.findIndex(a => a.id.toLowerCase() === id);
    if (index >= 0) {
        const account = data.accounts[index];
        data.accounts.splice(index, 1);
        await saveAccounts(data);

        // Cleanup Files
        try {
            // 1. Delete Cookie File
            const cookiePath = path.join(COOKIES_DIR, `${id}_${account.platform}.json`);
            if (await fs.pathExists(cookiePath)) {
                await fs.remove(cookiePath);
            }

            // 2. Delete Profile Directory
            const profilePath = path.join(PROFILES_DIR, account.platform, id);
            if (await fs.pathExists(profilePath)) {
                await fs.remove(profilePath);
            }

            // 3. Delete Encrypted Backup
            const encPath = path.join(ENCRYPTED_DIR, account.platform, `${id}.zip.enc`);
            if (await fs.pathExists(encPath)) {
                await fs.remove(encPath);
            }

            // 4. Delete Local Storage File
            const lsPath = path.join(DATA_DIR, 'storage', `${id}_${account.platform}.json`);
            if (await fs.pathExists(lsPath)) {
                await fs.remove(lsPath);
            }

            // 5. Delete from Cloud
            await deleteCloudAccount(id).catch(err => {
                console.error(`[Cloud] Background deletion failed for ${id}:`, err);
            });
        } catch (e) {
            console.error(`Failed to cleanup files for ${id}:`, e);
        }

        return true;
    }
    return false;
}
