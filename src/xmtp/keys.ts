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

import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

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

  // Try reading existing key
  if (existsSync(keyPath)) {
    const keyHex = (await readFile(keyPath, 'utf-8')).trim();
    if (HEX_64_RE.test(keyHex)) {
      return new Uint8Array(Buffer.from(keyHex, 'hex'));
    }
    // Key is corrupt or wrong length — regenerate
  }

  // Atomic create: open with 'wx' flag fails if file already exists,
  // preventing races where two concurrent calls both generate keys.
  const key = randomBytes(KEY_SIZE);
  const keyHex = key.toString('hex');
  try {
    const fh = await open(keyPath, 'wx', 0o600);
    await fh.writeFile(keyHex);
    await fh.close();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another call won the race — read their key
      const existingHex = (await readFile(keyPath, 'utf-8')).trim();
      if (HEX_64_RE.test(existingHex)) {
        return new Uint8Array(Buffer.from(existingHex, 'hex'));
      }
    }
    throw err;
  }
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
