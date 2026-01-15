import { Page } from 'playwright';

/**
 * Injects a floating navigation overlay into the page.
 * Allows quick switching between Flipkart and Shopsy.
 */
export async function injectOverlay(page: Page, currentPlatform: 'flipkart' | 'shopsy') {
    await page.addInitScript(({ platform }) => {
        // Create container
        const container = document.createElement('div');
        container.id = 'fsa-overlay';
        Object.assign(container.style, {
            position: 'fixed',
            top: '10px',
            right: '10px',
            zIndex: '2147483647', // Max z-index
            display: 'flex',
            gap: '10px',
            fontFamily: 'system-ui, sans-serif',
            pointerEvents: 'none', // Allow clicking through the container area
        });

        // Helper to create button
        const createBtn = (text: string, url: string, color: string) => {
            const btn = document.createElement('a');
            btn.href = url;
            btn.target = '_blank'; // Open in new tab to preserve current session context
            btn.textContent = text;
            Object.assign(btn.style, {
                display: 'inline-block',
                padding: '8px 16px',
                backgroundColor: color,
                color: 'white',
                textDecoration: 'none',
                borderRadius: '20px',
                fontSize: '14px',
                fontWeight: 'bold',
                boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
                cursor: 'pointer',
                pointerEvents: 'auto', // Re-enable clicks for buttons
                transition: 'transform 0.2s',
            });

            btn.onmouseover = () => { btn.style.transform = 'scale(1.05)'; };
            btn.onmouseout = () => { btn.style.transform = 'scale(1)'; };

            return btn;
        };

        // Add buttons based on context
        if (platform === 'shopsy') {
            const btn = createBtn('Open Flipkart', 'https://www.flipkart.com', '#2874f0'); // Flipkart Blue
            container.appendChild(btn);
        } else {
            const btn = createBtn('Open Shopsy', 'https://www.shopsy.in', '#d32f2f'); // Shopsy Red-ish
            container.appendChild(btn);
        }

        // Add to DOM when body is ready
        const init = () => {
            if (document.body) {
                document.body.appendChild(container); // Append
            } else {
                setTimeout(init, 100);
            }
        };
        init();

    }, { platform: currentPlatform });
}
