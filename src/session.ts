import { chromium, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs-extra';
import { PROFILES_DIR } from './config.js';
import { generateFingerprint } from './fingerprint.js';
import logger, { getAccountLogger } from './log.js';
import { loadCookiesFromDisk, extractAndSaveCookies, adaptCookiesForShopsy } from './cookies.js';
import { browsers } from './browserManager.js';
import { pushCookies, fetchCookiesFromCloud, fetchLocalStorage, pushLocalStorage, getSupabase } from './cloud.js';
import { loadLocalStorage, saveLocalStorage } from './localStorage.js';

export interface SessionOptions {
    accountId: string;
    platform: 'flipkart' | 'shopsy';
}

/**
 * Opens a browser session with pre-injected cookies for viewing logged-in state.
 * For Shopsy, uses Flipkart cookies adapted to shopsy.in domain.
 */
export async function openSession(options: SessionOptions) {
    const { accountId, platform } = options;
    const log = getAccountLogger(accountId);

    const url = platform === 'flipkart'
        ? 'https://www.flipkart.com'
        : 'https://www.shopsy.in';

    // Normalize to lowercase for consistent profile paths (macOS is case-insensitive)
    const normalizedId = accountId.toLowerCase().trim();
    const profilePath = path.join(PROFILES_DIR, platform, normalizedId, 'userDataDir');
    const fingerprint = generateFingerprint(platform, accountId);
    const lockFile = path.join(profilePath, 'SingletonLock');

    console.log(`[Session] Opening ${platform} for ${accountId}`);
    console.log(`[Session] Profile path: ${profilePath}`);
    console.log(`[Session] Active browsers: ${browsers.isActive(accountId) ? 'Yes' : 'No'}`);

    log.info(`Opening ${platform} session for ${accountId}`);

    // Proactive unlock
    try {
        if (await fs.pathExists(lockFile)) {
            console.log(`[Session] Removing stale lock file: ${lockFile}`);
            await fs.remove(lockFile);
        }
    } catch (err) {
        console.log(`[Session] Could not remove lock file:`, err);
    }

    // FORCE FRESH PROFILE for debugging:
    // This ensures we are testing the JSON cookies purely, without interference from stale browser cache.
    // if (await fs.pathExists(profilePath)) {
    //    await fs.emptyDir(profilePath);
    //    log.info('[DEBUG-ANTIGRAVITY] cleared profile directory for fresh cookie test.');
    // }

    let context: BrowserContext;

    try {
        log.info(`[DEBUG-ANTIGRAVITY] Launching with UA: ${fingerprint.userAgent}`);

        // For BOTH Flipkart and Shopsy, use null viewport + fixed window size for consistent Desktop experience.
        const viewport = null;

        context = await chromium.launchPersistentContext(profilePath, {
            headless: false,
            viewport: viewport,
            userAgent: fingerprint.userAgent, // Ensure this is a Desktop UA from fingerprint.ts
            locale: fingerprint.locale,
            timezoneId: fingerprint.timezoneId,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                // Fixed window size for all platforms
                '--window-size=1280,720',
                '--window-position=50,50'
            ]
        });
    } catch (e: any) {
        const errorMsg = String(e.message || e);
        if (errorMsg.includes('ProcessSingleton') || errorMsg.includes('SingletonLock')) {
            try {
                if (await fs.pathExists(lockFile)) {
                    await fs.remove(lockFile);
                }
            } catch (err) { }

            const viewport = null;

            context = await chromium.launchPersistentContext(profilePath, {
                headless: false,
                viewport: viewport,
                userAgent: fingerprint.userAgent,
                locale: fingerprint.locale,
                timezoneId: fingerprint.timezoneId,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--window-size=1280,720',
                    '--window-position=50,50'
                ]
            });
        } else {
            throw e;
        }
    }

    browsers.register(`${accountId}-${platform}-session`, context);

    // Load and inject cookies - try cloud DB first, then local disk
    try {
        let cookies: any[] = [];

        if (platform === 'shopsy') {
            // For Shopsy: First try cloud DB
            cookies = await fetchCookiesFromCloud(accountId, 'shopsy');

            if (cookies.length === 0) {
                // Try local disk
                cookies = await loadCookiesFromDisk(accountId, 'shopsy');
            }

            if (cookies.length === 0) {
                // Fallback: Try adapting Flipkart cookies from cloud
                const flipkartCookies = await fetchCookiesFromCloud(accountId, 'flipkart');
                if (flipkartCookies.length > 0) {
                    cookies = adaptCookiesForShopsy(flipkartCookies);
                    log.info(`Adapted ${cookies.length} Flipkart cookies from cloud for Shopsy`);
                } else {
                    // Final fallback: local Flipkart cookies
                    const localFlipkart = await loadCookiesFromDisk(accountId, 'flipkart');
                    if (localFlipkart.length > 0) {
                        cookies = adaptCookiesForShopsy(localFlipkart);
                        log.info(`Adapted ${cookies.length} local Flipkart cookies for Shopsy`);
                    }
                }
            } else {
                log.info(`Found ${cookies.length} Shopsy cookies`);
            }
        } else {
            // For Flipkart: Try cloud DB first
            if (getSupabase()) {
                cookies = await fetchCookiesFromCloud(accountId, 'flipkart');
            }

            if (cookies.length === 0) {
                // Fallback to local disk
                cookies = await loadCookiesFromDisk(accountId, 'flipkart');
                log.info(`Loaded ${cookies.length} Flipkart cookies from local disk (backend/data)`);
            } else {
                log.info(`Loaded ${cookies.length} Flipkart cookies from cloud DB`);
            }
        }

        if (cookies.length > 0) {
            // Sanitize cookies and FORCE correct security attributes for critical auth cookies
            const cleanCookies = cookies.map(c => {
                const clean = { ...c };
                // Ensure domain starts with dot 
                if (clean.domain === 'www.flipkart.com') clean.domain = '.flipkart.com';

                // Force secure authentication cookies - REMOVED: Trusting origin attributes
                // Flipkart's 'at', 'SN', 'S' cookies MUST be strict/secure to work properly
                // if (['at', 'SN', 'S', 'T'].includes(clean.name)) {
                //    clean.secure = true;
                //    // 'None' is often required for these, but 'Lax' might work. 
                //    // Matching the working 'sonalinayak' profile which has 'None'.
                //    clean.sameSite = 'None';
                // }
                return clean;
            });

            // Critical Debug: Log auth cookies specifically
            const authCookies = cleanCookies.filter(c => ['at', 'S', 'SN'].includes(c.name));
            log.info(`DEBUG AUTH COOKIES (Fixed): ${JSON.stringify(authCookies)}`);

            // Log summary of all cookies
            const summary = cleanCookies.map(c => `${c.name} (exp: ${c.expires}, sec: ${c.secure}, ss: ${c.sameSite}, dom: ${c.domain})`).join(', ');
            log.info(`DEBUG ALL COOKIES: ${summary}`);

            await context.addCookies(cleanCookies);
            log.info(`Injected ${cleanCookies.length} sanitized cookies`);

            console.log(`[DEBUG-ANTIGRAVITY] session.ts: Injected ${cleanCookies.length} cookies.`);
            const ctxCookies = await context.cookies();
            console.log(`[DEBUG-ANTIGRAVITY] session.ts: Verification in context: ${ctxCookies.length} cookies found.`);
            console.log(`[DEBUG-ANTIGRAVITY] session.ts: Context Cookie Names: ${ctxCookies.map(c => c.name).join(', ')}`);
        } else {
            log.warn('No saved cookies found. Session may not be logged in.');
            console.log('[DEBUG-ANTIGRAVITY] session.ts: No saved cookies found to inject.');
        }
    } catch (e: any) {
        log.warn(`Failed to load/inject cookies: ${e.message}`);
    }

    // INJECT LOCAL STORAGE (New)
    try {
        let lsData = null;
        if (getSupabase()) {
            lsData = await fetchLocalStorage(accountId, platform);
        }

        if (!lsData) {
            lsData = await loadLocalStorage(accountId, platform);
        }

        // Shopsy Fallback: if no Shopsy LS, try Flipkart LS
        if (!lsData && platform === 'shopsy') {
            log.info(`No Shopsy Local Storage found for ${accountId}, attempting Flipkart LS fallback...`);
            if (getSupabase()) {
                lsData = await fetchLocalStorage(accountId, 'flipkart');
            }
            if (!lsData) {
                lsData = await loadLocalStorage(accountId, 'flipkart');
            }
            if (lsData) log.info('Using Flipkart Local Storage for Shopsy session.');
        }

        if (lsData) {
            log.info(`Injecting Local Storage data for ${accountId}...`);
            await context.addInitScript((data) => {
                const hostname = window.location.hostname;
                console.log(`[ANTIGRAVITY-BROWSER] InitScript running on: ${hostname} (href: ${window.location.href})`);

                if (hostname.includes('flipkart') || hostname.includes('shopsy')) {
                    console.log(`[ANTIGRAVITY-BROWSER] Creating localStorage entries: ${Object.keys(data).length}`);
                    for (const [key, value] of Object.entries(data)) {
                        // Skip explicit logged-out state to allow cookies to rebuild it
                        if (key === 'isLoggedIn' && value === 'false') {
                            console.log('[ANTIGRAVITY-BROWSER] Skipping isLoggedIn: false from LS injection');
                            continue;
                        }
                        window.localStorage.setItem(key, value as string);
                    }
                } else {
                    console.log('[ANTIGRAVITY-BROWSER] Hostname specific check failed. Skipping LS injection.');
                }
            }, lsData);
        }
    } catch (e: any) {
        log.warn(`Failed to inject Local Storage: ${e.message}`);
    }

    // Navigate to platform
    const page = await context.newPage();

    // Diagnostic: Log requests to see if cookies are being sent
    await page.route('**/*', async (route) => {
        const request = route.request();
        if (request.url().includes('flipkart.com') && request.isNavigationRequest()) {
            const headers = await request.allHeaders();
            const hasCookie = !!headers['cookie'];
            console.log(`[DEBUG-ANTIGRAVITY] Navigation Request to: ${request.url()} | Has Cookie Header: ${hasCookie}`);
        }
        await route.continue();
    });

    page.on('console', msg => {
        if (msg.type() === 'log' || msg.type() === 'debug') {
            const text = msg.text();
            if (text.includes('[ANTIGRAVITY-BROWSER]')) {
                console.log(text);
            }
        }
    });

    const startUrl = platform === 'flipkart' ? 'https://www.flipkart.com/account' : 'https://www.shopsy.in/';
    log.info(`Navigating to ${startUrl}...`);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

    // Settle time
    await page.waitForTimeout(2000);

    // If we land on login page, try one refresh just in case cookies were slow to register
    if (page.url().includes('/login')) {
        log.info('[DEBUG-ANTIGRAVITY] Landed on login page. Attempting one refresh for cookie settlement...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
    }

    log.info(`${platform} session opened. Browser will stay open for use.`);

    // VERIFY LOGIN STATE
    const cookiesAfter = await context.cookies();
    const authNames = cookiesAfter.map(c => c.name).filter(n => ['at', 'S', 'SN', 'T'].includes(n));
    log.info(`[DEBUG-ANTIGRAVITY] Context Auth Cookies after nav: ${authNames.join(', ')}`);

    const finalLoggedIn = await Promise.race([
        page.waitForSelector('text=My Profile', { timeout: 3000 }).then(() => true).catch(() => false),
        page.waitForSelector('text=Logout', { timeout: 3000 }).then(() => true).catch(() => false),
        page.waitForSelector('text=Orders', { timeout: 3000 }).then(() => true).catch(() => false),
        page.waitForSelector('._28p97w', { timeout: 3000 }).then(() => true).catch(() => false),
        new Promise(r => setTimeout(() => r(false), 3500))
    ]);

    if (finalLoggedIn && !page.url().includes('/login')) {
        log.info(`[DEBUG-ANTIGRAVITY] PAGE STATE: LOGGED IN (Selector matched and URL=${page.url()})`);
    } else {
        log.info(`[DEBUG-ANTIGRAVITY] PAGE STATE: LOGGED OUT (URL=${page.url()})`);

        // Check for Login button
        const loginBtn = await page.getByRole('link', { name: 'Login' }).first().isVisible().catch(() => false);
        log.info(`[DEBUG-ANTIGRAVITY] Login Button Visible: ${loginBtn}`);
    }

    // PERIODIC SAVE (LS & Cookies) - Optimized to only save when changed
    let lastCookieHash = '';
    let lastLsHash = '';

    const saveInterval = setInterval(async () => {
        try {
            if (page.isClosed()) return;
            const url = page.url();

            // 1. Save Local Storage - only if changed
            const ls = await page.evaluate(() => JSON.stringify(window.localStorage));
            if (ls && ls !== '{}') {
                const lsHash = Buffer.from(ls).toString('base64').slice(0, 50); // Simple hash
                if (lsHash !== lastLsHash) {
                    lastLsHash = lsHash;
                    await saveLocalStorage(accountId, JSON.parse(ls), 'flipkart');
                    await pushLocalStorage(accountId, 'flipkart');
                    log.info('Local Storage changed - synced to cloud.');
                }
            }

            // 2. Save Cookies if we are likely logged in - only if changed
            // Safety: Don't save if we are at a login page or if SN cookie says .LO
            if (!url.includes('/login') && !url.includes('/logout')) {
                const cookies = await context.cookies();
                const snCookie = cookies.find(c => c.name === 'SN');

                // Only save if we have a session cookie and it doesn't explicitly say LO
                const isLO = snCookie?.value.endsWith('.LO') || false;

                if (snCookie && !isLO) {
                    // Create a simple hash of cookie values to detect changes
                    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).sort().join('|');
                    const cookieHash = Buffer.from(cookieStr).toString('base64').slice(0, 50);

                    if (cookieHash !== lastCookieHash) {
                        lastCookieHash = cookieHash;
                        await extractAndSaveCookies(context, accountId, platform);
                        try {
                            await pushCookies(accountId, platform);
                            log.info('Cookies changed - synced to cloud.');
                        } catch (e: any) {
                            log.warn(`Failed to push cookies to cloud: ${e.message}`);
                        }
                    }
                }
            }
        } catch (e) {
            // Ignore errors (page might be closing)
        }
    }, 5000);

    log.info(`${platform} session opened. Browser will stay open for use.`);
    context.on('close', async () => {
        clearInterval(saveInterval); // Stop polling
        log.info('Session browser closed.');
    });

    return { status: 'success', message: `${platform} session opened with saved cookies` };
}
