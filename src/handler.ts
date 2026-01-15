import { IncomingMessage, ServerResponse } from 'http';
import { loadAccounts, upsertAccount, deleteAccount, updateAccountStatus } from './accounts.js';
import { openSession } from './session.js';
import { pushAccounts, fetchCookiesFromCloud, pushAllCookies } from './cloud.js';
import logger from './log.js';

// Helper to parse JSON body
const parseBody = async (req: IncomingMessage): Promise<any> => {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
};

// Helper for CORS
const setCors = (res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

    logger.info(`Request: ${req.method} ${path}`);

    try {
        if (path === '/api/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
            return;
        }

        // ACCOUNTS ROUTES
        if (path === '/api/accounts' && req.method === 'GET') {
            const data = await loadAccounts();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return;
        }

        if (path === '/api/accounts' && req.method === 'POST') {
            const body = await parseBody(req);
            const result = await upsertAccount(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        if (path.startsWith('/api/accounts/') && req.method === 'DELETE') {
            const id = path.split('/').pop() || '';
            const result = await deleteAccount(id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: result }));
            return;
        }

        // SESSION ROUTES
        if (path === '/api/session/open' && req.method === 'POST') {
            const body = await parseBody(req);
            const { accountId, platform } = body;

            if (process.env.VERCEL) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Cannot open browser sessions in Vercel environment.' }));
                return;
            }

            const result = await openSession({ accountId, platform });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        // CLOUD SYNC ROUTES
        if (path === '/api/cloud/sync-all' && req.method === 'POST') {
            await pushAccounts();
            // await pushAllCookies(); // Optional, might be heavy
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Triggered global sync' }));
            return;
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
