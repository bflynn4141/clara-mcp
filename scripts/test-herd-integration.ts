#!/usr/bin/env npx tsx
/**
 * Herd Integration Test Script
 *
 * Tests all Herd-powered tools with real contracts and transactions.
 * Run with: HERD_ENABLED=true npx tsx scripts/test-herd-integration.ts
 *
 * Prerequisites:
 * - HERD_ENABLED=true in environment
 * - Herd MCP installed and accessible (see below)
 * - Optional: ZERION_API_KEY for history tests
 *
 * Herd MCP Installation:
 * Herd MCP is not yet publicly available on npm. When it becomes available:
 *
 * Option 1: Use npx (default)
 *   HERD_MCP_ARGS="@anthropic/herd" HERD_ENABLED=true npx tsx scripts/test-herd-integration.ts
 *
 * Option 2: Local installation
 *   npm install @anthropic/herd
 *   HERD_MCP_COMMAND="node" HERD_MCP_ARGS="node_modules/@anthropic/herd/dist/index.js" HERD_ENABLED=true npx tsx scripts/test-herd-integration.ts
 *
 * Option 3: Custom MCP server path
 *   HERD_MCP_COMMAND="/path/to/herd-mcp" HERD_MCP_ARGS="" HERD_ENABLED=true npx tsx scripts/test-herd-integration.ts
 *
 * Until Herd is available, you can test the fallback behavior (Zerion-only):
 *   npx tsx scripts/test-herd-integration.ts --fallback-only
 */

import { initProviders, shutdownProviders, getProviderRegistry } from '../src/providers/index.js';
import { handleAnalyzeContract } from '../src/tools/analyze-contract.js';
import { handleAnalyzeTx } from '../src/tools/analyze-tx.js';
import { handleMonitorEvents } from '../src/tools/monitor-events.js';
import { assessContractRisk, formatRiskAssessment } from '../src/services/risk.js';
import { isHerdEnabled } from '../src/providers/herd.js';

// ============================================================================
// Test Data - Real Mainnet Contracts & Transactions
// ============================================================================

const TEST_CONTRACTS = {
  // Well-known verified contracts
  USDC_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDC_ETH: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  UNISWAP_V3_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  WETH_ETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',

  // Proxy contract (for testing proxy detection)
  AAVE_V3_POOL: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',

  // NFT contract
  NOUNS_ETH: '0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03',
};

const TEST_TRANSACTIONS = {
  // USDC Transfer on Base
  USDC_TRANSFER_BASE: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', // Replace with real tx

  // Uniswap Swap on Ethereum
  UNISWAP_SWAP_ETH: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890', // Replace with real tx

  // Real example transactions (you can find these on block explorers)
  // Replace these with actual tx hashes you want to test
};

// ============================================================================
// Test Utilities
// ============================================================================

function log(emoji: string, message: string) {
  console.log(`${emoji} ${message}`);
}

function section(title: string) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60) + '\n');
}

function subsection(title: string) {
  console.log(`\n--- ${title} ---\n`);
}

async function runTest<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ success: boolean; result?: T; error?: string; duration: number }> {
  const start = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - start;
    log('✅', `${name} (${duration}ms)`);
    return { success: true, result, duration };
  } catch (error) {
    const duration = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    log('❌', `${name} FAILED: ${message}`);
    return { success: false, error: message, duration };
  }
}

// ============================================================================
// Test: Contract Analysis
// ============================================================================

async function testContractAnalysis() {
  section('CONTRACT ANALYSIS TESTS');

  // Test 1: Analyze USDC on Base
  subsection('1. Analyze USDC on Base');
  const usdcResult = await runTest('Analyze USDC Base', async () => {
    return await handleAnalyzeContract({
      address: TEST_CONTRACTS.USDC_BASE,
      chain: 'base',
    });
  });
  if (usdcResult.success && usdcResult.result) {
    console.log(usdcResult.result.content[0].text.slice(0, 500) + '...');
  }

  // Test 2: Analyze USDC on Ethereum
  subsection('2. Analyze USDC on Ethereum');
  const usdcEthResult = await runTest('Analyze USDC Ethereum', async () => {
    return await handleAnalyzeContract({
      address: TEST_CONTRACTS.USDC_ETH,
      chain: 'ethereum',
    });
  });
  if (usdcEthResult.success && usdcEthResult.result) {
    console.log(usdcEthResult.result.content[0].text.slice(0, 500) + '...');
  }

  // Test 3: Analyze proxy contract (Aave)
  subsection('3. Analyze Proxy Contract (Aave V3 Pool)');
  const aaveResult = await runTest('Analyze Aave V3 Pool', async () => {
    return await handleAnalyzeContract({
      address: TEST_CONTRACTS.AAVE_V3_POOL,
      chain: 'ethereum',
    });
  });
  if (aaveResult.success && aaveResult.result) {
    console.log(aaveResult.result.content[0].text.slice(0, 500) + '...');
  }

  // Test 4: Analyze NFT contract
  subsection('4. Analyze NFT Contract (Nouns)');
  const nounsResult = await runTest('Analyze Nouns NFT', async () => {
    return await handleAnalyzeContract({
      address: TEST_CONTRACTS.NOUNS_ETH,
      chain: 'ethereum',
    });
  });
  if (nounsResult.success && nounsResult.result) {
    console.log(nounsResult.result.content[0].text.slice(0, 500) + '...');
  }

  // Test 5: Unsupported chain (should gracefully fail)
  subsection('5. Unsupported Chain (Polygon - should fail gracefully)');
  const polygonResult = await runTest('Analyze on Polygon (expected fail)', async () => {
    return await handleAnalyzeContract({
      address: TEST_CONTRACTS.USDC_BASE,
      chain: 'polygon',
    });
  });
  if (polygonResult.result) {
    console.log(polygonResult.result.content[0].text);
  }

  return { usdcResult, usdcEthResult, aaveResult, nounsResult, polygonResult };
}

// ============================================================================
// Test: Transaction Analysis
// ============================================================================

async function testTransactionAnalysis() {
  section('TRANSACTION ANALYSIS TESTS');

  // For this test, we need real transaction hashes
  // You can find these on Etherscan/Basescan

  subsection('1. Analyze a recent Ethereum transaction');
  log('ℹ️', 'To test transaction analysis, provide a real tx hash:');
  log('ℹ️', 'Example: npx tsx scripts/test-herd-integration.ts --tx 0x...');

  // If you have a test tx hash, uncomment and use:
  /*
  const txResult = await runTest('Analyze Transaction', async () => {
    return await handleAnalyzeTx({
      hash: '0x...your-tx-hash...',
      chain: 'ethereum',
    });
  });
  if (txResult.success && txResult.result) {
    console.log(txResult.result.content[0].text);
  }
  */

  return {};
}

// ============================================================================
// Test: Event Monitoring
// ============================================================================

async function testEventMonitoring() {
  section('EVENT MONITORING TESTS');

  // Test 1: Monitor Transfer events on USDC
  subsection('1. Monitor USDC Transfer Events on Ethereum');
  const transferResult = await runTest('Monitor USDC Transfers', async () => {
    return await handleMonitorEvents({
      address: TEST_CONTRACTS.USDC_ETH,
      chain: 'ethereum',
      event: 'Transfer',
      limit: 5,
    });
  });
  if (transferResult.success && transferResult.result) {
    console.log(transferResult.result.content[0].text.slice(0, 1000) + '...');
  }

  // Test 2: Monitor Approval events
  subsection('2. Monitor USDC Approval Events');
  const approvalResult = await runTest('Monitor USDC Approvals', async () => {
    return await handleMonitorEvents({
      address: TEST_CONTRACTS.USDC_ETH,
      chain: 'ethereum',
      event: 'Approval',
      limit: 5,
    });
  });
  if (approvalResult.success && approvalResult.result) {
    console.log(approvalResult.result.content[0].text.slice(0, 1000) + '...');
  }

  // Test 3: Monitor all events (no filter)
  subsection('3. Monitor All WETH Events');
  const allEventsResult = await runTest('Monitor WETH All Events', async () => {
    return await handleMonitorEvents({
      address: TEST_CONTRACTS.WETH_ETH,
      chain: 'ethereum',
      limit: 5,
    });
  });
  if (allEventsResult.success && allEventsResult.result) {
    console.log(allEventsResult.result.content[0].text.slice(0, 1000) + '...');
  }

  return { transferResult, approvalResult, allEventsResult };
}

// ============================================================================
// Test: Risk Assessment
// ============================================================================

async function testRiskAssessment() {
  section('RISK ASSESSMENT TESTS');

  // Test 1: Known safe contract (USDC)
  subsection('1. Risk Assessment - Known Safe (USDC)');
  const usdcRisk = await runTest('Assess USDC Risk', async () => {
    const assessment = await assessContractRisk(TEST_CONTRACTS.USDC_ETH, 'ethereum');
    return {
      recommendation: assessment.recommendation,
      signals: assessment.signals.length,
      formatted: formatRiskAssessment(assessment),
    };
  });
  if (usdcRisk.success && usdcRisk.result) {
    console.log(`Recommendation: ${usdcRisk.result.recommendation}`);
    console.log(`Signals: ${usdcRisk.result.signals}`);
    console.log(usdcRisk.result.formatted.join('\n'));
  }

  // Test 2: Proxy contract (might flag as upgradeable)
  subsection('2. Risk Assessment - Upgradeable Proxy (Aave)');
  const aaveRisk = await runTest('Assess Aave Risk', async () => {
    const assessment = await assessContractRisk(TEST_CONTRACTS.AAVE_V3_POOL, 'ethereum');
    return {
      recommendation: assessment.recommendation,
      signals: assessment.signals.length,
      formatted: formatRiskAssessment(assessment),
    };
  });
  if (aaveRisk.success && aaveRisk.result) {
    console.log(`Recommendation: ${aaveRisk.result.recommendation}`);
    console.log(`Signals: ${aaveRisk.result.signals}`);
    console.log(aaveRisk.result.formatted.join('\n'));
  }

  // Test 3: Random address (unverified - should flag)
  subsection('3. Risk Assessment - Random Address (should flag as unverified)');
  const randomRisk = await runTest('Assess Random Address Risk', async () => {
    const assessment = await assessContractRisk('0x1234567890123456789012345678901234567890', 'ethereum');
    return {
      recommendation: assessment.recommendation,
      signals: assessment.signals.length,
      formatted: formatRiskAssessment(assessment),
    };
  });
  if (randomRisk.success && randomRisk.result) {
    console.log(`Recommendation: ${randomRisk.result.recommendation}`);
    console.log(`Signals: ${randomRisk.result.signals}`);
    console.log(randomRisk.result.formatted.join('\n'));
  }

  return { usdcRisk, aaveRisk, randomRisk };
}

// ============================================================================
// Test: Provider Registry
// ============================================================================

async function testProviderRegistry() {
  section('PROVIDER REGISTRY TESTS');

  const registry = getProviderRegistry();
  const status = registry.getStatus();

  subsection('1. Registered Providers');
  console.log('History Providers:', status.providers.history);
  console.log('Tx Analysis Providers:', status.providers.txAnalysis);
  console.log('Contract Intel Providers:', status.providers.contractIntel);
  console.log('Event Monitor Providers:', status.providers.eventMonitor);
  console.log('Research Providers:', status.providers.research);

  subsection('2. Chain Support');
  for (const support of status.chainSupport) {
    console.log(`${support.provider} -> ${support.capability}: ${support.chains.join(', ')} (priority: ${support.priority})`);
  }

  subsection('3. Capability Checks');
  const capabilities = ['TxAnalysis', 'ContractMetadata', 'EventMonitor', 'HistoryList'] as const;
  const chains = ['ethereum', 'base', 'arbitrum', 'polygon'] as const;

  for (const cap of capabilities) {
    const supported = chains.filter(c => registry.hasCapability(cap, c));
    console.log(`${cap}: ${supported.join(', ') || 'none'}`);
  }

  return { status };
}

// ============================================================================
// Test: Caching
// ============================================================================

async function testCaching() {
  section('CACHING TESTS');

  // Test cache hit/miss by analyzing same contract twice
  subsection('1. First Request (should be cache miss)');
  const firstResult = await runTest('First USDC Analysis', async () => {
    return await handleAnalyzeContract({
      address: TEST_CONTRACTS.USDC_ETH,
      chain: 'ethereum',
    });
  });

  subsection('2. Second Request (should be cache hit - faster)');
  const secondResult = await runTest('Second USDC Analysis (cached)', async () => {
    return await handleAnalyzeContract({
      address: TEST_CONTRACTS.USDC_ETH,
      chain: 'ethereum',
    });
  });

  if (firstResult.success && secondResult.success) {
    const speedup = firstResult.duration / secondResult.duration;
    log('📊', `Speedup from caching: ${speedup.toFixed(1)}x (${firstResult.duration}ms -> ${secondResult.duration}ms)`);
  }

  return { firstResult, secondResult };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const fallbackOnly = process.argv.includes('--fallback-only');

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           HERD INTEGRATION TEST SUITE                        ║');
  console.log('║           Clara MCP + Herd MCP                               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('\n');

  if (fallbackOnly) {
    log('ℹ️', 'Running in fallback-only mode (no Herd)');
    log('ℹ️', 'This tests Zerion integration without Herd MCP\n');
  }

  // Check environment
  if (!fallbackOnly && process.env.HERD_ENABLED !== 'true') {
    log('⚠️', 'HERD_ENABLED is not set to "true"');
    log('ℹ️', 'Run with: HERD_ENABLED=true npx tsx scripts/test-herd-integration.ts');
    log('ℹ️', 'Or run with --fallback-only to test without Herd');
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

  if (!fallbackOnly && !isHerdEnabled()) {
    log('❌', 'Herd failed to initialize.');
    log('');
    log('ℹ️', 'Herd MCP is not yet publicly available on npm.');
    log('ℹ️', 'When Anthropic releases it, configure with:');
    log('ℹ️', '  HERD_MCP_ARGS="@anthropic/herd" HERD_ENABLED=true npx tsx scripts/test-herd-integration.ts');
    log('');
    log('ℹ️', 'To test Zerion fallback mode only:');
    log('ℹ️', '  npx tsx scripts/test-herd-integration.ts --fallback-only');
    process.exit(1);
  }

  if (!fallbackOnly) {
    log('✅', 'Herd MCP connected successfully!\n');
  }

  // Run all tests
  const results: Record<string, unknown> = {};

  try {
    results.providerRegistry = await testProviderRegistry();

    if (fallbackOnly) {
      log('ℹ️', 'Skipping Herd-specific tests in fallback mode\n');
      log('ℹ️', 'The following tests require Herd MCP:');
      log('ℹ️', '  - Contract Analysis');
      log('ℹ️', '  - Event Monitoring');
      log('ℹ️', '  - Caching (contract metadata)');
    } else {
      results.contractAnalysis = await testContractAnalysis();
      results.eventMonitoring = await testEventMonitoring();
      results.caching = await testCaching();
    }

    // Risk assessment can work without Herd (uses local heuristics)
    results.riskAssessment = await testRiskAssessment();

    // results.transactionAnalysis = await testTransactionAnalysis(); // Needs real tx hash
  } catch (error) {
    log('❌', `Test suite error: ${error}`);
  }

  // Summary
  section('TEST SUMMARY');

  let totalTests = 0;
  let passedTests = 0;

  function countResults(obj: unknown) {
    if (obj && typeof obj === 'object') {
      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object' && 'success' in value) {
          totalTests++;
          if ((value as { success: boolean }).success) passedTests++;
        } else if (typeof value === 'object') {
          countResults(value);
        }
      }
    }
  }
  countResults(results);

  console.log(`Total Tests: ${totalTests}`);
  console.log(`Passed: ${passedTests}`);
  console.log(`Failed: ${totalTests - passedTests}`);
  console.log(`Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);

  // Cleanup
  log('🧹', 'Shutting down providers...');
  await shutdownProviders();

  log('✅', 'Done!');
}

main().catch(console.error);
