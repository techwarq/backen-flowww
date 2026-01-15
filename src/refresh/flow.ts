import { loginFlipkart } from '../login/flipkart.js';
import { loginShopsy } from '../login/shopsy.js';
import logger from '../log.js';

export async function refreshSession(platform: 'flipkart' | 'shopsy', accountId: string, identifier: string) {
    logger.info(`Attempting refresh for ${platform} - ${accountId}`);

    // For MVP, "refresh" is essentially trying to open the browser again.
    // If it requires OTP, it will wait for it (if headed).
    // If we want silent refresh, we'd try headless first, but often if token is dead, we NEED OTP.
    // So "Refresh" in this context effectively means "Re-login helper".

    if (platform === 'flipkart') {
        return loginFlipkart({ accountId, identifier, headless: false });
    } else {
        return loginShopsy({ accountId, identifier, headless: false });
    }
}
