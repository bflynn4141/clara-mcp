#!/usr/bin/env npx tsx
/**
 * Quick test of x402 parser against real test endpoint
 */

import { X402Client, USDC_BASE } from './src/para/x402.js';

async function main() {
  console.log('Testing x402 parser against https://402payment-test.com/api/x402\n');

  // Create a mock client (we just need the parser)
  const client = new X402Client(
    async () => '0x0' as `0x${string}`,
    async () => '0x0' as `0x${string}`
  );

  // Fetch the 402 response
  const response = await fetch('https://402payment-test.com/api/x402');

  console.log(`Status: ${response.status}`);
  console.log('Headers:');
  response.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));
  console.log('');

  // Parse it
  const details = client.parsePaymentRequired(response);

  if (details) {
    console.log('✅ Successfully parsed payment details:');
    console.log(`  Recipient: ${details.recipient}`);
    console.log(`  Amount: ${details.amount} (raw)`);
    console.log(`  Amount USD: $${client.tokenAmountToUsd(details.amount, details.token)}`);
    console.log(`  Token: ${details.token}`);
    console.log(`  Chain ID: ${details.chainId}`);
    console.log(`  Valid Until: ${new Date(details.validUntil * 1000).toISOString()}`);
    console.log(`  Payment ID: ${details.paymentId}`);
  } else {
    console.log('❌ Failed to parse payment details');
  }
}

main().catch(console.error);
