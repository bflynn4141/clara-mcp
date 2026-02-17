/**
 * Tests for ClaraIdentityCache.
 *
 * Covers name/wallet/inbox resolution, normalization, seeding
 * from ENS directory, and edge cases.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClaraIdentityCache } from '../../xmtp/identity.js';

describe('ClaraIdentityCache', () => {
  let cache: ClaraIdentityCache;

  beforeEach(() => {
    cache = new ClaraIdentityCache();
  });

  describe('add + resolve', () => {
    it('resolves by name', () => {
      cache.add({ claraName: 'brian', walletAddress: '0xAbCd1234567890abcdef1234567890abcdef1234' });
      const entry = cache.resolveName('brian');
      expect(entry).toBeDefined();
      expect(entry!.walletAddress).toBe('0xabcd1234567890abcdef1234567890abcdef1234');
    });

    it('resolves by wallet address', () => {
      cache.add({ claraName: 'alice', walletAddress: '0x1234567890123456789012345678901234567890' });
      const entry = cache.resolveWallet('0x1234567890123456789012345678901234567890');
      expect(entry).toBeDefined();
      expect(entry!.claraName).toBe('alice');
    });

    it('resolves by inbox ID', () => {
      cache.add({
        claraName: 'bob',
        walletAddress: '0x1111111111111111111111111111111111111111',
        inboxId: 'inbox-bob-123',
      });
      const entry = cache.resolveInboxId('inbox-bob-123');
      expect(entry).toBeDefined();
      expect(entry!.claraName).toBe('bob');
    });

    it('handles null claraName', () => {
      cache.add({ claraName: null, walletAddress: '0xAAAABBBBCCCCDDDDEEEE1111222233334444AAAA' });
      const entry = cache.resolveWallet('0xaaaabbbbccccddddeeeE1111222233334444aaaa');
      expect(entry).toBeDefined();
      expect(entry!.claraName).toBeNull();
      // No name → should not be findable by name
      expect(cache.resolveName('')).toBeUndefined();
    });
  });

  describe('normalization', () => {
    it('lowercases wallet addresses', () => {
      cache.add({ claraName: 'test', walletAddress: '0xAbCdEf1234567890ABCDEF1234567890AbCdEf12' });
      expect(cache.resolveWallet('0xabcdef1234567890abcdef1234567890abcdef12')).toBeDefined();
      expect(cache.resolveWallet('0xABCDEF1234567890ABCDEF1234567890ABCDEF12')).toBeDefined();
    });

    it('lowercases names', () => {
      cache.add({ claraName: 'Brian', walletAddress: '0x0000000000000000000000000000000000000001' });
      expect(cache.resolveName('brian')).toBeDefined();
      expect(cache.resolveName('BRIAN')).toBeDefined();
    });

    it('strips .claraid.eth suffix from name queries', () => {
      cache.add({ claraName: 'alice', walletAddress: '0x0000000000000000000000000000000000000002' });
      expect(cache.resolveName('alice.claraid.eth')).toBeDefined();
    });

    it('strips @ prefix from name queries', () => {
      cache.add({ claraName: 'bob', walletAddress: '0x0000000000000000000000000000000000000003' });
      expect(cache.resolveName('@bob')).toBeDefined();
    });

    it('strips both @ prefix and .claraid.eth suffix', () => {
      cache.add({ claraName: 'charlie', walletAddress: '0x0000000000000000000000000000000000000004' });
      // @ gets stripped first, then .claraid.eth
      expect(cache.resolveName('charlie.claraid.eth')).toBeDefined();
    });
  });

  describe('setInboxId', () => {
    it('updates existing entry with inbox ID', () => {
      cache.add({ claraName: 'dan', walletAddress: '0x0000000000000000000000000000000000000005' });
      cache.setInboxId('0x0000000000000000000000000000000000000005', 'inbox-dan');
      const entry = cache.resolveInboxId('inbox-dan');
      expect(entry).toBeDefined();
      expect(entry!.claraName).toBe('dan');
    });

    it('no-ops for unknown wallet address', () => {
      cache.setInboxId('0x0000000000000000000000000000000000000099', 'inbox-unknown');
      expect(cache.resolveInboxId('inbox-unknown')).toBeUndefined();
    });
  });

  describe('getSenderName', () => {
    it('returns clara name when known', () => {
      cache.add({
        claraName: 'eve',
        walletAddress: '0x0000000000000000000000000000000000000006',
        inboxId: 'inbox-eve',
      });
      expect(cache.getSenderName('inbox-eve')).toBe('eve');
    });

    it('returns truncated inbox ID when unknown', () => {
      const longId = 'abcdef1234567890abcdef1234567890';
      expect(cache.getSenderName(longId)).toBe('abcdef...7890');
    });

    it('returns short inbox IDs as-is', () => {
      expect(cache.getSenderName('short')).toBe('short');
      expect(cache.getSenderName('exactly12ch')).toBe('exactly12ch');
    });
  });

  describe('size + all + clear', () => {
    it('tracks size correctly', () => {
      expect(cache.size).toBe(0);
      cache.add({ claraName: 'a', walletAddress: '0x0000000000000000000000000000000000000001' });
      cache.add({ claraName: 'b', walletAddress: '0x0000000000000000000000000000000000000002' });
      expect(cache.size).toBe(2);
    });

    it('all() returns all entries', () => {
      cache.add({ claraName: 'x', walletAddress: '0x0000000000000000000000000000000000000010' });
      cache.add({ claraName: 'y', walletAddress: '0x0000000000000000000000000000000000000020' });
      expect(cache.all()).toHaveLength(2);
    });

    it('clear() empties all maps', () => {
      cache.add({
        claraName: 'z',
        walletAddress: '0x0000000000000000000000000000000000000030',
        inboxId: 'inbox-z',
      });
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.resolveName('z')).toBeUndefined();
      expect(cache.resolveWallet('0x0000000000000000000000000000000000000030')).toBeUndefined();
      expect(cache.resolveInboxId('inbox-z')).toBeUndefined();
    });
  });

  describe('seedFromDirectory', () => {
    it('populates cache from proxy ENS directory', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          names: [
            { name: 'alice', address: '0x1111111111111111111111111111111111111111' },
            { name: 'bob', address: '0x2222222222222222222222222222222222222222' },
          ],
        }),
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      await cache.seedFromDirectory('https://proxy.example.com');

      expect(cache.size).toBe(2);
      expect(cache.resolveName('alice')?.walletAddress).toBe('0x1111111111111111111111111111111111111111');
      expect(cache.resolveName('bob')?.walletAddress).toBe('0x2222222222222222222222222222222222222222');

      vi.unstubAllGlobals();
    });

    it('silently handles network errors', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

      // Should not throw
      await cache.seedFromDirectory('https://proxy.example.com');
      expect(cache.size).toBe(0);

      vi.unstubAllGlobals();
    });

    it('silently handles non-ok responses', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      await cache.seedFromDirectory('https://proxy.example.com');
      expect(cache.size).toBe(0);

      vi.unstubAllGlobals();
    });

    it('handles empty names array', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ names: [] }),
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      await cache.seedFromDirectory('https://proxy.example.com');
      expect(cache.size).toBe(0);

      vi.unstubAllGlobals();
    });
  });
});
