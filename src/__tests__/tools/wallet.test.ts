/**
 * Tests for wallet management tools
 *
 * Tests wallet_setup and wallet_session tools.
 *
 * NOTE: Wallet handlers (setup, session) do NOT use ToolContext.
 * They manage session internally because:
 * - wallet_setup runs BEFORE any session exists
 * - wallet_session status needs to report unauthenticated state
 * - wallet_session logout destroys the session
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setupToolDefinition,
  sessionToolDefinition,
  handleSetupRequest,
  handleSessionRequest,
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

// Mock session storage
vi.mock('../../storage/session.js', () => ({
  getSession: vi.fn(),
  touchSession: vi.fn(),
}));

// Mock identity resolution
vi.mock('../../identity/resolved-identity.js', () => ({
  resolveIdentity: vi.fn(() => ({ success: false })),
  SUPPORTED_CHAIN_IDS: [1, 8453, 42161, 10, 137],
  CHAIN_NAMES: { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon' },
  DEFAULT_CHAIN_ID: 8453,
}));

// Mock para transactions (for getParaApiBase)
vi.mock('../../para/transactions.js', () => ({
  getParaApiBase: vi.fn(() => 'https://api.para.test'),
  signAndSendTransaction: vi.fn(),
}));

import { setupWallet, getWalletStatus, logout } from '../../para/client.js';
import { getSession, touchSession } from '../../storage/session.js';

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

    it('wallet_session has correct schema', () => {
      expect(sessionToolDefinition.name).toBe('wallet_session');
      expect(sessionToolDefinition.description).toContain('session');
      expect(sessionToolDefinition.inputSchema.type).toBe('object');
      expect(sessionToolDefinition.inputSchema.properties).toHaveProperty('action');
    });
  });

  describe('handleSetupRequest', () => {
    it('handles successful setup without email', async () => {
      vi.mocked(setupWallet).mockResolvedValue({
        address: '0x1234567890123456789012345678901234567890',
        isNew: true,
      });

      const result = await handleSetupRequest({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Wallet created');
      expect(result.content[0].text).toContain('0x1234567890123456789012345678901234567890');
    });

    it('handles successful setup with email', async () => {
      vi.mocked(setupWallet).mockResolvedValue({
        address: '0x1234567890123456789012345678901234567890',
        email: 'test@example.com',
        isNew: true,
      });

      const result = await handleSetupRequest({ email: 'test@example.com' });

      expect(result.content[0].text).toContain('Portable wallet');
      expect(result.content[0].text).toContain('test@example.com');
    });

    it('handles existing wallet', async () => {
      vi.mocked(setupWallet).mockResolvedValue({
        address: '0x1234567890123456789012345678901234567890',
        isNew: false,
      });

      const result = await handleSetupRequest({});

      expect(result.content[0].text).toContain('Wallet ready');
    });

    it('handles setup errors', async () => {
      vi.mocked(setupWallet).mockRejectedValue(new Error('API error'));

      const result = await handleSetupRequest({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Setup failed');
      expect(result.content[0].text).toContain('API error');
    });
  });

  describe('handleSessionRequest', () => {
    it('defaults to status action', async () => {
      vi.mocked(getWalletStatus).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        email: 'test@example.com',
        sessionAge: '2 hours',
        chains: ['base', 'ethereum'],
      });
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      });

      const result = await handleSessionRequest({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Wallet Active');
      expect(result.content[0].text).toContain('0x1234567890123456789012345678901234567890');
      expect(result.content[0].text).toContain('test@example.com');
      expect(result.content[0].text).toContain('2h');
    });

    it('handles status action explicitly', async () => {
      vi.mocked(getWalletStatus).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        sessionAge: '1 hour',
        chains: ['base'],
      });
      vi.mocked(getSession).mockResolvedValue({
        authenticated: true,
        address: '0x1234567890123456789012345678901234567890',
        walletId: 'test-wallet-id',
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });

      const result = await handleSessionRequest({ action: 'status' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Wallet Active');
    });

    it('handles unauthenticated state', async () => {
      vi.mocked(getWalletStatus).mockResolvedValue({
        authenticated: false,
      });

      const result = await handleSessionRequest({ action: 'status' });

      expect(result.content[0].text).toContain('No wallet configured');
      expect(result.content[0].text).toContain('wallet_setup');
    });

    it('handles status errors', async () => {
      vi.mocked(getWalletStatus).mockRejectedValue(new Error('Network error'));

      const result = await handleSessionRequest({ action: 'status' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network error');
    });

    it('handles logout action', async () => {
      vi.mocked(logout).mockResolvedValue(undefined);

      const result = await handleSessionRequest({ action: 'logout' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Logged out');
    });

    it('handles logout errors', async () => {
      vi.mocked(logout).mockRejectedValue(new Error('Session error'));

      const result = await handleSessionRequest({ action: 'logout' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session error');
    });

    it('rejects unknown action', async () => {
      const result = await handleSessionRequest({ action: 'invalid' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown action');
    });
  });
});
