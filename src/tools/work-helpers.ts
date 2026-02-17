/**
 * Agent Identity Helpers
 *
 * Shared utilities for ERC-8004 agent identity tools.
 * Handles local agent storage, data URI encoding, and formatting.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ─── Local Agent Storage ────────────────────────────────────────────

const CLARA_DIR = join(homedir(), '.clara');
const AGENT_FILE = join(CLARA_DIR, 'agent.json');

interface LocalAgentData {
  agentId: number;
  name: string;
  registeredAt: string;
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
