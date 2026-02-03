/**
 * Test script for Tenderly simulation integration
 *
 * Run with:
 *   TENDERLY_API_KEY=your-key npx tsx scripts/test-tenderly.ts
 */

import { simulateWithTenderly, isTenderlyConfigured, getTenderlyConfig } from '../src/providers/tenderly.js';

async function main() {
  console.log('🧪 Testing Tenderly Integration\n');

  // Check configuration
  console.log('1. Checking configuration...');
  const config = getTenderlyConfig();
  if (!config) {
    console.error('❌ TENDERLY_API_KEY not set');
    console.log('\nSet it with:');
    console.log('  export TENDERLY_API_KEY=your-api-key');
    process.exit(1);
  }

  console.log('✅ Tenderly configured');
  console.log(`   Account: ${config.accountSlug}`);
  console.log(`   Project: ${config.projectSlug}`);
  console.log(`   API Key: ${config.apiKey.slice(0, 8)}...`);

  // Test simulation - a simple USDC approval on Base
  console.log('\n2. Testing simulation...');

  const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const TEST_ADDRESS = '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd'; // Your Clara wallet

  // Simulate a simple balanceOf call (read-only, won't fail)
  const result = await simulateWithTenderly(
    {
      to: USDC_BASE,
      // balanceOf(address) - read the test address balance
      data: '0x70a08231000000000000000000000000' + TEST_ADDRESS.slice(2),
      value: '0',
    },
    TEST_ADDRESS,
    'base'
  );

  if (!result) {
    console.error('❌ Tenderly simulation returned null (API error)');
    process.exit(1);
  }

  console.log('✅ Tenderly simulation successful!');
  console.log(`   Will revert: ${result.willRevert}`);
  console.log(`   Gas used: ${result.gasUsed}`);
  console.log(`   Balance changes: ${result.balanceChanges.length}`);

  if (result.balanceChanges.length > 0) {
    console.log('\n   Token changes:');
    for (const change of result.balanceChanges) {
      const symbol = change.symbol || change.token.slice(0, 10);
      const prefix = change.direction === 'increase' ? '+' : '-';
      console.log(`   ${prefix}${change.formattedAmount} ${symbol}`);
    }
  }

  // Test a claim simulation if you have a staking contract
  console.log('\n3. Testing claim simulation (optional)...');

  // Example: Simulate claiming from a known staking contract
  // Replace with an actual staking contract you have rewards on
  const EXAMPLE_STAKING = '0x...'; // Replace with real address

  if (EXAMPLE_STAKING !== '0x...') {
    const claimResult = await simulateWithTenderly(
      {
        to: EXAMPLE_STAKING,
        // getReward() selector
        data: '0x3d18b912',
        value: '0',
      },
      TEST_ADDRESS,
      'base'
    );

    if (claimResult && !claimResult.willRevert) {
      console.log('✅ Claim simulation successful!');
      for (const change of claimResult.balanceChanges) {
        console.log(`   Would receive: +${change.formattedAmount} ${change.symbol || 'tokens'}`);
      }
    }
  } else {
    console.log('   Skipped (no staking contract configured)');
  }

  console.log('\n✅ Tenderly integration working!');
}

main().catch(console.error);
