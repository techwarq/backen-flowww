import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from './log.js';

/**
 * Checks if Playwright browsers are installed and installs them if missing.
 * This provides self-healing for deployments where postinstall didn't run.
 */
export async function ensurePlaywrightBrowsers(): Promise<void> {
    try {
        // Try to detect if chromium exists by checking the registry
        const { chromium } = await import('playwright');

        // This will throw if browser is not installed
        const executablePath = chromium.executablePath();

        if (!fs.existsSync(executablePath)) {
            throw new Error('Browser executable not found');
        }

        logger.info('[Playwright] Chromium browser found and ready.');
    } catch (error: any) {
        logger.warn(`[Playwright] Browser not found: ${error.message}`);
        logger.info('[Playwright] Attempting to install Chromium automatically...');

        try {
            execSync('npx playwright install chromium', {
                stdio: 'inherit',
                timeout: 120000 // 2 minute timeout
            });
            logger.info('[Playwright] Chromium installed successfully!');
        } catch (installError: any) {
            logger.error(`[Playwright] Failed to auto-install Chromium: ${installError.message}`);
            logger.error('[Playwright] Please run manually: npx playwright install chromium');
            // Don't throw - let the app start, it will fail at runtime if browser needed
        }
    }
}
