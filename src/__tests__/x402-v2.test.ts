/**
 * Tests for x402 v2 compatibility
 *
 * Verifies that Clara correctly handles x402 v2 responses,
 * especially when token domain info is not provided in the `extra` field.
 */

import { describe, it, expect, vi } from 'vitest';
import { X402Client, USDC_BASE, BASE_CHAIN_ID, type EIP712Domain, type EIP712TypeDefinition } from '../para/x402.js';
import type { Hex } from 'viem';

// Mock signer that captures what we're signing
function createMockSigner() {
  const signedData: Array<{
    domain: EIP712Domain;
    types: EIP712TypeDefinition;
    value: Record<string, unknown>;
  }> = [];

  const signTypedData = async (
    domain: EIP712Domain,
    types: EIP712TypeDefinition,
    value: Record<string, unknown>
  ): Promise<Hex> => {
    signedData.push({ domain, types, value });
    return '0x' + '00'.repeat(65) as Hex; // Mock signature
  };

  const getAddress = async (): Promise<Hex> => {
    return '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd' as Hex;
  };

  return { signTypedData, getAddress, signedData };
}

describe('X402Client v2 compatibility', () => {
  describe('parsePaymentRequired', () => {
    it('should parse v2 response correctly', () => {
      const client = new X402Client(
        createMockSigner().signTypedData,
        createMockSigner().getAddress
      );

      // Simulate a v2 402 response
      const v2Payload = {
        x402Version: 2,
        resource: {
          url: 'https://api.example.com/data',
          description: 'Premium data',
          mimeType: 'application/json',
        },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            asset: USDC_BASE,
            amount: '1000', // $0.001 USDC
            payTo: '0x1234567890123456789012345678901234567890',
            maxTimeoutSeconds: 300,
            extra: {}, // No token domain provided!
          },
        ],
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v2Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const details = client.parsePaymentRequired(response);

      expect(details).not.toBeNull();
      expect(details?.x402Version).toBe(2);
      expect(details?.chainId).toBe(8453);
      expect(details?.token.toLowerCase()).toBe(USDC_BASE.toLowerCase());
      // tokenDomain should be undefined since extra was empty
      expect(details?.tokenDomain).toBeUndefined();
    });

    it('should parse v2 response with token domain in extra', () => {
      const client = new X402Client(
        createMockSigner().signTypedData,
        createMockSigner().getAddress
      );

      const v2Payload = {
        x402Version: 2,
        resource: {
          url: 'https://api.example.com/data',
          description: 'Premium data',
          mimeType: 'application/json',
        },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            asset: USDC_BASE,
            amount: '1000',
            payTo: '0x1234567890123456789012345678901234567890',
            maxTimeoutSeconds: 300,
            extra: {
              name: 'USD Coin',
              version: '2',
            },
          },
        ],
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v2Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const details = client.parsePaymentRequired(response);

      expect(details).not.toBeNull();
      expect(details?.tokenDomain).toEqual({ name: 'USD Coin', version: '2' });
    });
  });

  describe('createPaymentSignature', () => {
    it('should use known USDC domain when extra is empty (v2)', async () => {
      const mockSigner = createMockSigner();
      const client = new X402Client(mockSigner.signTypedData, mockSigner.getAddress);

      // v2 payment details WITHOUT tokenDomain (simulating missing extra)
      const details = {
        recipient: '0x1234567890123456789012345678901234567890' as Hex,
        amount: 1000n,
        token: USDC_BASE as Hex,
        chainId: BASE_CHAIN_ID,
        validUntil: Math.floor(Date.now() / 1000) + 300,
        paymentId: '0x' + '00'.repeat(32) as Hex,
        rawHeaders: {},
        x402Version: 2 as const,
        // tokenDomain is undefined - should use fallback!
      };

      const result = await client.createPaymentSignature(details);

      // Should have signed with EIP-3009 format (v2), not v1
      expect(result.authorization).toBeDefined();
      expect(result.authorization?.from).toBe('0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd');

      // Check the domain used for signing
      expect(mockSigner.signedData.length).toBe(1);
      const signedDomain = mockSigner.signedData[0].domain;
      expect(signedDomain.name).toBe('USD Coin');
      expect(signedDomain.version).toBe('2');
      expect(signedDomain.chainId).toBe(8453);
      expect((signedDomain.verifyingContract as string).toLowerCase()).toBe(USDC_BASE.toLowerCase());

      // Check the types used (should be TransferWithAuthorization)
      const signedTypes = mockSigner.signedData[0].types;
      expect(signedTypes).toHaveProperty('TransferWithAuthorization');
    });

    it('should use provided tokenDomain when available (v2)', async () => {
      const mockSigner = createMockSigner();
      const client = new X402Client(mockSigner.signTypedData, mockSigner.getAddress);

      const details = {
        recipient: '0x1234567890123456789012345678901234567890' as Hex,
        amount: 1000n,
        token: USDC_BASE as Hex,
        chainId: BASE_CHAIN_ID,
        validUntil: Math.floor(Date.now() / 1000) + 300,
        paymentId: '0x' + '00'.repeat(32) as Hex,
        rawHeaders: {},
        x402Version: 2 as const,
        tokenDomain: { name: 'Custom Token', version: '99' }, // Explicit domain
      };

      await client.createPaymentSignature(details);

      const signedDomain = mockSigner.signedData[0].domain;
      expect(signedDomain.name).toBe('Custom Token');
      expect(signedDomain.version).toBe('99');
    });

    it('should throw for unknown token without domain (v2)', async () => {
      const mockSigner = createMockSigner();
      const client = new X402Client(mockSigner.signTypedData, mockSigner.getAddress);

      const details = {
        recipient: '0x1234567890123456789012345678901234567890' as Hex,
        amount: 1000n,
        token: '0xUnknownTokenAddress1234567890123456789012' as Hex, // Unknown token
        chainId: BASE_CHAIN_ID,
        validUntil: Math.floor(Date.now() / 1000) + 300,
        paymentId: '0x' + '00'.repeat(32) as Hex,
        rawHeaders: {},
        x402Version: 2 as const,
        // No tokenDomain, and token is unknown
      };

      await expect(client.createPaymentSignature(details)).rejects.toThrow(
        /unknown token domain/i
      );
    });

    it('should use v1 format when x402Version is 1', async () => {
      const mockSigner = createMockSigner();
      const client = new X402Client(mockSigner.signTypedData, mockSigner.getAddress);

      const details = {
        recipient: '0x1234567890123456789012345678901234567890' as Hex,
        amount: 1000n,
        token: USDC_BASE as Hex,
        chainId: BASE_CHAIN_ID,
        validUntil: Math.floor(Date.now() / 1000) + 300,
        paymentId: '0x' + '00'.repeat(32) as Hex,
        rawHeaders: {},
        // x402Version not set or is 1 - should use v1 format
      };

      const result = await client.createPaymentSignature(details);

      // v1 doesn't have authorization object
      expect(result.authorization).toBeUndefined();

      // Check the domain used (should be x402 domain, not token domain)
      const signedDomain = mockSigner.signedData[0].domain;
      expect(signedDomain.name).toBe('x402');
      expect(signedDomain.version).toBe('1');

      // Check the types used (should be Payment, not TransferWithAuthorization)
      const signedTypes = mockSigner.signedData[0].types;
      expect(signedTypes).toHaveProperty('Payment');
      expect(signedTypes).not.toHaveProperty('TransferWithAuthorization');
    });
  });
});
