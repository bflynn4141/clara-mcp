/**
 * Clara Error Types
 *
 * Standardized error codes and formatting for all Clara MCP tools.
 * Tools throw ClaraError instead of returning ad-hoc { isError: true } objects.
 * The middleware pipeline catches these and formats them into MCP responses.
 */

export enum ClaraErrorCode {
  NO_SESSION = 'NO_SESSION',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  SPENDING_LIMIT = 'SPENDING_LIMIT',
  INSUFFICIENT_GAS = 'INSUFFICIENT_GAS',
  NO_CONTRACT = 'NO_CONTRACT',
  SIMULATION_FAILED = 'SIMULATION_FAILED',
  TX_REVERTED = 'TX_REVERTED',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  INVALID_INPUT = 'INVALID_INPUT',
  UNKNOWN = 'UNKNOWN',
}

export class ClaraError extends Error {
  constructor(
    public code: ClaraErrorCode,
    message: string,
    public suggestion?: string,
    public context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ClaraError';
  }
}

/**
 * Format a ClaraError into an MCP tool response
 */
export function formatClaraError(error: ClaraError): {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
} {
  const icon = error.code === ClaraErrorCode.SPENDING_LIMIT ? '🛑' : '❌';
  let text = `${icon} ${error.message}`;
  if (error.suggestion) text += `\n\n→ ${error.suggestion}`;
  if (error.context) text += `\n\n${JSON.stringify(error.context, null, 2)}`;
  return { content: [{ type: 'text', text }], isError: true };
}
