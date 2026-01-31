/**
 * Tests for decode tool
 *
 * Tests wallet_decode_tx tool for transaction calldata decoding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeToolDefinition, handleDecodeRequest } from '../../tools/decode.js';

// Mock fetch for 4byte.directory
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Decode Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock response for 4byte.directory
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });
  });

  describe('Tool Definition', () => {
    it('has correct name and description', () => {
      expect(decodeToolDefinition.name).toBe('wallet_decode_tx');
      expect(decodeToolDefinition.description).toContain('Decode');
      expect(decodeToolDefinition.description).toContain('calldata');
    });

    it('has required data field', () => {
      expect(decodeToolDefinition.inputSchema.required).toContain('data');
    });

    it('has correct properties', () => {
      const props = decodeToolDefinition.inputSchema.properties;
      expect(props).toHaveProperty('data');
      expect(props).toHaveProperty('value');
      expect(props).toHaveProperty('to');
    });
  });

  describe('handleDecodeRequest - Input Validation', () => {
    it('rejects missing data', async () => {
      const result = await handleDecodeRequest({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid');
    });

    it('rejects invalid hex format', async () => {
      const result = await handleDecodeRequest({
        data: 'not-hex-data',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid');
    });

    it('accepts empty calldata (0x)', async () => {
      const result = await handleDecodeRequest({
        data: '0x',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Native ETH Transfer');
    });
  });

  describe('handleDecodeRequest - Native Transfers', () => {
    it('decodes empty calldata as native transfer', async () => {
      const result = await handleDecodeRequest({
        data: '0x',
        value: '1',
        to: '0x1234567890123456789012345678901234567890',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Native ETH Transfer');
    });

    it('handles short calldata as native transfer', async () => {
      const result = await handleDecodeRequest({
        data: '0x1234', // Less than 10 chars
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Native ETH Transfer');
    });
  });

  describe('handleDecodeRequest - Known Methods', () => {
    it('decodes ERC20 transfer', async () => {
      // transfer(address,uint256)
      const transferData = '0xa9059cbb' +
        '0000000000000000000000001234567890123456789012345678901234567890' + // recipient
        '00000000000000000000000000000000000000000000000000000000000f4240';  // amount (1000000)

      const result = await handleDecodeRequest({
        data: transferData,
        to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('transfer');
      expect(result.content[0].text).toContain('recipient');
    });

    it('decodes ERC20 approve', async () => {
      // approve(address,uint256) with unlimited approval
      const approveData = '0x095ea7b3' +
        '0000000000000000000000001111111254fb6c44bac0bed2854e76f90643097d' + // spender
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';  // max uint256

      const result = await handleDecodeRequest({
        data: approveData,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('approve');
      expect(result.content[0].text).toContain('spender');
    });

    it('decodes ERC20 transferFrom', async () => {
      // transferFrom(address,address,uint256)
      const transferFromData = '0x23b872dd' +
        '000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' + // from
        '000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' + // to
        '0000000000000000000000000000000000000000000000000000000000000064';  // amount (100)

      const result = await handleDecodeRequest({
        data: transferFromData,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('transferFrom');
    });

    it('decodes WETH deposit', async () => {
      // deposit() - no parameters
      const depositData = '0xd0e30db0';

      const result = await handleDecodeRequest({
        data: depositData,
        value: '1',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('deposit');
    });

    it('decodes WETH withdraw', async () => {
      // withdraw(uint256)
      const withdrawData = '0x2e1a7d4d' +
        '0000000000000000000000000000000000000000000000000de0b6b3a7640000'; // 1 ETH

      const result = await handleDecodeRequest({
        data: withdrawData,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('withdraw');
    });

    it('decodes Aave supply', async () => {
      // supply(address,uint256,address,uint16)
      const supplyData = '0x617ba037' +
        '000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913' + // asset (USDC)
        '00000000000000000000000000000000000000000000000000000000000f4240' + // amount
        '0000000000000000000000001234567890123456789012345678901234567890' + // onBehalfOf
        '0000000000000000000000000000000000000000000000000000000000000000';  // referralCode

      const result = await handleDecodeRequest({
        data: supplyData,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('supply');
    });
  });

  describe('handleDecodeRequest - Unknown Methods', () => {
    it('falls back to 4byte.directory for unknown methods', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          results: [{ text_signature: 'unknownMethod(uint256,address)' }],
        }),
      });

      const unknownData = '0xdeadbeef' +
        '0000000000000000000000000000000000000000000000000000000000000001' +
        '0000000000000000000000001234567890123456789012345678901234567890';

      const result = await handleDecodeRequest({
        data: unknownData,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('unknownMethod');
      expect(result.content[0].text).toContain('4byte.directory');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('0xdeadbeef'),
        expect.any(Object)
      );
    });

    it('handles 4byte.directory API failure', async () => {
      mockFetch.mockRejectedValue(new Error('API timeout'));

      const unknownData = '0xdeadbeef' +
        '0000000000000000000000000000000000000000000000000000000000000001';

      const result = await handleDecodeRequest({
        data: unknownData,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('0xdeadbeef');
      expect(result.content[0].text).toContain('unknown');
    });

    it('handles 4byte.directory no results', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      });

      const unknownData = '0xdeadbeef' +
        '0000000000000000000000000000000000000000000000000000000000000001';

      const result = await handleDecodeRequest({
        data: unknownData,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('0xdeadbeef');
      expect(result.content[0].text).toContain('unknown');
    });

    it('shows raw parameters for unknown methods', async () => {
      const unknownData = '0xdeadbeef' +
        '0000000000000000000000001234567890123456789012345678901234567890' +
        '0000000000000000000000000000000000000000000000000000000000000064';

      const result = await handleDecodeRequest({
        data: unknownData,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Raw Parameters');
    });
  });

  describe('handleDecodeRequest - Parameter Parsing', () => {
    it('formats addresses correctly', async () => {
      const transferData = '0xa9059cbb' +
        '000000000000000000000000abcdef1234567890abcdef1234567890abcdef12' +
        '0000000000000000000000000000000000000000000000000000000000000001';

      const result = await handleDecodeRequest({
        data: transferData,
      });

      expect(result.content[0].text).toContain('0xabcdef1234567890abcdef1234567890abcdef12');
    });

    it('formats small numbers correctly', async () => {
      // Small numbers should be decoded as decimal, not mistaken for addresses
      const withdrawData = '0x2e1a7d4d' +
        '0000000000000000000000000000000000000000000000000000000000000064'; // 100

      const result = await handleDecodeRequest({
        data: withdrawData,
      });

      // Verify the method and parameter are correctly decoded
      expect(result.content[0].text).toContain('withdraw');
      expect(result.content[0].text).toContain('100');
    });
  });

  describe('handleDecodeRequest - Context Display', () => {
    it('shows value when provided', async () => {
      const depositData = '0xd0e30db0';

      const result = await handleDecodeRequest({
        data: depositData,
        value: '1',
      });

      expect(result.content[0].text).toContain('Value');
    });

    it('shows target when provided', async () => {
      const transferData = '0xa9059cbb' +
        '0000000000000000000000001234567890123456789012345678901234567890' +
        '0000000000000000000000000000000000000000000000000000000000000001';

      const result = await handleDecodeRequest({
        data: transferData,
        to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      });

      expect(result.content[0].text).toContain('Target');
      expect(result.content[0].text).toContain('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    });

    it('truncates long parameter lists', async () => {
      // Build data with 15 parameters
      let data = '0xdeadbeef';
      for (let i = 0; i < 15; i++) {
        data += '0'.repeat(63) + i.toString(16).padStart(1, '0');
      }

      const result = await handleDecodeRequest({
        data: data,
      });

      expect(result.content[0].text).toContain('more parameters');
    });
  });
});
