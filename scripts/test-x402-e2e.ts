#!/usr/bin/env npx tsx
/**
 * End-to-End x402 Test Script
 *
 * Tests Clara's x402 implementation against simulated server responses
 * to verify parsing, signing, and header generation work correctly.
 */

import { X402Client, USDC_BASE, BASE_CHAIN_ID, TRANSFER_WITH_AUTHORIZATION_TYPES, X402_TYPES } from '../src/para/x402.js';
import type { Hex } from 'viem';

// ANSI colors for output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function pass(msg: string) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}

function fail(msg: string) {
  console.log(`${RED}✗${RESET} ${msg}`);
}

function info(msg: string) {
  console.log(`${CYAN}ℹ${RESET} ${msg}`);
}

function header(msg: string) {
  console.log(`\n${BOLD}${YELLOW}═══ ${msg} ═══${RESET}\n`);
}

// Track what was signed for verification
interface SignedData {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  value: Record<string, unknown>;
}

const signedDataLog: SignedData[] = [];

// Mock signer that logs what it signs
async function mockSignTypedData(
  domain: Record<string, unknown>,
  types: Record<string, unknown>,
  value: Record<string, unknown>
): Promise<Hex> {
  signedDataLog.push({ domain, types, value });
  // Return a valid-looking signature
  return ('0x' + 'ab'.repeat(65)) as Hex;
}

async function mockGetAddress(): Promise<Hex> {
  return '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd' as Hex;
}

/**
 * Test 1: Parse and sign a v2 response WITH token domain in extra
 */
async function testV2WithTokenDomain() {
  header('Test 1: v2 with token domain in extra');
  signedDataLog.length = 0;

  const client = new X402Client(mockSignTypedData, mockGetAddress);

  // Simulate a v2 402 response with full token domain
  const v2Payload = {
    x402Version: 2,
    resource: {
      url: 'https://api.example.com/premium',
      description: 'Premium weather data',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: USDC_BASE,
        amount: '2000', // $0.002 USDC
        payTo: '0x1E54dd08e5FD673d3F96080B35d973f0EB840353',
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

  // Parse
  const details = client.parsePaymentRequired(response);
  if (!details) {
    fail('Failed to parse v2 response');
    return false;
  }
  pass('Parsed v2 response');

  // Verify parsed values
  if (details.x402Version !== 2) {
    fail(`Expected x402Version=2, got ${details.x402Version}`);
    return false;
  }
  pass('x402Version is 2');

  if (details.tokenDomain?.name !== 'USD Coin') {
    fail(`Expected tokenDomain.name='USD Coin', got ${details.tokenDomain?.name}`);
    return false;
  }
  pass('Token domain extracted from extra');

  // Sign
  const signResult = await client.createPaymentSignature(details);
  if (!signResult.authorization) {
    fail('Expected authorization object for v2');
    return false;
  }
  pass('Created v2 signature with authorization');

  // Verify signed domain
  const signedDomain = signedDataLog[0].domain;
  if (signedDomain.name !== 'USD Coin') {
    fail(`Expected signed domain name='USD Coin', got ${signedDomain.name}`);
    return false;
  }
  pass(`Signed with correct domain: ${signedDomain.name} v${signedDomain.version}`);

  // Verify signed types (should be TransferWithAuthorization)
  if (!signedDataLog[0].types.TransferWithAuthorization) {
    fail('Expected TransferWithAuthorization types');
    return false;
  }
  pass('Used EIP-3009 TransferWithAuthorization types');

  // Create payment header
  const { headerName, headerValue } = await client.createPaymentHeader(details, signResult);
  if (headerName !== 'PAYMENT-SIGNATURE') {
    fail(`Expected header 'PAYMENT-SIGNATURE', got '${headerName}'`);
    return false;
  }
  pass('Created PAYMENT-SIGNATURE header');

  // Decode and verify header payload
  const payload = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf-8'));
  if (payload.x402Version !== 2) {
    fail(`Expected payload.x402Version=2, got ${payload.x402Version}`);
    return false;
  }
  pass('Header payload has correct x402Version');

  info(`Header value (base64): ${headerValue.slice(0, 50)}...`);

  return true;
}

/**
 * Test 2: Parse and sign a v2 response WITHOUT token domain (uses fallback)
 */
async function testV2WithoutTokenDomain() {
  header('Test 2: v2 WITHOUT token domain (fallback)');
  signedDataLog.length = 0;

  const client = new X402Client(mockSignTypedData, mockGetAddress);

  // Simulate a v2 402 response WITHOUT token domain in extra
  const v2Payload = {
    x402Version: 2,
    resource: {
      url: 'https://api.example.com/data',
      description: 'API data',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: USDC_BASE,
        amount: '5000',
        payTo: '0x1234567890123456789012345678901234567890',
        maxTimeoutSeconds: 600,
        extra: {}, // Empty extra - no token domain!
      },
    ],
  };

  const headers = new Headers({
    'payment-required': Buffer.from(JSON.stringify(v2Payload)).toString('base64'),
  });
  const response = new Response(null, { status: 402, headers });

  // Parse
  const details = client.parsePaymentRequired(response);
  if (!details) {
    fail('Failed to parse v2 response');
    return false;
  }
  pass('Parsed v2 response (empty extra)');

  if (details.tokenDomain) {
    fail(`Expected tokenDomain to be undefined, got ${JSON.stringify(details.tokenDomain)}`);
    return false;
  }
  pass('tokenDomain is undefined (as expected from empty extra)');

  // Sign - should use fallback domain for USDC
  const signResult = await client.createPaymentSignature(details);
  if (!signResult.authorization) {
    fail('Expected authorization object for v2 (should use fallback)');
    return false;
  }
  pass('Created v2 signature using fallback domain');

  // Verify fallback domain was used
  const signedDomain = signedDataLog[0].domain;
  if (signedDomain.name !== 'USD Coin') {
    fail(`Expected fallback domain name='USD Coin', got ${signedDomain.name}`);
    return false;
  }
  pass(`Used fallback domain: ${signedDomain.name} v${signedDomain.version}`);

  // Verify correct types
  if (!signedDataLog[0].types.TransferWithAuthorization) {
    fail('Expected TransferWithAuthorization types');
    return false;
  }
  pass('Used EIP-3009 types with fallback domain');

  return true;
}

/**
 * Test 3: Parse and sign a v1 response (legacy)
 */
async function testV1Legacy() {
  header('Test 3: v1 legacy format');
  signedDataLog.length = 0;

  const client = new X402Client(mockSignTypedData, mockGetAddress);

  // Simulate a v1 402 response
  const v1Payload = {
    payTo: '0x9876543210987654321098765432109876543210',
    maxAmountRequired: '1000',
    asset: USDC_BASE,
    network: 'base',
    validUntil: Math.floor(Date.now() / 1000) + 300,
    paymentId: '0x' + '11'.repeat(32),
    description: 'Legacy v1 payment',
  };

  const headers = new Headers({
    'payment-required': Buffer.from(JSON.stringify(v1Payload)).toString('base64'),
  });
  const response = new Response(null, { status: 402, headers });

  // Parse
  const details = client.parsePaymentRequired(response);
  if (!details) {
    fail('Failed to parse v1 response');
    return false;
  }
  pass('Parsed v1 response');

  if (details.x402Version === 2) {
    fail('Should not be detected as v2');
    return false;
  }
  pass('Correctly identified as v1 (no x402Version field)');

  // Sign
  const signResult = await client.createPaymentSignature(details);
  if (signResult.authorization) {
    fail('v1 should NOT have authorization object');
    return false;
  }
  pass('No authorization object (correct for v1)');

  // Verify v1 domain
  const signedDomain = signedDataLog[0].domain;
  if (signedDomain.name !== 'x402') {
    fail(`Expected v1 domain name='x402', got ${signedDomain.name}`);
    return false;
  }
  pass(`Used v1 domain: ${signedDomain.name} v${signedDomain.version}`);

  // Verify v1 types (should be Payment, not TransferWithAuthorization)
  if (signedDataLog[0].types.TransferWithAuthorization) {
    fail('v1 should NOT use TransferWithAuthorization');
    return false;
  }
  if (!signedDataLog[0].types.Payment) {
    fail('v1 should use Payment type');
    return false;
  }
  pass('Used v1 Payment types');

  // Create payment header
  const { headerName } = await client.createPaymentHeader(details, signResult);
  if (headerName !== 'X-PAYMENT') {
    fail(`Expected header 'X-PAYMENT', got '${headerName}'`);
    return false;
  }
  pass('Created X-PAYMENT header (v1 format)');

  return true;
}

/**
 * Test 4: v2 with unknown token should throw
 */
async function testV2UnknownToken() {
  header('Test 4: v2 with unknown token (should throw)');
  signedDataLog.length = 0;

  const client = new X402Client(mockSignTypedData, mockGetAddress);

  const v2Payload = {
    x402Version: 2,
    resource: { url: 'https://api.example.com/data' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x9999999999999999999999999999999999999999', // Unknown token
        amount: '1000',
        payTo: '0x1234567890123456789012345678901234567890',
        maxTimeoutSeconds: 300,
        extra: {}, // No domain provided
      },
    ],
  };

  const headers = new Headers({
    'payment-required': Buffer.from(JSON.stringify(v2Payload)).toString('base64'),
  });
  const response = new Response(null, { status: 402, headers });

  const details = client.parsePaymentRequired(response);
  if (!details) {
    fail('Failed to parse response');
    return false;
  }
  pass('Parsed response with unknown token');

  try {
    await client.createPaymentSignature(details);
    fail('Should have thrown for unknown token without domain');
    return false;
  } catch (error) {
    if (error instanceof Error && error.message.includes('unknown token domain')) {
      pass(`Correctly threw: ${error.message.slice(0, 60)}...`);
      return true;
    }
    fail(`Unexpected error: ${error}`);
    return false;
  }
}

/**
 * Test 5: Amount parsing edge cases
 */
async function testAmountParsing() {
  header('Test 5: Amount parsing edge cases');

  const client = new X402Client(mockSignTypedData, mockGetAddress);

  // Test decimal amount (v2 style)
  const decimalPayload = {
    x402Version: 2,
    resource: { url: 'https://api.example.com/data' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: USDC_BASE,
        amount: '0.50', // $0.50 in decimal
        payTo: '0x1234567890123456789012345678901234567890',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  };

  const headers1 = new Headers({
    'payment-required': Buffer.from(JSON.stringify(decimalPayload)).toString('base64'),
  });
  const response1 = new Response(null, { status: 402, headers: headers1 });
  const details1 = client.parsePaymentRequired(response1);

  if (!details1 || details1.amount !== 500000n) {
    fail(`Expected amount=500000 (base units), got ${details1?.amount}`);
    return false;
  }
  pass('Parsed decimal amount "0.50" → 500000 base units');

  // Test integer amount
  const intPayload = {
    x402Version: 2,
    resource: { url: 'https://api.example.com/data' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: USDC_BASE,
        amount: '1000000', // 1 USDC in base units
        payTo: '0x1234567890123456789012345678901234567890',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  };

  const headers2 = new Headers({
    'payment-required': Buffer.from(JSON.stringify(intPayload)).toString('base64'),
  });
  const response2 = new Response(null, { status: 402, headers: headers2 });
  const details2 = client.parsePaymentRequired(response2);

  if (!details2 || details2.amount !== 1000000n) {
    fail(`Expected amount=1000000, got ${details2?.amount}`);
    return false;
  }
  pass('Parsed integer amount "1000000" → 1000000 base units');

  // Test amount to USD conversion
  const usdAmount = client.tokenAmountToUsd(500000n, USDC_BASE as Hex);
  if (usdAmount !== '0.50') {
    fail(`Expected USD amount='0.50', got '${usdAmount}'`);
    return false;
  }
  pass('Converted 500000 base units → $0.50 USD');

  return true;
}

/**
 * Test 6: Network parsing (CAIP-2 format)
 */
async function testNetworkParsing() {
  header('Test 6: Network parsing (CAIP-2)');

  const client = new X402Client(mockSignTypedData, mockGetAddress);

  // Test eip155:8453 format
  const payload1 = {
    x402Version: 2,
    resource: { url: 'https://api.example.com/data' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453', // CAIP-2 format
        asset: USDC_BASE,
        amount: '1000',
        payTo: '0x1234567890123456789012345678901234567890',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  };

  const headers1 = new Headers({
    'payment-required': Buffer.from(JSON.stringify(payload1)).toString('base64'),
  });
  const response1 = new Response(null, { status: 402, headers: headers1 });
  const details1 = client.parsePaymentRequired(response1);

  if (details1?.chainId !== 8453) {
    fail(`Expected chainId=8453, got ${details1?.chainId}`);
    return false;
  }
  pass('Parsed eip155:8453 → chainId 8453');

  // Test "base" format (v1 style)
  const payload2 = {
    payTo: '0x1234567890123456789012345678901234567890',
    maxAmountRequired: '1000',
    asset: USDC_BASE,
    network: 'base', // Simple name format
  };

  const headers2 = new Headers({
    'payment-required': Buffer.from(JSON.stringify(payload2)).toString('base64'),
  });
  const response2 = new Response(null, { status: 402, headers: headers2 });
  const details2 = client.parsePaymentRequired(response2);

  if (details2?.chainId !== 8453) {
    fail(`Expected chainId=8453 for "base", got ${details2?.chainId}`);
    return false;
  }
  pass('Parsed network="base" → chainId 8453');

  return true;
}

// Run all tests
async function main() {
  console.log(`${BOLD}${CYAN}`);
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           x402 End-to-End Test Suite                          ║');
  console.log('║           Testing Clara\'s x402 Implementation                  ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`${RESET}`);

  const results: { name: string; passed: boolean }[] = [];

  const tests = [
    { name: 'v2 with token domain', fn: testV2WithTokenDomain },
    { name: 'v2 without token domain (fallback)', fn: testV2WithoutTokenDomain },
    { name: 'v1 legacy format', fn: testV1Legacy },
    { name: 'v2 unknown token (should throw)', fn: testV2UnknownToken },
    { name: 'Amount parsing edge cases', fn: testAmountParsing },
    { name: 'Network parsing (CAIP-2)', fn: testNetworkParsing },
  ];

  for (const test of tests) {
    try {
      const passed = await test.fn();
      results.push({ name: test.name, passed });
    } catch (error) {
      console.error(`${RED}Error in ${test.name}:${RESET}`, error);
      results.push({ name: test.name, passed: false });
    }
  }

  // Summary
  header('Test Summary');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const result of results) {
    console.log(`  ${result.passed ? GREEN + '✓' : RED + '✗'} ${result.name}${RESET}`);
  }

  console.log('');
  console.log(`${BOLD}Total: ${passed} passed, ${failed} failed${RESET}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(console.error);
