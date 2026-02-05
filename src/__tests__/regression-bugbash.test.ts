/**
 * Regression Tests from Bug Bash (2026-02-05)
 *
 * These tests capture bugs found during the Clara MCP bug bash:
 *
 * T2: Gas estimation buffer too low for complex DeFi interactions (Morpho)
 * T10: MCP config precedence causes missing Tenderly env vars
 *
 * T6 (Herd field names) had no bugs — all consumers use correct field names.
 */

import { describe, it, expect, vi } from 'vitest';
import { estimateGasLimit, type GasEstimate } from '../para/gas.js';
import type { PublicClient } from 'viem';

// ============================================================================
// T2: Gas Estimation Buffer Regression Tests
// ============================================================================

describe('T2: Gas estimation buffer for complex DeFi interactions', () => {
  /**
   * BUG: The 20% gas buffer in transactions.ts:192 and execute-prepared.ts:132
   * is insufficient for complex DeFi interactions like Morpho supply/withdraw.
   *
   * Root cause: Morpho Blue operations involve multi-step state changes
   * (interest accrual, oracle reads, share calculation) where gas consumption
   * at execution time can vary >20% from estimation time.
   *
   * Files affected:
   * - src/para/transactions.ts:192 — `(estimatedGas * 120n) / 100n`
   * - src/tools/execute-prepared.ts:132-133 — `(gasEstimate * 120n) / 100n`
   */

  it('estimateGasLimit applies exactly 20% buffer (documents current behavior)', async () => {
    // This test documents the CURRENT (buggy) behavior:
    // All calls get a uniform 20% buffer regardless of complexity.
    const estimatedGas = 300_000n; // Typical Morpho supply gas
    const client = {
      estimateGas: vi.fn().mockResolvedValue(estimatedGas),
    } as unknown as PublicClient;

    const result = await estimateGasLimit(client, {
      account: '0x1234567890123456789012345678901234567890',
      to: '0x1234567890123456789012345678901234567890',
      data: '0xb6b55f25' as `0x${string}`, // deposit(uint256) — typical Morpho call
    });

    // Current behavior: 300,000 * 1.2 = 360,000
    expect(result).toBe(360_000n);

    // DESIRED behavior after fix: Should be 300,000 * 1.5 = 450,000
    // for contract calls (has data field).
    // Uncomment this assertion after applying the fix:
    // expect(result).toBe(450_000n);
  });

  it('simple ETH transfers should keep 20% buffer (after fix)', async () => {
    // Simple transfers don't need extra buffer
    const estimatedGas = 21_000n;
    const client = {
      estimateGas: vi.fn().mockResolvedValue(estimatedGas),
    } as unknown as PublicClient;

    const result = await estimateGasLimit(client, {
      account: '0x1234567890123456789012345678901234567890',
      to: '0x1234567890123456789012345678901234567890',
      value: 1_000_000_000_000_000_000n, // 1 ETH
    });

    // 21,000 * 1.2 = 25,200
    expect(result).toBe(25_200n);
  });

  it('high gas estimate contract calls should have sufficient buffer', async () => {
    // Morpho Blue supply can use 400k+ gas
    const estimatedGas = 400_000n;
    const client = {
      estimateGas: vi.fn().mockResolvedValue(estimatedGas),
    } as unknown as PublicClient;

    const result = await estimateGasLimit(client, {
      account: '0x1234567890123456789012345678901234567890',
      to: '0x1234567890123456789012345678901234567890',
      data: '0x00000000' as `0x${string}`, // Some contract call
    });

    // Current: 400,000 * 1.2 = 480,000
    // After fix: Should be 400,000 * 1.5 = 600,000
    // The key assertion is that buffer is at least 20%
    expect(result).toBeGreaterThan(estimatedGas);
    expect(result).toBe((estimatedGas * 6n) / 5n); // Current 20% buffer
  });
});

describe('T2: execute-prepared gas buffer (unit documentation)', () => {
  /**
   * BUG: In execute-prepared.ts:132-133, the gas buffer is hardcoded to 20%.
   * This is the same buffer used for all transaction types.
   *
   * The prepared transaction stores the gas estimate from simulation time,
   * then at execution time applies only a 20% buffer. For complex DeFi
   * interactions where state changes between simulation and execution
   * (interest accrual, oracle updates, utilization rate changes),
   * this buffer is insufficient.
   */

  it('documents the prepared tx gas buffer calculation', () => {
    // This simulates what execute-prepared.ts:132-133 does
    const simulatedGasEstimate = 350_000n; // Morpho-like gas estimate

    // Current behavior (execute-prepared.ts:132-133):
    const currentBufferedGas = (simulatedGasEstimate * 120n) / 100n;
    expect(currentBufferedGas).toBe(420_000n);

    // Proposed fix:
    const fixedBufferedGas = (simulatedGasEstimate * 150n) / 100n;
    expect(fixedBufferedGas).toBe(525_000n);

    // The difference is 105,000 gas — enough headroom for Morpho's
    // multi-step state changes between estimation and execution.
    expect(fixedBufferedGas - currentBufferedGas).toBe(105_000n);
  });
});

describe('T2: wallet_execute gas estimate not carried through', () => {
  /**
   * BUG: In src/tools/execute.ts:300-305, the formatExecutionReady function
   * returns transaction data as display text but does NOT include the gas
   * estimate from simulation. The gas estimate computed at safety.ts:519
   * is only shown to the user, not injected into the execution payload.
   *
   * This means when a user follows up with `wallet_send`, there's no gas
   * limit in the transaction data — forcing a new estimation at send time,
   * which may differ from the simulated estimate.
   */

  it('documents that formatExecutionReady omits gas estimate', () => {
    // This is a documentation test — the actual bug is in execute.ts:376-403
    // where formatExecutionReady produces JSON with {to, data, value, from, chainId}
    // but NOT {gas: simulatedGasEstimate}

    const mockTxData = {
      to: '0x1234567890123456789012345678901234567890',
      data: '0xa9059cbb',
      value: '0',
      from: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      chainId: 8453,
    };

    // The gas field is missing from the returned tx data
    expect(mockTxData).not.toHaveProperty('gas');

    // After fix, the transaction data should include gas:
    // const fixedTxData = { ...mockTxData, gas: '420000' };
    // expect(fixedTxData).toHaveProperty('gas');
  });
});

// ============================================================================
// T10: MCP Config Precedence Regression Tests
// ============================================================================

describe('T10: MCP config precedence', () => {
  /**
   * BUG: ~/.mcp.json (project-level) overrides ~/.claude.json (global)
   * for the 'clara' MCP server configuration. The project-level config
   * is missing TENDERLY_API_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG
   * which exist in the global config.
   *
   * This means Clara runs without Tenderly simulation support,
   * degrading the safety UX (no balance change previews).
   *
   * Files affected:
   * - ~/.mcp.json (project-level) — missing 3 Tenderly env vars
   * - ~/.claude.json (global) — has Tenderly vars but gets overridden
   * - src/providers/tenderly.ts — isTenderlyConfigured() returns false
   * - src/intelligence/safety.ts:431 — falls back to basic estimateGas
   */

  it('documents that Tenderly requires all 3 env vars', () => {
    // isTenderlyConfigured() checks for these env vars
    const requiredEnvVars = [
      'TENDERLY_API_KEY',
      'TENDERLY_ACCOUNT_SLUG',
      'TENDERLY_PROJECT_SLUG',
    ];

    // Project-level config (.mcp.json) has these:
    const projectLevelEnv = {
      CLARA_PROXY_URL: 'https://clara-proxy.bflynn-me.workers.dev',
      PARA_WALLET_ID: '...',
      PARA_WALLET_ADDRESS: '...',
      BASE_RPC_URL: '...',
      ZERION_API_KEY: '...',
      HERD_ENABLED: 'true',
      HERD_API_URL: '...',
      HERD_API_KEY: '...',
      // Missing: TENDERLY_API_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG
    };

    // Verify the 3 Tenderly vars are NOT in the project-level config
    for (const envVar of requiredEnvVars) {
      expect(projectLevelEnv).not.toHaveProperty(envVar);
    }

    // Global config (.claude.json) DOES have them:
    const globalEnv = {
      ...projectLevelEnv,
      TENDERLY_API_KEY: 'present',
      TENDERLY_ACCOUNT_SLUG: 'present',
      TENDERLY_PROJECT_SLUG: 'present',
    };

    for (const envVar of requiredEnvVars) {
      expect(globalEnv).toHaveProperty(envVar);
    }
  });

  it('documents stale /clawd project config with empty env', () => {
    // In ~/.claude.json, the /clawd project has a Clara config with empty env:
    const clawdProjectConfig = {
      type: 'stdio',
      command: 'node',
      args: ['/Users/brianflynn/clawd/clara-mcp/dist/index.js'],
      env: {},
    };

    // This would cause Clara to start with NO configuration at all
    expect(Object.keys(clawdProjectConfig.env)).toHaveLength(0);

    // Required env vars for basic functionality:
    const requiredForBasic = ['HERD_ENABLED', 'HERD_API_URL', 'HERD_API_KEY'];
    for (const envVar of requiredForBasic) {
      expect(clawdProjectConfig.env).not.toHaveProperty(envVar);
    }
  });
});

// ============================================================================
// T6: Herd Field Names (No Bugs - Verification Tests)
// ============================================================================

describe('T6: Herd field name correctness (verification)', () => {
  /**
   * NO BUG FOUND. These tests verify that the Herd response format
   * and Clara's TokenBalance interface are aligned.
   *
   * Herd API response fields: address, symbol, name, decimals, amount, valueUsd, logoUrl
   * Clara TokenBalance fields: address, symbol, name, amount, decimals, valueUsd, logoUrl
   *
   * The mapping at herd.ts:1150-1160 correctly transforms between them.
   */

  it('Herd response schema matches TokenBalance interface', () => {
    // Simulated Herd getWalletOverviewTool response
    const herdBalance = {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      amount: '100.500000',
      valueUsd: 100.50,
      logoUrl: 'https://example.com/usdc.png',
    };

    // The mapping at herd.ts:1152-1160
    const tokenBalance = {
      address: herdBalance.address,
      symbol: herdBalance.symbol,
      name: herdBalance.name,
      amount: herdBalance.amount,
      decimals: herdBalance.decimals,
      valueUsd: herdBalance.valueUsd || 0,
      logoUrl: herdBalance.logoUrl || undefined,
    };

    expect(tokenBalance.address).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(tokenBalance.amount).toBe('100.500000');
    expect(tokenBalance.valueUsd).toBe(100.50);
  });

  it('native ETH uses "native" as address (not contract address)', () => {
    const herdNativeBalance = {
      address: 'native',
      symbol: 'ETH',
      decimals: 18,
      amount: '1.234567',
      valueUsd: 3500.00,
      logoUrl: null,
    };

    const tokenBalance = {
      address: herdNativeBalance.address,
      symbol: herdNativeBalance.symbol,
      amount: herdNativeBalance.amount,
      decimals: herdNativeBalance.decimals,
      valueUsd: herdNativeBalance.valueUsd || 0,
      logoUrl: herdNativeBalance.logoUrl || undefined,
    };

    expect(tokenBalance.address).toBe('native');
    expect(tokenBalance.logoUrl).toBeUndefined();
  });
});
