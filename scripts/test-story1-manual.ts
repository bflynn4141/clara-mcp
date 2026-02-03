/**
 * User Story 1: Pre-Transaction Risk Check
 * Manual test showing what works and what needs Herd
 */

import { initProviders, shutdownProviders } from '../src/providers/index.js';
import { handleAnalyzeContract } from '../src/tools/analyze-contract.js';

const CONTRACTS = {
  UNISWAP_V4: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
  AERODROME: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
  USDC_ETH: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  RANDOM: '0x1234567890123456789012345678901234567890',
};

async function testScenario(name: string, address: string, chain: string) {
  console.log('\n' + '='.repeat(60));
  console.log('  Scenario: ' + name);
  console.log('  Contract: ' + address);
  console.log('  Chain: ' + chain);
  console.log('='.repeat(60));

  try {
    const result = await handleAnalyzeContract({ address, chain });
    console.log('\nResult:');
    console.log(result.content[0].text);
  } catch (error) {
    console.log('\nError:', error);
  }
}

async function main() {
  console.log('\n');
  console.log('+================================================================+');
  console.log('|        USER STORY 1: Pre-Transaction Risk Check               |');
  console.log('|        Testing without Herd MCP                               |');
  console.log('+================================================================+');

  console.log('\nInitializing providers...');
  await initProviders();

  // Test 1.1: Known Safe Contract (Uniswap)
  await testScenario(
    '1.1 - Known Safe Contract (Uniswap V4 Router)',
    CONTRACTS.UNISWAP_V4,
    'ethereum'
  );

  // Test 1.2: Base DEX (Aerodrome)
  await testScenario(
    '1.2 - Base DEX (Aerodrome Router)',
    CONTRACTS.AERODROME,
    'base'
  );

  // Test 1.3: Stablecoin (USDC)
  await testScenario(
    '1.3 - Stablecoin (USDC on Ethereum)',
    CONTRACTS.USDC_ETH,
    'ethereum'
  );

  // Test 1.4: Random/Unknown Contract
  await testScenario(
    '1.4 - Unknown Contract (should warn)',
    CONTRACTS.RANDOM,
    'ethereum'
  );

  console.log('\n\n>> Summary:');
  console.log('-'.repeat(60));
  console.log('Without Herd MCP, contract analysis is not available.');
  console.log('When Herd is installed, these tests will return:');
  console.log('  - Contract name and verification status');
  console.log('  - Function and event analysis');
  console.log('  - Proxy detection');
  console.log('  - Security flags (admin functions, age, etc.)');
  console.log('-'.repeat(60));

  await shutdownProviders();
}

main().catch(console.error);
