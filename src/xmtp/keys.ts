/**
 * XMTP Key Manager
 *
 * Manages the local database encryption keys used by the XMTP SDK.
 * Each wallet address gets its own encryption key stored at:
 *   ~/.clara/xmtp/{address}.key
 *
 * The XMTP SDK requires a 32-byte encryption key for its local SQLite
 * database. This key is generated once per wallet and persisted locally.
 *
 * Ported from Glorp's @glorp/xmtp package with path changes only.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const XMTP_DIR = join(homedir(), '.clara', 'xmtp');
const KEY_SIZE = 32; // 256-bit encryption key

async function ensureXmtpDir(): Promise<void> {
  if (!existsSync(XMTP_DIR)) {
    await mkdir(XMTP_DIR, { recursive: true, mode: 0o700 });
  }
}

export function getXmtpPaths(walletAddress: string): {
  keyPath: string;
  dbPath: string;
} {
  const addr = walletAddress.toLowerCase();
  return {
    keyPath: join(XMTP_DIR, `${addr}.key`),
    dbPath: join(XMTP_DIR, `${addr}.db3`),
  };
}

/**
 * Get or create the database encryption key for a wallet.
 * Generates a new 32-byte random key on first use, then
 * persists it for subsequent client sessions.
 *
 * When customDbPath is provided, the key is co-located next to the DB
 * for containerized deployments where home is ephemeral.
 */
export async function getOrCreateEncryptionKey(
  walletAddress: string,
  customDbPath?: string,
): Promise<Uint8Array> {
  let keyPath: string;

  if (customDbPath) {
    keyPath = customDbPath.replace(/\.db3$/, '.key');
    if (keyPath === customDbPath) keyPath = customDbPath + '.key';
    const dir = keyPath.substring(0, keyPath.lastIndexOf('/'));
    if (dir && !existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
  } else {
    await ensureXmtpDir();
    keyPath = getXmtpPaths(walletAddress).keyPath;
  }

  if (existsSync(keyPath)) {
    const keyHex = await readFile(keyPath, 'utf-8');
    const key = Buffer.from(keyHex.trim(), 'hex');
    if (key.length === KEY_SIZE) {
      return new Uint8Array(key);
    }
    // Key is corrupt — regenerate
  }

  const key = randomBytes(KEY_SIZE);
  await writeFile(keyPath, key.toString('hex'), { mode: 0o600 });
  return new Uint8Array(key);
}

/**
 * Check if XMTP is already initialized for a wallet address.
 * Returns true if both the key and database files exist.
 */
export function isXmtpInitialized(walletAddress: string): boolean {
  const { keyPath, dbPath } = getXmtpPaths(walletAddress);
  return existsSync(keyPath) && existsSync(dbPath);
}
