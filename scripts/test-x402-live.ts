#!/usr/bin/env npx tsx
/**
 * Live x402 Test against Mock Server
 *
 * This script tests Clara's x402 client against a running mock server.
 *
 * Prerequisites:
 *   1. Start the mock server: npx tsx scripts/mock-x402-server.ts
 *   2. Run this test: npx tsx scripts/test-x402-live.ts
 */

import { X402Client } from '../src/para/x402.js';
import type { Hex } from 'viem';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

const SERVER_URL = 'http://localhost:4020';

// Track what was signed
interface SignedData {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  value: Record<string, unknown>;
}
const signedDataLog: SignedData[] = [];

// Mock signer
async function mockSignTypedData(
  domain: Record<string, unknown>,
  types: Record<string, unknown>,
  value: Record<string, unknown>
): Promise<Hex> {
  signedDataLog.push({ domain, types, value });
  console.log(`${CYAN}  [signer]${RESET} Signing with domain: ${domain.name} v${domain.version}`);
  return ('0x' + 'ab'.repeat(65)) as Hex;
}

async function mockGetAddress(): Promise<Hex> {
  return '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd' as Hex;
}

async function testEndpoint(
  client: X402Client,
  endpoint: string,
  description: string,
  expectedVersion: number,
  expectFallback: boolean
): Promise<boolean> {
  console.log(`\n${BOLD}${YELLOW}─── Testing: ${description} ───${RESET}\n`);
  signedDataLog.length = 0;

  const url = `${SERVER_URL}${endpoint}`;
  console.log(`${CYAN}  [fetch]${RESET} GET ${url}`);

  try {
    // Make initial request
    const response = await fetch(url);

    if (response.status !== 402) {
      console.log(`${RED}  ✗ Expected 402, got ${response.status}${RESET}`);
      return false;
    }
    console.log(`${GREEN}  ✓ Received 402 Payment Required${RESET}`);

    // Parse payment details
    const details = client.parsePaymentRequired(response);
    if (!details) {
      console.log(`${RED}  ✗ Failed to parse payment details${RESET}`);
      return false;
    }
    console.log(`${GREEN}  ✓ Parsed payment details${RESET}`);
    console.log(`    x402Version: ${details.x402Version || 'undefined (v1)'}`);
    console.log(`    amount: ${details.amount} (${client.tokenAmountToUsd(details.amount, details.token)} USD)`);
    console.log(`    chainId: ${details.chainId}`);
    console.log(`    tokenDomain: ${details.tokenDomain ? `${details.tokenDomain.name} v${details.tokenDomain.version}` : 'undefined (will use fallback)'}`);

    // Verify version detection
    if (expectedVersion === 2 && details.x402Version !== 2) {
      console.log(`${RED}  ✗ Expected v2, got v${details.x402Version || 1}${RESET}`);
      return false;
    }
    if (expectedVersion === 1 && details.x402Version === 2) {
      console.log(`${RED}  ✗ Expected v1, got v2${RESET}`);
      return false;
    }
    console.log(`${GREEN}  ✓ Correct version detected (v${expectedVersion})${RESET}`);

    // Create signature
    console.log(`${CYAN}  [sign]${RESET} Creating payment signature...`);
    const signResult = await client.createPaymentSignature(details);

    // Verify signing used correct domain
    const signedDomain = signedDataLog[0]?.domain;
    if (expectedVersion === 2) {
      if (signedDomain?.name !== 'USD Coin') {
        console.log(`${RED}  ✗ Expected token domain, got ${signedDomain?.name}${RESET}`);
        return false;
      }
      if (!signResult.authorization) {
        console.log(`${RED}  ✗ Expected authorization object for v2${RESET}`);
        return false;
      }
      console.log(`${GREEN}  ✓ Used EIP-3009 signing with token domain${RESET}`);

      if (expectFallback && !details.tokenDomain) {
        console.log(`${GREEN}  ✓ Correctly used fallback domain (tokenDomain was undefined)${RESET}`);
      }
    } else {
      if (signedDomain?.name !== 'x402') {
        console.log(`${RED}  ✗ Expected x402 domain, got ${signedDomain?.name}${RESET}`);
        return false;
      }
      if (signResult.authorization) {
        console.log(`${RED}  ✗ v1 should not have authorization object${RESET}`);
        return false;
      }
      console.log(`${GREEN}  ✓ Used v1 signing with x402 domain${RESET}`);
    }

    // Create payment header
    const { headerName, headerValue } = await client.createPaymentHeader(details, signResult);
    const expectedHeader = expectedVersion === 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT';
    if (headerName !== expectedHeader) {
      console.log(`${RED}  ✗ Expected header ${expectedHeader}, got ${headerName}${RESET}`);
      return false;
    }
    console.log(`${GREEN}  ✓ Created ${headerName} header${RESET}`);

    // Make paid request
    console.log(`${CYAN}  [fetch]${RESET} Retrying with payment header...`);
    const paidResponse = await fetch(url, {
      headers: {
        [headerName]: headerValue,
      },
    });

    if (paidResponse.status !== 200) {
      console.log(`${RED}  ✗ Payment not accepted: ${paidResponse.status}${RESET}`);
      const body = await paidResponse.text();
      console.log(`    Response: ${body}`);
      return false;
    }

    const data = await paidResponse.json();
    console.log(`${GREEN}  ✓ Payment accepted! Response:${RESET}`);
    console.log(`    ${JSON.stringify(data, null, 2).replace(/\n/g, '\n    ')}`);

    return true;
  } catch (error) {
    console.log(`${RED}  ✗ Error: ${error instanceof Error ? error.message : error}${RESET}`);
    return false;
  }
}

async function main() {
  console.log(`${BOLD}${CYAN}`);
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           Live x402 Test (against mock server)                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`${RESET}`);

  // Check if server is running
  try {
    const health = await fetch(`${SERVER_URL}/health`);
    if (!health.ok) throw new Error('Server not healthy');
    console.log(`${GREEN}✓ Mock server is running at ${SERVER_URL}${RESET}`);
  } catch {
    console.log(`${RED}✗ Mock server not running!${RESET}`);
    console.log(`\nStart it with: ${CYAN}npx tsx scripts/mock-x402-server.ts${RESET}\n`);
    process.exit(1);
  }

  const client = new X402Client(mockSignTypedData, mockGetAddress);

  const tests = [
    { endpoint: '/api/weather', description: 'v2 with token domain', version: 2, fallback: false },
    { endpoint: '/api/v2-no-domain', description: 'v2 WITHOUT token domain (fallback)', version: 2, fallback: true },
    { endpoint: '/api/v1-legacy', description: 'v1 legacy format', version: 1, fallback: false },
  ];

  const results: boolean[] = [];

  for (const test of tests) {
    const passed = await testEndpoint(client, test.endpoint, test.description, test.version, test.fallback);
    results.push(passed);
  }

  // Summary
  console.log(`\n${BOLD}${YELLOW}═══ Test Summary ═══${RESET}\n`);
  const passed = results.filter(r => r).length;
  const failed = results.filter(r => !r).length;

  for (let i = 0; i < tests.length; i++) {
    console.log(`  ${results[i] ? GREEN + '✓' : RED + '✗'} ${tests[i].description}${RESET}`);
  }

  console.log(`\n${BOLD}Total: ${passed} passed, ${failed} failed${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
