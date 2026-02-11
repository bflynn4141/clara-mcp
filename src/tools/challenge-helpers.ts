/**
 * Challenge Tool Helpers
 *
 * Shared utilities for the challenge_* tools.
 * Handles formatting, data URI parsing, and prize pool display.
 */

import { formatUnits } from 'viem';
import type { ChallengeStatus } from '../indexer/types.js';
import { getTokenMeta, formatAddress, parseTaskURI } from './work-helpers.js';

// ─── Formatting Helpers ─────────────────────────────────────────────

/**
 * Format a raw prize pool amount for display.
 * Uses the token's decimals and symbol.
 */
export function formatPrizePool(rawAmount: string, tokenAddress: string): string {
  const meta = getTokenMeta(tokenAddress);
  const formatted = formatUnits(BigInt(rawAmount), meta.decimals);
  const num = parseFloat(formatted);
  const decimals = ['USDC', 'USDT', 'DAI'].includes(meta.symbol.toUpperCase()) ? 2 : 4;
  return `${num.toFixed(decimals)} ${meta.symbol}`;
}

/**
 * Format a ChallengeStatus enum value as a human-readable string with emoji.
 */
export function formatChallengeStatus(status: ChallengeStatus): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'scoring':
      return 'Scoring';
    case 'finalized':
      return 'Finalized';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    default:
      return status;
  }
}

/**
 * Parse a challengeURI (data URI or URL) and extract the problem statement summary.
 * Returns a truncated string suitable for listing.
 */
export function getChallengeSummary(challengeURI: string): string {
  const data = parseTaskURI(challengeURI);
  if (!data) return '(unable to parse challenge)';
  return (
    (data.title as string) ||
    (data.summary as string) ||
    (data.problemStatement as string)?.slice(0, 120) ||
    (data.description as string)?.slice(0, 120) ||
    '(no title)'
  );
}

/**
 * Format a deadline as relative time from now.
 */
export function formatTimeRemaining(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = timestamp - now;

  if (diff <= 0) return 'expired';

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Format a payout BPS array as a human-readable breakdown.
 * e.g. [6000, 2500, 1500] => "1st: 60% | 2nd: 25% | 3rd: 15%"
 */
export function formatPayoutBreakdown(payoutBps: number[], totalPrize: string, tokenAddress: string): string {
  const meta = getTokenMeta(tokenAddress);
  const total = BigInt(totalPrize);

  const ordinals = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

  return payoutBps
    .map((bps, i) => {
      const pct = (bps / 100).toFixed(0);
      const amount = (total * BigInt(bps)) / 10000n;
      const formatted = formatUnits(amount, meta.decimals);
      const num = parseFloat(formatted);
      const decimals = ['USDC', 'USDT', 'DAI'].includes(meta.symbol.toUpperCase()) ? 2 : 4;
      return `${ordinals[i] ?? `#${i + 1}`}: ${pct}% (${num.toFixed(decimals)} ${meta.symbol})`;
    })
    .join(' | ');
}

/**
 * Parse a payout split string into BPS array.
 * Supports:
 * - "top3" => [6000, 2500, 1500]
 * - "top5" => [4000, 2500, 1500, 1000, 500]
 * - "equal" => equal split (for winnerCount winners)
 * - "[6000,2500,1500]" => raw BPS array
 */
export function parsePayoutSplit(split: string | undefined, winnerCount: number): number[] {
  if (!split || split === 'top3') {
    return [6000, 2500, 1500].slice(0, winnerCount);
  }
  if (split === 'top5') {
    return [4000, 2500, 1500, 1000, 500].slice(0, winnerCount);
  }
  if (split === 'equal') {
    const perWinner = Math.floor(10000 / winnerCount);
    const remainder = 10000 - perWinner * winnerCount;
    return Array.from({ length: winnerCount }, (_, i) =>
      i === 0 ? perWinner + remainder : perWinner,
    );
  }

  // Try parsing as JSON array
  try {
    const parsed = JSON.parse(split);
    if (Array.isArray(parsed) && parsed.every((v: unknown) => typeof v === 'number')) {
      return parsed;
    }
  } catch {
    // fall through
  }

  // Default to top3
  return [6000, 2500, 1500].slice(0, winnerCount);
}
