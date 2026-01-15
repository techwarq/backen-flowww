
import fs from 'fs-extra';
import path from 'path';
import { DATA_DIR } from './config.js';

const USERS_FILE = path.join(DATA_DIR, 'users.json');

export interface AdminUser {
    username: string;
    role: 'admin' | 'staff';
    allowedAccounts: number;
    createdAt: string;
}

export async function getUsers(): Promise<AdminUser[]> {
    try {
        if (await fs.pathExists(USERS_FILE)) {
            return await fs.readJSON(USERS_FILE);
        }
    } catch (e) {
        console.error('Failed to read users', e);
    }
    return [];
}

export async function upsertUser(user: AdminUser): Promise<AdminUser> {
    const users = await getUsers();
    const index = users.findIndex(u => u.username === user.username);
    if (index >= 0) {
        users[index] = { ...users[index], ...user };
    } else {
        users.push(user);
    }
    await fs.ensureDir(DATA_DIR);
    await fs.writeJSON(USERS_FILE, users, { spaces: 2 });
    return user;
}

export async function deleteUser(username: string): Promise<boolean> {
    let users = await getUsers();
    const initialLen = users.length;
    users = users.filter(u => u.username !== username);
    if (users.length !== initialLen) {
        await fs.writeJSON(USERS_FILE, users, { spaces: 2 });
        return true;
    }
    return false;
}
