import { createClient, SupabaseClient } from '@supabase/supabase-js';
import fs from 'fs-extra';
import path from 'path';
import { getSettings } from './settings.js';
import { ACCOUNTS_FILE } from './config.js';
import { getCookieFilePath } from './cookies.js';
import { getStorageFilePath } from './localStorage.js';
import logger from './log.js';

let supabaseClient: SupabaseClient | null = null;
let supabaseAdminClient: SupabaseClient | null = null;

// Helper to get config
function getSupabaseConfig() {
    const settings = getSettings();

    // URL
    const envUrl = process.env.SUPABASE_URL;
    const url = envUrl || settings.cloudConfig?.url;

    // Keys
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLIC_KEY || process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // Enabled check
    // We consider it enabled if we have a URL and at least one key
    const enabled = settings.cloudConfig?.enabled !== false && (!!url && (!!anonKey || !!serviceRoleKey));

    return { url, anonKey, serviceRoleKey, enabled };
}

/**
 * Get Supabase Client (Anon/Public) - Use for Auth & User User operations
 */
export function getSupabaseClient() {
    const { url, anonKey, enabled } = getSupabaseConfig();

    if (!enabled || !url || !anonKey) {
        // Silent fail or warn depending on context? 
        // If we need auth but don't have anon key, it's an issue.
        if (enabled && url && !anonKey) {
            logger.warn('[Cloud] Supabase Anon Key is missing. Auth flows may fail.');
        }
        return null;
    }

    if (!supabaseClient) {
        try {
            const keyUsed = anonKey;
            const maskedKey = keyUsed ? (keyUsed.substring(0, 5) + '...' + keyUsed.substring(keyUsed.length - 5)) : 'NONE';
            logger.info(`[Cloud] Supabase Anon Client initializing with URL: ${url} and Key: ${maskedKey}`);

            supabaseClient = createClient(url, anonKey);
            logger.info(`[Cloud] Supabase Anon Client initialized.`);
        } catch (e: any) {
            logger.error(`[Cloud] Failed to initialize Supabase Anon Client: ${e.message}`);
            return null;
        }
    }
    return supabaseClient;
}

/**
 * Get Supabase Admin Client (Service Role) - Use for Data Sync & Admin operations
 */
export function getSupabaseAdminClient() {
    const { url, serviceRoleKey, enabled } = getSupabaseConfig();

    if (!enabled || !url || !serviceRoleKey) {
        if (enabled && url && !serviceRoleKey) {
            logger.warn('[Cloud] Supabase Service Role Key is missing. Sync flows will fail.');
        }
        return null;
    }

    if (!supabaseAdminClient) {
        try {
            supabaseAdminClient = createClient(url, serviceRoleKey, {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                }
            });
            logger.info(`[Cloud] Supabase Admin Client initialized.`);
        } catch (e: any) {
            logger.error(`[Cloud] Failed to initialize Supabase Admin Client: ${e.message}`);
            return null;
        }
    }
    return supabaseAdminClient;
}

/**
 * Legacy accessor - Defaults to Admin client for backward compatibility in this file context,
 * but specifically for Auth it should NOT be used.
 * @deprecated Use getSupabaseClient() or getSupabaseAdminClient() explicitly.
 */
export function getSupabase() {
    return getSupabaseAdminClient() || getSupabaseClient();
}

/**
 * Health check for Supabase connection & tables
 * Uses Admin access to check table existence reliably
 */
export async function checkCloudConnection() {
    const client = getSupabaseAdminClient();
    if (!client) return { success: false, message: 'Cloud sync (Admin) not configured.' };

    try {
        // More robust check: try to select one row from accounts
        const { error } = await client.from('accounts').select('*').limit(1);
        if (error) {
            // Check for specific "table not found" error
            if (error.code === '42P01' || error.message.includes('schema cache')) {
                return { success: false, message: 'Supabase connected, but "accounts" table is missing. Did you run the SQL schema?' };
            }
            throw error;
        }
        return { success: true, message: 'Supabase connection healthy and tables found.' };
    } catch (e: any) {
        return { success: false, message: `Cloud connection failed: ${e.message}` };
    }
}

/**
 * Push a single account to cloud
 */
export async function pushAccount(acc: any) {
    const client = getSupabaseAdminClient();
    if (!client) return;

    try {
        const payload: any = {
            id: acc.id.toLowerCase(),
            platform: acc.platform,
            identifier: acc.identifier,
            status: acc.status,
            last_login_at: acc.lastLoginAt || null,
            details: {
                loginType: acc.loginType,
                emailConfig: acc.emailConfig,
                assignedTo: acc.assignedTo,
                createdAt: acc.createdAt,
                updatedAt: acc.updatedAt,
                errorCode: acc.errorCode
            },
            updated_at: new Date().toISOString()
        };

        if (acc.userId) {
            payload.user_id = acc.userId;
        }

        // logger.debug(`[Cloud] Pushing account payload: ${JSON.stringify(payload)}`);

        const { error } = await client
            .from('accounts')
            .upsert(payload, { onConflict: 'id' });

        if (error) throw error;
        logger.debug(`[Cloud] Synced single account: ${acc.id}`);
    } catch (e: any) {
        logger.error(`[Cloud] pushAccount failed for ${acc.id}: ${e.message}`);
    }
}

/**
 * Push accounts.json to cloud (SQL Table: accounts)
 */
export async function pushAccounts() {
    const client = getSupabaseAdminClient();
    if (!client) {
        logger.debug('[Cloud] pushAccounts: Cloud sync not enabled or configured.');
        return;
    }

    try {
        if (!await fs.pathExists(ACCOUNTS_FILE)) return;
        const data = await fs.readJSON(ACCOUNTS_FILE);
        const accounts = data.accounts || [];

        for (const acc of accounts) {
            // Flatten/Structure data for SQL
            const payload: any = {
                id: acc.id.toLowerCase(),
                platform: acc.platform,
                identifier: acc.identifier,
                status: acc.status,
                last_login_at: acc.lastLoginAt || null,
                details: {
                    loginType: acc.loginType,
                    emailConfig: acc.emailConfig,
                    assignedTo: acc.assignedTo,
                    createdAt: acc.createdAt,
                    updatedAt: acc.updatedAt,
                    errorCode: acc.errorCode
                },
                updated_at: new Date().toISOString()
            };

            // Only send user_id if we have it, otherwise let DB default or keep existing
            if (acc.userId) {
                payload.user_id = acc.userId;
            }

            const { error } = await client
                .from('accounts')
                .upsert(payload);

            if (error) throw error;
        }

        logger.info(`[Cloud] Synced ${accounts.length} accounts to SQL.`);
    } catch (e: any) {
        logger.error(`[Cloud] Account sync failed: ${e.message}`);
    }
}

/**
 * Push ALL cookies from local files to cloud (for initial sync)
 */
export async function pushAllCookies() {
    const client = getSupabaseAdminClient();
    if (!client) {
        logger.debug('[Cloud] pushAllCookies: Cloud sync not enabled.');
        return;
    }

    try {
        if (!await fs.pathExists(ACCOUNTS_FILE)) return;
        const data = await fs.readJSON(ACCOUNTS_FILE);
        const accounts = data.accounts || [];

        let totalSynced = 0;
        for (const acc of accounts) {
            const platform = acc.platform as 'flipkart' | 'shopsy';
            await pushCookies(acc.id, platform);
            totalSynced++;
        }

        logger.info(`[Cloud] Attempted cookie sync for ${totalSynced} accounts.`);
    } catch (e: any) {
        logger.error(`[Cloud] pushAllCookies failed: ${e.message}`);
    }
}

/**
 * Push specific cookie file to cloud (SQL Table: cookies)
 */
export async function pushCookies(accountId: string, platform: 'flipkart' | 'shopsy') {
    const client = getSupabaseAdminClient();
    if (!client) return;

    try {
        const filePath = getCookieFilePath(accountId, platform);
        if (!await fs.pathExists(filePath)) return;

        const cookies = await fs.readJSON(filePath);
        if (!Array.isArray(cookies)) return;

        // 1. Delete existing cookies for this account/platform to avoid duplicates
        // Note: Using a transaction or carefully defined deletion is safer
        const { error: delError } = await client
            .from('cookies')
            .delete()
            .eq('account_id', accountId.toLowerCase())
            .eq('platform', platform);

        if (delError) throw delError;

        // 2. Insert new cookies
        // Map playright/extension cookie format to DB schema
        const rows = cookies.map((c: any) => ({
            account_id: accountId.toLowerCase(),
            platform: platform,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            http_only: c.httpOnly,
            // Handle both Playwright ('expires') and Extension ('expirationDate') formats
            expiration_date: c.expires || c.expirationDate,
            same_site: c.sameSite,
            host_only: c.hostOnly,
            session: c.session
        }));

        if (rows.length > 0) {
            const { error: insError } = await client
                .from('cookies')
                .insert(rows);

            if (insError) throw insError;
            logger.info(`[Cloud] Synced ${rows.length} cookies for ${accountId} (${platform}).`);
        }
    } catch (e: any) {
        logger.error(`[Cloud] Cookie sync failed for ${accountId}: ${e.message}`);
        logger.error(`[Cloud] Cookie sync failed for ${accountId}: ${e.message}`);
    }
}

/**
 * Push Local Storage to cloud (SQL Table: local_storage)
 */
export async function pushLocalStorage(accountId: string, platform: 'flipkart' | 'shopsy') {
    const client = getSupabaseAdminClient();
    if (!client) return;

    try {
        const filePath = getStorageFilePath(accountId, platform);
        if (!await fs.pathExists(filePath)) return;

        const data = await fs.readJSON(filePath);

        // Upsert to local_storage table
        // Schema assumed: account_id, platform, data (jsonb), updated_at
        const payload = {
            account_id: accountId.toLowerCase(),
            platform: platform,
            data: data,
            updated_at: new Date().toISOString()
        };

        const { error } = await client
            .from('local_storage')
            .upsert(payload, { onConflict: 'account_id, platform' });

        if (error) throw error;
        logger.info(`[Cloud] Synced Local Storage for ${accountId} (${platform}).`);
    } catch (e: any) {
        logger.error(`[Cloud] LS sync failed for ${accountId}: ${e.message}`);
    }
}

/**
 * Fetch Local Storage from cloud
 */
export async function fetchLocalStorage(accountId: string, platform: 'flipkart' | 'shopsy'): Promise<Record<string, string> | null> {
    const client = getSupabaseAdminClient();
    if (!client) return null;

    try {
        const { data, error } = await client
            .from('local_storage')
            .select('data')
            .eq('account_id', accountId.toLowerCase())
            .eq('platform', platform)
            .single();

        if (error) {
            if (error.code !== 'PGRST116') { // PGRST116 is 'Row not found' which is fine
                throw error;
            }
            return null;
        }

        if (data && data.data) {
            logger.info(`[Cloud] Fetched Local Storage from DB for ${accountId} (${platform}).`);
            return data.data;
        }
        return null;
    } catch (e: any) {
        logger.error(`[Cloud] Failed to fetch LS from DB for ${accountId}: ${e.message}`);
        return null;
    }
}


/**
 * Fetch cookies for a specific account from cloud database
 */
export async function fetchCookiesFromCloud(accountId: string, platform: 'flipkart' | 'shopsy'): Promise<any[]> {
    const client = getSupabaseAdminClient();
    if (!client) return [];

    try {
        const { data: dbCookies, error } = await client
            .from('cookies')
            .select('*')
            .eq('account_id', accountId.toLowerCase())
            .eq('platform', platform);

        if (error) throw error;

        if (dbCookies && dbCookies.length > 0) {
            // Map back to Playwright-compatible cookie format
            const cookies = dbCookies.map((row: any) => {
                // Convert expiration_date to proper Unix timestamp (number)
                let expires: number | undefined;
                if (row.expiration_date != null) {
                    const exp = Number(row.expiration_date);
                    expires = isNaN(exp) ? undefined : exp;
                }

                const sameSite = row.same_site === 'no_restriction' ? 'None' :
                    (['Strict', 'Lax', 'None'].includes(row.same_site) ? row.same_site : 'Lax');

                return {
                    name: row.name,
                    value: row.value,
                    domain: row.domain,
                    path: row.path,
                    // Critical: SameSite=None requires Secure=true
                    secure: row.secure || sameSite === 'None',
                    httpOnly: row.http_only,
                    ...(expires !== undefined && { expires }),
                    sameSite: sameSite
                };
            });
            logger.info(`[Cloud] Fetched ${cookies.length} cookies from DB for ${accountId} (${platform}).`);
            return cookies;
        }
        return [];
    } catch (e: any) {
        logger.error(`[Cloud] Failed to fetch cookies from DB for ${accountId}: ${e.message}`);
        return [];
    }
}

/**
 * Pull all data from cloud (for new device setup)
 */
export async function pullSyncData() {
    const client = getSupabaseAdminClient();
    if (!client) return { success: false, error: 'Cloud sync not enabled' };

    try {
        // 1. Pull Accounts
        const { data: dbAccounts, error: accError } = await client
            .from('accounts')
            .select('*');

        if (accError) throw accError;

        if (dbAccounts) {
            // Reconstruct accounts.json format
            const accounts = dbAccounts.map((row: any) => ({
                id: row.id,
                platform: row.platform,
                identifier: row.identifier,
                status: row.status,
                lastLoginAt: row.last_login_at,
                // Spread details back
                ...row.details
            }));

            await fs.writeJSON(ACCOUNTS_FILE, { accounts }, { spaces: 2 });
            logger.info(`[Cloud] Pulled ${accounts.length} accounts from SQL.`);
        }

        // 2. Pull Cookies
        // We pull ALL cookies. If dataset is huge, might need to optimize this.
        const { data: dbCookies, error: cookError } = await client
            .from('cookies')
            .select('*');

        if (cookError) throw cookError;

        if (dbCookies) {
            // Group by account_id + platform
            const grouped: Record<string, any[]> = {};

            for (const row of dbCookies) {
                const key = `${row.account_id}_${row.platform}`;
                if (!grouped[key]) grouped[key] = [];

                // Map back to Cookie object
                grouped[key].push({
                    name: row.name,
                    value: row.value,
                    domain: row.domain,
                    path: row.path,
                    secure: row.secure,
                    httpOnly: row.http_only,
                    expirationDate: row.expiration_date,
                    sameSite: row.same_site,
                    hostOnly: row.host_only,
                    session: row.session
                });
            }

            for (const key in grouped) {
                const [accId, platform] = key.split('_');
                // We need to match the actual file path logic in 'getCookieFilePath'
                // But getCookieFilePath requires platform param. 
                // We can just construct it manually or use the helper if we know the args.
                // Re-importing or using the helper logic:
                // backend/data/cookies/{id}_{platform}.json
                const localPath = path.join(path.dirname(getCookieFilePath('dummy', 'flipkart')), `${accId}_${platform}.json`);
                await fs.writeJSON(localPath, grouped[key], { spaces: 2 });
            }
            logger.info(`[Cloud] Pulled cookies for ${Object.keys(grouped).length} sessions.`);
        }

        return { success: true };
    } catch (e: any) {
        logger.error(`[Cloud] Sync pull failed: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * Log user activity to Supabase
 */
export async function logActivity(username: string, action: string, data: any = {}) {
    const client = getSupabaseAdminClient();
    if (!client) return;

    try {
        const deviceInfo = {
            os: process.platform,
            arch: process.arch,
            hostname: require('os').hostname()
        };

        await client.from('activity_logs').insert({
            username,
            action,
            platform: data.platform || null,
            account_id: data.accountId || null,
            device_info: deviceInfo,
            timestamp: new Date().toISOString()
        });
        logger.info(`[Cloud] Activity logged: ${action} by ${username}`);
    } catch (e: any) {
        logger.error(`[Cloud] Failed to log activity: ${e.message}`);
    }
}

/**
 * Report error to Supabase
 */
export async function reportError(username: string, message: string, stack?: string, context: any = {}) {
    const client = getSupabaseAdminClient();
    if (!client) return;

    try {
        const deviceInfo = {
            os: process.platform,
            arch: process.arch,
            hostname: require('os').hostname()
        };

        await client.from('app_errors').insert({
            username,
            message,
            stack,
            context: { ...context, deviceInfo },
            timestamp: new Date().toISOString()
        });
        logger.info(`[Cloud] Error reported to cloud for ${username}`);
    } catch (e: any) {
        logger.error(`[Cloud] Failed to report error: ${e.message}`);
    }
}

/**
 * Fetch centralized users from Supabase (from profiles table)
 * Returns all users except their password hashes
 */
export async function fetchCloudUsers() {
    const client = getSupabaseAdminClient();
    if (!client) return null;

    try {
        // Select all and filter in code to avoid column name issues
        const { data, error } = await client
            .from('profiles')
            .select('*');

        if (error) {
            logger.error(`[Cloud] Failed to fetch users: ${error.message}`);
            return null;
        }

        if (!data || data.length === 0) {
            logger.info('[Cloud] No users found in profiles table');
            return [];
        }

        // Map to frontend-expected format, excluding password_hash
        return data.map((u: any) => ({
            username: u.username,
            role: u.role || 'user',
            allowedAccounts: u.allowed_accounts || 10,
            createdAt: u.created_at
        }));
    } catch (e: any) {
        logger.error(`[Cloud] fetchCloudUsers exception: ${e.message}`);
        return null;
    }
}

/**
 * Update user settings in Supabase profiles table (Admin Only)
 * Note: For creating new users, use signUpSupabase instead
 */
export async function upsertCloudUser(user: any) {
    const client = getSupabaseAdminClient();
    if (!client) throw new Error('Cloud sync not configured');

    const { error } = await client
        .from('profiles')
        .update({
            role: user.role || 'user',
            allowed_accounts: user.allowedAccounts || 10
        })
        .eq('username', user.username?.toLowerCase());

    if (error) throw error;
    logger.info(`[Cloud] Updated user settings: ${user.username}`);
}

/**
 * Delete user from Supabase profiles table
 */
export async function deleteCloudUser(username: string) {
    const client = getSupabaseAdminClient();
    if (!client) throw new Error('Cloud sync not configured');

    const { error } = await client
        .from('profiles')
        .delete()
        .eq('username', username.toLowerCase());

    if (error) throw error;
    logger.info(`[Cloud] Deleted user: ${username}`);
}

/**
 * Fetch recent activity logs from Supabase
 */
export async function fetchActivityLogs() {
    const client = getSupabaseAdminClient();
    if (!client) return [];

    try {
        const { data, error } = await client
            .from('activity_logs')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(100);
        if (error) throw error;
        return data;
    } catch (e) {
        logger.error(`[Cloud] Failed to fetch activity logs: ${e}`);
        return [];
    }
}

/**
 * Fetch recent app errors from Supabase
 */
export async function fetchAppErrors() {
    const client = getSupabaseAdminClient();
    if (!client) return [];

    try {
        const { data, error } = await client
            .from('app_errors')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(100);
        if (error) throw error;
        return data;
    } catch (e) {
        logger.error(`[Cloud] Failed to fetch app errors: ${e}`);
        return [];
    }
}

/**
 * Delete account and all associated data from cloud
 */
export async function deleteCloudAccount(accountId: string) {
    const client = getSupabaseAdminClient();
    if (!client) return;

    const id = accountId.toLowerCase().trim();
    try {
        // 1. Delete cookies
        const { error: cookError } = await client
            .from('cookies')
            .delete()
            .eq('account_id', id);
        if (cookError) throw cookError;

        // 2. Delete local storage
        const { error: lsError } = await client
            .from('local_storage')
            .delete()
            .eq('account_id', id);
        if (lsError) throw lsError;

        // 3. Delete account record
        const { error: accError } = await client
            .from('accounts')
            .delete()
            .eq('id', id);
        if (accError) throw accError;

        logger.info(`[Cloud] Deleted account and all data for ${id}`);
    } catch (e: any) {
        logger.error(`[Cloud] Deletion failed for ${id}: ${e.message}`);
        throw e;
    }
}
