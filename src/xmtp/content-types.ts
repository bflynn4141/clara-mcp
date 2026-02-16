/**
 * Clara XMTP Content Types
 *
 * Messages sent via XMTP use a JSON payload prefixed with `CLARA_V1:`.
 * Non-Clara XMTP clients (Converse, Coinbase Wallet) see the raw JSON.
 * Clara clients decode the full structured payload.
 *
 * Format: "CLARA_V1:" + JSON.stringify(ClaraMessagePayload)
 */

export interface ClaraMessagePayload {
  /** Human-readable message text (always present) */
  text: string;

  /** Structured context for agent-to-agent messages */
  context?: {
    bountyId?: number;
    txHash?: string;
    action?: 'bounty-claim' | 'bounty-submit' | 'bounty-approve' | 'payment' | 'general';
    senderName?: string;
    agentId?: number;
  };

  /** XMTP message ID of the parent (for threading) */
  replyTo?: string;

  /** Protocol version */
  v: 1;
}

const CLARA_PREFIX = 'CLARA_V1:';

export function encodeClaraMessage(payload: Omit<ClaraMessagePayload, 'v'>): string {
  const full: ClaraMessagePayload = { ...payload, v: 1 };
  return CLARA_PREFIX + JSON.stringify(full);
}

export function decodeClaraMessage(raw: string): ClaraMessagePayload | null {
  if (!raw.startsWith(CLARA_PREFIX)) return null;
  try {
    const parsed = JSON.parse(raw.slice(CLARA_PREFIX.length)) as ClaraMessagePayload;
    if (typeof parsed.text !== 'string' || parsed.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isClaraMessage(raw: string): boolean {
  return raw.startsWith(CLARA_PREFIX);
}

/**
 * Extract human-readable text from any XMTP message.
 * Handles CLARA_V1, GLORP_V1, and plain text.
 */
export function extractText(raw: string): string {
  const clara = decodeClaraMessage(raw);
  if (clara) return clara.text;

  // Interop: Glorp users can message Clara users
  if (raw.startsWith('GLORP_V1:')) {
    try {
      const parsed = JSON.parse(raw.slice('GLORP_V1:'.length));
      if (typeof parsed.text === 'string') return parsed.text;
    } catch { /* fall through */ }
  }

  return raw;
}
