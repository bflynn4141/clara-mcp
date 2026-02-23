/**
 * Contract Error Decoding
 *
 * Decodes Ethereum contract revert errors into human-readable messages.
 * Supports custom error signatures and viem error parsing.
 */

import { type Hex } from 'viem';

/**
 * Known error signatures from Clara contracts
 * Format: 4-byte selector => human readable description
 */
export const KNOWN_ERROR_SIGNATURES: Record<string, string> = {
  // Generic EVM errors
  '0x08c379a0': 'GenericError: Contract reverted with a message',
  '0x4e487b71': 'Panic: Internal contract error (check for overflow/underflow)',

  // ERC-20 errors
  '0xfb8f41b2': 'ERC20InsufficientBalance: Not enough tokens for this operation',
  '0x3e3f8f73': 'ERC20InsufficientAllowance: Token allowance too low. Approve more tokens first',

  // Generic
  '0xcd786059': 'AddressEmptyCode: Contract address has no code (wrong address?)',
};

export interface DecodedContractError {
  signature: string;
  message: string;
  suggestion?: string;
}

/**
 * Extract 4-byte error signature from error message or data
 */
function extractErrorSignature(error: unknown): string | null {
  const msg = error instanceof Error ? error.message : String(error);
  
  // Look for 0x followed by 8 hex chars (4 bytes)
  const match = msg.match(/0x([a-fA-F0-9]{8})/);
  if (match) return `0x${match[1].toLowerCase()}`;
  
  return null;
}

/**
 * Check if error is a specific type
 */
function errorIncludes(error: unknown, patterns: string[]): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return patterns.some(p => msg.includes(p.toLowerCase()));
}

/**
 * Decode a contract error into a human-readable message
 */
export function decodeContractError(error: unknown): DecodedContractError {
  const signature = extractErrorSignature(error);
  
  // Check for known signatures
  if (signature && KNOWN_ERROR_SIGNATURES[signature]) {
    return {
      signature,
      message: KNOWN_ERROR_SIGNATURES[signature],
      suggestion: getSuggestionForError(signature, error),
    };
  }
  
  // Check for common error patterns
  if (errorIncludes(error, ['insufficient funds', 'insufficientFunds'])) {
    return {
      signature: signature || '0x????????',
      message: 'Insufficient ETH for gas fees',
      suggestion: 'Add more ETH to your wallet to cover transaction costs.',
    };
  }
  
  if (errorIncludes(error, ['nonce too low', 'NONCE_TOO_LOW'])) {
    return {
      signature: signature || '0x????????',
      message: 'Transaction nonce is too low',
      suggestion: 'Wait for pending transactions to confirm, or retry in a moment.',
    };
  }
  
  if (errorIncludes(error, ['replacement transaction underpriced'])) {
    return {
      signature: signature || '0x????????',
      message: 'Transaction underpriced (gas too low)',
      suggestion: 'Increase gas price or wait for the pending transaction to confirm.',
    };
  }
  
  if (errorIncludes(error, ['user rejected', 'user denied'])) {
    return {
      signature: signature || '0x????????',
      message: 'Transaction was rejected',
      suggestion: 'The transaction was cancelled. Try again if needed.',
    };
  }
  
  // Unknown error
  const msg = error instanceof Error ? error.message : String(error);
  return {
    signature: signature || 'Unknown',
    message: msg.slice(0, 200), // Truncate long messages
    suggestion: 'This is an unexpected error. Check your inputs and try again.',
  };
}

/**
 * Get specific suggestion based on error signature
 */
function getSuggestionForError(signature: string, originalError: unknown): string | undefined {
  switch (signature) {
    case '0x3e3f8f73': // ERC20InsufficientAllowance
      return 'The contract needs a token allowance. Use wallet_call to approve the contract to spend your tokens first.';

    case '0xfb8f41b2': // ERC20InsufficientBalance
      return 'Check your token balance with wallet_dashboard.';

    default:
      return undefined;
  }
}

/**
 * Format a contract error for display in MCP responses
 */
export function formatContractError(error: unknown): string {
  const decoded = decodeContractError(error);
  let text = `❌ **${decoded.message}**`;
  if (decoded.suggestion) {
    text += `\n\n→ ${decoded.suggestion}`;
  }
  if (decoded.signature !== 'Unknown' && decoded.signature !== '0x????????') {
    text += `\n\n(Error signature: \`${decoded.signature}\`)`;
  }
  return text;
}
