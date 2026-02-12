/**
 * Transport Factory
 *
 * Returns the appropriate viem HTTP transport for a given chain.
 * When QUICKNODE_X402=true, routes through QuickNode's x402 gateway.
 * Otherwise falls back to the standard getRpcUrl() resolution.
 */

import { http, type HttpTransport } from 'viem';
import { getRpcUrl, type SupportedChain } from './chains.js';
import {
  isQuickNodeX402Enabled,
  createQuickNodeFetchFn,
} from '../providers/quicknode-x402.js';

/**
 * Get an HTTP transport for a chain.
 *
 * Routes through QuickNode x402 when enabled, otherwise uses
 * the standard RPC URL resolution (env var → Chainstack → fallback).
 */
export function getTransport(chain: SupportedChain): HttpTransport {
  if (isQuickNodeX402Enabled()) {
    return http(undefined, { fetchFn: createQuickNodeFetchFn(chain) });
  }
  return http(getRpcUrl(chain));
}
