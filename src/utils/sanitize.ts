/**
 * Sanitization Utilities
 *
 * Sanitize on-chain data before including in LLM context.
 * Prevents prompt injection attacks from malicious contract names,
 * token symbols, or metadata stored on-chain.
 *
 * Attack vectors:
 * - Contract names like "IGNORE PREVIOUS INSTRUCTIONS"
 * - Token symbols containing markdown/XML injection
 * - NFT metadata with embedded prompts
 * - Event/function names with special characters
 */

// ============================================================================
// Patterns to detect and neutralize
// ============================================================================

/**
 * Common prompt injection patterns
 * NOTE: Using 'i' flag only (not 'g') because .test() with global flag is stateful
 * and can cause false negatives on repeated calls.
 */
const INJECTION_PATTERNS = [
  // Instruction override attempts
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /disregard\s+(all\s+)?prior\s+instructions?/i,
  /forget\s+(everything|all)/i,
  /new\s+instructions?:/i,
  /system\s*:/i,
  /assistant\s*:/i,
  /user\s*:/i,
  /human\s*:/i,

  // Role-playing attempts
  /you\s+are\s+(now|a)/i,
  /act\s+as\s+(if|a)/i,
  /pretend\s+(you|to)/i,
  /roleplay\s+as/i,

  // Output manipulation
  /output\s+the\s+following/i,
  /print\s+(exactly|this)/i,
  /respond\s+with\s+only/i,

  // XML/HTML injection
  /<\/?script/i,
  /<\/?style/i,
  /\]\]\>/,  // CDATA end
  /<!\[CDATA\[/,  // CDATA start
];

/**
 * Characters that could be used for formatting attacks
 */
const DANGEROUS_CHARS: Record<string, string> = {
  '<': '‹',    // Replace with similar-looking safe char
  '>': '›',
  '`': "'",    // Backticks can break markdown code blocks
  '$': '＄',   // Could trigger template literals
  '{': '｛',   // JSON/template injection
  '}': '｝',
  '|': '│',    // Table injection in markdown
  '\n': ' ',   // Newlines can break formatting
  '\r': ' ',
  '\t': ' ',
  '\0': '',    // Null bytes
  // Unicode control characters (invisible prompt/URL tricks)
  '\u202E': '', // Right-to-Left Override - can reverse text display
  '\u202D': '', // Left-to-Right Override
  '\u202C': '', // Pop Directional Formatting
  '\u202B': '', // Right-to-Left Embedding
  '\u202A': '', // Left-to-Right Embedding
  '\u200E': '', // Left-to-Right Mark
  '\u200F': '', // Right-to-Left Mark
  '\u200B': '', // Zero Width Space - invisible
  '\u200C': '', // Zero Width Non-Joiner
  '\u200D': '', // Zero Width Joiner
  '\u2060': '', // Word Joiner
  '\uFEFF': '', // Zero Width No-Break Space (BOM)
  '\u00AD': '', // Soft Hyphen - invisible
  '\u034F': '', // Combining Grapheme Joiner
  '\u061C': '', // Arabic Letter Mark
  '\u2066': '', // Left-to-Right Isolate
  '\u2067': '', // Right-to-Left Isolate
  '\u2068': '', // First Strong Isolate
  '\u2069': '', // Pop Directional Isolate
};

// ============================================================================
// Core sanitization functions
// ============================================================================

/**
 * Sanitize a string for safe inclusion in LLM context
 *
 * @param input - Raw string from on-chain source
 * @param maxLength - Maximum allowed length (default 100)
 * @returns Sanitized string safe for LLM context
 */
export function sanitizeString(input: string | undefined | null, maxLength = 100): string {
  if (!input) return '';

  let result = input;

  // Step 1: Truncate to max length
  if (result.length > maxLength) {
    result = result.slice(0, maxLength) + '...';
  }

  // Step 2: Replace dangerous characters
  for (const [dangerous, safe] of Object.entries(DANGEROUS_CHARS)) {
    result = result.split(dangerous).join(safe);
  }

  // Step 3: Neutralize injection patterns
  // Create global version of pattern for replaceAll behavior
  for (const pattern of INJECTION_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags + 'g');
    result = result.replace(globalPattern, '[filtered]');
  }

  // Step 4: Remove any remaining Unicode control characters (Cf category)
  // This catches any bidi overrides or invisible characters we might have missed
  result = result.replace(/[\p{Cf}]/gu, '');

  // Step 5: Collapse multiple spaces
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

/**
 * Sanitize a contract name
 */
export function sanitizeContractName(name: string | undefined | null): string {
  return sanitizeString(name, 50);
}

/**
 * Sanitize a token symbol
 */
export function sanitizeTokenSymbol(symbol: string | undefined | null): string {
  // Symbols should be short alphanumeric only
  if (!symbol) return '';
  const cleaned = symbol.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 20);
  return cleaned || 'UNKNOWN';
}

/**
 * Sanitize a function/event name
 */
export function sanitizeFunctionName(name: string | undefined | null): string {
  // Function names should be valid identifiers
  if (!name) return '';
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64);
  return cleaned || 'unknown';
}

/**
 * Sanitize an address (should already be hex)
 */
export function sanitizeAddress(address: string | undefined | null): string {
  if (!address) return '';
  // Only allow valid hex addresses
  const match = address.match(/^0x[a-fA-F0-9]{40}$/);
  return match ? address.toLowerCase() : '';
}

/**
 * Sanitize a transaction hash
 */
export function sanitizeTxHash(hash: string | undefined | null): string {
  if (!hash) return '';
  const match = hash.match(/^0x[a-fA-F0-9]{64}$/);
  return match ? hash.toLowerCase() : '';
}

/**
 * Sanitize a description/summary field
 */
export function sanitizeDescription(description: string | undefined | null): string {
  return sanitizeString(description, 500);
}

/**
 * Sanitize a URL
 */
export function sanitizeUrl(url: string | undefined | null): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    // Only allow http(s) protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

// ============================================================================
// Batch sanitization
// ============================================================================

/**
 * Sanitize contract metadata object
 */
export function sanitizeContractMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...metadata };

  if ('name' in sanitized && typeof sanitized.name === 'string') {
    (sanitized as Record<string, unknown>).name = sanitizeContractName(sanitized.name);
  }
  if ('summary' in sanitized && typeof sanitized.summary === 'string') {
    (sanitized as Record<string, unknown>).summary = sanitizeDescription(sanitized.summary);
  }
  if ('address' in sanitized && typeof sanitized.address === 'string') {
    (sanitized as Record<string, unknown>).address = sanitizeAddress(sanitized.address);
  }

  // Sanitize token info
  if ('token' in sanitized && typeof sanitized.token === 'object' && sanitized.token) {
    const token = sanitized.token as Record<string, unknown>;
    if ('name' in token && typeof token.name === 'string') {
      token.name = sanitizeContractName(token.name);
    }
    if ('symbol' in token && typeof token.symbol === 'string') {
      token.symbol = sanitizeTokenSymbol(token.symbol);
    }
  }

  // Sanitize function names
  if ('functions' in sanitized && Array.isArray(sanitized.functions)) {
    (sanitized as Record<string, unknown>).functions = (sanitized.functions as Record<string, unknown>[]).map((f) => ({
      ...f,
      name: sanitizeFunctionName(f.name as string),
      summary: f.summary ? sanitizeDescription(f.summary as string) : undefined,
    }));
  }

  // Sanitize event names
  if ('events' in sanitized && Array.isArray(sanitized.events)) {
    (sanitized as Record<string, unknown>).events = (sanitized.events as Record<string, unknown>[]).map((e) => ({
      ...e,
      name: sanitizeFunctionName(e.name as string),
      summary: e.summary ? sanitizeDescription(e.summary as string) : undefined,
    }));
  }

  return sanitized;
}

/**
 * Sanitize transaction analysis object
 */
export function sanitizeTransactionAnalysis(analysis: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...analysis };

  if ('hash' in sanitized && typeof sanitized.hash === 'string') {
    (sanitized as Record<string, unknown>).hash = sanitizeTxHash(sanitized.hash);
  }
  if ('intentSummary' in sanitized && typeof sanitized.intentSummary === 'string') {
    (sanitized as Record<string, unknown>).intentSummary = sanitizeDescription(sanitized.intentSummary);
  }

  // Sanitize call info
  if ('call' in sanitized && typeof sanitized.call === 'object' && sanitized.call) {
    const call = sanitized.call as Record<string, unknown>;
    if ('functionName' in call && typeof call.functionName === 'string') {
      call.functionName = sanitizeFunctionName(call.functionName);
    }
    if ('contractName' in call && typeof call.contractName === 'string') {
      call.contractName = sanitizeContractName(call.contractName);
    }
    if ('readable' in call && typeof call.readable === 'string') {
      call.readable = sanitizeDescription(call.readable);
    }
  }

  // Sanitize events
  if ('events' in sanitized && Array.isArray(sanitized.events)) {
    (sanitized as Record<string, unknown>).events = (sanitized.events as Record<string, unknown>[]).map((e) => ({
      ...e,
      eventName: sanitizeFunctionName(e.eventName as string),
      contractName: e.contractName ? sanitizeContractName(e.contractName as string) : undefined,
    }));
  }

  return sanitized;
}

// ============================================================================
// Detection utilities
// ============================================================================

/**
 * Check if a string contains suspicious patterns
 */
export function containsSuspiciousPatterns(input: string): boolean {
  if (!input) return false;

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      return true;
    }
  }

  // Check for excessive special characters
  const specialCount = (input.match(/[<>{}|\[\]`$]/g) || []).length;
  if (specialCount > input.length * 0.1) {
    return true;
  }

  return false;
}

/**
 * Log a warning if suspicious content is detected
 */
export function warnIfSuspicious(input: string, source: string): void {
  if (containsSuspiciousPatterns(input)) {
    console.warn(`⚠️ Suspicious content detected in ${source}: "${input.slice(0, 50)}..."`);
  }
}
