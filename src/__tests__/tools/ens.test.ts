/**
 * Tests for ENS resolution tool
 *
 * Tests wallet_resolve_ens tool with mocked ENS responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensToolDefinition, handleEnsRequest } from '../../tools/ens.js';

// Mock viem
vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getEnsAddress: vi.fn(),
      getEnsName: vi.fn(),
      getEnsAvatar: vi.fn(),
      getEnsText: vi.fn(),
    })),
  };
});

// Mock viem/ens
vi.mock('viem/ens', () => ({
  normalize: vi.fn((name: string) => name.toLowerCase()),
}));

import { createPublicClient } from 'viem';

describe('ENS Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(ensToolDefinition.name).toBe('wallet_resolve_ens');
      expect(ensToolDefinition.description).toContain('ENS');
      expect(ensToolDefinition.description).toContain('Resolve');
    });

    it('has name and address properties', () => {
      const props = ensToolDefinition.inputSchema.properties;
      expect(props).toHaveProperty('name');
      expect(props).toHaveProperty('address');
      expect(props.name.description).toContain('vitalik.eth');
    });

    it('has no required fields (either name or address works)', () => {
      expect(ensToolDefinition.inputSchema.required).toEqual([]);
    });
  });

  describe('handleEnsRequest - Input Validation', () => {
    it('requires either name or address', async () => {
      const result = await handleEnsRequest({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Either `name` or `address` is required');
    });

    it('validates address format', async () => {
      const mockClient = {
        getEnsAddress: vi.fn(),
        getEnsName: vi.fn(),
        getEnsAvatar: vi.fn(),
        getEnsText: vi.fn(),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleEnsRequest({ address: 'invalid-address' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid address format');
    });

    it('validates address length', async () => {
      const mockClient = {
        getEnsAddress: vi.fn(),
        getEnsName: vi.fn(),
        getEnsAvatar: vi.fn(),
        getEnsText: vi.fn(),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleEnsRequest({ address: '0x123' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid address format');
    });
  });

  describe('handleEnsRequest - Forward Resolution (name -> address)', () => {
    it('resolves ENS name to address', async () => {
      const mockClient = {
        getEnsAddress: vi.fn().mockResolvedValue('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'),
        getEnsName: vi.fn(),
        getEnsAvatar: vi.fn().mockResolvedValue(null),
        getEnsText: vi.fn().mockResolvedValue(null),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleEnsRequest({ name: 'vitalik.eth' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('ENS Resolution');
      expect(result.content[0].text).toContain('vitalik.eth');
      expect(result.content[0].text).toContain('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    });

    it('handles unregistered ENS name', async () => {
      const mockClient = {
        getEnsAddress: vi.fn().mockResolvedValue(null),
        getEnsName: vi.fn(),
        getEnsAvatar: vi.fn(),
        getEnsText: vi.fn(),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleEnsRequest({ name: 'unregistered-name-12345.eth' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('includes additional records when available', async () => {
      const mockClient = {
        getEnsAddress: vi.fn().mockResolvedValue('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'),
        getEnsName: vi.fn(),
        getEnsAvatar: vi.fn().mockResolvedValue('https://example.com/avatar.png'),
        getEnsText: vi.fn().mockImplementation(async ({ key }) => {
          if (key === 'description') return 'Ethereum founder';
          if (key === 'com.twitter') return 'VitalikButerin';
          if (key === 'url') return 'https://vitalik.eth.limo';
          return null;
        }),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleEnsRequest({ name: 'vitalik.eth' });

      expect(result.content[0].text).toContain('Records');
      expect(result.content[0].text).toContain('Avatar');
      expect(result.content[0].text).toContain('Description');
      expect(result.content[0].text).toContain('Twitter');
      expect(result.content[0].text).toContain('URL');
    });
  });

  describe('handleEnsRequest - Reverse Resolution (address -> name)', () => {
    it('resolves address to ENS name', async () => {
      const mockClient = {
        getEnsAddress: vi.fn(),
        getEnsName: vi.fn().mockResolvedValue('vitalik.eth'),
        getEnsAvatar: vi.fn().mockResolvedValue(null),
        getEnsText: vi.fn(),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleEnsRequest({
        address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Reverse Lookup');
      expect(result.content[0].text).toContain('vitalik.eth');
    });

    it('handles address with no ENS name', async () => {
      const mockClient = {
        getEnsAddress: vi.fn(),
        getEnsName: vi.fn().mockResolvedValue(null),
        getEnsAvatar: vi.fn(),
        getEnsText: vi.fn(),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleEnsRequest({
        address: '0x1234567890123456789012345678901234567890',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Not set');
      expect(result.content[0].text).toContain('no primary ENS name');
    });
  });

  describe('handleEnsRequest - Error Handling', () => {
    it('handles RPC errors gracefully', async () => {
      const mockClient = {
        getEnsAddress: vi.fn().mockRejectedValue(new Error('RPC timeout')),
        getEnsName: vi.fn(),
        getEnsAvatar: vi.fn(),
        getEnsText: vi.fn(),
      };
      vi.mocked(createPublicClient).mockReturnValue(mockClient as any);

      const result = await handleEnsRequest({ name: 'vitalik.eth' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ENS resolution failed');
      expect(result.content[0].text).toContain('RPC timeout');
    });
  });
});
