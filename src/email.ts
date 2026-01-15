import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import { GlobalConfig } from './config.js';

export interface EmailConfig {
    user: string;
    password: string; // App Password for Gmail
    host: string;
    port: number;
    tls: boolean;
}

/**
 * Connects to IMAP and searches for recent emails from Flipkart containing OTP.
 * @param config Email credentials
 * @param since Minutes to look back (default 5)
 */
export async function fetchFlipkartOtp(config: EmailConfig, sinceMinutes = 5): Promise<string | null> {
    const connectionConfig = {
        imap: {
            user: config.user,
            password: config.password,
            host: config.host,
            port: config.port,
            tls: config.tls,
            authTimeout: 10000
        }
    };

    try {
        const connection = await imaps.connect(connectionConfig);
        await connection.openBox('INBOX');

        // Search criteria: UNSEEN, or just recent? OTPs might be seen if open on phone.
        // Better to search by time and sender/subject.
        const delay = 60 * 1000 * sinceMinutes;
        const sinceDate = new Date(Date.now() - delay);

        const searchCriteria = [
            ['SINCE', sinceDate.toISOString()]
        ];

        const fetchOptions = {
            bodies: ['HEADER', 'TEXT'],
            markSeen: false
        };

        const messages = await connection.search(searchCriteria, fetchOptions);

        // Iterate backwards (newest first)
        for (const item of messages.reverse()) {
            const all = item.parts.filter(part => part.which === 'TEXT');
            const id = item.attributes.uid;
            const idHeader = "Imap-Id: " + id + "\r\n";

            // Simple parsing
            for (const part of all) {
                const mail = await simpleParser(idHeader + part.body);

                // Subject Match
                if (mail.subject && (mail.subject.includes('Flipkart') || mail.subject.includes('OTP'))) {
                    // Body Regex for 6-digit OTP
                    // "Your OTP is 123456"
                    const text = mail.text || "";
                    const otpMatch = text.match(/\b\d{6}\b/);
                    if (otpMatch) {
                        connection.end();
                        return otpMatch[0];
                    }
                }
            }
        }

        connection.end();
        return null;

    } catch (err) {
        console.error("IMAP Error:", err);
        return null;
    }
}
