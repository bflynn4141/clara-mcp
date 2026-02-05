/**
 * Middleware Pipeline
 *
 * Wraps every tool handler with standard pre/post processing:
 * 1. Auth check (getSession → validate → inject ctx)
 * 2. Error normalization (ClaraError → MCP response)
 * 3. Session touch (extend expiry after successful ops)
 *
 * Tools receive a ToolContext with session + walletAddress pre-validated,
 * eliminating the getSession()/touchSession() boilerplate from every handler.
 */

import { getSession, touchSession } from './storage/session.js';
import { ClaraError, ClaraErrorCode, formatClaraError } from './errors.js';
import { checkGasPreflight, requireGas } from './gas-preflight.js';
import type { Hex } from 'viem';
import type { WalletSession } from './storage/session.js';
import type { SupportedChain } from './config/chains.js';

/**
 * Context injected into auth-required tool handlers
 */
export interface ToolContext {
  session: WalletSession;
  walletAddress: Hex;
}

/**
 * Standard MCP tool result type
 */
export type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/**
 * Handler signature for tools that require authentication
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

/**
 * Handler signature for public tools (no auth needed)
 */
export type PublicToolHandler = (
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/**
 * Gas preflight mode:
 * - 'check': Block the tool if wallet can't afford gas (throws INSUFFICIENT_GAS)
 * - 'warn': Run preflight but only log a warning (don't block)
 * - 'none': Skip gas preflight entirely (default)
 */
export type GasPreflightMode = 'check' | 'warn' | 'none';

/**
 * Function to extract chain and tx value from tool args for gas estimation.
 * Returns null to skip gas preflight for this particular call.
 */
export type GasPreflightExtractor = (args: Record<string, unknown>) => {
  chain: SupportedChain;
  txValue?: bigint;
  gasLimit?: bigint;
} | null;

/**
 * Configuration for how middleware wraps a tool
 */
export interface ToolConfig {
  requiresAuth: boolean;
  checksSpending: boolean;
  touchesSession: boolean;
  gasPreflight: GasPreflightMode;
  gasExtractor?: GasPreflightExtractor;
}

const DEFAULT_CONFIG: ToolConfig = {
  requiresAuth: true,
  checksSpending: false,
  touchesSession: true,
  gasPreflight: 'none',
};

/**
 * Wrap a tool handler with the middleware pipeline
 *
 * Returns a flat (args) => Promise<ToolResult> function that the
 * tool registry can call directly from MCP dispatch.
 */
export function wrapTool(
  handler: ToolHandler | PublicToolHandler,
  config: Partial<ToolConfig> = {},
): (args: Record<string, unknown>) => Promise<ToolResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      // 1. Auth check
      if (cfg.requiresAuth) {
        const session = await getSession();
        if (!session?.authenticated || !session.address) {
          throw new ClaraError(
            ClaraErrorCode.NO_SESSION,
            'No wallet session found.',
            'Run wallet_setup first to connect your wallet.',
          );
        }

        const ctx: ToolContext = {
          session,
          walletAddress: session.address as Hex,
        };

        // 2. Gas preflight check (if configured)
        if (cfg.gasPreflight !== 'none' && cfg.gasExtractor) {
          const gasParams = cfg.gasExtractor(args);
          if (gasParams) {
            try {
              if (cfg.gasPreflight === 'check') {
                // requireGas throws ClaraError(INSUFFICIENT_GAS) if can't afford
                await requireGas(gasParams.chain, ctx.walletAddress, {
                  txValue: gasParams.txValue,
                  gasLimit: gasParams.gasLimit,
                });
              } else {
                // 'warn' mode — check but don't block
                const preflight = await checkGasPreflight(
                  gasParams.chain,
                  ctx.walletAddress,
                  { txValue: gasParams.txValue, gasLimit: gasParams.gasLimit },
                );
                if (!preflight.canAfford) {
                  console.error(`[clara] Gas warning: ${preflight.breakdown}`);
                }
              }
            } catch (error) {
              if (error instanceof ClaraError) throw error;
              // Non-fatal: preflight failed (network issue), proceed anyway
              console.error(`[clara] Gas preflight failed: ${error}`);
            }
          }
        }

        // 3. Call handler with context
        const result = await (handler as ToolHandler)(args, ctx);

        // 4. Touch session to extend expiry
        if (cfg.touchesSession) {
          await touchSession();
        }

        return result;
      } else {
        // Public tool — no auth needed
        return await (handler as PublicToolHandler)(args);
      }
    } catch (error) {
      if (error instanceof ClaraError) {
        return formatClaraError(error);
      }
      // Unknown error — wrap in generic response
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  };
}
