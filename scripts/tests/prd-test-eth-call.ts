/**
 * PRD Test: On-Chain Read Calls (eth_call)
 *
 * TEST: On-Chain Read Calls (eth_call)
 * SETUP: Aerodrome router on Base at 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
 *
 * EXPECTED:
 * - Returns { result: "0x..." } with amounts array
 * - Can be decoded to show expected AERO output
 *
 * Run with: npx tsx scripts/tests/prd-test-eth-call.ts
 */

import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, type Hex } from 'viem';
import { base } from 'viem/chains';
import { requireIdentity, createToolResponse } from '../../src/identity/resolved-identity.js';
import { getRpcUrl } from '../../src/config/chains.js';

// Aerodrome Router on Base
const AERODROME_ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
// USDC on Base
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// AERO token on Base
const AERO_BASE = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
// Factory (for route)
const FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
// Amount: 2.5 USDC
const AMOUNT = 2500000n;

// getAmountsOut ABI
const GET_AMOUNTS_OUT_ABI = [
  {
    name: 'getAmountsOut',
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      {
        name: 'routes',
        type: 'tuple[]',
        components: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'stable', type: 'bool' },
          { name: 'factory', type: 'address' },
        ],
      },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const;

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('PRD TEST: On-Chain Read Calls (eth_call)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const results: { step: string; status: 'PASS' | 'FAIL'; details: string }[] = [];

  // Step 1: Resolve identity
  console.log('Step 1: Resolve identity for Base (8453)');
  let identity;
  try {
    identity = await requireIdentity(8453);
    results.push({
      step: 'Identity resolution',
      status: 'PASS',
      details: `${identity.address} on chain ${identity.chainId}`,
    });
    console.log(`  ✅ Address: ${identity.address}\n`);
  } catch (err) {
    results.push({
      step: 'Identity resolution',
      status: 'FAIL',
      details: String(err),
    });
    console.log(`  ❌ ${err}\n`);
    printSummary(results);
    process.exit(1);
  }

  // Step 2: Encode getAmountsOut calldata
  console.log('Step 2: Encode getAmountsOut() calldata');
  const route = [
    {
      from: USDC_BASE as Hex,
      to: AERO_BASE as Hex,
      stable: false,
      factory: FACTORY as Hex,
    },
  ];

  const calldata = encodeFunctionData({
    abi: GET_AMOUNTS_OUT_ABI,
    functionName: 'getAmountsOut',
    args: [AMOUNT, route],
  });
  console.log(`  ✅ Data: ${calldata.slice(0, 42)}... (${calldata.length} chars)\n`);
  results.push({
    step: 'Encode calldata',
    status: 'PASS',
    details: `getAmountsOut(${AMOUNT}, [USDC→AERO])`,
  });

  // Step 3: Execute eth_call
  console.log('Step 3: Execute eth_call on Aerodrome Router');
  const rpcUrl = getRpcUrl('base');
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  try {
    const result = await publicClient.call({
      account: identity.address as Hex,
      to: AERODROME_ROUTER as Hex,
      data: calldata,
    });

    if (!result.data) {
      results.push({
        step: 'eth_call execution',
        status: 'FAIL',
        details: 'No data returned',
      });
      console.log(`  ❌ No data returned\n`);
    } else {
      results.push({
        step: 'eth_call execution',
        status: 'PASS',
        details: `Returned ${result.data.length} chars`,
      });
      console.log(`  ✅ Result: ${result.data.slice(0, 66)}...`);
      console.log(`  ✅ Length: ${result.data.length} chars\n`);

      // Step 4: Decode result
      console.log('Step 4: Decode result');
      try {
        const decoded = decodeFunctionResult({
          abi: GET_AMOUNTS_OUT_ABI,
          functionName: 'getAmountsOut',
          data: result.data,
        });

        const amounts = decoded as bigint[];
        const inputAmount = amounts[0];
        const outputAmount = amounts[1];

        results.push({
          step: 'Decode result',
          status: 'PASS',
          details: `Input: ${inputAmount}, Output: ${outputAmount}`,
        });

        // Format for display
        const inputFormatted = (Number(inputAmount) / 1e6).toFixed(2); // USDC has 6 decimals
        const outputFormatted = (Number(outputAmount) / 1e18).toFixed(6); // AERO has 18 decimals

        console.log(`  ✅ Input: ${inputFormatted} USDC`);
        console.log(`  ✅ Output: ${outputFormatted} AERO\n`);
      } catch (err) {
        results.push({
          step: 'Decode result',
          status: 'FAIL',
          details: String(err),
        });
        console.log(`  ❌ Decode failed: ${err}\n`);
      }
    }

    // Step 5: Verify response structure
    console.log('Step 5: Verify response includes resolvedIdentity');
    const response = createToolResponse(
      {
        result: result.data || '0x',
        blockTag: 'latest',
        chain: 'base',
        chainId: 8453,
      },
      identity
    );

    const hasResolvedIdentity = !!response.resolvedIdentity;
    const hasResult = !!response.result;

    results.push({
      step: 'Response structure',
      status: hasResolvedIdentity && hasResult ? 'PASS' : 'FAIL',
      details: `resolvedIdentity: ${hasResolvedIdentity}, result: ${hasResult}`,
    });

    console.log(`  ${hasResolvedIdentity ? '✅' : '❌'} Has resolvedIdentity`);
    console.log(`  ${hasResult ? '✅' : '❌'} Has result\n`);
  } catch (err) {
    results.push({
      step: 'eth_call execution',
      status: 'FAIL',
      details: String(err),
    });
    console.log(`  ❌ eth_call failed: ${err}\n`);
  }

  printSummary(results);
}

function printSummary(results: { step: string; status: 'PASS' | 'FAIL'; details: string }[]) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  for (const result of results) {
    const icon = result.status === 'PASS' ? '✅' : '❌';
    console.log(`${icon} ${result.step}: ${result.details}`);
  }

  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  console.log(`\nSTATUS: ${failed === 0 ? 'PASS' : 'FAIL'}`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
