import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { PROFILES_DIR, ENCRYPTED_DIR, getProfileDir, getEncryptedPath } from '../config.js';
import logger from '../log.js';

const ALGORITHM = 'aes-256-gcm';
const AUTH_TAG_LENGTH = 16;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

export interface ProfileStoreConfig {
    passphrase?: string;
}

let globalPassphrase: string | null = null;

export function setGlobalPassphrase(pass: string) {
    globalPassphrase = pass;
}

function getKey(salt: Buffer): Buffer {
    if (!globalPassphrase) {
        throw new Error("Global passphrase not set. Cannot encrypt/decrypt.");
    }
    return crypto.pbkdf2Sync(globalPassphrase, salt, 100000, KEY_LENGTH, 'sha256');
}

export async function saveProfileToDisk(platform: string, accountId: string): Promise<string> {
    const id = accountId.toLowerCase().trim();
    const profilePath = path.join(PROFILES_DIR, platform, id, 'userDataDir');
    const zipPath = path.join(ENCRYPTED_DIR, platform, `${id}.zip`);
    const encPath = path.join(ENCRYPTED_DIR, platform, `${id}.zip.enc`);

    if (!await fs.pathExists(profilePath)) {
        throw new Error(`Profile not found at ${profilePath}`);
    }

    await fs.ensureDir(path.dirname(encPath));

    try {
        // 1. Zip the userDataDir
        logger.info(`Zipping profile for ${accountId}...`);
        const zip = new AdmZip();
        // Filter out ephemeral/lock files that might disappear or cause issues
        // format: (filename) => boolean
        zip.addLocalFolder(profilePath, undefined, (filename) => {
            if (filename.includes('SingletonLock') ||
                filename.includes('RunningChromeVersion') ||
                filename.includes('SingletonCookie') ||
                filename.includes('lockfile')) {
                return false;
            }
            return true;
        });
        zip.writeZip(zipPath);

        // 2. Encrypt the Zip
        logger.info(`Encrypting profile for ${accountId}...`);
        const salt = crypto.randomBytes(SALT_LENGTH);
        const iv = crypto.randomBytes(IV_LENGTH);
        const key = getKey(salt);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

        const input = fs.createReadStream(zipPath);
        const output = fs.createWriteStream(encPath);

        // Write salt and IV first (unencrypted)
        output.write(salt);
        output.write(iv);

        input.pipe(cipher).pipe(output);

        await new Promise((resolve, reject) => {
            output.on('finish', () => resolve(undefined));
            output.on('error', reject);
        });

        // Get auth tag and append it? No, GCM typicaly requires getting auth tag after final.
        // Node's cipher stream might handle this automatically if we piped?
        // Actually for GCM with streams, we need to handle auth tag carefully.
        // It's safer to read the whole zip buffer if it's not huge, OR use `pipeline` and handle auth tag.
        // For simplicity/robustness in MVP, let's buffer the small zip or use block encryption logic.
        // RE-DOING encryption properly with simple buffer for safety:

        const zipBuffer = await fs.readFile(zipPath);

        const cipher2 = crypto.createCipheriv(ALGORITHM, key, iv);
        const encrypted = Buffer.concat([cipher2.update(zipBuffer), cipher2.final()]);
        const tag = cipher2.getAuthTag();

        // Final layout: [SALT (16)][IV (12)][TAG (16)][ENCRYPTED DATA]
        const finalBuffer = Buffer.concat([salt, iv, tag, encrypted]);
        await fs.writeFile(encPath, finalBuffer);

        // Cleanup
        await fs.remove(zipPath);
        logger.info(`Encrypted profile saved to ${encPath}`);

        return encPath;

    } catch (err) {
        logger.error(`Failed to save encrypted profile: ${err}`);
        throw err;
    }
}

export async function restoreProfileFromDisk(platform: string, accountId: string): Promise<string> {
    const id = accountId.toLowerCase().trim();
    const encPath = path.join(ENCRYPTED_DIR, platform, `${id}.zip.enc`);
    const profileDir = path.join(PROFILES_DIR, platform, id); // Parent of userDataDir
    const profilePath = path.join(profileDir, 'userDataDir');

    if (!await fs.pathExists(encPath)) {
        throw new Error(`Encrypted profile not found at ${encPath}`);
    }

    try {
        logger.info(`Decrypting profile for ${accountId}...`);
        const fileData = await fs.readFile(encPath);

        // Parse: [SALT (16)][IV (12)][TAG (16)][ENCRYPTED DATA]
        const salt = fileData.subarray(0, SALT_LENGTH);
        const iv = fileData.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
        const tag = fileData.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
        const encryptedText = fileData.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

        const key = getKey(salt);
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);

        const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);

        const tempZipPath = path.join(ENCRYPTED_DIR, platform, `${accountId}_temp.zip`);
        await fs.writeFile(tempZipPath, decrypted);

        // Unzip
        await fs.ensureDir(profileDir);
        // Clear existing if any to avoid corruption
        await fs.emptyDir(profilePath);

        const zip = new AdmZip(tempZipPath);
        zip.extractAllTo(profilePath, true);

        await fs.remove(tempZipPath);
        logger.info(`Profile restored to ${profilePath}`);

        return profilePath;
    } catch (err) {
        logger.error(`Failed to restore profile: ${err}`);
        throw err;
    }
}
