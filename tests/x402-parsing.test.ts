/**
 * x402 Parsing Tests
 *
 * Tests for v1 and v2 format parsing, network handling, and amount parsing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { X402Client, USDC_BASE, BASE_CHAIN_ID } from '../src/para/x402.js';

describe('X402Client', () => {
  let client: X402Client;

  beforeEach(() => {
    // Create client with mock signing functions
    client = new X402Client(
      async () => '0x' + '00'.repeat(65) as `0x${string}`,
      async () => '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd' as `0x${string}`
    );
  });

  describe('parsePaymentRequired - v1 format', () => {
    it('parses valid v1 PAYMENT-REQUIRED header', () => {
      const v1Payload = {
        payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
        maxAmountRequired: '2000',
        asset: USDC_BASE,
        network: 'base',
        validUntil: Math.floor(Date.now() / 1000) + 300,
        paymentId: '0x' + 'ab'.repeat(32),
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v1Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result).not.toBeNull();
      expect(result?.recipient).toBe(v1Payload.payTo);
      expect(result?.amount).toBe(BigInt(2000));
      expect(result?.token).toBe(USDC_BASE);
      expect(result?.chainId).toBe(BASE_CHAIN_ID);
    });

    it('handles decimal amount in v1 format (USDC)', () => {
      const v1Payload = {
        payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
        maxAmountRequired: '0.01', // $0.01 = 10000 base units
        asset: USDC_BASE,
        network: 'base',
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v1Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result).not.toBeNull();
      expect(result?.amount).toBe(BigInt(10000)); // 0.01 * 1_000_000
    });
  });

  describe('parsePaymentRequired - v2 format', () => {
    it('parses valid v2 accepts array', () => {
      const v2Payload = {
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            amount: '2000',
            asset: USDC_BASE,
            payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
            maxTimeoutSeconds: 300,
          },
        ],
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v2Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result).not.toBeNull();
      expect(result?.recipient).toBe('0x1E54dd08e5FD673d3F96080B35d973f0EB840353');
      expect(result?.amount).toBe(BigInt(2000));
      expect(result?.chainId).toBe(8453);
    });

    it('selects Base+USDC option when multiple choices available', () => {
      const v2Payload = {
        x402Version: 2,
        accepts: [
          {
            network: 'eip155:1', // Ethereum mainnet
            amount: '2000',
            asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum USDC
            payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
          },
          {
            network: 'eip155:8453', // Base
            amount: '2000',
            asset: USDC_BASE, // Base USDC
            payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
          },
        ],
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v2Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result).not.toBeNull();
      // Should select Base (8453) over Ethereum (1)
      expect(result?.chainId).toBe(8453);
      expect(result?.token.toLowerCase()).toBe(USDC_BASE.toLowerCase());
    });

    it('returns null for empty accepts array', () => {
      const v2Payload = {
        x402Version: 2,
        accepts: [],
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v2Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result).toBeNull();
    });

    it('returns null for missing accepts array', () => {
      const v2Payload = {
        x402Version: 2,
        // accepts is missing
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v2Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result).toBeNull();
    });

    it('validates EVM address format', () => {
      const v2Payload = {
        x402Version: 2,
        accepts: [
          {
            network: 'eip155:8453',
            amount: '2000',
            asset: 'not-an-address', // Invalid
            payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
          },
        ],
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v2Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result).toBeNull();
    });
  });

  describe('network parsing', () => {
    it('parses eip155:8453 format', () => {
      const v2Payload = {
        x402Version: 2,
        accepts: [
          {
            network: 'eip155:8453',
            amount: '2000',
            asset: USDC_BASE,
            payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
          },
        ],
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v2Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result?.chainId).toBe(8453);
    });

    it('parses named network "base"', () => {
      const v1Payload = {
        payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
        maxAmountRequired: '2000',
        asset: USDC_BASE,
        network: 'base',
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v1Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result?.chainId).toBe(8453);
    });

    it('parses named network "ethereum"', () => {
      const v1Payload = {
        payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
        maxAmountRequired: '2000',
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        network: 'ethereum',
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v1Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result?.chainId).toBe(1);
    });

    it('fails for unknown network in v2 (fail-closed)', () => {
      const v2Payload = {
        x402Version: 2,
        accepts: [
          {
            network: 'unknown-network',
            amount: '2000',
            asset: USDC_BASE,
            payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
          },
        ],
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v2Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      // Should fail because unknown network is not supported
      expect(result).toBeNull();
    });

    it('defaults to Base when network is missing', () => {
      const v1Payload = {
        payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
        maxAmountRequired: '2000',
        asset: USDC_BASE,
        // network is missing
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v1Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result?.chainId).toBe(8453); // Default to Base
    });
  });

  describe('amount parsing', () => {
    it('parses integer base units correctly', () => {
      const v1Payload = {
        payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
        maxAmountRequired: '1000000', // 1 USDC
        asset: USDC_BASE,
        network: 'base',
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v1Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result?.amount).toBe(BigInt(1000000));
    });

    it('parses decimal format correctly for USDC', () => {
      const v1Payload = {
        payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
        maxAmountRequired: '1.234567', // Should become 1234567
        asset: USDC_BASE,
        network: 'base',
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v1Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      expect(result?.amount).toBe(BigInt(1234567));
    });

    it('truncates excessive decimal places', () => {
      const v1Payload = {
        payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
        maxAmountRequired: '0.1234567890', // More than 6 decimals
        asset: USDC_BASE,
        network: 'base',
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v1Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      // Should truncate to 6 decimals: 0.123456
      expect(result?.amount).toBe(BigInt(123456));
    });

    it('pads short decimal places', () => {
      const v1Payload = {
        payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
        maxAmountRequired: '0.1', // $0.10
        asset: USDC_BASE,
        network: 'base',
      };

      const headers = new Headers({
        'payment-required': Buffer.from(JSON.stringify(v1Payload)).toString('base64'),
      });

      const response = new Response(null, { status: 402, headers });
      const result = client.parsePaymentRequired(response);

      // 0.1 = 100000 base units
      expect(result?.amount).toBe(BigInt(100000));
    });
  });
});
