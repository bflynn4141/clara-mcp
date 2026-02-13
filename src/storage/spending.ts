/**
 * Spending Limits Storage
 *
 * Tracks autonomous spending and enforces limits to prevent
 * accidental large payments. This is crucial for AI agents
 * that can make payments without human approval.
 *
 * Storage: ~/.clara/spending.json
 *
 * Design principles:
 * - Fail-safe: If storage is corrupted, use conservative defaults
 * - Transparent: All spending is logged with full context
 * - Configurable: Users can adjust limits to their comfort level
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CLARA_DIR = join(homedir(), '.clara');
const SPENDING_FILE = join(CLARA_DIR, 'spending.json');

/**
 * Spending limit configuration
 */
export interface SpendingLimits {
  /** Maximum USD per single transaction (default: $1.00) */
  maxPerTransaction: string;
  /** Maximum USD per rolling 24-hour period (default: $10.00) */
  maxPerDay: string;
  /** Transactions above this require explicit approval (default: $0.50) */
  requireApprovalAbove: string;
}

/**
 * Record of a single spending event
 */
export interface SpendingRecord {
  /** ISO timestamp */
  timestamp: string;
  /** Amount in USD */
  amountUsd: string;
  /** Payment recipient address */
  recipient: string;
  /** Human-readable description */
  description: string;
  /** URL that was paid for */
  url: string;
  /** Chain ID */
  chainId: number;
  /** Transaction hash (if settled on-chain) */
  txHash?: string;
  /** Payment ID from the x402 protocol */
  paymentId: string;
}

/**
 * Full spending configuration and history
 */
export interface SpendingConfig {
  limits: SpendingLimits;
  history: SpendingRecord[];
}

const DEFAULT_LIMITS: SpendingLimits = {
  maxPerTransaction: '1.00',
  maxPerDay: '10.00',
  requireApprovalAbove: '0.50',
};

const DEFAULT_CONFIG: SpendingConfig = {
  limits: DEFAULT_LIMITS,
  history: [],
};

/**
 * Ensure the Clara config directory exists
 */
function ensureDir(): void {
  if (!existsSync(CLARA_DIR)) {
    mkdirSync(CLARA_DIR, { recursive: true, mode: 0o700 });
  } else {
    // Repair permissions on existing directories (may be world-readable from older versions)
    const stats = statSync(CLARA_DIR);
    const currentMode = stats.mode & 0o777;
    if (currentMode !== 0o700) {
      chmodSync(CLARA_DIR, 0o700);
    }
  }
}

/**
 * Load spending configuration from disk
 *
 * Returns default config if file doesn't exist or is corrupted.
 */
export function loadSpendingConfig(): SpendingConfig {
  ensureDir();

  if (!existsSync(SPENDING_FILE)) {
    return { ...DEFAULT_CONFIG, history: [] };
  }

  // Repair file permissions if too open (older versions wrote 0o644)
  const fileStats = statSync(SPENDING_FILE);
  const fileMode = fileStats.mode & 0o777;
  if (fileMode !== 0o600) {
    chmodSync(SPENDING_FILE, 0o600);
  }

  try {
    const data = readFileSync(SPENDING_FILE, 'utf-8');
    const config = JSON.parse(data) as SpendingConfig;

    // Ensure all required fields exist (handles config migrations)
    return {
      limits: {
        ...DEFAULT_LIMITS,
        ...config.limits,
      },
      history: config.history || [],
    };
  } catch (error) {
    console.error('Failed to load spending config, using defaults:', error);
    return { ...DEFAULT_CONFIG, history: [] };
  }
}

/**
 * Save spending configuration to disk
 */
export function saveSpendingConfig(config: SpendingConfig): void {
  ensureDir();
  writeFileSync(SPENDING_FILE, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Get current spending limits
 */
export function getSpendingLimits(): SpendingLimits {
  return loadSpendingConfig().limits;
}

/**
 * Update spending limits
 */
export function setSpendingLimits(limits: Partial<SpendingLimits>): SpendingLimits {
  const config = loadSpendingConfig();
  config.limits = {
    ...config.limits,
    ...limits,
  };
  saveSpendingConfig(config);
  return config.limits;
}

/**
 * Record a spending event
 */
export function recordSpending(record: SpendingRecord): void {
  const config = loadSpendingConfig();
  config.history.push(record);

  // Keep only last 1000 records to prevent unbounded growth
  if (config.history.length > 1000) {
    config.history = config.history.slice(-1000);
  }

  saveSpendingConfig(config);
}

/**
 * Get spending history
 *
 * @param days - Number of days to look back (default: 7)
 */
export function getSpendingHistory(days: number = 7): SpendingRecord[] {
  const config = loadSpendingConfig();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffTime = cutoff.getTime();

  return config.history.filter((record) => {
    const recordTime = new Date(record.timestamp).getTime();
    return recordTime >= cutoffTime;
  });
}

/**
 * Get total spending in the last 24 hours
 */
export function getTodaySpending(): number {
  const history = getSpendingHistory(1);
  return history.reduce((total, record) => {
    return total + parseFloat(record.amountUsd);
  }, 0);
}

/**
 * Check if a payment would exceed limits
 *
 * Returns an object with:
 * - allowed: Whether the payment can proceed
 * - requiresApproval: Whether explicit user approval is needed
 * - reason: Human-readable explanation if blocked
 */
export function checkSpendingLimits(amountUsd: string): {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  todayTotal: number;
  remainingToday: number;
} {
  const limits = getSpendingLimits();
  const amount = parseFloat(amountUsd);
  const todayTotal = getTodaySpending();
  const maxPerDay = parseFloat(limits.maxPerDay);
  const maxPerTransaction = parseFloat(limits.maxPerTransaction);
  const approvalThreshold = parseFloat(limits.requireApprovalAbove);

  const remainingToday = Math.max(0, maxPerDay - todayTotal);

  // Check per-transaction limit
  if (amount > maxPerTransaction) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: `Amount $${amountUsd} exceeds per-transaction limit of $${limits.maxPerTransaction}`,
      todayTotal,
      remainingToday,
    };
  }

  // Check daily limit
  if (todayTotal + amount > maxPerDay) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: `Would exceed daily limit. Today's spending: $${todayTotal.toFixed(2)}, limit: $${limits.maxPerDay}`,
      todayTotal,
      remainingToday,
    };
  }

  // Check if approval is required (but payment is allowed)
  const requiresApproval = amount > approvalThreshold;

  return {
    allowed: true,
    requiresApproval,
    todayTotal,
    remainingToday,
  };
}

/**
 * Format spending summary for display
 */
export function formatSpendingSummary(): string {
  const limits = getSpendingLimits();
  const todayTotal = getTodaySpending();
  const remaining = Math.max(0, parseFloat(limits.maxPerDay) - todayTotal);

  const lines = [
    '📊 Spending Summary',
    '─────────────────────',
    `Today's spending: $${todayTotal.toFixed(2)} / $${limits.maxPerDay}`,
    `Remaining today:  $${remaining.toFixed(2)}`,
    '',
    '⚙️  Limits',
    `Per transaction:  $${limits.maxPerTransaction}`,
    `Per day:          $${limits.maxPerDay}`,
    `Approval above:   $${limits.requireApprovalAbove}`,
  ];

  return lines.join('\n');
}

/**
 * Format recent spending history for display
 */
export function formatSpendingHistory(days: number = 7): string {
  const history = getSpendingHistory(days);

  if (history.length === 0) {
    return `No spending in the last ${days} days.`;
  }

  const lines = [
    `📜 Spending History (last ${days} days)`,
    '─────────────────────────────────────',
  ];

  // Group by day
  const byDay = new Map<string, SpendingRecord[]>();
  for (const record of history) {
    const day = record.timestamp.split('T')[0];
    if (!byDay.has(day)) {
      byDay.set(day, []);
    }
    byDay.get(day)!.push(record);
  }

  for (const [day, records] of byDay) {
    const dayTotal = records.reduce((sum, r) => sum + parseFloat(r.amountUsd), 0);
    lines.push(`\n${day} (total: $${dayTotal.toFixed(2)})`);

    for (const record of records) {
      const time = record.timestamp.split('T')[1].split('.')[0];
      const desc = record.description || new URL(record.url).hostname;
      lines.push(`  ${time}  $${record.amountUsd}  ${desc}`);
    }
  }

  return lines.join('\n');
}
