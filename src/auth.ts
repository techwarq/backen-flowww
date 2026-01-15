import fs from 'fs-extra';
import path from 'path';
import { DATA_DIR } from './config.js';
import crypto from 'crypto';

const USERS_FILE = path.join(DATA_DIR, 'users.json');

export type UserRole = 'admin' | 'staff';

export interface User {
    username: string;
    passwordHash: string; // Simple SHA256 for local prototype
    role: UserRole;
    allowedAccounts: number; // e.g. 5
    createdAt: number;
}

export interface AuthSession {
    username: string;
    role: UserRole;
    allowedAccounts: number;
    loginTime: number;
}

// Ensure at least one admin exists
export async function initAuth() {
    if (!await fs.pathExists(USERS_FILE)) {
        // Create default admin
        const salt = 'fsa_local_salt'; // In prod, unique salt per user
        const defaultAdmin: User = {
            username: 'admin',
            // Default password 'admin123' -> hash
            passwordHash: crypto.createHash('sha256').update('admin123' + salt).digest('hex'),
            role: 'admin',
            allowedAccounts: 9999,
            createdAt: Date.now()
        };
        await fs.writeJSON(USERS_FILE, { users: [defaultAdmin] }, { spaces: 2 });
    }
}

export async function loginUser(username: string, password: string): Promise<{ success: boolean; session?: AuthSession; message?: string }> {
    await initAuth();
    const data = await fs.readJSON(USERS_FILE);
    const user = data.users.find((u: User) => u.username === username);

    if (!user) return { success: false, message: 'User not found' };

    const salt = 'fsa_local_salt';
    const hash = crypto.createHash('sha256').update(password + salt).digest('hex');

    if (hash === user.passwordHash) {
        return {
            success: true,
            session: {
                username: user.username,
                role: user.role,
                allowedAccounts: user.allowedAccounts || 5,
                loginTime: Date.now()
            }
        };
    } else {
        return { success: false, message: 'Invalid password' };
    }
}

export async function createUser(adminUsername: string, newUser: Partial<User>) {
    const data = await fs.readJSON(USERS_FILE);
    const admin = data.users.find((u: User) => u.username === adminUsername);

    if (!admin || admin.role !== 'admin') {
        throw new Error('Unauthorized: Only admin can create users');
    }

    if (data.users.find((u: User) => u.username === newUser.username)) {
        throw new Error('Username already exists');
    }

    const salt = 'fsa_local_salt';
    if (!newUser.passwordHash && (newUser as any)['password']) {
        newUser.passwordHash = crypto.createHash('sha256').update((newUser as any)['password'] + salt).digest('hex');
    }

    const user: User = {
        username: newUser.username!,
        passwordHash: newUser.passwordHash!,
        role: newUser.role || 'staff',
        allowedAccounts: newUser.allowedAccounts || 5,
        createdAt: Date.now()
    };

    data.users.push(user);
    await fs.writeJSON(USERS_FILE, data, { spaces: 2 });
    return user;
}

export async function getUsers() {
    await initAuth();
    const data = await fs.readJSON(USERS_FILE);
    return data.users.map((u: User) => ({ ...u, passwordHash: '***' }));
}
