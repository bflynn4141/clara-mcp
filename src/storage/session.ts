/**
 * Encrypted Session Storage for Clara MCP
 *
 * Persists wallet session data to ~/.clara/session.enc
 * Uses AES-256-GCM encryption with a locally-generated key.
 *
 * Session data includes:
 * - Authentication state
 * - Wallet ID (required for Para API signing)
 * - Wallet address
 * - Last active timestamp (for 7-day expiry)
 *
 * Ported from para-wallet with simplifications for clara-mcp.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { randomUUID } from 'node:crypto';

/**
 * Clara wallet session data
 *
 * Stores the essential data needed for wallet operations:
 * - walletId: Required for all Para API signing calls
 * - address: Used for balance checks, nonce lookups
 * - email/identifier: For portable wallet recovery
 */
export interface WalletSession {
  authenticated: boolean;
  walletId?: string;              // Para wallet ID (REQUIRED for signing)
  address?: string;               // EVM address
  email?: string;                 // Email if using email identifier (portable)
  identifierType?: 'email' | 'customId';
  identifier?: string;            // The actual identifier value
  authExpiresAt?: string;         // ISO 8601 — when Para auth expires (24h from creation)
  chains: string[];               // Supported chains
  createdAt: string;
  lastActiveAt: string;
}

// Storage paths - can be overridden via CLARA_SESSION_PATH env var
function getStorageDir(): string {
  const customPath = process.env.CLARA_SESSION_PATH;
  if (customPath) {
    return customPath;
  }
  return path.join(os.homedir(), '.clara');
}

function getSessionFile(): string {
  return path.join(getStorageDir(), 'session.enc');
}

function getKeyFile(): string {
  return path.join(getStorageDir(), '.key');
}

// In-memory cache for performance
let cachedSession: WalletSession | null = null;
let encryptionKey: Buffer | null = null;

/**
 * Get or create encryption key
 *
 * Generates a random 256-bit key on first use, stored at ~/.clara/.key
 * The key file is created with mode 0o600 (owner read/write only).
 */
async function getEncryptionKey(): Promise<Buffer> {
  if (encryptionKey) {
    return encryptionKey;
  }

  const storageDir = getStorageDir();
  const keyFile = getKeyFile();

  await fs.mkdir(storageDir, { recursive: true, mode: 0o700 });

  try {
    const keyData = await fs.readFile(keyFile);
    encryptionKey = keyData;
    return encryptionKey;
  } catch (err) {
    // Key file doesn't exist or is unreadable — generate new key
    console.error('[clara] No existing encryption key, generating new one:', err instanceof Error ? err.message : err);
    encryptionKey = crypto.randomBytes(32);
    await fs.writeFile(keyFile, encryptionKey, { mode: 0o600 });
    return encryptionKey;
  }
}

/**
 * Encrypt data using AES-256-GCM
 *
 * Format: [IV (16 bytes)] [Auth Tag (16 bytes)] [Encrypted Data]
 */
async function encrypt(data: string): Promise<Buffer> {
  const key = await getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(data, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt data using AES-256-GCM
 */
async function decrypt(data: Buffer): Promise<string> {
  const key = await getEncryptionKey();

  const iv = data.subarray(0, 16);
  const authTag = data.subarray(16, 32);
  const encrypted = data.subarray(32);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Session load status — explains WHY getSession returned null.
 * Middleware uses this to give actionable error messages.
 */
export type SessionStatus =
  | 'ok'
  | 'missing'       // No session file — fresh install
  | 'expired'       // Session older than 7 days
  | 'corrupt';      // File exists but can't be decrypted/parsed

let lastSessionStatus: SessionStatus = 'missing';

/**
 * Get the status of the last getSession() call.
 * Use this after getSession() returns null to determine WHY.
 */
export function getSessionStatus(): SessionStatus {
  return lastSessionStatus;
}

/**
 * Get current wallet session
 *
 * Returns cached session if available, otherwise reads from disk.
 * Returns null if no session exists, is expired, or is corrupt.
 * Call getSessionStatus() after a null return for the reason.
 */
export async function getSession(): Promise<WalletSession | null> {
  if (cachedSession) {
    // Check if cached session has expired (7 days of inactivity)
    if (cachedSession.authenticated && cachedSession.lastActiveAt) {
      const lastActive = new Date(cachedSession.lastActiveAt);
      const now = new Date();
      const daysSinceActive = (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceActive > 7) {
        console.error('[clara] Session expired after 7 days inactivity, clearing...');
        await clearSession();
        lastSessionStatus = 'expired';
        return null;
      }
    }
    lastSessionStatus = 'ok';
    return cachedSession;
  }

  // Check if session file exists
  const sessionFile = getSessionFile();
  try {
    await fs.access(sessionFile);
  } catch (err) {
    // File doesn't exist (normal) or permissions error (problem)
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') {
      console.error(`[clara] Session file access error (${code}):`, err instanceof Error ? err.message : err);
    }
    lastSessionStatus = 'missing';
    return null;
  }

  // File exists — try to decrypt
  try {
    const encryptedData = await fs.readFile(sessionFile);
    const decrypted = await decrypt(encryptedData);
    const session: WalletSession = JSON.parse(decrypted);

    // Check if loaded session has expired (7 days of inactivity)
    if (session.authenticated && session.lastActiveAt) {
      const lastActive = new Date(session.lastActiveAt);
      const now = new Date();
      const daysSinceActive = (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceActive > 7) {
        console.error('[clara] Session expired after 7 days inactivity, clearing...');
        await clearSession();
        lastSessionStatus = 'expired';
        return null;
      }
    }

    cachedSession = session;
    lastSessionStatus = 'ok';
    return cachedSession;
  } catch (err) {
    // File exists but can't be read/decrypted — corrupt
    console.error(`[clara] Session file corrupt or key mismatch: ${err instanceof Error ? err.message : err}`);
    console.error('[clara] Removing corrupt session — wallet_setup will restore access');
    await clearSession();
    lastSessionStatus = 'corrupt';
    return null;
  }
}

/**
 * Save wallet session
 *
 * Encrypts and persists session to disk, updates timestamps.
 */
export async function saveSession(session: WalletSession): Promise<void> {
  const storageDir = getStorageDir();
  const sessionFile = getSessionFile();

  await fs.mkdir(storageDir, { recursive: true, mode: 0o700 });

  // Update timestamps
  session.lastActiveAt = new Date().toISOString();
  if (!session.createdAt) {
    session.createdAt = session.lastActiveAt;
  }

  const encrypted = await encrypt(JSON.stringify(session));
  await fs.writeFile(sessionFile, encrypted, { mode: 0o600 });

  cachedSession = session;
}

/**
 * Update session with partial data
 *
 * Merges updates with existing session, creates new if none exists.
 */
export async function updateSession(
  updates: Partial<WalletSession>
): Promise<WalletSession> {
  const current = (await getSession()) || {
    authenticated: false,
    chains: [],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };

  const updated = { ...current, ...updates };
  await saveSession(updated);
  return updated;
}

/**
 * Clear session (logout)
 *
 * Removes both cached and persisted session data.
 */
export async function clearSession(): Promise<void> {
  cachedSession = null;

  try {
    const sessionFile = getSessionFile();
    await fs.unlink(sessionFile);
  } catch (err) {
    // File doesn't exist (fine) or permissions error (problem)
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') {
      console.error(`[clara] Failed to remove session file (${code}):`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Check if session is valid and not expired
 *
 * Sessions expire after 7 days of inactivity.
 * Expired sessions are automatically cleared.
 */
export async function isSessionValid(): Promise<boolean> {
  const session = await getSession();
  if (!session?.authenticated) {
    return false;
  }

  // Check if session is too old (7 days)
  const lastActive = new Date(session.lastActiveAt);
  const now = new Date();
  const daysSinceActive = (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceActive > 7) {
    console.error('[clara] Session expired after 7 days inactivity, clearing...');
    await clearSession();
    return false;
  }

  return true;
}

/**
 * Refresh session timestamp (extends validity)
 *
 * Call this after successful operations to prevent expiry.
 */
export async function touchSession(): Promise<void> {
  const session = await getSession();
  if (session) {
    await updateSession({ lastActiveAt: new Date().toISOString() });
  }
}

/**
 * Get the current session storage directory path
 */
export function getSessionPath(): string {
  return getStorageDir();
}

/**
 * Invalidate the in-memory cache
 *
 * Forces next getSession() to read from disk.
 */
export function invalidateCache(): void {
  cachedSession = null;
  encryptionKey = null;
}

/**
 * Get or create a stable device ID
 *
 * Generates a random UUID on first call, persists to ~/.clara/device_id.
 * Survives session loss — that's the whole point. Used as a stable
 * machine identifier for CUSTOM_ID wallets instead of hostname/username
 * (which leaks PII and collides across machines).
 */
const DEVICE_ID_FILE = 'device_id';

export async function getDeviceId(): Promise<string> {
  const deviceFile = path.join(getStorageDir(), DEVICE_ID_FILE);
  try {
    const id = await fs.readFile(deviceFile, 'utf-8');
    return id.trim();
  } catch {
    // First run — generate and persist
    const id = randomUUID();
    await fs.mkdir(getStorageDir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(deviceFile, id, { mode: 0o600 });
    return id;
  }
}
