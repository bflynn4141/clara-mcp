/**
 * Work Tool Helpers
 *
 * Shared utilities for the work_* bounty tools.
 * Handles indexer communication, local agent storage,
 * data URI encoding, and formatting helpers.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { formatUnits } from 'viem';

// ─── Indexer Communication ──────────────────────────────────────────

/**
 * Get the indexer base URL from environment
 */
export function getIndexerUrl(): string {
  return process.env.CLARA_INDEXER_URL || 'http://localhost:8787';
}

/**
 * Fetch wrapper for the Clara indexer API.
 * Adds auth header if CLARA_INDEXER_API_KEY is set.
 */
export async function indexerFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const baseUrl = getIndexerUrl();
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  const apiKey = process.env.CLARA_INDEXER_API_KEY;
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  return fetch(url, {
    ...options,
    headers,
  });
}

// ─── Local Agent Storage ────────────────────────────────────────────

const CLARA_DIR = join(homedir(), '.clara');
const AGENT_FILE = join(CLARA_DIR, 'agent.json');

interface LocalAgentData {
  agentId: number;
  name: string;
  registeredAt: string;
}

/**
 * Read local agent ID from ~/.clara/agent.json
 */
export function getLocalAgentId(): number | null {
  try {
    const data = JSON.parse(readFileSync(AGENT_FILE, 'utf-8')) as LocalAgentData;
    return data.agentId ?? null;
  } catch {
    return null;
  }
}

/**
 * Save local agent ID to ~/.clara/agent.json
 */
export function saveLocalAgentId(agentId: number, name: string): void {
  mkdirSync(CLARA_DIR, { recursive: true });
  const data: LocalAgentData = {
    agentId,
    name,
    registeredAt: new Date().toISOString(),
  };
  writeFileSync(AGENT_FILE, JSON.stringify(data, null, 2));
}

// ─── Data URI Encoding ──────────────────────────────────────────────

/**
 * Convert a JSON object to a data: URI (base64-encoded)
 */
export function toDataUri(obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj);
  const b64 = Buffer.from(json).toString('base64');
  return `data:application/json;base64,${b64}`;
}

// ─── Formatting Helpers ─────────────────────────────────────────────

/**
 * Truncate an address to 0x1234...5678 format
 */
export function formatAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Format a Unix timestamp (seconds) as human-readable relative time
 */
export function formatDeadline(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = timestamp - now;

  if (diff <= 0) return 'expired';

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;

  const minutes = Math.floor(diff / 60);
  return `${minutes}m`;
}

/**
 * Parse a deadline string into a Unix timestamp (seconds).
 * Accepts ISO dates ("2025-03-01") or relative ("3 days", "1 week").
 */
export function parseDeadline(input: string): number {
  // Try ISO date first
  const isoDate = Date.parse(input);
  if (!isNaN(isoDate)) {
    return Math.floor(isoDate / 1000);
  }

  // Try relative format: "3 days", "1 week", "24 hours"
  const match = input.match(/^(\d+)\s*(day|days|d|hour|hours|h|week|weeks|w|min|minutes|m)$/i);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const now = Math.floor(Date.now() / 1000);

    if (unit.startsWith('d')) return now + value * 86400;
    if (unit.startsWith('h')) return now + value * 3600;
    if (unit.startsWith('w')) return now + value * 604800;
    if (unit.startsWith('m')) return now + value * 60;
  }

  throw new Error(
    `Invalid deadline format: "${input}". Use ISO date ("2025-03-01") or relative ("3 days", "24 hours").`,
  );
}

/**
 * Format a token amount for display (4 decimal places max)
 */
export function formatAmount(amount: string, symbol: string): string {
  const num = parseFloat(amount);
  if (isNaN(num)) return `${amount} ${symbol}`;
  // Use 2 decimals for stablecoins, 4 for others
  const decimals = ['USDC', 'USDT', 'DAI'].includes(symbol.toUpperCase()) ? 2 : 4;
  return `${num.toFixed(decimals)} ${symbol}`;
}

// ─── Local Indexer Helpers ──────────────────────────────────────────

/** Well-known ERC-20 tokens and their decimals/symbols */
const TOKEN_META: Record<string, { symbol: string; decimals: number }> = {
  // Base Mainnet
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6 },
  // Base Sepolia
  '0x514228d83ab8dcf1c0370fca88444f2f85c6ef55': { symbol: 'CLARA', decimals: 18 },
};

/**
 * Get token symbol and decimals for a known token address.
 * Falls back to "TOKEN" / 18 decimals for unknown tokens.
 */
export function getTokenMeta(tokenAddress: string): { symbol: string; decimals: number } {
  return TOKEN_META[tokenAddress.toLowerCase()] ?? { symbol: 'TOKEN', decimals: 18 };
}

/**
 * Format a raw bigint amount string using the token's decimals.
 */
export function formatRawAmount(rawAmount: string, tokenAddress: string): string {
  const meta = getTokenMeta(tokenAddress);
  const formatted = formatUnits(BigInt(rawAmount), meta.decimals);
  return formatAmount(formatted, meta.symbol);
}

/**
 * Parse a data:application/json;base64,... URI into a JSON object.
 * Returns null if parsing fails.
 */
export function parseTaskURI(taskURI: string): Record<string, unknown> | null {
  try {
    const b64Prefix = 'data:application/json;base64,';
    if (taskURI.startsWith(b64Prefix)) {
      const b64 = taskURI.slice(b64Prefix.length);
      const json = Buffer.from(b64, 'base64').toString('utf-8');
      return JSON.parse(json);
    }
    // Handle non-base64 data URI: data:application/json,{...}
    const plainPrefix = 'data:application/json,';
    if (taskURI.startsWith(plainPrefix)) {
      const json = decodeURIComponent(taskURI.slice(plainPrefix.length));
      return JSON.parse(json);
    }
    // Try as plain JSON
    return JSON.parse(taskURI);
  } catch {
    return null;
  }
}

/**
 * Extract a human-readable task summary from a taskURI.
 * Looks for title, description, or summary fields.
 */
export function getTaskSummary(taskURI: string): string {
  const data = parseTaskURI(taskURI);
  if (!data) return '(unable to parse task)';
  return (data.title as string) || (data.summary as string) || (data.description as string)?.slice(0, 100) || '(no title)';
}
