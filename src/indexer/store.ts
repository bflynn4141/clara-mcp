/**
 * Bounty Index Persistence
 *
 * Stores the bounty index at ~/.clara/bounties.json.
 * Follows the same load/save pattern as storage/spending.ts.
 *
 * Fail-safe: returns a fresh empty index if the file is
 * missing or corrupt, so the indexer re-syncs from chain.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { BountyIndex } from './types.js';
import { getBountyContracts, getClaraContracts } from '../config/clara-contracts.js';
import { FACTORY_DEPLOY_BLOCK } from '../config/clara-contracts.js';

const CLARA_DIR = join(homedir(), '.clara');
const INDEX_FILE = join(CLARA_DIR, 'bounties.json');

function ensureDir(): void {
  if (!existsSync(CLARA_DIR)) {
    mkdirSync(CLARA_DIR, { recursive: true });
  }
}

/**
 * Build a default empty index for the current network.
 * lastBlock starts at the factory deploy block so the first
 * sync fetches all historical events.
 */
function defaultIndex(): BountyIndex {
  const { bountyFactory, identityRegistry } = getBountyContracts();
  const { chainId } = getClaraContracts();
  return {
    lastBlock: Number(FACTORY_DEPLOY_BLOCK),
    factoryAddress: bountyFactory.toLowerCase(),
    identityRegistryAddress: identityRegistry.toLowerCase(),
    chainId,
    bounties: {},
    agents: {},
  };
}

/**
 * Load the bounty index from disk.
 * Returns a fresh default if file is missing or corrupt.
 */
export function loadIndex(): BountyIndex {
  ensureDir();

  if (!existsSync(INDEX_FILE)) {
    return defaultIndex();
  }

  try {
    const data = readFileSync(INDEX_FILE, 'utf-8');
    const index = JSON.parse(data) as BountyIndex;

    // Validate: if factory or identity registry address changed (network switch), reset
    const contracts = getBountyContracts();
    const expectedFactory = contracts.bountyFactory.toLowerCase();
    const expectedRegistry = contracts.identityRegistry.toLowerCase();
    if (index.factoryAddress !== expectedFactory || index.identityRegistryAddress !== expectedRegistry) {
      return defaultIndex();
    }

    return {
      lastBlock: index.lastBlock ?? Number(FACTORY_DEPLOY_BLOCK),
      factoryAddress: index.factoryAddress,
      identityRegistryAddress: index.identityRegistryAddress,
      chainId: index.chainId,
      bounties: index.bounties ?? {},
      agents: index.agents ?? {},
    };
  } catch {
    console.error('[indexer] Corrupt bounties.json, resetting index');
    return defaultIndex();
  }
}

/**
 * Persist the bounty index to disk.
 */
export function saveIndex(index: BountyIndex): void {
  ensureDir();
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}
