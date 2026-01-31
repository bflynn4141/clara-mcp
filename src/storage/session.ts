/**
 * Session Storage
 *
 * Manages encrypted wallet session persistence.
 * Sessions are stored locally and encrypted with AES-256-GCM.
 *
 * Storage: ~/.clara/session.enc
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const CLARA_DIR = join(homedir(), '.clara');
const SESSION_FILE = join(CLARA_DIR, 'session.enc');
const ALGORITHM = 'aes-256-gcm';

/**
 * Session data structure
 */
export interface WalletSession {
  authenticated: boolean;
  walletId: string;
  address: string;
  email?: string;
  chains?: string[];
  createdAt: string;
  lastActiveAt: string;
}

/**
 * Get encryption key from machine-specific data
 * Uses scrypt to derive a key from machine identifier
 */
function getEncryptionKey(): Buffer {
  // Use a combination of home dir and username as salt
  const salt = `${homedir()}-${process.env.USER || 'clara'}`;
  // Derive key using scrypt (CPU-intensive, resistant to brute force)
  return scryptSync('clara-wallet-session', salt, 32);
}

/**
 * Ensure the Clara config directory exists
 */
function ensureDir(): void {
  if (!existsSync(CLARA_DIR)) {
    mkdirSync(CLARA_DIR, { recursive: true });
  }
}

/**
 * Encrypt session data
 */
function encrypt(data: WalletSession): Buffer {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  
  const json = JSON.stringify(data);
  const encrypted = Buffer.concat([
    cipher.update(json, 'utf8'),
    cipher.final()
  ]);
  
  const authTag = cipher.getAuthTag();
  
  // Format: IV (16 bytes) + Auth Tag (16 bytes) + Encrypted Data
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt session data
 */
function decrypt(buffer: Buffer): WalletSession | null {
  try {
    const key = getEncryptionKey();
    
    // Extract components
    const iv = buffer.subarray(0, 16);
    const authTag = buffer.subarray(16, 32);
    const encrypted = buffer.subarray(32);
    
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    return JSON.parse(decrypted.toString('utf8')) as WalletSession;
  } catch (error) {
    console.error('Failed to decrypt session:', error);
    return null;
  }
}

/**
 * Get the current session
 * Returns null if no session exists or session is invalid
 */
export async function getSession(): Promise<WalletSession | null> {
  ensureDir();
  
  if (!existsSync(SESSION_FILE)) {
    return null;
  }
  
  try {
    const encrypted = readFileSync(SESSION_FILE);
    const session = decrypt(encrypted);
    
    if (!session) {
      return null;
    }
    
    // Check session expiry (7 days of inactivity)
    const lastActive = new Date(session.lastActiveAt);
    const now = new Date();
    const daysSinceActive = (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24);
    
    if (daysSinceActive > 7) {
      console.error('Session expired after 7 days of inactivity');
      await clearSession();
      return null;
    }
    
    // Update last active time
    session.lastActiveAt = now.toISOString();
    await saveSession(session);
    
    return session;
  } catch (error) {
    console.error('Failed to read session:', error);
    return null;
  }
}

/**
 * Save session to encrypted storage
 */
export async function saveSession(session: WalletSession): Promise<void> {
  ensureDir();
  const encrypted = encrypt(session);
  writeFileSync(SESSION_FILE, encrypted);
}

/**
 * Clear the current session
 */
export async function clearSession(): Promise<void> {
  if (existsSync(SESSION_FILE)) {
    unlinkSync(SESSION_FILE);
  }
}

/**
 * Check if a session exists
 */
export function hasSession(): boolean {
  return existsSync(SESSION_FILE);
}
