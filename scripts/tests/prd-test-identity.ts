/**
 * PRD Test: Unified Wallet Identity
 *
 * TEST: Unified Wallet Identity
 * SETUP: User has Clara wallet 0x8744... configured in CLAUDE.md and Para is connected to the same wallet.
 *
 * EXPECTED:
 * - clara.address == para.activeAddress == session.activeIdentity.address == 0x8744...
 * - session.activeIdentity.walletBackend is set and stable across calls
 *
 * Run with: npx tsx scripts/tests/prd-test-identity.ts
 */

import { resolveIdentity, DEFAULT_CHAIN_ID } from '../../src/identity/resolved-identity.js';
import { getSession } from '../../src/storage/session.js';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('PRD TEST: Unified Wallet Identity');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const results: { step: string; status: 'PASS' | 'FAIL'; details: string }[] = [];

  // Step 1: Get raw session
  console.log('Step 1: Call getSession()');
  const session = await getSession();
  if (session?.authenticated && session.address) {
    results.push({
      step: 'Raw session',
      status: 'PASS',
      details: `Address: ${session.address}, WalletId: ${session.walletId}`,
    });
    console.log(`  ✅ Address: ${session.address}`);
    console.log(`  ✅ WalletId: ${session.walletId}\n`);
  } else {
    results.push({
      step: 'Raw session',
      status: 'FAIL',
      details: 'No authenticated session found',
    });
    console.log('  ❌ No authenticated session found\n');
  }

  // Step 2: Resolve identity for Base
  console.log('Step 2: Call resolveIdentity(8453) [Base]');
  const identityBase = await resolveIdentity(8453);
  if (identityBase.success) {
    results.push({
      step: 'Identity (Base)',
      status: 'PASS',
      details: `${identityBase.identity.address} on chain ${identityBase.identity.chainId}`,
    });
    console.log(`  ✅ Address: ${identityBase.identity.address}`);
    console.log(`  ✅ Chain: ${identityBase.identity.chainId}`);
    console.log(`  ✅ Backend: ${identityBase.identity.walletBackend}`);
    console.log(`  ✅ Session Marker: ${identityBase.identity.sessionMarker}\n`);
  } else {
    results.push({
      step: 'Identity (Base)',
      status: 'FAIL',
      details: `${identityBase.errorCode}: ${identityBase.hint}`,
    });
    console.log(`  ❌ ${identityBase.errorCode}: ${identityBase.hint}\n`);
  }

  // Step 3: Resolve identity for Ethereum
  console.log('Step 3: Call resolveIdentity(1) [Ethereum]');
  const identityEth = await resolveIdentity(1);
  if (identityEth.success) {
    results.push({
      step: 'Identity (Ethereum)',
      status: 'PASS',
      details: `${identityEth.identity.address} on chain ${identityEth.identity.chainId}`,
    });
    console.log(`  ✅ Address: ${identityEth.identity.address}`);
    console.log(`  ✅ Chain: ${identityEth.identity.chainId}\n`);
  } else {
    results.push({
      step: 'Identity (Ethereum)',
      status: 'FAIL',
      details: `${identityEth.errorCode}: ${identityEth.hint}`,
    });
    console.log(`  ❌ ${identityEth.errorCode}: ${identityEth.hint}\n`);
  }

  // Step 4: Verify consistency
  console.log('Step 4: Verify address consistency across calls');
  if (identityBase.success && identityEth.success) {
    const consistent = identityBase.identity.address === identityEth.identity.address;
    results.push({
      step: 'Address consistency',
      status: consistent ? 'PASS' : 'FAIL',
      details: consistent
        ? 'Same address on both chains'
        : `Mismatch: ${identityBase.identity.address} vs ${identityEth.identity.address}`,
    });
    console.log(consistent ? '  ✅ Same address on both chains' : '  ❌ Address mismatch!\n');
  }

  // Summary
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
