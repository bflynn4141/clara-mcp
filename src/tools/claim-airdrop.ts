/**
 * wallet_claim_airdrop - Check Eligibility & Claim CLARA Airdrop
 *
 * Looks up the user's Merkle proof from the distribution JSON,
 * checks isClaimed() on-chain, and prepares a claim transaction
 * if eligible and unclaimed.
 *
 * Uses the two-phase pattern: prepare → wallet_executePrepared.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { encodeFunctionData, formatUnits, type Hex } from 'viem';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../middleware.js';
import {
  getClaraContracts,
  getClaraNetwork,
  getClaraPublicClient,
  MERKLE_DROP_ABI,
} from '../config/clara-contracts.js';
import { storePreparedTx, formatPreparedTx, getPreparedTx } from '../para/prepared-tx.js';

// ─── Merkle Data Types ──────────────────────────────────────────────

interface MerkleRecipient {
  index: number;
  account: string;
  amount: string;
  proof: string[];
}

interface MerkleOutput {
  root: string;
  totalAmount: string;
  recipients: MerkleRecipient[];
}

// ─── Tool Definition ────────────────────────────────────────────────

export const claimAirdropToolDefinition: Tool = {
  name: 'wallet_claim_airdrop',
  description: `Check eligibility and claim your CLARA token airdrop.

Shows your allocation and claim status. If eligible and unclaimed, prepares the claim transaction.

Returns a preparedTxId — use wallet_executePrepared to broadcast.

**Examples:**
\`\`\`json
{}
{"address": "0x..."}
\`\`\`

No parameters needed if wallet is connected — uses your wallet address automatically.`,
  inputSchema: {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        description: 'Override address to check (defaults to connected wallet)',
      },
    },
  },
};

// ─── Merkle Data Loading ────────────────────────────────────────────

let cachedMerkleData: MerkleOutput | null = null;

function loadMerkleData(): MerkleOutput {
  if (cachedMerkleData) return cachedMerkleData;

  const network = getClaraNetwork();

  // Check env var override first, then default path
  const envPath = process.env.CLARA_MERKLE_DATA;
  let dataPath: string;

  if (envPath) {
    dataPath = resolve(envPath);
  } else {
    // Resolve relative to project root (src/../contracts/data/)
    const __dirname = dirname(fileURLToPath(import.meta.url));
    dataPath = resolve(__dirname, '..', '..', 'contracts', 'data', `merkle-output-${network}.json`);
  }

  try {
    const raw = readFileSync(dataPath, 'utf-8');
    cachedMerkleData = JSON.parse(raw) as MerkleOutput;
    return cachedMerkleData;
  } catch (error) {
    throw new Error(`Failed to load merkle data from ${dataPath}: ${error instanceof Error ? error.message : error}`);
  }
}

// ─── Handler ────────────────────────────────────────────────────────

export async function handleClaimAirdropRequest(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const address = ((args.address as string) || ctx.walletAddress).toLowerCase() as Hex;

  try {
    // 1. Load merkle data and find recipient
    const merkleData = loadMerkleData();
    const recipient = merkleData.recipients.find(
      (r) => r.account.toLowerCase() === address,
    );

    if (!recipient) {
      return {
        content: [
          {
            type: 'text',
            text: [
              `## CLARA Airdrop`,
              '',
              `**Address:** \`${address}\``,
              `**Status:** Not eligible`,
              '',
              `This address is not included in the CLARA airdrop distribution.`,
            ].join('\n'),
          },
        ],
      };
    }

    // 2. Check if already claimed on-chain
    const contracts = getClaraContracts();
    const client = getClaraPublicClient();

    const [isClaimed, deadline] = await Promise.all([
      client.readContract({
        address: contracts.merkleDrop,
        abi: MERKLE_DROP_ABI,
        functionName: 'isClaimed',
        args: [BigInt(recipient.index)],
      }),
      client.readContract({
        address: contracts.merkleDrop,
        abi: MERKLE_DROP_ABI,
        functionName: 'deadline',
      }),
    ]);

    const amountFormatted = formatUnits(BigInt(recipient.amount), 18);
    const amountNum = parseFloat(amountFormatted);
    const network = getClaraNetwork();
    const deadlineDate = new Date(Number(deadline as bigint) * 1000);
    const now = new Date();

    if (isClaimed) {
      return {
        content: [
          {
            type: 'text',
            text: [
              `## CLARA Airdrop`,
              '',
              `**Address:** \`${address}\``,
              `**Allocation:** ${amountNum.toLocaleString()} CLARA`,
              `**Status:** Already claimed ✅`,
              `**Network:** ${network}`,
              '',
              `This allocation has already been claimed.`,
            ].join('\n'),
          },
        ],
      };
    }

    // 3. Check deadline
    if (now > deadlineDate) {
      return {
        content: [
          {
            type: 'text',
            text: [
              `## CLARA Airdrop`,
              '',
              `**Address:** \`${address}\``,
              `**Allocation:** ${amountNum.toLocaleString()} CLARA`,
              `**Status:** Expired ❌`,
              `**Deadline:** ${deadlineDate.toISOString()}`,
              '',
              `The airdrop claim period has ended.`,
            ].join('\n'),
          },
        ],
      };
    }

    // 4. Prepare the claim transaction
    const calldata = encodeFunctionData({
      abi: MERKLE_DROP_ABI,
      functionName: 'claim',
      args: [
        BigInt(recipient.index),
        recipient.account as Hex,
        BigInt(recipient.amount),
        recipient.proof as Hex[],
      ],
    });

    // Simulate the transaction
    let simulation: {
      success: boolean;
      gasEstimate: bigint;
      gasEstimateFormatted: string;
      error?: string;
    };

    try {
      const gasEstimate = await client.estimateGas({
        account: address,
        to: contracts.merkleDrop,
        data: calldata,
      });

      simulation = {
        success: true,
        gasEstimate,
        gasEstimateFormatted: gasEstimate.toLocaleString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      simulation = {
        success: false,
        gasEstimate: 0n,
        gasEstimateFormatted: '0',
        error: message,
      };
    }

    // Store prepared transaction
    const preparedTxId = storePreparedTx({
      to: contracts.merkleDrop,
      data: calldata,
      value: 0n,
      chainId: contracts.chainId,
      chain: 'base',
      contractName: 'MerkleDrop',
      functionName: 'claim',
      functionSignature: 'claim(uint256,address,uint256,bytes32[])',
      args: [recipient.index, recipient.account, recipient.amount, recipient.proof],
      simulation,
    });

    const preparedTx = getPreparedTx(preparedTxId)!;
    const display = formatPreparedTx(preparedTx);

    const lines: string[] = [
      `## CLARA Airdrop`,
      '',
      `**Address:** \`${address}\``,
      `**Allocation:** ${amountNum.toLocaleString()} CLARA`,
      `**Status:** Eligible — ready to claim 🎉`,
      `**Network:** ${network}`,
      `**Deadline:** ${deadlineDate.toISOString()}`,
      '',
      display,
    ];

    if (simulation.success) {
      lines.push('');
      lines.push(`💡 To claim your CLARA tokens:`);
      lines.push(`\`wallet_executePrepared preparedTxId="${preparedTxId}"\``);
    } else {
      lines.push('');
      lines.push(`⚠️ Simulation failed: ${simulation.error}`);
      lines.push(`The claim may still succeed — check gas balance on Base Sepolia.`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      isError: !simulation.success,
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Airdrop check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
