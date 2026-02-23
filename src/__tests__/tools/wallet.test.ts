/**
 * Tests for wallet reauth tool
 *
 * Tests wallet_reauth — the narrow MCP tool that refreshes expired sessions.
 * Full setup/session tests are covered by CLI integration tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  reauthToolDefinition,
  handleReauthRequest,
} from '../../tools/wallet.js';

// Mock the para client
vi.mock('../../para/client.js', () => ({
  reauthWallet: vi.fn(),
}));

import { reauthWallet } from '../../para/client.js';

describe('Wallet Reauth Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('wallet_reauth has correct schema', () => {
      expect(reauthToolDefinition.name).toBe('wallet_reauth');
      expect(reauthToolDefinition.description).toContain('Refresh');
      expect(reauthToolDefinition.inputSchema.type).toBe('object');
      // No input parameters — zero-param tool
      expect(Object.keys(reauthToolDefinition.inputSchema.properties)).toHaveLength(0);
    });
  });

  describe('handleReauthRequest', () => {
    it('returns wallet info when session is valid', async () => {
      vi.mocked(reauthWallet).mockResolvedValue({
        isNew: false,
        address: '0x1234567890123456789012345678901234567890',
        email: 'test@example.com',
      });

      const result = await handleReauthRequest({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Wallet ready');
      expect(result.content[0].text).toContain('0x1234567890123456789012345678901234567890');
      expect(result.content[0].text).toContain('test@example.com');
    });

    it('returns wallet info without email for device-only wallets', async () => {
      vi.mocked(reauthWallet).mockResolvedValue({
        isNew: false,
        address: '0x1234567890123456789012345678901234567890',
      });

      const result = await handleReauthRequest({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Wallet ready');
      expect(result.content[0].text).not.toContain('Email');
    });

    it('directs to CLI setup when no wallet configured', async () => {
      vi.mocked(reauthWallet).mockRejectedValue(
        new Error('No wallet configured. Run `clara-mcp setup` to create one.')
      );

      const result = await handleReauthRequest({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No wallet configured');
      expect(result.content[0].text).toContain('clara-mcp setup');
    });

    it('handles re-auth errors', async () => {
      vi.mocked(reauthWallet).mockRejectedValue(new Error('Network error'));

      const result = await handleReauthRequest({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Re-auth failed');
      expect(result.content[0].text).toContain('Network error');
    });
  });
});
