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

  await fs.mkdir(storageDir, { recursive: true });

  try {
    const keyData = await fs.readFile(keyFile);
    encryptionKey = keyData;
    return encryptionKey;
  } catch {
    // Generate new key
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
 * Get current wallet session
 *
 * Returns cached session if available, otherwise reads from disk.
 * Returns null if no session exists or decryption fails.
 */
export async function getSession(): Promise<WalletSession | null> {
  if (cachedSession) {
    return cachedSession;
  }

  try {
    const sessionFile = getSessionFile();
    const encryptedData = await fs.readFile(sessionFile);
    const decrypted = await decrypt(encryptedData);
    cachedSession = JSON.parse(decrypted);
    return cachedSession;
  } catch {
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

  await fs.mkdir(storageDir, { recursive: true });

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
  } catch {
    // File doesn't exist, that's fine
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
