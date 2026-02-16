/**
 * Tests for XMTP key management.
 *
 * Covers key generation, persistence, corruption recovery,
 * path construction, and initialization detection.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { join } from 'path';

// Mock fs operations to avoid touching real filesystem
const mockExistsSync = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

vi.mock('node:os', () => ({
  homedir: () => '/mock-home',
}));

import { getXmtpPaths, getOrCreateEncryptionKey, isXmtpInitialized } from '../../xmtp/keys.js';

describe('XMTP Key Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  describe('getXmtpPaths', () => {
    it('returns key and db paths for a wallet address', () => {
      const paths = getXmtpPaths('0xAbCd1234567890abcdef1234567890abcdef1234');
      expect(paths.keyPath).toBe(join('/mock-home', '.clara', 'xmtp', '0xabcd1234567890abcdef1234567890abcdef1234.key'));
      expect(paths.dbPath).toBe(join('/mock-home', '.clara', 'xmtp', '0xabcd1234567890abcdef1234567890abcdef1234.db3'));
    });

    it('lowercases the address', () => {
      const paths = getXmtpPaths('0xABCDEF');
      expect(paths.keyPath).toContain('0xabcdef');
    });
  });

  describe('getOrCreateEncryptionKey', () => {
    it('generates a new 32-byte key when none exists', async () => {
      mockExistsSync.mockReturnValue(false);

      const key = await getOrCreateEncryptionKey('0x0000000000000000000000000000000000000001');

      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
      expect(mockWriteFile).toHaveBeenCalledOnce();
      // Verify permissions
      expect(mockWriteFile.mock.calls[0][2]).toEqual({ mode: 0o600 });
    });

    it('reads existing key from file', async () => {
      const testKey = Buffer.from('a'.repeat(64), 'hex'); // 32 bytes
      mockExistsSync.mockImplementation((path: string) => {
        if (path.endsWith('.key')) return true;
        return path.includes('.clara/xmtp'); // directory exists
      });
      mockReadFile.mockResolvedValue('a'.repeat(64));

      const key = await getOrCreateEncryptionKey('0x0000000000000000000000000000000000000001');

      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
      expect(Buffer.from(key).toString('hex')).toBe('a'.repeat(64));
      // Should NOT write a new key
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('regenerates key if existing key is corrupt (wrong length)', async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.endsWith('.key')) return true;
        return path.includes('.clara/xmtp');
      });
      mockReadFile.mockResolvedValue('tooshort');

      const key = await getOrCreateEncryptionKey('0x0000000000000000000000000000000000000001');

      expect(key.length).toBe(32);
      // Should write a new key since the old one was corrupt
      expect(mockWriteFile).toHaveBeenCalledOnce();
    });

    it('trims whitespace from key file', async () => {
      const hexKey = 'b'.repeat(64);
      mockExistsSync.mockImplementation((path: string) => {
        if (path.endsWith('.key')) return true;
        return path.includes('.clara/xmtp');
      });
      mockReadFile.mockResolvedValue(hexKey + '\n');

      const key = await getOrCreateEncryptionKey('0x0000000000000000000000000000000000000001');
      expect(Buffer.from(key).toString('hex')).toBe(hexKey);
    });

    it('creates directory with 0o700 permissions', async () => {
      mockExistsSync.mockReturnValue(false);

      await getOrCreateEncryptionKey('0x0000000000000000000000000000000000000001');

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining('.clara/xmtp'),
        expect.objectContaining({ recursive: true, mode: 0o700 }),
      );
    });

    it('uses custom db path when provided', async () => {
      mockExistsSync.mockReturnValue(false);

      await getOrCreateEncryptionKey('0x0000000000000000000000000000000000000001', '/custom/path/wallet.db3');

      // Key path should be derived from custom db path
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/custom/path/wallet.key',
        expect.any(String),
        expect.any(Object),
      );
    });

    it('handles custom path without .db3 extension', async () => {
      mockExistsSync.mockReturnValue(false);

      await getOrCreateEncryptionKey('0x0000000000000000000000000000000000000001', '/custom/path/wallet');

      // Should append .key
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/custom/path/wallet.key',
        expect.any(String),
        expect.any(Object),
      );
    });
  });

  describe('isXmtpInitialized', () => {
    it('returns true when both key and db files exist', () => {
      mockExistsSync.mockReturnValue(true);
      expect(isXmtpInitialized('0x0000000000000000000000000000000000000001')).toBe(true);
    });

    it('returns false when key file is missing', () => {
      mockExistsSync.mockImplementation((path: string) => !path.endsWith('.key'));
      expect(isXmtpInitialized('0x0000000000000000000000000000000000000001')).toBe(false);
    });

    it('returns false when db file is missing', () => {
      mockExistsSync.mockImplementation((path: string) => !path.endsWith('.db3'));
      expect(isXmtpInitialized('0x0000000000000000000000000000000000000001')).toBe(false);
    });

    it('returns false when both files are missing', () => {
      mockExistsSync.mockReturnValue(false);
      expect(isXmtpInitialized('0x0000000000000000000000000000000000000001')).toBe(false);
    });
  });
});
