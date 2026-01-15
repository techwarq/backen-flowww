import crypto from 'crypto';

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_DIGEST = 'sha512';

export interface EncryptedData {
    iv: string; // hex
    authTag: string; // hex
    ciphertext: string; // hex
    salt: string; // hex
}

/**
 * Generate a random salt for key derivation
 */
export function generateSalt(): Buffer {
    return crypto.randomBytes(SALT_LENGTH);
}

/**
 * Derive a 256-bit key from a passphrase using PBKDF2
 */
export function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(
        passphrase,
        salt,
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        PBKDF2_DIGEST
    );
}

/**
 * Encrypt data using AES-256-GCM
 */
export function encrypt(data: Buffer, key: Buffer): EncryptedData {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
    });

    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        ciphertext: ciphertext.toString('hex'),
        salt: '', // Set by caller if needed
    };
}

/**
 * Decrypt data using AES-256-GCM
 */
export function decrypt(encrypted: EncryptedData, key: Buffer): Buffer {
    const iv = Buffer.from(encrypted.iv, 'hex');
    const authTag = Buffer.from(encrypted.authTag, 'hex');
    const ciphertext = Buffer.from(encrypted.ciphertext, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt data with a passphrase (combines key derivation and encryption)
 */
export function encryptWithPassphrase(data: Buffer, passphrase: string): EncryptedData {
    const salt = generateSalt();
    const key = deriveKeyFromPassphrase(passphrase, salt);
    const encrypted = encrypt(data, key);
    encrypted.salt = salt.toString('hex');
    return encrypted;
}

/**
 * Decrypt data with a passphrase (combines key derivation and decryption)
 */
export function decryptWithPassphrase(encrypted: EncryptedData, passphrase: string): Buffer {
    const salt = Buffer.from(encrypted.salt, 'hex');
    const key = deriveKeyFromPassphrase(passphrase, salt);
    return decrypt(encrypted, key);
}

/**
 * Hash a string for comparison (e.g., account ID fingerprint)
 */
export function hashString(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
}
