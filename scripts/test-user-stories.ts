#!/usr/bin/env npx tsx
/**
 * User Story Test Script
 *
 * Tests Clara + Herd integration with real trending contracts.
 * Run with: HERD_ENABLED=true npx tsx scripts/test-user-stories.ts
 *
 * See docs/user-stories-herd.md for full documentation.
 */

import { initProviders, shutdownProviders } from '../src/providers/index.js';
import { handleAnalyzeContract } from '../src/tools/analyze-contract.js';
import { handleAnalyzeTx } from '../src/tools/analyze-tx.js';
import { isHerdEnabled } from '../src/providers/herd.js';

// ============================================================================
// Trending Contracts (January 2026)
// ============================================================================

const CONTRACTS = {
  // Ethereum Mainnet
  ethereum: {
    // Stablecoins
    USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    // DEX
    UNISWAP_V4_ROUTER: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
    METAMASK_SWAP: '0x881d40237659c251811cec9c364ef91dc08d300c',
    // Yield
    PENDLE: '0x808507121b80c02388fad14726482e061b8da827',
    LIDO_STETH: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
    // Restaking
    EIGENLAYER_STRATEGY: '0x858646372CC42E1A627fcE94aa7A7033e7CF075A',
    // Unknown/Test
    RANDOM_ADDRESS: '0x1234567890123456789012345678901234567890',
  },
  // Base
  base: {
    AERODROME_ROUTER: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
    AERO_TOKEN: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    CBETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  },
};

// ============================================================================
// Test Utilities
// ============================================================================

function log(emoji: string, message: string) {
  console.log(`${emoji} ${message}`);
}

function section(title: string) {
  console.log('\n' + '━'.repeat(70));
  console.log(`  ${title}`);
  console.log('━'.repeat(70) + '\n');
}

function subsection(title: string) {
  console.log(`\n▸ ${title}\n`);
}

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  output?: string;
  error?: string;
}

async function runTest(
  name: string,
  fn: () => Promise<{ content: Array<{ type: string; text: string }> }>
): Promise<TestResult> {
  const start = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - start;
    const output = result.content[0]?.text || '';

    // Basic validation
    const passed = output.length > 50 && !output.includes('Error') && !output.includes('failed');

    if (passed) {
      log('✅', `${name} (${duration}ms)`);
    } else {
      log('⚠️', `${name} - unexpected output (${duration}ms)`);
    }

    // Show preview of output
    console.log('   ' + output.split('\n').slice(0, 3).join('\n   ') + '...\n');

    return { name, passed, duration, output };
  } catch (error) {
    const duration = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    log('❌', `${name} FAILED: ${message}`);
    return { name, passed: false, duration, error: message };
  }
}

// ============================================================================
// User Story 1: Pre-Transaction Risk Check
// ============================================================================

async function testRiskCheck(): Promise<TestResult[]> {
  section('USER STORY 1: Pre-Transaction Risk Check');
  const results: TestResult[] = [];

  // 1.1: Known Safe - Uniswap
  subsection('1.1: Known Safe Contract (Uniswap V4 Router)');
  results.push(
    await runTest('Analyze Uniswap V4 Router', () =>
      handleAnalyzeContract({
        address: CONTRACTS.ethereum.UNISWAP_V4_ROUTER,
        chain: 'ethereum',
      })
    )
  );

  // 1.2: Upgradeable Proxy - EigenLayer
  subsection('1.2: Upgradeable Proxy (EigenLayer StrategyManager)');
  results.push(
    await runTest('Analyze EigenLayer StrategyManager', () =>
      handleAnalyzeContract({
        address: CONTRACTS.ethereum.EIGENLAYER_STRATEGY,
        chain: 'ethereum',
      })
    )
  );

  // 1.3: Unknown Contract
  subsection('1.3: Unknown/Suspicious Contract');
  results.push(
    await runTest('Analyze Random Address', () =>
      handleAnalyzeContract({
        address: CONTRACTS.ethereum.RANDOM_ADDRESS,
        chain: 'ethereum',
      })
    )
  );

  // 1.4: Base DEX
  subsection('1.4: Base DEX (Aerodrome Router)');
  results.push(
    await runTest('Analyze Aerodrome Router', () =>
      handleAnalyzeContract({
        address: CONTRACTS.base.AERODROME_ROUTER,
        chain: 'base',
      })
    )
  );

  return results;
}

// ============================================================================
// User Story 2: Token Utility Discovery
// ============================================================================

async function testTokenUtility(): Promise<TestResult[]> {
  section('USER STORY 2: Token Utility Discovery');
  const results: TestResult[] = [];

  // 2.1: Governance Token - AERO
  subsection('2.1: Governance Token (AERO)');
  results.push(
    await runTest('Analyze AERO Token', () =>
      handleAnalyzeContract({
        address: CONTRACTS.base.AERO_TOKEN,
        chain: 'base',
      })
    )
  );

  // 2.2: Yield Protocol - Pendle
  subsection('2.2: Yield Protocol Token (PENDLE)');
  results.push(
    await runTest('Analyze PENDLE Token', () =>
      handleAnalyzeContract({
        address: CONTRACTS.ethereum.PENDLE,
        chain: 'ethereum',
      })
    )
  );

  // 2.3: Liquid Staking - stETH
  subsection('2.3: Liquid Staking Token (stETH)');
  results.push(
    await runTest('Analyze Lido stETH', () =>
      handleAnalyzeContract({
        address: CONTRACTS.ethereum.LIDO_STETH,
        chain: 'ethereum',
      })
    )
  );

  // 2.4: Stablecoin - USDC
  subsection('2.4: Stablecoin (USDC)');
  results.push(
    await runTest('Analyze USDC', () =>
      handleAnalyzeContract({
        address: CONTRACTS.ethereum.USDC,
        chain: 'ethereum',
      })
    )
  );

  return results;
}

// ============================================================================
// User Story 3: Transaction Decoder
// ============================================================================

async function testTransactionDecoder(): Promise<TestResult[]> {
  section('USER STORY 3: Transaction Decoder');
  const results: TestResult[] = [];

  log('ℹ️', 'Transaction analysis requires real tx hashes.');
  log('ℹ️', 'To test manually, run:');
  log('ℹ️', '  wallet_analyze_tx hash=0x... chain=ethereum');
  log('');
  log('ℹ️', 'Find recent transactions at:');
  log('ℹ️', '  - https://etherscan.io/txs');
  log('ℹ️', '  - https://basescan.org/txs');

  // If you have specific tx hashes to test, add them here:
  // results.push(await runTest('Analyze Swap TX', () =>
  //   handleAnalyzeTx({
  //     hash: '0x...',
  //     chain: 'ethereum',
  //   })
  // ));

  return results;
}

// ============================================================================
// User Story 5: Approval Analysis (via Contract Analysis)
// ============================================================================

async function testApprovalAnalysis(): Promise<TestResult[]> {
  section('USER STORY 5: Approval Analysis');
  const results: TestResult[] = [];

  // 5.1: Analyze DEX Router (potential approval target)
  subsection('5.1: Standard DEX (Aerodrome - would user approve?)');
  results.push(
    await runTest('Analyze Aerodrome as Spender', () =>
      handleAnalyzeContract({
        address: CONTRACTS.base.AERODROME_ROUTER,
        chain: 'base',
      })
    )
  );

  // 5.2: Analyze MetaMask Swap Router
  subsection('5.2: Aggregator (MetaMask Swap Router)');
  results.push(
    await runTest('Analyze MetaMask Swap as Spender', () =>
      handleAnalyzeContract({
        address: CONTRACTS.ethereum.METAMASK_SWAP,
        chain: 'ethereum',
      })
    )
  );

  return results;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                    CLARA USER STORY TESTS                            ║');
  console.log('║              Testing Herd Integration with Trending Contracts        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('\n');

  // Check environment
  if (process.env.HERD_ENABLED !== 'true') {
    log('⚠️', 'HERD_ENABLED is not set to "true"');
    log('ℹ️', 'Run with: HERD_ENABLED=true npx tsx scripts/test-user-stories.ts');
    process.exit(1);
  }

  // Initialize providers
  log('🚀', 'Initializing providers...');
  try {
    await initProviders();
  } catch (error) {
    log('❌', `Failed to initialize providers: ${error}`);
    process.exit(1);
  }

  if (!isHerdEnabled()) {
    log('❌', 'Herd MCP not available.');
    log('ℹ️', 'These tests require Herd MCP to be installed.');
    log('ℹ️', 'See docs/user-stories-herd.md for prerequisites.');
    process.exit(1);
  }

  log('✅', 'Herd MCP connected!\n');

  // Run all user story tests
  const allResults: TestResult[] = [];

  try {
    allResults.push(...(await testRiskCheck()));
    allResults.push(...(await testTokenUtility()));
    allResults.push(...(await testTransactionDecoder()));
    allResults.push(...(await testApprovalAnalysis()));
  } catch (error) {
    log('❌', `Test suite error: ${error}`);
  }

  // Summary
  section('TEST SUMMARY');

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  const totalDuration = allResults.reduce((sum, r) => sum + r.duration, 0);

  console.log(`Total Tests: ${allResults.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Success Rate: ${allResults.length > 0 ? ((passed / allResults.length) * 100).toFixed(1) : 0}%`);
  console.log(`Total Duration: ${(totalDuration / 1000).toFixed(1)}s`);

  if (failed > 0) {
    console.log('\nFailed Tests:');
    for (const result of allResults.filter((r) => !r.passed)) {
      console.log(`  - ${result.name}: ${result.error || 'unexpected output'}`);
    }
  }

  // Cleanup
  log('\n🧹', 'Shutting down providers...');
  await shutdownProviders();

  log('✅', 'Done!');

  // Exit with error code if any tests failed
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
