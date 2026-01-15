import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import logger from './log.js';

/**
 * Downloads Playwright Chromium browser programmatically.
 * Works even in bundled Tauri apps where npx isn't available.
 */
export async function ensurePlaywrightBrowsers(): Promise<void> {
    try {
        // Import playwright dynamically
        const { chromium } = await import('playwright');

        // Get the expected executable path
        let executablePath: string;
        try {
            executablePath = chromium.executablePath();
        } catch (e) {
            // If this throws, browsers definitely aren't installed
            logger.warn('[Playwright] Cannot determine executable path, attempting install...');
            await downloadChromium();
            return;
        }

        // Check if the browser actually exists at that path
        if (!fs.existsSync(executablePath)) {
            logger.warn(`[Playwright] Browser not found at ${executablePath}`);
            await downloadChromium();
            return;
        }

        logger.info('[Playwright] Chromium browser found and ready.');
    } catch (error: any) {
        logger.error(`[Playwright] Browser check failed: ${error.message}`);
        // Don't throw - let app continue, will fail at runtime if browser needed
    }
}

async function downloadChromium(): Promise<void> {
    logger.info('[Playwright] Downloading Chromium browser (this may take a minute)...');

    try {
        // Method 1: Try using playwright's internal CLI
        const playwrightPath = require.resolve('playwright');
        const playwrightDir = path.dirname(playwrightPath);
        const cliPath = path.join(playwrightDir, 'cli.js');

        if (fs.existsSync(cliPath)) {
            // Use Node to run the CLI directly (works in bundled apps)
            const result = await new Promise<boolean>((resolve) => {
                const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
                    stdio: 'inherit',
                    env: { ...process.env }
                });

                child.on('close', (code) => {
                    if (code === 0) {
                        logger.info('[Playwright] Chromium installed successfully!');
                        resolve(true);
                    } else {
                        logger.error(`[Playwright] Install exited with code ${code}`);
                        resolve(false);
                    }
                });

                child.on('error', (err) => {
                    logger.error(`[Playwright] Spawn error: ${err.message}`);
                    resolve(false);
                });
            });

            if (result) return;
        }

        // Method 2: Fallback to npx if available
        try {
            execSync('npx playwright install chromium', {
                stdio: 'inherit',
                timeout: 180000 // 3 minute timeout
            });
            logger.info('[Playwright] Chromium installed via npx!');
            return;
        } catch (npxError) {
            logger.warn('[Playwright] npx method failed, trying direct download...');
        }

        // Method 3: Use playwright's internal download API
        // @ts-ignore - accessing internal API
        const { Registry } = await import('playwright-core/lib/server/registry.js');
        const registry = new Registry(require('playwright-core'));
        await registry.install(['chromium']);
        logger.info('[Playwright] Chromium installed via registry API!');

    } catch (error: any) {
        logger.error(`[Playwright] All install methods failed: ${error.message}`);
        logger.error('[Playwright] Please manually run: npx playwright install chromium');
    }
}
