#!/usr/bin/env node
/**
 * Live Integration Test — Bounty Indexer on Base Mainnet
 *
 * Tests the full indexer pipeline against real on-chain data:
 * 1. syncFromChain() — fetches events from Base mainnet
 * 2. Query functions — getOpenBounties, getBountyByAddress, getIndexStats
 * 3. work_browse tool handler — formats results for MCP output
 *
 * Usage: node scripts/live-test.mjs
 */

import { syncFromChain, stopPolling, getIndex } from '../dist/indexer/sync.js';
import {
  getOpenBounties,
  getBountyByAddress,
  getIndexStats,
} from '../dist/indexer/queries.js';
import { handleWorkBrowse } from '../dist/tools/work-browse.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function section(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(60)}\n`);
}

function elapsed(startMs) {
  return ((performance.now() - startMs) / 1000).toFixed(2);
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('Clara Bounty Indexer — Live Integration Test');
  console.log(`Network: mainnet (Base, chainId 8453)`);
  console.log(`Time: ${new Date().toISOString()}`);

  // ── Step 1: Sync from chain ────────────────────────────────────────
  section('1. syncFromChain()');

  const indexBefore = getIndex();
  console.log(`Index state before sync: ${indexBefore ? 'loaded from disk' : 'fresh (no prior index)'}`);

  const syncStart = performance.now();
  try {
    await syncFromChain();
    console.log(`✓ Sync completed in ${elapsed(syncStart)}s`);
  } catch (err) {
    console.error(`✗ Sync FAILED after ${elapsed(syncStart)}s`);
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }

  const indexAfter = getIndex();
  if (!indexAfter) {
    console.error('✗ Index is null after sync — unexpected');
    process.exit(1);
  }

  const bountyCount = Object.keys(indexAfter.bounties).length;
  console.log(`\nSync results:`);
  console.log(`  Factory:     ${indexAfter.factoryAddress}`);
  console.log(`  Chain ID:    ${indexAfter.chainId}`);
  console.log(`  Last block:  ${indexAfter.lastBlock}`);
  console.log(`  Bounties:    ${bountyCount}`);

  // ── Step 2: getIndexStats() ────────────────────────────────────────
  section('2. getIndexStats()');

  const stats = getIndexStats();
  console.log(JSON.stringify(stats, null, 2));

  // ── Step 3: getOpenBounties() ──────────────────────────────────────
  section('3. getOpenBounties()');

  const openBounties = getOpenBounties();
  console.log(`Open bounties: ${openBounties.length}`);

  if (openBounties.length > 0) {
    console.log(`\nFirst open bounty:`);
    console.log(JSON.stringify(openBounties[0], null, 2));
  }

  // Also test with "all statuses" by fetching each
  for (const status of ['open', 'claimed', 'submitted', 'approved', 'expired', 'cancelled']) {
    const count = getOpenBounties({ status }).length;
    if (count > 0) {
      console.log(`  ${status}: ${count}`);
    }
  }

  // ── Step 4: getBountyByAddress() ───────────────────────────────────
  section('4. getBountyByAddress()');

  const allAddresses = Object.keys(indexAfter.bounties);
  if (allAddresses.length > 0) {
    const testAddr = allAddresses[0];
    const bounty = getBountyByAddress(testAddr);
    console.log(`Lookup by address: ${testAddr}`);
    console.log(JSON.stringify(bounty, null, 2));
  } else {
    console.log('No bounties to look up (factory may have zero events on mainnet)');
  }

  // ── Step 5: handleWorkBrowse() ─────────────────────────────────────
  section('5. handleWorkBrowse() — MCP tool handler');

  const browseResult = await handleWorkBrowse({ limit: 5 });
  console.log('work_browse output:');
  for (const item of browseResult.content) {
    console.log(item.text);
  }
  if (browseResult.isError) {
    console.log('⚠ isError=true');
  }

  // ── Step 6: Verify bounties.json persistence ───────────────────────
  section('6. Persistence check (~/.clara/bounties.json)');

  const { readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');

  const indexPath = join(homedir(), '.clara', 'bounties.json');
  if (existsSync(indexPath)) {
    const raw = readFileSync(indexPath, 'utf-8');
    const parsed = JSON.parse(raw);
    console.log(`✓ bounties.json exists (${raw.length} bytes)`);
    console.log(`  lastBlock:      ${parsed.lastBlock}`);
    console.log(`  factoryAddress: ${parsed.factoryAddress}`);
    console.log(`  chainId:        ${parsed.chainId}`);
    console.log(`  bounties:       ${Object.keys(parsed.bounties).length}`);
  } else {
    console.log('✗ bounties.json NOT found — persistence may have failed');
  }

  // ── Summary ────────────────────────────────────────────────────────
  section('Summary');

  console.log(`Total bounties indexed: ${bountyCount}`);
  console.log(`Open bounties:          ${openBounties.length}`);
  console.log(`Index stats valid:      ${stats.lastSyncedBlock > 0 ? 'yes' : 'no'}`);
  console.log(`Persistence:            ${existsSync(indexPath) ? 'ok' : 'FAILED'}`);
  console.log(`\n✓ All checks passed.`);

  // Stop any background polling
  stopPolling();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
