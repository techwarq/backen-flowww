import { BrowserContext } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import { DATA_DIR } from './config.js';
import { pushCookies } from './cloud.js';

const COOKIES_DIR = path.join(DATA_DIR, 'cookies');

export async function ensureCookiesDir() {
    await fs.ensureDir(COOKIES_DIR);
}

/**
 * Get cookie file path
 */
export function getCookieFilePath(accountId: string, platform: 'flipkart' | 'shopsy' = 'flipkart') {
    const id = accountId.toLowerCase().trim();
    return path.join(COOKIES_DIR, `${id}_${platform}.json`);
}

/**
 * Load cookies from disk and sanitize for Playwright
 */
export async function loadCookiesFromDisk(accountId: string, platform: 'flipkart' | 'shopsy' = 'flipkart') {
    const file = getCookieFilePath(accountId, platform);
    console.log(`[DEBUG-ANTIGRAVITY] loadCookiesFromDisk reading from: ${file}`);
    if (await fs.pathExists(file)) {
        const cookies = await fs.readJSON(file);
        console.log(`[DEBUG-ANTIGRAVITY] Read ${cookies.length} raw cookies from disk.`);
        // Sanitize cookies for Playwright - sameSite must be "Strict", "Lax", or "None"
        return cookies.map((c: any) => {
            const sanitized = { ...c };
            // Fix sameSite value
            // Fix sameSite value
            if (sanitized.sameSite === 'no_restriction') {
                sanitized.sameSite = 'None';
                sanitized.secure = true;
            } else if (sanitized.sameSite === 'None') {
                // Keep None, ensure Secure is true
                sanitized.secure = true;
            } else if (!sanitized.sameSite || !['Strict', 'Lax', 'None'].includes(sanitized.sameSite)) {
                sanitized.sameSite = 'Lax'; // Default to Lax if invalid
            }
            // Remove fields that Playwright doesn't accept
            delete sanitized.hostOnly;
            delete sanitized.session;
            delete sanitized.storeId;
            return sanitized;
        });
    }
    return [];
}

/**
 * Save cookies to disk
 */
export async function saveCookiesToDisk(accountId: string, cookies: any[], platform: 'flipkart' | 'shopsy' = 'flipkart') {
    await ensureCookiesDir();
    const file = getCookieFilePath(accountId, platform);
    await fs.writeJSON(file, cookies, { spaces: 2 });
    // Attempt cloud sync
    // pushCookies(accountId, platform); // DISABLED
}

/**
 * Extracts cookies from the context (Flipkart) and saves them.
 */
export async function extractAndSaveCookies(context: BrowserContext, accountId: string, platform: 'flipkart' | 'shopsy' = 'flipkart') {
    await ensureCookiesDir();
    const id = accountId.toLowerCase().trim();

    let cookies: any[] = [];
    // Retry up to 5 times with a 1s delay
    for (let i = 0; i < 5; i++) {
        cookies = await context.cookies();
        // Look for common auth cookies
        if (cookies.length > 5) {
            console.log(`[Cookies] [${platform}] Found ${cookies.length} cookies on attempt ${i + 1}`);
            break;
        }
        console.log(`[Cookies] [${platform}] Attempt ${i + 1}: Only ${cookies.length} cookies found. Retrying...`);
        await new Promise(r => setTimeout(r, 1000));
    }

    if (cookies.length === 0) {
        throw new Error(`No cookies found in browser context for ${id} on ${platform}.`);
    }

    const cookieFile = getCookieFilePath(id, platform);
    console.log(`[Cookies] Saving ${cookies.length} cookies to: ${cookieFile}`);
    await fs.writeJSON(cookieFile, cookies, { spaces: 2 });

    // Attempt cloud sync
    // pushCookies(id, platform); // DISABLED

    return cookies;
}

/**
 * Loads Flipkart cookies, adapts them for Shopsy, and injects them.
 */
export async function injectFlipkartCookiesIntoShopsy(context: BrowserContext, accountId: string) {
    const file = getCookieFilePath(accountId, 'flipkart');
    if (!await fs.pathExists(file)) return false;

    const flipkartCookies = await fs.readJSON(file);
    const shopsyCookies = adaptCookiesForShopsy(flipkartCookies);
    await context.addCookies(shopsyCookies);
    return true;
}

/**
 * Adapt cookies from flipkart.com to shopsy.in
 */
export function adaptCookiesForShopsy(cookies: any[]) {
    return cookies.map((c: any) => {
        const newCookie = { ...c };
        delete newCookie.hostOnly;
        delete newCookie.session;

        // Convert flipkart domains to shopsy
        if (c.domain.includes('flipkart.com')) {
            newCookie.domain = '.shopsy.in';
        }

        // Shopsy mobile web often requires Secure/None for session cookies to work across domains/subdomains
        if (['at', 'S', 'SN', 'T'].includes(c.name)) {
            newCookie.secure = true;
            newCookie.sameSite = 'None';
        }

        return newCookie;
    });
}
