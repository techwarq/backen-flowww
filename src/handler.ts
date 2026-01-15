import { IncomingMessage, ServerResponse } from 'http';
import { loadAccounts, upsertAccount, deleteAccount, updateAccountStatus, getAccount } from './accounts.js';
import { openSession } from './session.js';
import { pushAccounts, fetchCookiesFromCloud, pushAllCookies, pullSyncData, fetchCloudUsers, upsertCloudUser as upsertCloudUserFn, deleteCloudUser as deleteCloudUserFn, fetchActivityLogs, fetchAppErrors as fetchCloudErrors, checkCloudConnection, getSupabaseAdminClient, fetchAccountsDirectly } from './cloud.js';
import logger from './log.js';
import { checkAccountHealth as checkHealthLogic } from './check/health.js';
import { refreshSession as refreshSessionLogic } from './refresh/flow.js';
import { loginFlipkart } from './login/flipkart.js';
import { loginShopsy } from './login/shopsy.js';
import { signUpSupabase, signInSupabase, verifySession } from './auth_supabase.js';
import { getSettings, saveSettings, loadSettings } from './settings.js';
import { browsers } from './browserManager.js';
import { initDirs } from './config.js';
import { getActivityLogs, getAppErrors } from './log.js';
import { loadCookiesFromDisk } from './cookies.js';
import { getUsers, upsertUser, deleteUser } from './users.js';

// Helper to parse JSON body
const parseBody = async (req: IncomingMessage): Promise<any> => {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                // Return empty object if body is empty string/null
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                // If parsing fails (e.g. invalid JSON), reject or return {}
                reject(e);
            }
        });
        req.on('error', reject);
    });
};

// Helper for CORS
const setCors = (res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
};

// Auth Helper
const getSession = async (req: IncomingMessage) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        return await verifySession(token);
    }
    return null;
};

// Response Helpers
const sendJson = (res: ServerResponse, status: number, data: any) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

const sendError = (res: ServerResponse, status: number, message: string) => {
    sendJson(res, status, { success: false, message });
};

export const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    setCors(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // Debug logging
    // console.log(`[API] ${req.method} ${path}`);
    logger.info(`Request: ${req.method} ${path}`);

    try {
        // --- PUBLIC / BASE ROUTES ---

        if (path === '/' || path === '/api' || path === '/api/') {
            return sendJson(res, 200, { message: "FlowDesk Backend API", status: "running", version: "1.2.0" });
        }

        if (path === '/api/health') {
            return sendJson(res, 200, { status: 'ok', version: '1.2.0', timestamp: new Date().toISOString() });
        }

        // --- AUTH ROUTES ---

        if (path === '/api/auth/signup' && req.method === 'POST') {
            const body = await parseBody(req);
            const { username, password } = body;
            if (!username || !password) return sendError(res, 400, 'Username and password are required');
            const result = await signUpSupabase(username, password);
            return sendJson(res, 200, result);
        }

        if (path === '/api/auth/signin' && req.method === 'POST') {
            const body = await parseBody(req);
            const { username, password } = body;
            if (!username || !password) return sendError(res, 400, 'Username and password are required');
            const result = await signInSupabase(username, password);
            return sendJson(res, 200, result);
        }

        if (path === '/api/auth/me' && req.method === 'GET') {
            const session = await getSession(req);
            if (!session) return sendError(res, 401, 'Unauthorized');
            return sendJson(res, 200, { success: true, session });
        }

        // --- ACCOUNTS ROUTES ---

        if (path === '/api/accounts' && req.method === 'GET') {
            const session = await getSession(req);

            // "no local directly use subase" -> always fetch from cloud
            // If logged in, filter by user; if admin, maybe show all (or filtered if desired).
            // Passing undefined fetches all. passing session.id filters.

            let userIdToFilter: string | undefined = undefined;

            if (session) {
                if (session.role !== 'admin') {
                    userIdToFilter = session.id;
                }
                // If admin, userIdToFilter remains undefined -> fetches all
            } else {
                // Not logged in? Return empty or public? Strict: empty.
                return sendJson(res, 200, { accounts: [] });
            }

            const data = await fetchAccountsDirectly(userIdToFilter);
            logger.info(`[Debug] Fetching accounts for userId: ${userIdToFilter || 'ALL'}, found: ${data.accounts.length}`);
            return sendJson(res, 200, data);
        }

        if (path === '/api/accounts' && req.method === 'POST') {
            const session = await getSession(req);
            if (!session) return sendError(res, 401, 'Unauthorized');

            const body = await parseBody(req);
            // Enforce userId
            body.userId = session.id;

            const account = await upsertAccount(body);
            return sendJson(res, 200, account);
        }

        // DELETE /api/accounts/:id
        const deleteAccountMatch = path.match(/^\/api\/accounts\/([^\/]+)$/);
        if (deleteAccountMatch && req.method === 'DELETE') {
            const id = decodeURIComponent(deleteAccountMatch[1]);
            const session = await getSession(req);
            if (!session) return sendError(res, 401, 'Unauthorized');

            // Permission check
            if (session.role !== 'admin') {
                // Fetch ALL accounts for this user from cloud to check ownership
                // Ideally getAccount should be cloud-aware too, or fetchAccountsDirectly(session.id)
                // If the account ID is in the list returned for this user, they own it.
                const { accounts } = await fetchAccountsDirectly(session.id);
                const ownsAccount = accounts.some(a => a.id.toLowerCase() === id.toLowerCase());

                if (!ownsAccount) {
                    return sendError(res, 403, 'Forbidden');
                }
            }

            const result = await deleteAccount(id);
            return sendJson(res, 200, { success: result });
        }


        // --- SETTINGS ROUTES ---

        if (path === '/api/settings' && req.method === 'GET') {
            const settings = getSettings();
            return sendJson(res, 200, settings);
        }

        if (path === '/api/settings' && req.method === 'POST') {
            const body = await parseBody(req);
            saveSettings(body);
            return sendJson(res, 200, { success: true });
        }


        // --- OPERATIONS ROUTES ---

        // POST /api/check/:id
        const checkMatch = path.match(/^\/api\/check\/([^\/]+)$/);
        if (checkMatch && req.method === 'POST') {
            const id = decodeURIComponent(checkMatch[1]);
            const account = await getAccount(id);
            if (!account) return sendError(res, 404, 'Account not found');

            try {
                const result = await checkHealthLogic(account.platform, id);
                if (['Healthy', 'NeedsRefresh', 'Error'].includes(result.status)) {
                    await updateAccountStatus(id, result.status as any);
                }
                return sendJson(res, 200, result);
            } catch (error: any) {
                await updateAccountStatus(id, 'Error', String(error));
                return sendJson(res, 200, { status: 'Error', message: String(error) });
            }
        }

        // POST /api/refresh/:id
        const refreshMatch = path.match(/^\/api\/refresh\/([^\/]+)$/);
        if (refreshMatch && req.method === 'POST') {
            const id = decodeURIComponent(refreshMatch[1]);
            const account = await getAccount(id);
            if (!account) return sendError(res, 404, 'Account not found');

            try {
                const result = await refreshSessionLogic(account.platform, id, account.identifier);
                return sendJson(res, 200, result || { status: 'success', message: 'Refresh process completed' });
            } catch (error: any) {
                return sendJson(res, 200, { status: 'error', message: String(error) });
            }
        }

        // POST /api/login
        if (path === '/api/login' && req.method === 'POST') {
            const body = await parseBody(req);
            const { accountId, identifier, platform } = body;

            try {
                let result;
                if (platform === 'flipkart') {
                    result = await loginFlipkart({ accountId, identifier, headless: false, keepOpen: true });
                } else {
                    result = await loginShopsy({ accountId, identifier, headless: false, keepOpen: true });
                }
                return sendJson(res, 200, result);
            } catch (error) {
                return sendJson(res, 200, { status: 'error', message: String(error) });
            }
        }

        // POST /api/session (Open Session)
        if ((path === '/api/session' || path === '/api/session/open') && req.method === 'POST') {
            const body = await parseBody(req);
            const { accountId, platform } = body;
            try {
                const result = await openSession({ accountId, platform });
                return sendJson(res, 200, result);
            } catch (error) {
                return sendJson(res, 200, { status: 'error', message: String(error) });
            }
        }

        // POST /api/terminate-all
        if (path === '/api/terminate-all' && req.method === 'POST') {
            await browsers.closeAll();
            return sendJson(res, 200, { success: true });
        }


        // --- CLOUD SYNC ROUTES ---

        // POST /api/cloud/sync
        if (path === '/api/cloud/sync' && req.method === 'POST') {
            const result = await pullSyncData();
            return sendJson(res, 200, result);
        }

        // POST /api/cloud/sync-all (Explicit trigger)
        if (path === '/api/cloud/sync-all' && req.method === 'POST') {
            await pushAccounts();
            return sendJson(res, 200, { success: true, message: 'Triggered global sync' });
        }

        // GET /api/cloud/status
        if (path === '/api/cloud/status' && req.method === 'GET') {
            const result = await checkCloudConnection();
            return sendJson(res, 200, result);
        }


        // --- LOGS & ADMIN ROUTES ---

        // GET /api/accounts/:id/:platform/cookies
        const cookiesMatch = path.match(/^\/api\/accounts\/([^\/]+)\/([^\/]+)\/cookies$/);
        if (cookiesMatch && req.method === 'GET') {
            const id = decodeURIComponent(cookiesMatch[1]);
            const platform = decodeURIComponent(cookiesMatch[2]) as 'flipkart' | 'shopsy';
            const cookies = await loadCookiesFromDisk(id, platform);
            return sendJson(res, 200, cookies);
        }

        // GET /api/logs/activity
        if (path === '/api/logs/activity' && req.method === 'GET') {
            const cloudLogs = await fetchActivityLogs();
            if (cloudLogs && cloudLogs.length > 0) return sendJson(res, 200, cloudLogs);
            const localLogs = await getActivityLogs();
            return sendJson(res, 200, localLogs);
        }

        // GET /api/logs/errors
        if (path === '/api/logs/errors' && req.method === 'GET') {
            const cloudErrors = await fetchCloudErrors();
            if (cloudErrors && cloudErrors.length > 0) return sendJson(res, 200, cloudErrors);
            const localErrors = await getAppErrors();
            return sendJson(res, 200, localErrors);
        }

        // GET /api/admin/users
        if (path === '/api/admin/users' && req.method === 'GET') {
            const cloudUsers = await fetchCloudUsers();
            if (cloudUsers) return sendJson(res, 200, cloudUsers);
            const localUsers = await getUsers();
            return sendJson(res, 200, localUsers);
        }

        // POST /api/admin/users
        if (path === '/api/admin/users' && req.method === 'POST') {
            const body = await parseBody(req);
            const { username, password, role } = body;
            if (!username || !password) return sendError(res, 400, 'Username and password are required');

            try {
                const result = await signUpSupabase(username, password);
                if (!result.success) {
                    return sendJson(res, 200, { success: false, message: result.message });
                }

                if (role && role !== 'user') {
                    const client = getSupabaseAdminClient();
                    if (client) {
                        await client.from('profiles').update({ role }).eq('username', username.toLowerCase());
                    }
                }
                return sendJson(res, 200, { success: true, message: 'User created successfully', source: 'cloud' });
            } catch (e: any) {
                return sendJson(res, 200, { success: false, message: e.message });
            }
        }

        // DELETE /api/admin/users/:username
        const deleteUserMatch = path.match(/^\/api\/admin\/users\/([^\/]+)$/);
        if (deleteUserMatch && req.method === 'DELETE') {
            const username = decodeURIComponent(deleteUserMatch[1]);
            try {
                await deleteCloudUserFn(username);
                return sendJson(res, 200, { success: true, source: 'cloud' });
            } catch (e) {
                const result = await deleteUser(username);
                return sendJson(res, 200, { success: result });
            }
        }


        // 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Route not found' }));

    } catch (err: any) {
        logger.error(`API Error: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
};

// Initialize on first import/run
(async () => {
    if (!process.env.VERCEL) {
        // Run init logic only if strictly needed or just rely on lazy init in functions
        // But the original code had top-level await init.
        // We can't do top-level await easily in all environments without module config, 
        // but this file is being imported by index.ts or server.ts.
        // server.ts or api/index.ts should ideally trigger init.
        // For now, we'll leave it as lazy or side-effect helper.
        try {
            await initDirs();
            await loadSettings();
        } catch (e) { }
    }
})();
