import fs from 'fs-extra';
import path from 'path';
import { DATA_DIR } from './config.js';

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export interface AppSettings {
    masterEmail?: {
        user: string;
        passEncrypted: string;
        host: string;
    },
    cloudConfig?: {
        url: string;
        key: string;
        enabled: boolean;
    }
}

let currentSettings: AppSettings = {};

export async function loadSettings() {
    try {
        if (await fs.pathExists(SETTINGS_FILE)) {
            currentSettings = await fs.readJSON(SETTINGS_FILE);
        }
    } catch (e) {
        console.error('Failed to load settings', e);
    }
    return currentSettings;
}

export async function saveSettings(settings: AppSettings) {
    currentSettings = { ...currentSettings, ...settings };
    await fs.ensureDir(DATA_DIR);
    await fs.writeJSON(SETTINGS_FILE, currentSettings, { spaces: 2 });
    return currentSettings;
}

export function getSettings() {
    return currentSettings;
}
