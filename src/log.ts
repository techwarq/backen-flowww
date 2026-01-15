import winston from 'winston';
import path from 'path';
import { LOGS_DIR } from './config.js';

// Custom format for console that is readable
const consoleFormat = winston.format.printf(({ level, message, timestamp, ...metadata }: any) => {
    let msg = `${timestamp} [${level}] : ${message} `;
    if (Object.keys(metadata).length > 0) {
        msg += JSON.stringify(metadata);
    }
    return msg;
});

// Create a logger instance
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'automation-script' },
    transports: process.env.VERCEL
        ? [new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'HH:mm:ss' }),
                consoleFormat
            ),
        })]
        : [
            // Write all logs with importance level of `error` or less to `error.log`
            new winston.transports.File({ filename: path.join(LOGS_DIR, 'error.log'), level: 'error' }),
            // Write all logs with importance level of `info` or less to `combined.log`
            new winston.transports.File({ filename: path.join(LOGS_DIR, 'combined.log') }),
        ],
});

// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
// If we're not in production and not on Vercel (where we already added console), add console
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({ format: 'HH:mm:ss' }),
            consoleFormat
        ),
    }));
}

export function getAccountLogger(accountId: string) {
    return logger.child({ accountId });
}

export default logger;

import fs from 'fs-extra';
// Helper to read last N lines from a log file
async function readLogFile(filename: string, limit: number = 50) {
    const filePath = path.join(LOGS_DIR, filename);
    if (!await fs.pathExists(filePath)) return [];

    // Simple reading approach for now. 
    // For large logs, we should read from end, but for local desktop app, reading whole file is usually fine.
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n');
        return lines.slice(-limit).map(line => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean).reverse();
    } catch (e) {
        return [];
    }
}

export async function getActivityLogs(limit: number = 50) {
    return readLogFile('combined.log', limit);
}

export async function getAppErrors(limit: number = 50) {
    return readLogFile('error.log', limit);
}
