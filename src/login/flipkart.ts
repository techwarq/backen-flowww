import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs-extra';
import { PROFILES_DIR, getProfileDir, loadConfig, randomJitter } from '../config.js';
import { generateFingerprint } from '../fingerprint.js';
import logger, { getAccountLogger } from '../log.js';
import { saveProfileToDisk } from '../profiles/store.js';
import { injectOverlay } from '../overlay.js';
import { extractAndSaveCookies, loadCookiesFromDisk } from '../cookies.js';
// IMAP OTP automation removed - manual OTP entry only
import { getAccount, updateLastLogin, updateAccountStatus } from '../accounts.js';
import { getSettings } from '../settings.js';
import { browsers } from '../browserManager.js';
import { pushCookies, pushLocalStorage } from '../cloud.js';
import { saveLocalStorage } from '../localStorage.js';

export interface LoginOptions {
    accountId: string;
    identifier: string; // Phone or Email
    headless?: boolean;
    keepOpen?: boolean; // New flag
}

// Singleton map to track active contexts
const activeContexts = new Map<string, BrowserContext>();

export async function loginFlipkart(options: LoginOptions) {
    const { accountId, identifier, headless = false, keepOpen = false } = options;
    const log = getAccountLogger(accountId);
    const platform = 'flipkart';

    // Check if valid context already exists
    if (activeContexts.has(accountId)) {
        const existingContext = activeContexts.get(accountId)!;
        if (existingContext.pages().length > 0 && !existingContext.pages()[0].isClosed()) {
            log.info('Browser already open for this account. Reusing/Ignoring launch.');
            // Ideally bring to front, but Playwright limitation.
            console.log('DEBUG: Browser already open detected for', accountId);
            return { status: 'success', message: 'Browser already open' };
        } else {
            // Stale context
            console.log('DEBUG: Stale context found for', accountId, 'removing...');
            activeContexts.delete(accountId);
        }
    }

    // Normalize to lowercase for consistent profile paths (macOS is case-insensitive)
    const normalizedId = accountId.toLowerCase().trim();
    const profilePath = path.join(PROFILES_DIR, platform, normalizedId, 'userDataDir');
    const fingerprint = generateFingerprint(platform, accountId); // Stable fingerprint based on ID

    log.info(`Starting Flipkart login flow for ${accountId}`);
    console.log(`DEBUG: Launching persistent context at ${profilePath} with headless=${headless}`);

    // Check if this is a new account - if so, clear the profile for fresh login
    try {
        const account = await getAccount(accountId);
        const isNewAccount = !account || account.status === 'New';

        if (isNewAccount && await fs.pathExists(profilePath)) {
            log.info('New account - clearing old profile for fresh login...');
            await fs.remove(profilePath);
        }
    } catch (e: any) {
        log.warn(`Could not check/clear profile: ${e.message}`);
    }

    let context: BrowserContext;
    const lockFile = path.join(profilePath, 'SingletonLock');

    // Proactive unlock
    try {
        if (await fs.pathExists(lockFile)) {
            await fs.remove(lockFile);
            console.log('DEBUG: Proactively removed stale SingletonLock');
        }
    } catch (err) { }

    try {
        context = await chromium.launchPersistentContext(profilePath, {
            headless: headless,
            viewport: null, // Allow window resizing
            userAgent: fingerprint.userAgent,
            locale: fingerprint.locale,
            timezoneId: fingerprint.timezoneId,
            permissions: ['geolocation', 'notifications'],
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--window-size=1280,720',
                '--window-position=50,50'
            ]
        });
    } catch (e: any) {
        const errorMsg = String(e.message || e);
        if (errorMsg.includes('ProcessSingleton') || errorMsg.includes('SingletonLock')) {
            console.warn('DEBUG: Profile locked detected in error. Attempting force unlock...');
            try {
                if (await fs.pathExists(lockFile)) {
                    await fs.remove(lockFile);
                    console.log('DEBUG: Removed stale SingletonLock after failure');
                }
            } catch (err) { }

            context = await chromium.launchPersistentContext(profilePath, {
                headless: headless,
                viewport: null, // Allow window resizing
                userAgent: fingerprint.userAgent,
                locale: fingerprint.locale,
                timezoneId: fingerprint.timezoneId,
                permissions: ['geolocation', 'notifications'],
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--window-size=1280,720',
                    '--window-position=50,50'
                ]
            });
        } else {
            console.error('DEBUG: Launch failed completely:', e);
            throw e;
        }
    }

    console.log('DEBUG: Context launched successfully');

    // Register context
    activeContexts.set(accountId, context);
    browsers.register(`${accountId}-flipkart-login`, context);

    context.on('close', () => {
        log.info('Browser context closed. Removing from active list.');
        activeContexts.delete(accountId);
    });

    // Strategy: Inject cookies from JSON if available, BUT NOT for new accounts
    // New accounts should go through fresh login flow
    try {
        const account = await getAccount(accountId);
        const isNewAccount = !account || account.status === 'New';

        if (isNewAccount) {
            log.info('New account detected - skipping cookie injection for fresh login flow.');
        } else {
            console.log(`[DEBUG-ANTIGRAVITY] Attempting to load cookies for ${accountId}...`);
            const cookies = await loadCookiesFromDisk(accountId, platform);
            if (cookies.length > 0) {
                log.info(`Injecting ${cookies.length} cookies from storage...`);
                console.log(`[DEBUG-ANTIGRAVITY] Cookies to inject: ${cookies.map((c: { name: any; }) => c.name).join(', ')}`);

                await context.addCookies(cookies);

                const contextCookies = await context.cookies();
                console.log(`[DEBUG-ANTIGRAVITY] Verification - Cookies present in context: ${contextCookies.length}`);
                console.log(`[DEBUG-ANTIGRAVITY] Context Cookie Names: ${contextCookies.map(c => c.name).join(', ')}`);
            } else {
                console.log(`[DEBUG-ANTIGRAVITY] No cookies found on disk for ${accountId}`);
            }
        }
    } catch (e) {
        log.warn('Failed to inject cookies', e);
        console.error('[DEBUG-ANTIGRAVITY] Cookie injection error:', e);
    }

    try {
        const page = await context.newPage();
        await injectOverlay(page, 'flipkart');
        await page.goto('https://www.flipkart.com/', { waitUntil: 'domcontentloaded' });

        // Check if already logged in via simple selector check
        const isLoggedIn = await Promise.race([
            page.waitForSelector('text=My Profile', { timeout: 3000 }).then(() => true).catch(() => false),
            page.waitForSelector('text=Logout', { timeout: 3000 }).then(() => true).catch(() => false),
            page.waitForSelector('text=Orders', { timeout: 3000 }).then(() => true).catch(() => false),
            page.waitForSelector('._28p97w', { timeout: 3000 }).then(() => true).catch(() => false), // Class for header user name
            new Promise(r => setTimeout(() => r(false), 3500))
        ]);

        if (isLoggedIn) {
            log.info('Session is valid. No login required.');
            // Do NOT return early. Proceed to capture cookies to ensure DB is up to date.
        } else {
            // Only perform login steps if NOT logged in

            log.info('Session invalid or expired. Initiating login flow...');

            // Click Login button if visible
            try {
                const loginBtn = page.getByRole('link', { name: 'Login' }).first();
                if (await loginBtn.isVisible()) {
                    await loginBtn.click();
                }
            } catch (e) {
                log.debug('Login button interaction skipped or failed', e);
            }

            // Enter Identifier
            try {
                log.info(`Auto-filling identifier: ${identifier}`);
                // Various selectors for the input
                const input = await page.waitForSelector('input[type="text"], input[type="tel"], ._2IX_2-', { timeout: 10000 });
                await input.fill(identifier);

                // Various selectors for the button
                const requestOtpBtn = page.locator('button:has-text("Request OTP"), button:has-text("CONTINUE"), ._2KpZ6l._2HKl97._3AWRsL').first();
                if (await requestOtpBtn.isVisible()) {
                    log.info('Clicking Request OTP / Continue...');
                    await requestOtpBtn.click();
                }
            } catch (e) {
                log.warn('Could not auto-fill identifier. User interaction might be required.', e);
            }

            log.info('Waiting for manual OTP entry... Please complete login in the browser window.');

            // Wait for user or automation to complete login
            try {
                await Promise.race([
                    page.waitForSelector('text=My Profile', { timeout: keepOpen ? 0 : 60000 }),
                    page.waitForSelector('div._28p97w', { timeout: keepOpen ? 0 : 60000 }),
                    page.waitForSelector('text=Logout', { timeout: keepOpen ? 0 : 60000 }),
                    page.waitForSelector('text=Account', { timeout: keepOpen ? 0 : 60000 })
                ]);

                log.info('Login detected successfully! Waiting for session to settle...');
            } catch (e: any) {
                if (keepOpen && (e.name === 'TimeoutError' || e.message.includes('timeout'))) {
                    log.warn('Login detection timed out/deferred, attempting cookie extraction anyway...');
                } else {
                    throw e;
                }
            }
        } // End of else block (login steps only)

        // SHARED LOGIC: Cookie capture
        // (Runs for both cached-session and new-login paths)

        // Mandatory settle and capture
        await page.waitForTimeout(3000);

        // Wait for critical 'S' cookie to ensure complete session capture
        // Poll for up to 10 seconds
        let attempts = 0;
        while (attempts < 10) {
            const currentCookies = await context.cookies();
            if (currentCookies.find(c => c.name === 'S')) {
                log.info('Critical "S" cookie detected. Session captured.');
                break;
            }
            await page.waitForTimeout(1000);
            attempts++;
        }
        if (attempts >= 10) {
            log.warn('Critical "S" cookie NOT detected after wait. Login might be partial.');
        }

        // PERIODIC SAVE (LS & Cookies) - Added for manual login persistence
        const saveInterval = setInterval(async () => {
            try {
                if (page.isClosed()) return;
                const url = page.url();

                // 1. Save Local Storage
                const ls = await page.evaluate(() => JSON.stringify(window.localStorage));
                if (ls && ls !== '{}') {
                    await saveLocalStorage(accountId, JSON.parse(ls), 'flipkart');
                    await pushLocalStorage(accountId, 'flipkart');
                }

                // 2. Save Cookies if we are likely logged in
                if (!url.includes('/login') && !url.includes('/logout')) {
                    const cookies = await context.cookies();
                    const snCookie = cookies.find(c => c.name === 'SN');
                    const isLO = snCookie?.value.endsWith('.LO') || false;

                    if (snCookie && !isLO) {
                        await extractAndSaveCookies(context, accountId, 'flipkart');
                        await pushCookies(accountId, 'flipkart');
                    }
                }
            } catch (e) {
                // Ignore errors
            }
        }, 5000);

        context.on('close', () => clearInterval(saveInterval));

        // SAVE LOCAL STORAGE (New)
        try {
            const ls = await page.evaluate(() => JSON.stringify(window.localStorage));
            if (ls && ls !== '{}') {
                await saveLocalStorage(accountId, JSON.parse(ls), 'flipkart');
                await pushLocalStorage(accountId, 'flipkart');
                log.info('Local Storage captured and synced to cloud.');
            }
        } catch (e: any) {
            log.warn(`Failed to save Local Storage: ${e.message}`);
        }

        log.info('Extracting cookies for persistence...');
        try {
            const cookies = await extractAndSaveCookies(context, accountId, 'flipkart');
            log.info(`Captured ${cookies.length} cookies.`);
        } catch (err: any) {
            log.error(`Cookie capture failed: ${err.message}`);
            if (!keepOpen) throw err; // Only throw if we weren't expecting manual intervention
        }

        try {
            await pushCookies(accountId, 'flipkart');
        } catch (e: any) {
            log.warn('Failed to sync cookies to cloud:', e.message);
        }

        log.info('Login completed. Finalizing session store...');
        if (!keepOpen) await context.close();
        await saveProfileToDisk(platform, accountId);
        log.info('Profile saved and encrypted.');

        // Update Account Status in DB
        await updateLastLogin(accountId);
        log.info('Account status updated to Healthy.');

        return { status: 'success', message: 'Login completed' };

    } catch (err: any) {
        // Handle "Browser closed by user"
        if (err.message.includes('closed') || err.message.includes('browser has been closed')) {
            log.warn('Browser closed by user or crashed.');
            try { await context.close(); } catch { }
            return { status: 'cancelled', message: 'Browser closed by user' };
        }

        log.error(`Login flow failed: ${err}`);
        await updateAccountStatus(accountId, 'Error', String(err));

        // IMPORTANT: If keepOpen is true, do NOT close the browser. 
        // This allows user to finish manual login if automation fails.
        if (!keepOpen) {
            try { await context.close(); } catch { }
            throw err;
        } else {
            log.info('KeepOpen is true, leaving browser open for manual intervention.');
            return { status: 'warning', message: `Automation failed but browser kept open: ${err.message}` };
        }
    }
}
