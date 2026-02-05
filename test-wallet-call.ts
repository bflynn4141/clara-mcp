#!/usr/bin/env npx ts-node
/**
 * Test script for wallet_call and wallet_executePrepared
 *
 * Full test including:
 * - ABI override tests
 * - Herd ABI auto-lookup
 * - Real transaction execution
 */

import { handleCallRequest } from './src/tools/call.js';
import { handleExecutePreparedRequest } from './src/tools/execute-prepared.js';
import { initProviders, isHerdEnabled } from './src/providers/index.js';

// USDC on Base - verified, simple functions
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MY_WALLET = '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd';

// Minimal USDC ABI for testing
const USDC_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transferFrom',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
];

// Should we actually execute?
const EXECUTE_REAL_TX = process.env.EXECUTE_TX === 'true';
const TEST_HERD = process.env.HERD_ENABLED === 'true';

async function runTests() {
  console.log('='.repeat(60));
  console.log('wallet_call + wallet_executePrepared Test Suite');
  console.log('='.repeat(60));
  console.log(`EXECUTE_TX: ${EXECUTE_REAL_TX}`);
  console.log(`HERD_ENABLED: ${TEST_HERD}`);
  console.log();

  // Initialize providers
  await initProviders();
  console.log();

  // Test 2.1: Call view function with ABI override
  console.log('─'.repeat(60));
  console.log('Test 2.1: balanceOf with ABI override');
  console.log('─'.repeat(60));

  const result1 = await handleCallRequest({
    contract: USDC_BASE,
    function: 'balanceOf',
    args: [MY_WALLET],
    chain: 'base',
    abi: USDC_ABI,
  });
  console.log(result1.content[0].text);
  console.log();

  // Test 2.2: Wrong function name
  console.log('─'.repeat(60));
  console.log('Test 2.2: Wrong function name (should error)');
  console.log('─'.repeat(60));

  const result2 = await handleCallRequest({
    contract: USDC_BASE,
    function: 'doesNotExist',
    args: [],
    chain: 'base',
    abi: USDC_ABI,
  });
  console.log(result2.content[0].text);
  console.log();

  // Test 2.3: Wrong arg types
  console.log('─'.repeat(60));
  console.log('Test 2.3: Wrong arg types (should error)');
  console.log('─'.repeat(60));

  const result3 = await handleCallRequest({
    contract: USDC_BASE,
    function: 'balanceOf',
    args: ['not-an-address'],
    chain: 'base',
    abi: USDC_ABI,
  });
  console.log(result3.content[0].text);
  console.log();

  // Test 2.5: Herd ABI auto-lookup (if enabled)
  if (TEST_HERD && isHerdEnabled()) {
    console.log('─'.repeat(60));
    console.log('Test 2.5: Herd ABI auto-lookup (no ABI override)');
    console.log('─'.repeat(60));

    const result5 = await handleCallRequest({
      contract: USDC_BASE,
      function: 'balanceOf',
      args: [MY_WALLET],
      chain: 'base',
      // No ABI - should fetch from Herd
    });
    console.log(result5.content[0].text);
    console.log();
  } else {
    console.log('─'.repeat(60));
    console.log('Test 2.5: Skipped (Herd not enabled/connected)');
    console.log('─'.repeat(60));
    console.log();
  }

  // Test 2.4 + 3.1: Transfer simulation and execution
  console.log('─'.repeat(60));
  console.log('Test 2.4 + 3.1: transfer simulation and execution');
  console.log('─'.repeat(60));

  // Small transfer: 0.01 USDC (10000 units with 6 decimals)
  // Sending to burn-like address to avoid losing much
  const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
  const SMALL_AMOUNT = '10000'; // 0.01 USDC

  const result4 = await handleCallRequest({
    contract: USDC_BASE,
    function: 'transfer',
    args: [BURN_ADDRESS, SMALL_AMOUNT],
    chain: 'base',
    abi: USDC_ABI,
  });
  console.log(result4.content[0].text);
  console.log();

  // Extract preparedTxId for execution
  const match = result4.content[0].text.match(/`(ptx_[a-z0-9_]+)`/);
  const preparedTxId = match ? match[1] : null;

  if (preparedTxId) {
    // Test 3.2: Try to execute with an invalid ID
    console.log('─'.repeat(60));
    console.log('Test 3.2: Invalid preparedTxId (should error)');
    console.log('─'.repeat(60));

    const result5 = await handleExecutePreparedRequest({
      preparedTxId: 'ptx_invalid_123',
    });
    console.log(result5.content[0].text);
    console.log();

    // Test 3.1: Execute the valid preparedTxId
    if (EXECUTE_REAL_TX) {
      console.log('─'.repeat(60));
      console.log(`Test 3.1: EXECUTING ${preparedTxId}`);
      console.log('─'.repeat(60));
      console.log('Sending 0.01 USDC to burn address...');
      console.log();

      const execResult = await handleExecutePreparedRequest({
        preparedTxId: preparedTxId,
      });
      console.log(execResult.content[0].text);
      console.log();
    } else {
      console.log('─'.repeat(60));
      console.log(`Test 3.1: Skipped (EXECUTE_TX != true)`);
      console.log(`PreparedTxId: ${preparedTxId}`);
      console.log('─'.repeat(60));
      console.log();
    }
  }

  console.log('='.repeat(60));
  console.log('Tests Complete!');
  console.log('='.repeat(60));
}

runTests().catch(console.error);
