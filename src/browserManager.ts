import { BrowserContext } from 'playwright';

export class BrowserManager {
    private contexts: Map<string, BrowserContext> = new Map();

    register(id: string, context: BrowserContext) {
        this.contexts.set(id, context);
        context.on('close', () => {
            this.contexts.delete(id);
            console.log(`[BrowserManager] Context closed and removed: ${id}`);
        });
        console.log(`[BrowserManager] Context registered: ${id}`);
    }

    async closeAll() {
        console.log(`[BrowserManager] Closing ${this.contexts.size} active contexts...`);
        for (const [id, context] of this.contexts.entries()) {
            try {
                await context.close();
            } catch (e) {
                console.error(`[BrowserManager] Failed to close context for ${id}:`, e);
            }
        }
        this.contexts.clear();
    }

    isActive(idPrefix: string): boolean {
        for (const key of this.contexts.keys()) {
            if (key.startsWith(idPrefix)) return true;
        }
        return false;
    }
}

export const browsers = new BrowserManager();
