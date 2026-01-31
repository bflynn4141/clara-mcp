/**
 * Tests for wallet management tools
 *
 * Tests wallet_setup, wallet_status, and wallet_logout tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setupToolDefinition,
  statusToolDefinition,
  logoutToolDefinition,
  handleWalletToolRequest,
} from '../../tools/wallet.js';

// Mock the para client
vi.mock('../../para/client.js', () => ({
  setupWallet: vi.fn(),
  getWalletStatus: vi.fn(),
  logout: vi.fn(),
}));

// Mock spending storage
vi.mock('../../storage/spending.js', () => ({
  formatSpendingSummary: vi.fn(() => 'Per-operation: $0.10 max | Daily: $1.00 max'),
}));

import { setupWallet, getWalletStatus, logout } from '../../para/client.js';

describe('Wallet Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definitions', () => {
    it('wallet_setup has correct schema', () => {
      expect(setupToolDefinition.name).toBe('wallet_setup');
      expect(setupToolDefinition.description).toContain('Initialize');
      expect(setupToolDefinition.inputSchema.type).toBe('object');
      expect(setupToolDefinition.inputSchema.properties).toHaveProperty('email');
    });

    it('wallet_status has correct schema', () => {
      expect(statusToolDefinition.name).toBe('wallet_status');
      expect(statusToolDefinition.description).toContain('status');
      expect(statusToolDefinition.inputSchema.type).toBe('object');
    });

    it('wallet_logout has correct schema', () => {
      expect(logoutToolDefinition.name).toBe('wallet_logout');
      expect(logoutToolDefinition.description).toContain('Clear');
      expect(logoutToolDefinition.inputSchema.type).toBe('object');
    });
  });

  describe('handleWalletToolRequest', () => {
    it('returns null for unknown tool names', async () => {
      const result = await handleWalletToolRequest('unknown_tool', {});
      expect(result).toBeNull();
    });

    describe('wallet_setup', () => {
      it('handles successful setup without email', async () => {
        vi.mocked(setupWallet).mockResolvedValue({
          address: '0x1234567890123456789012345678901234567890',
          isNew: true,
        });

        const result = await handleWalletToolRequest('wallet_setup', {});

        expect(result).not.toBeNull();
        expect(result?.isError).toBeUndefined();
        expect(result?.content[0].text).toContain('Wallet created');
        expect(result?.content[0].text).toContain('0x1234567890123456789012345678901234567890');
      });

      it('handles successful setup with email', async () => {
        vi.mocked(setupWallet).mockResolvedValue({
          address: '0x1234567890123456789012345678901234567890',
          email: 'test@example.com',
          isNew: true,
        });

        const result = await handleWalletToolRequest('wallet_setup', { email: 'test@example.com' });

        expect(result?.content[0].text).toContain('Portable wallet');
        expect(result?.content[0].text).toContain('test@example.com');
      });

      it('handles existing wallet', async () => {
        vi.mocked(setupWallet).mockResolvedValue({
          address: '0x1234567890123456789012345678901234567890',
          isNew: false,
        });

        const result = await handleWalletToolRequest('wallet_setup', {});

        expect(result?.content[0].text).toContain('Wallet ready');
      });

      it('handles setup errors', async () => {
        vi.mocked(setupWallet).mockRejectedValue(new Error('API error'));

        const result = await handleWalletToolRequest('wallet_setup', {});

        expect(result?.isError).toBe(true);
        expect(result?.content[0].text).toContain('Setup failed');
        expect(result?.content[0].text).toContain('API error');
      });
    });

    describe('wallet_status', () => {
      it('handles authenticated wallet', async () => {
        vi.mocked(getWalletStatus).mockResolvedValue({
          authenticated: true,
          address: '0x1234567890123456789012345678901234567890',
          email: 'test@example.com',
          sessionAge: '2 hours',
          chains: ['base', 'ethereum'],
        });

        const result = await handleWalletToolRequest('wallet_status', {});

        expect(result?.isError).toBeUndefined();
        expect(result?.content[0].text).toContain('Wallet Active');
        expect(result?.content[0].text).toContain('0x1234567890123456789012345678901234567890');
        expect(result?.content[0].text).toContain('test@example.com');
        expect(result?.content[0].text).toContain('2 hours');
      });

      it('handles unauthenticated state', async () => {
        vi.mocked(getWalletStatus).mockResolvedValue({
          authenticated: false,
        });

        const result = await handleWalletToolRequest('wallet_status', {});

        expect(result?.content[0].text).toContain('No wallet configured');
        expect(result?.content[0].text).toContain('wallet_setup');
      });

      it('handles status errors', async () => {
        vi.mocked(getWalletStatus).mockRejectedValue(new Error('Network error'));

        const result = await handleWalletToolRequest('wallet_status', {});

        expect(result?.isError).toBe(true);
        expect(result?.content[0].text).toContain('Network error');
      });
    });

    describe('wallet_logout', () => {
      it('handles successful logout', async () => {
        vi.mocked(logout).mockResolvedValue(undefined);

        const result = await handleWalletToolRequest('wallet_logout', {});

        expect(result?.isError).toBeUndefined();
        expect(result?.content[0].text).toContain('Logged out');
      });

      it('handles logout errors', async () => {
        vi.mocked(logout).mockRejectedValue(new Error('Session error'));

        const result = await handleWalletToolRequest('wallet_logout', {});

        expect(result?.isError).toBe(true);
        expect(result?.content[0].text).toContain('Session error');
      });
    });
  });
});
