import bcrypt from 'bcryptjs';
import { getSupabaseAdminClient } from './cloud.js';
import logger from './log.js';
import { randomUUID } from 'crypto';

export interface AuthResponse {
    success: boolean;
    session?: any;
    user?: any;
    profile?: any;
    message?: string;
}

/**
 * Sign up a new user
 * Creates a new row in the `profiles` table with bcrypt-hashed password.
 */
export async function signUpSupabase(username: string, password: string): Promise<AuthResponse> {
    const supabase = getSupabaseAdminClient();
    if (!supabase) return { success: false, message: 'Database not configured.' };

    username = username?.trim().toLowerCase() || '';
    password = password?.trim() || '';

    if (!username || !password) {
        return { success: false, message: 'Username and password are required.' };
    }
    if (password.length < 6) {
        return { success: false, message: 'Password must be at least 6 characters.' };
    }

    try {
        // Check if username already exists
        const { data: existing } = await supabase
            .from('profiles')
            .select('id')
            .eq('username', username)
            .single();

        if (existing) {
            return { success: false, message: 'Username already taken.' };
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        // Create user
        const newUser = {
            id: randomUUID(),
            username: username,
            password_hash: password_hash,
            role: 'user',
            created_at: new Date().toISOString()
        };

        const { error: insertError } = await supabase
            .from('profiles')
            .insert(newUser);

        if (insertError) throw insertError;

        logger.info(`[Auth] User created: ${username}`);

        // Auto-login after signup
        return signInSupabase(username, password);
    } catch (e: any) {
        logger.error(`[Auth] Signup failed: ${e.message}`);
        return { success: false, message: e.message };
    }
}

// Simple in-memory session store (Token -> UserProfile)
// In a multi-instance env, this should be in Redis or DB.
const sessionStore = new Map<string, any>();

/**
 * Sign in an existing user
 * Validates against `profiles` table using bcrypt.
 */
export async function signInSupabase(username: string, password: string): Promise<AuthResponse> {
    const supabase = getSupabaseAdminClient();
    if (!supabase) return { success: false, message: 'Database not configured.' };

    username = username?.trim().toLowerCase() || '';
    password = password?.trim() || '';

    if (!username || !password) {
        return { success: false, message: 'Username and password are required.' };
    }

    try {
        logger.info(`[Auth] Attempting signin for: ${username}`);

        // Fetch user from profiles
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('username', username)
            .single();

        if (error || !profile) {
            logger.warn(`[Auth] User not found: ${username}`);
            return { success: false, message: 'Invalid username or password.' };
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, profile.password_hash);
        if (!validPassword) {
            logger.warn(`[Auth] Invalid password for: ${username}`);
            return { success: false, message: 'Invalid username or password.' };
        }

        // Create a simple session token
        const sessionToken = randomUUID();

        // Store session
        const sessionUser = {
            id: profile.id,
            username: profile.username,
            role: profile.role
        };
        sessionStore.set(sessionToken, sessionUser);

        logger.info(`[Auth] Sign-in successful for: ${username}`);

        return {
            success: true,
            user: { id: profile.id, username: profile.username },
            profile: {
                id: profile.id,
                username: profile.username,
                role: profile.role
            },
            session: {
                access_token: sessionToken,
                user_id: profile.id
            },
            message: 'Sign-in successful.'
        };
    } catch (e: any) {
        logger.error(`[Auth] Sign-in failed: ${e.message}`);
        return { success: false, message: e.message };
    }
}

/**
 * Verify session using in-memory store
 */
export async function verifySession(token: string) {
    if (!token) return null;
    return sessionStore.get(token) || null;
}

/**
 * Sign out - no-op for custom auth (frontend clears token)
 */
export async function signOutSupabase() {
    // No-op - frontend handles clearing the session
}
