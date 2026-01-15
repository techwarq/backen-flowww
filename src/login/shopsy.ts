import { chromium, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs-extra';
import { PROFILES_DIR, getProfileDir, loadConfig, randomJitter } from '../config.js';
import { generateFingerprint } from '../fingerprint.js';
import logger, { getAccountLogger } from '../log.js';
import { saveProfileToDisk } from '../profiles/store.js';
import { injectOverlay } from '../overlay.js';
import { injectFlipkartCookiesIntoShopsy } from '../cookies.js';
import { updateLastLogin, updateAccountStatus } from '../accounts.js';
import { browsers } from '../browserManager.js';
import { pushCookies } from '../cloud.js';

export interface LoginOptions {
    accountId: string;
    identifier: string; // Phone
    headless?: boolean;
    keepOpen?: boolean;
}

export async function loginShopsy(options: LoginOptions) {
    const { accountId, identifier, headless = false, keepOpen = false } = options;
    const log = getAccountLogger(accountId);
    const platform = 'shopsy';

    const profilePath = path.join(PROFILES_DIR, platform, accountId, 'userDataDir');
    const fingerprint = generateFingerprint(platform, accountId);

    log.info(`Starting Shopsy login flow for ${accountId} (Mobile Emulation)`);

    let context: BrowserContext;
    const lockFile = path.join(profilePath, 'SingletonLock');

    // Proactive unlock
    try {
        if (await fs.pathExists(lockFile)) {
            await fs.remove(lockFile);
            console.log('DEBUG: Proactively removed stale Shopsy SingletonLock');
        }
    } catch (err) { }

    try {
        context = await chromium.launchPersistentContext(profilePath, {
            headless: headless,
            viewport: null, // Desktop view
            userAgent: fingerprint.userAgent,
            // Remove mobile emulation flags
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
            console.warn('DEBUG: Shopsy profile locked. Attempting force unlock...');
            try {
                if (await fs.pathExists(lockFile)) {
                    await fs.remove(lockFile);
                    console.log('DEBUG: Removed stale Shopsy SingletonLock after failure');
                }
            } catch (err) { }

            context = await chromium.launchPersistentContext(profilePath, {
                headless: headless,
                viewport: null, // Desktop view
                userAgent: fingerprint.userAgent,
                // Remove mobile flags
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
            throw e;
        }
    }

    browsers.register(`${accountId}-shopsy-login`, context);

    try {
        const page = await context.newPage();

        // Try to inject cookies from Flipkart (if available)
        await injectFlipkartCookiesIntoShopsy(context, accountId);

        await injectOverlay(page, 'shopsy');
        await page.goto('https://www.shopsy.in/', { waitUntil: 'domcontentloaded' });

        // Basic check for logged in state
        const isLoggedIn = await Promise.race([
            page.waitForSelector('text=Account', { timeout: 8000 }).then(() => true).catch(() => false),
            page.waitForSelector('text=My Orders', { timeout: 8000 }).then(() => true).catch(() => false),
            page.waitForSelector('a[href*="/account"]', { timeout: 8000 }).then(() => true).catch(() => false),
            new Promise(r => setTimeout(() => r(false), 9000))
        ]) as boolean;

        if (isLoggedIn) {
            log.info('Detected automatic login via Flipkart cookies! Skipping manual steps.');

            // Allow session to settle
            await page.waitForTimeout(3000);

            try {
                const { extractAndSaveCookies } = await import('../cookies.js');
                await extractAndSaveCookies(context, accountId, 'shopsy');
            } catch (e: any) {
                log.warn(`Cookie extraction skipped for shopsy: ${e.message}`);
            }

            try { await pushCookies(accountId, 'shopsy'); } catch { }

            if (!keepOpen) await context.close();
            await saveProfileToDisk(platform, accountId);
            await updateLastLogin(accountId);
            return { status: 'success', message: 'Automatic login completed via Flipkart session' };
        }

        log.info('Instructions: Please log in using the mobile web interface shown.');

        // We rely on the user to interact since it's headed for first login.
        // Wait for a success indicator.
        await page.waitForTimeout(5000); // Wait for load

        const loginButtons = await page.getByText('Login').all();
        if (loginButtons.length > 0) {
            log.info('Login button found, attempting click...');
            try { await loginButtons[0].click(); } catch { }
        }

        try {
            const input = page.locator('input[type="tel"]').first();
            await input.fill(identifier);
            // Trigger OTP logic if button exists
        } catch { }

        log.info('Waiting for manual Login completion...');

        // Wait for typical "My Account" or "Profile" indicator on mobile
        await Promise.race([
            page.waitForURL(/.*\/account.*/, { timeout: 180000 }), // Navigate to account page
            page.waitForSelector('text=My Orders', { timeout: 180000 })
        ]);

        log.info('Login detected successfully!');
        await page.waitForTimeout(3000);

        try {
            const { extractAndSaveCookies } = await import('../cookies.js');
            await extractAndSaveCookies(context, accountId, 'shopsy');
        } catch (e: any) {
            log.warn(`Cookie extraction skipped for shopsy: ${e.message}`);
        }

        try {
            await pushCookies(accountId, 'shopsy');
        } catch (e: any) {
            log.warn('Failed to sync cookies to cloud:', e.message);
        }

        if (!keepOpen) await context.close();
        await saveProfileToDisk(platform, accountId);
        log.info('Profile saved and encrypted.');

        // Update Account Status in DB
        await updateLastLogin(accountId);
        log.info('Account status updated to Healthy.');

        return { status: 'success', message: 'Login completed and profile saved' };

    } catch (err: any) {
        log.error(`Shopsy Login flow failed: ${err}`);
        await updateAccountStatus(accountId, 'Error', String(err));

        if (!keepOpen) {
            try { await context.close(); } catch { }
            throw err;
        } else {
            log.info('KeepOpen is true, leaving Shopsy browser open for manual intervention.');
            return { status: 'warning', message: `Automation failed but browser kept open: ${err.message}` };
        }
    }
}
