import { webkit, devices } from 'playwright';

export interface Fingerprint {
    userAgent: string;
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    locale: string;
    timezoneId: string;
    hasTouch: boolean;
    isMobile: boolean;
    javaScriptEnabled: boolean;
}

const DESKTOP_USER_AGENTS = [
    // Standardize to Chrome on macOS for best consistency with the actual browser engine (Chromium) running on Mac.
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

// Shopsy is mobile-only, so we mostly need valid mobile configurations
const MOBILE_DEVICES = [
    devices['Pixel 5'],
    devices['Pixel 7'],
    devices['Samsung Galaxy S20 Ultra'],
    devices['iPhone 12'], // Careful with iPhone emulation on Chromium, usually fine for detection
];

export function generateFingerprint(platform: 'flipkart' | 'shopsy', seed: string): Fingerprint {
    console.log(`[Fingerprint] Generating for ${platform} with seed: ${seed}`);

    // Simple deterministic generation based on seed string sum
    let sum = 0;
    const seedStr = String(seed || 'default');
    for (let i = 0; i < seedStr.length; i++) {
        sum += seedStr.charCodeAt(i);
    }

    let result: Fingerprint;

    if (platform === 'shopsy') {
        // Desktop View requested for Shopsy as well.
        // Use the same desktop logic as Flipkart to ensure desktop site loads.
        const uaIndex = sum % DESKTOP_USER_AGENTS.length;
        const ua = DESKTOP_USER_AGENTS[uaIndex];

        result = {
            userAgent: ua || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 1,
            locale: 'en-IN',
            timezoneId: 'Asia/Kolkata',
            hasTouch: false,
            isMobile: false, // Critical: Set to false for Desktop site
            javaScriptEnabled: true
        };
    } else {
        // Flipkart Desktop
        const uaIndex = sum % DESKTOP_USER_AGENTS.length;
        const ua = DESKTOP_USER_AGENTS[uaIndex];

        if (!ua) {
            result = {
                userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                viewport: { width: 1920, height: 1080 },
                deviceScaleFactor: 1,
                locale: 'en-IN',
                timezoneId: 'Asia/Kolkata',
                hasTouch: false,
                isMobile: false,
                javaScriptEnabled: true
            };
        } else {
            result = {
                userAgent: ua,
                viewport: { width: 1920, height: 1080 },
                deviceScaleFactor: 1,
                locale: 'en-IN',
                timezoneId: 'Asia/Kolkata',
                hasTouch: false,
                isMobile: false,
                javaScriptEnabled: true
            };
        }
    }

    console.log(`[Fingerprint] Resulting UserAgent: ${result.userAgent.substring(0, 50)}...`);
    return result;
}
