# Wallet Intelligence System - MVP Plan (v2)

> **Philosophy:** Ship the 80% solution. The LLM is the intelligence layer.

## Vision

Clara understands what tokens you hold and suggests what you can do with them—for ANY verified contract, not just pre-integrated protocols.

```
User has tokens → Clara analyzes (Herd) → Clara suggests (LLM reasoning) → User approves → Clara executes (with simulation)
```

---

## Key Decisions (Locked In)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary chain | **Base** | Lower gas, faster iteration, growing ecosystem |
| Unknown tokens | **Show raw functions** | Let LLM reason about them naturally |
| Priority opportunity | **Unclaimed rewards** | Highest immediate value |
| Token alerts | **In MVP** | Detect new inflows proactively |
| Detection method | **Zerion tx history** | Track recent incoming transfers |
| Include balance | **Yes** | Show user's balance alongside token analysis |
| Cache TTL | **24 hours** | Token types don't change frequently |
| Test tokens | AAVE, UNI, stETH, USDC, Aero LP | Mix of types across chains |
| Execution | **Full loop** | Analyze → suggest → simulate → execute |
| Proxy handling | **Auto-resolve** | EIP-1967 implementation lookup |
| Briefing trigger | **Auto on session start** | + AskUserQuestion for next action |

---

## What We're Building vs. NOT Building

| Building (MVP) | NOT Building (Future/Never) |
|----------------|----------------------------|
| Pattern matching on function names | Bytecode-level heuristics |
| Simple related contract discovery | Full protocol graph with weighted edges |
| LLM-driven confidence/reasoning | Separate confidence scoring engine |
| Simulation + user confirmation | Complex intent assertion models |
| 24-hour classification cache | Incremental block-by-block updates |
| Auto-resolve proxy implementations | Manual proxy detection |
| New token inflow detection | Real-time websocket monitoring |
| Auto-briefing + guided next actions | Passive-only interactions |
| Base (primary) + Ethereum | All L2s day 1 |

---

## Architecture (Simplified)

```
┌─────────────────────────────────────────────────────────┐
│              Wallet Intelligence MVP                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐                                       │
│  │   OBSERVE    │  Zerion API                           │
│  │              │  • Get holdings (cached 5 min)        │
│  └──────┬───────┘  • Get recent transactions            │
│         ↓                                                │
│  ┌──────────────┐                                       │
│  │  CLASSIFY    │  Herd + Pattern Matching              │
│  │              │  • Check ABI for known functions      │
│  └──────┬───────┘  • Resolve proxies (EIP-1967)         │
│         ↓          • If unverified: "can't analyze"     │
│  ┌──────────────┐                                       │
│  │  DISCOVER    │  Simple Strategies Only               │
│  │              │  • Same deployer                      │
│  └──────┬───────┘  • Herd code search                   │
│         ↓                                                │
│  ┌──────────────┐                                       │
│  │   SUGGEST    │  LLM Reasoning (Claude)               │
│  │              │  • Explain what token is              │
│  └──────┬───────┘  • Suggest actions in plain English   │
│         ↓          • Natural confidence expression      │
│  ┌──────────────┐                                       │
│  │   EXECUTE    │  Always Safe                          │
│  │              │  • Simulate first (mandatory)         │
│  └──────────────┘  • Show expected changes              │
│                    • User confirms                      │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 1: Token Classification (Week 1)

### 1.1 Pattern Library (Simplified)

Focus on the most common token types. Don't try to cover everything.

```typescript
// src/intelligence/patterns.ts

export const TOKEN_PATTERNS = {
  // Governance - can delegate voting power
  governance: {
    functions: ['delegate', 'delegates', 'getVotes'],
    description: 'Governance token with voting power',
  },

  // LP Token - represents liquidity position
  lpToken: {
    functions: ['token0', 'token1', 'getReserves'],
    description: 'Liquidity pool token',
  },

  // Vault/Yield - ERC4626 style
  vault: {
    functions: ['asset', 'convertToAssets', 'deposit', 'withdraw'],
    description: 'Yield-bearing vault token',
  },

  // Staking - can stake/unstake with rewards
  staking: {
    functions: ['stake', 'unstake', 'earned'],
    altFunctions: ['deposit', 'withdraw', 'claimReward'], // Alternative names
    description: 'Staking contract with rewards',
  },

  // Vesting - locked tokens with release schedule
  vesting: {
    functions: ['release', 'vestedAmount', 'releasable'],
    description: 'Vesting contract',
  },
};

// Simple matching: does ABI contain these functions?
export function matchTokenType(abiFunctions: string[]): {
  type: string;
  matched: string[];
} | null {
  const fnLower = abiFunctions.map(f => f.toLowerCase());

  for (const [type, pattern] of Object.entries(TOKEN_PATTERNS)) {
    const matched = pattern.functions.filter(f =>
      fnLower.includes(f.toLowerCase())
    );

    // If we match majority of required functions, it's a match
    if (matched.length >= Math.ceil(pattern.functions.length * 0.6)) {
      return { type, matched };
    }
  }

  return null;
}
```

### 1.2 Classification with Proxy Resolution

**Key feature:** Auto-resolve EIP-1967 proxies to analyze the implementation contract.

```typescript
// src/intelligence/classifier.ts

import { createPublicClient, http, type Hex } from 'viem';

// EIP-1967 storage slot for implementation address
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

export interface TokenAnalysis {
  address: string;
  chain: string;

  // Basic info
  name?: string;
  symbol?: string;
  decimals?: number;

  // What we found
  isVerified: boolean;
  isProxy: boolean;
  implementationAddress?: string;

  // Classification (if we could determine)
  likelyType?: string;
  matchedFunctions?: string[];

  // All available functions (for LLM to reason about)
  availableFunctions: string[];

  // Related contracts we found
  relatedContracts: Array<{
    address: string;
    name?: string;
    relationship: string;
  }>;
}

export async function analyzeToken(
  address: string,
  chain: string
): Promise<TokenAnalysis> {
  const registry = getProviderRegistry();

  // Step 1: Check if this is a proxy and resolve implementation
  const proxyInfo = await resolveEIP1967Proxy(address, chain);

  // Step 2: Get metadata from implementation if proxy, otherwise from address
  const targetAddress = proxyInfo.implementationAddress || address;
  const result = await registry.getContractMetadata({
    address: targetAddress,
    chain,
    includeAbi: true,
  });

  if (!result.success || !result.data) {
    return {
      address,
      chain,
      isVerified: false,
      isProxy: proxyInfo.isProxy,
      implementationAddress: proxyInfo.implementationAddress,
      availableFunctions: [],
      relatedContracts: [],
    };
  }

  const { abi, name, tokenInfo } = result.data;

  // Extract function names
  const functions = abi
    .filter((item: any) => item.type === 'function')
    .map((item: any) => item.name);

  // Try to match a known type
  const typeMatch = matchTokenType(functions);

  // Find related contracts
  const related = await findRelatedContracts(address, chain);

  return {
    address,
    chain,
    name: name || tokenInfo?.name,
    symbol: tokenInfo?.symbol,
    decimals: tokenInfo?.decimals,
    isVerified: true,
    isProxy: proxyInfo.isProxy,
    implementationAddress: proxyInfo.implementationAddress,
    likelyType: typeMatch?.type,
    matchedFunctions: typeMatch?.matched,
    availableFunctions: functions,
    relatedContracts: related,
  };
}

// Resolve EIP-1967 proxy to get implementation address
async function resolveEIP1967Proxy(
  address: string,
  chain: string
): Promise<{ isProxy: boolean; implementationAddress?: string }> {
  try {
    const client = createPublicClient({
      chain: getViemChain(chain),
      transport: http(getRpcUrl(chain)),
    });

    // Read EIP-1967 implementation storage slot
    const slot = await client.getStorageAt({
      address: address as Hex,
      slot: EIP1967_IMPL_SLOT as Hex,
    });

    // Check if slot contains a valid address (not zero)
    if (slot && slot !== '0x' + '0'.repeat(64)) {
      const implAddress = '0x' + slot.slice(-40);
      if (implAddress !== '0x' + '0'.repeat(40)) {
        return { isProxy: true, implementationAddress: implAddress };
      }
    }

    return { isProxy: false };
  } catch {
    // If we can't check, assume not a proxy
    return { isProxy: false };
  }
}
```

### 1.3 Related Contract Discovery (Just Two Strategies)

```typescript
// src/intelligence/discovery.ts

export async function findRelatedContracts(
  address: string,
  chain: string
): Promise<RelatedContract[]> {
  const related: RelatedContract[] = [];
  const registry = getProviderRegistry();

  // Strategy 1: Code reference search via Herd
  // Find contracts that mention this token address
  try {
    const codeSearch = await registry.searchCode({
      query: address,
      chain,
    });

    if (codeSearch.success && codeSearch.data) {
      for (const match of codeSearch.data.slice(0, 5)) { // Limit to 5
        related.push({
          address: match.contractAddress,
          name: match.contractName,
          relationship: 'references this token in code',
        });
      }
    }
  } catch (e) {
    // Non-fatal, continue
  }

  // Strategy 2: Same deployer (if we can get it)
  // This would require transaction history lookup
  // Skip for MVP - add later if needed

  return related;
}
```

### 1.4 Tool: `wallet_analyze_holding`

```typescript
// src/tools/analyze-holding.ts

export const analyzeHoldingToolDefinition = {
  name: 'wallet_analyze_holding',
  description: `Analyze a token to understand what it is and what you can do with it.

Returns:
- Token classification (governance, LP, vault, staking, etc.)
- Your balance of this token (if connected)
- Available functions
- Related contracts
- Suggested actions

**Example:**
\`\`\`json
{"token": "0x...", "chain": "base"}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      token: {
        type: 'string',
        description: 'Token address (0x...)',
      },
      chain: {
        type: 'string',
        enum: ['ethereum', 'base'],
        default: 'base',
      },
    },
    required: ['token'],
  },
};

export async function handleAnalyzeHolding(
  args: Record<string, unknown>
): Promise<ToolResponse> {
  const token = args.token as string;
  const chain = (args.chain as string) || 'base';

  // Get token analysis
  const analysis = await analyzeToken(token, chain);

  // Also get user's balance of this token (if wallet connected)
  let userBalance: { amount: string; valueUsd?: number } | null = null;
  const session = await getSession();
  if (session?.address) {
    userBalance = await getTokenBalance(session.address, token, chain);
  }

  // Return analysis + balance - let LLM interpret and explain
  return {
    content: [{
      type: 'text',
      text: formatAnalysisForLLM(analysis, userBalance),
    }],
  };
}

function formatAnalysisForLLM(
  analysis: TokenAnalysis,
  userBalance?: { amount: string; valueUsd?: number } | null
): string {
  const lines: string[] = [];

  lines.push(`## Token Analysis: ${analysis.symbol || analysis.address}`);
  lines.push('');

  if (!analysis.isVerified) {
    lines.push('⚠️ **Contract not verified** - Cannot analyze source code safely.');
    lines.push('');
    lines.push('Recommendation: Be cautious interacting with unverified contracts.');
    return lines.join('\n');
  }

  lines.push(`**Address:** \`${analysis.address}\``);
  lines.push(`**Chain:** ${analysis.chain}`);
  if (analysis.name) lines.push(`**Name:** ${analysis.name}`);
  if (analysis.symbol) lines.push(`**Symbol:** ${analysis.symbol}`);

  // Show user's balance if available
  if (userBalance) {
    const valueStr = userBalance.valueUsd
      ? ` (~$${userBalance.valueUsd.toLocaleString()})`
      : '';
    lines.push(`**Your Balance:** ${userBalance.amount} ${analysis.symbol || 'tokens'}${valueStr}`);
  }

  if (analysis.isProxy) {
    lines.push(`**Proxy:** Yes (implementation: \`${analysis.implementationAddress}\`)`);
  }

  lines.push('');

  if (analysis.likelyType) {
    lines.push(`**Likely Type:** ${analysis.likelyType}`);
    lines.push(`**Matched Functions:** ${analysis.matchedFunctions?.join(', ')}`);
  } else {
    lines.push('**Type:** Could not determine standard type');
    lines.push('');
    lines.push('_Showing all functions so you can reason about this contract:_');
  }

  lines.push('');
  lines.push('**Available Functions:**');
  for (const fn of analysis.availableFunctions.slice(0, 20)) {
    lines.push(`- \`${fn}\``);
  }
  if (analysis.availableFunctions.length > 20) {
    lines.push(`- ... and ${analysis.availableFunctions.length - 20} more`);
  }

  if (analysis.relatedContracts.length > 0) {
    lines.push('');
    lines.push('**Related Contracts Found:**');
    for (const rel of analysis.relatedContracts) {
      lines.push(`- \`${rel.address}\` (${rel.name || 'unknown'}) - ${rel.relationship}`);
    }
  }

  return lines.join('\n');
}
```

---

## Phase 2: Opportunity Detection (Week 2)

### 2.1 Simple Opportunity Checks

For each holding, check for obvious opportunities. Don't over-engineer.

```typescript
// src/intelligence/opportunities.ts

export interface SimpleOpportunity {
  type: 'claimable' | 'governance' | 'stakeable' | 'vestable';
  title: string;
  description: string;
  contractAddress: string;
  functionToCall: string;
  estimatedValue?: string;
}

export async function checkOpportunities(
  userAddress: string,
  tokenAnalysis: TokenAnalysis
): Promise<SimpleOpportunity[]> {
  const opportunities: SimpleOpportunity[] = [];
  const fns = tokenAnalysis.availableFunctions.map(f => f.toLowerCase());

  // Check for claimable rewards
  if (fns.includes('earned') || fns.includes('claimable') || fns.includes('claimablereward')) {
    const claimable = await checkClaimableAmount(
      tokenAnalysis.address,
      userAddress,
      tokenAnalysis.availableFunctions
    );

    if (claimable && claimable !== '0') {
      opportunities.push({
        type: 'claimable',
        title: 'Unclaimed rewards available',
        description: `You have ${claimable} tokens available to claim`,
        contractAddress: tokenAnalysis.address,
        functionToCall: detectClaimFunction(tokenAnalysis.availableFunctions),
        estimatedValue: claimable,
      });
    }
  }

  // Check for governance
  if (fns.includes('delegate') && fns.includes('delegates')) {
    opportunities.push({
      type: 'governance',
      title: 'Governance token',
      description: 'This token has voting power. You can delegate to yourself or others.',
      contractAddress: tokenAnalysis.address,
      functionToCall: 'delegate',
    });
  }

  // Check for vesting
  if (fns.includes('release') && (fns.includes('releasable') || fns.includes('vestedamount'))) {
    const releasable = await checkReleasableAmount(tokenAnalysis.address, userAddress);

    if (releasable && releasable !== '0') {
      opportunities.push({
        type: 'vestable',
        title: 'Vested tokens available',
        description: `You have ${releasable} tokens ready to release`,
        contractAddress: tokenAnalysis.address,
        functionToCall: 'release',
        estimatedValue: releasable,
      });
    }
  }

  return opportunities;
}

// Helper to detect the right claim function name
function detectClaimFunction(functions: string[]): string {
  const claimFns = ['getReward', 'claim', 'claimReward', 'claimRewards', 'harvest'];
  for (const fn of claimFns) {
    if (functions.some(f => f.toLowerCase() === fn.toLowerCase())) {
      return fn;
    }
  }
  return 'claim'; // Default guess
}
```

### 2.2 Tool: `wallet_opportunities`

```typescript
// src/tools/opportunities.ts

export const opportunitiesToolDefinition = {
  name: 'wallet_opportunities',
  description: `Scan your holdings for actionable opportunities.

Checks each token for:
- Unclaimed rewards
- Governance participation
- Vested tokens ready to release

**Example:**
\`\`\`json
{"chain": "base"}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      chain: {
        type: 'string',
        enum: ['ethereum', 'base'],
        default: 'base',
      },
      minValueUsd: {
        type: 'number',
        default: 10,
        description: 'Only analyze holdings worth more than this',
      },
    },
  },
};

export async function handleOpportunities(
  args: Record<string, unknown>
): Promise<ToolResponse> {
  const chain = (args.chain as string) || 'base';
  const minValue = (args.minValueUsd as number) || 10;

  const session = await getSession();
  if (!session?.address) {
    return errorResponse('Wallet not connected');
  }

  // Get holdings from Zerion (cached)
  const holdings = await getHoldings(session.address, chain);
  const significantHoldings = holdings.filter(h => h.valueUsd >= minValue);

  // Analyze each and check for opportunities
  const allOpportunities: Array<{
    token: string;
    symbol: string;
    opportunities: SimpleOpportunity[];
  }> = [];

  for (const holding of significantHoldings.slice(0, 10)) { // Limit to 10 for speed
    const analysis = await analyzeToken(holding.address, chain);
    const opps = await checkOpportunities(session.address, analysis);

    if (opps.length > 0) {
      allOpportunities.push({
        token: holding.address,
        symbol: holding.symbol,
        opportunities: opps,
      });
    }
  }

  return {
    content: [{
      type: 'text',
      text: formatOpportunitiesForLLM(allOpportunities),
    }],
  };
}
```

---

## Phase 3: Briefing & Polish (Week 3)

### 3.1 Tool: `wallet_briefing`

Combines balance check + opportunity scan + new token detection into a session starter.
**This should auto-run when Clara starts a session**, followed by AskUserQuestion with contextual options.

```typescript
// src/tools/briefing.ts

export const briefingToolDefinition = {
  name: 'wallet_briefing',
  description: `Get a quick briefing on your wallet and opportunities.

**AUTO-RUN ON SESSION START** - Clara should run this proactively when
a user begins a session, then use AskUserQuestion to guide next actions.

Returns:
- Portfolio summary
- New tokens received (inflows since last check)
- Opportunities found (unclaimed rewards, governance, etc.)
- Suggested next actions

**Example:**
\`\`\`json
{"chain": "base"}
\`\`\``,
  inputSchema: {
    type: 'object' as const,
    properties: {
      chain: {
        type: 'string',
        enum: ['ethereum', 'base'],
        default: 'base',
      },
    },
  },
};

export async function handleBriefing(
  args: Record<string, unknown>
): Promise<ToolResponse> {
  const chain = (args.chain as string) || 'base';

  const session = await getSession();
  if (!session?.address) {
    return errorResponse('Wallet not connected');
  }

  // Parallel fetch: holdings + recent transactions (for inflow detection)
  const [holdings, recentTxs] = await Promise.all([
    getHoldings(session.address, chain),
    getRecentTransactions(session.address, chain, 20), // More for inflow detection
  ]);

  // Detect new token inflows
  const newTokens = detectNewInflows(recentTxs, session.address);

  // Quick opportunity scan on top 5 holdings
  const topHoldings = holdings
    .sort((a, b) => b.valueUsd - a.valueUsd)
    .slice(0, 5);

  const opportunities: SimpleOpportunity[] = [];
  for (const holding of topHoldings) {
    const analysis = await analyzeToken(holding.address, chain);
    const opps = await checkOpportunities(session.address, analysis);
    opportunities.push(...opps);
  }

  // Calculate totals
  const totalValueUsd = holdings.reduce((sum, h) => sum + h.valueUsd, 0);

  // Format briefing with suggested actions for AskUserQuestion
  return {
    content: [{
      type: 'text',
      text: formatBriefing({
        address: session.address,
        chain,
        holdings,
        totalValueUsd,
        newTokens,          // NEW: tokens received recently
        opportunities,
        suggestedActions: buildSuggestedActions(opportunities, newTokens), // NEW
      }),
    }],
  };
}

// Detect tokens that arrived via incoming transfers
function detectNewInflows(
  transactions: Transaction[],
  userAddress: string
): NewToken[] {
  const inflows: NewToken[] = [];

  for (const tx of transactions) {
    // Look for incoming token transfers
    if (tx.transfers) {
      for (const transfer of tx.transfers) {
        if (transfer.to?.toLowerCase() === userAddress.toLowerCase() &&
            transfer.direction === 'in') {
          inflows.push({
            address: transfer.tokenAddress,
            symbol: transfer.symbol,
            amount: transfer.amount,
            valueUsd: transfer.valueUsd,
            receivedAt: tx.timestamp,
            txHash: tx.hash,
          });
        }
      }
    }
  }

  // Dedupe by token address, keep most recent
  const unique = new Map<string, NewToken>();
  for (const inflow of inflows) {
    if (!unique.has(inflow.address) ||
        inflow.receivedAt > unique.get(inflow.address)!.receivedAt) {
      unique.set(inflow.address, inflow);
    }
  }

  return Array.from(unique.values());
}

// Build suggested actions for AskUserQuestion
function buildSuggestedActions(
  opportunities: SimpleOpportunity[],
  newTokens: NewToken[]
): SuggestedAction[] {
  const actions: SuggestedAction[] = [];

  // Add claim opportunities
  for (const opp of opportunities.filter(o => o.type === 'claimable')) {
    actions.push({
      label: `Claim ${opp.estimatedValue} rewards`,
      description: opp.description,
      action: 'claim',
      data: opp,
    });
  }

  // Add new token analysis
  for (const token of newTokens.slice(0, 2)) {
    actions.push({
      label: `Analyze new ${token.symbol} tokens`,
      description: `You received ${token.amount} ${token.symbol}`,
      action: 'analyze',
      data: token,
    });
  }

  // Add governance if detected
  for (const opp of opportunities.filter(o => o.type === 'governance')) {
    actions.push({
      label: 'Check governance voting power',
      description: opp.description,
      action: 'governance',
      data: opp,
    });
  }

  return actions;
}
```

### 3.2 Auto-Briefing Behavior

Clara should be instructed (via system prompt or tool description) to:

1. **On session start** - Run `wallet_briefing` proactively
2. **After briefing** - Use `AskUserQuestion` with options from `suggestedActions`
3. **On user selection** - Execute the corresponding flow

Example prompt addition for Clara:
```
When a user starts a conversation, proactively run wallet_briefing
to check their wallet state. Then use AskUserQuestion to present
the opportunities found and let them choose what to do next.
```

---

## Phase 4: Safety & Execution (Week 4)

### 4.1 Simulation Before Every Write

This is the core safety mechanism. No complex intent models—just simulate and show.

```typescript
// src/intelligence/safety.ts

export async function simulateAndExplain(
  transaction: { to: string; data: string; value?: string },
  userAddress: string,
  chain: string
): Promise<{
  success: boolean;
  balanceChanges: BalanceChange[];
  warnings: string[];
  revertReason?: string;
}> {
  // Use existing simulate tool
  const result = await handleSimulateRequest({
    to: transaction.to,
    data: transaction.data,
    value: transaction.value || '0',
    chain,
  });

  // Parse simulation result
  // Return in format LLM can explain to user
}
```

### 4.2 Action Execution Flow

```typescript
// In the LLM conversation, not in code:

// 1. User says "claim my rewards"
// 2. Clara analyzes the contract, identifies claim function
// 3. Clara builds transaction calldata
// 4. Clara ALWAYS simulates first
// 5. Clara shows: "This will claim 45 XYZ tokens to your wallet"
// 6. User confirms
// 7. Clara executes

// The safety is in the FLOW, not in complex code
```

---

## Implementation Timeline

### Week 1: Classification Foundation
- [ ] Create `src/intelligence/` directory
- [ ] Implement `patterns.ts` (5 common token types)
- [ ] Implement `classifier.ts` (simple pattern matching)
- [ ] Implement `discovery.ts` (code search only)
- [ ] Create `wallet_analyze_holding` tool
- [ ] Test with: AAVE, UNI, stETH, USDC, a random LP token

### Week 2: Opportunity Detection
- [ ] Implement `opportunities.ts` (claimable, governance, vesting)
- [ ] Add `checkClaimableAmount` helper (eth_call to common functions)
- [ ] Create `wallet_opportunities` tool
- [ ] Test with wallet that has staking positions

### Week 3: Briefing & Integration
- [ ] Create `wallet_briefing` tool
- [ ] Add basic caching (5 min TTL on classifications)
- [ ] Integration testing across tools
- [ ] Handle edge cases that come up

### Week 4: Safety & Polish
- [ ] Ensure simulation is always called before writes
- [ ] Add "unverified contract" warnings
- [ ] Add "contract < 30 days old" warnings
- [ ] Documentation
- [ ] Real-world testing

---

## File Structure (Minimal)

```
src/
├── intelligence/
│   ├── index.ts           # Exports
│   ├── patterns.ts        # Token type patterns (simple)
│   ├── classifier.ts      # Token classification
│   ├── discovery.ts       # Related contract discovery
│   ├── opportunities.ts   # Opportunity checking
│   └── cache.ts           # Simple TTL cache
│
├── tools/
│   ├── analyze-holding.ts # NEW
│   ├── opportunities.ts   # NEW
│   ├── briefing.ts        # NEW
│   └── ... (existing)
```

---

## The Magic UX: Auto-Briefing + Guided Actions

When a user starts a Clara session, the flow should be:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Session Start Flow                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. User says anything ("hi", "what's up", etc.)                │
│                          ↓                                       │
│  2. Clara auto-runs wallet_briefing                             │
│                          ↓                                       │
│  3. Briefing shows:                                             │
│     • Portfolio summary ($X total, Y tokens)                    │
│     • New tokens since last session                             │
│     • Opportunities found (unclaimed rewards, etc.)             │
│                          ↓                                       │
│  4. Clara uses AskUserQuestion with contextual options:         │
│                                                                  │
│     ┌─────────────────────────────────────────────────────┐     │
│     │ "I found some opportunities. What would you like    │     │
│     │  to do?"                                            │     │
│     │                                                     │     │
│     │  ○ Claim 12.5 stkAAVE rewards (~$1,200)            │     │
│     │  ○ Analyze the new AERO tokens you received        │     │
│     │  ○ Check your governance voting power              │     │
│     │  ○ Something else                                  │     │
│     └─────────────────────────────────────────────────────┘     │
│                          ↓                                       │
│  5. User clicks option → Clara executes that flow               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Key UX Principles

1. **Proactive, not passive** - Don't wait for user to ask "any opportunities?"
2. **Contextual options** - AskUserQuestion options come FROM the briefing data
3. **One-click to action** - User clicks "Claim rewards" → Clara handles the rest
4. **Always include escape hatch** - "Something else" option for user autonomy

### Example Session Start

```
User: "hey"

Clara: *runs wallet_briefing automatically*

"📊 **Wallet Briefing** (Base)

**Portfolio:** $4,250 across 8 tokens
**New this week:** Received 500 AERO from Aerodrome rewards

**🎯 Opportunities Found:**
1. **Unclaimed rewards:** 12.5 stkAAVE (~$1,200) from Safety Module
2. **Governance:** You hold UNI but haven't delegated voting power
3. **New token:** 500 AERO - this is Aerodrome's governance token

What would you like to do?"

[AskUserQuestion appears with options based on the above]
```

---

## What Success Looks Like

### Week 1 Demo
```
User: "What is this token? 0x..."
Clara: "This is AAVE, a governance token. It has delegate() and
        vote() functions, meaning you can participate in Aave
        governance. You currently have 100 AAVE (~$9,500).

        Would you like me to check if you've delegated your
        voting power?"
```

### Week 2 Demo
```
User: "Any opportunities in my wallet?"
Clara: "I found 2 opportunities:
        1. You have 12.5 stkAAVE rewards unclaimed (~$1,200)
        2. Your CRV tokens aren't vote-locked - you could earn
           boost by locking

        Want me to claim the AAVE rewards?"
```

### Week 4 Demo
```
User: "Claim my staking rewards"
Clara: *simulates transaction*
       "This will claim 12.5 stkAAVE to your wallet.

        Simulation shows:
        • Your stkAAVE balance: +12.5
        • Gas estimate: ~0.002 ETH

        Proceed?"
User: "Yes"
Clara: *executes* "Done! TX: 0x..."
```

---

## Key Decisions (MVP Constraints)

1. **Pattern matching on function names** - Good enough for 80% of tokens. When it fails, LLM can still reason about the raw function list.

2. **No confidence scores** - The LLM naturally expresses confidence: "This looks like a governance token..." vs "I'm not sure what this contract does..."

3. **Code search is the only discovery** - Factory backtracking and same-deployer are nice-to-haves. Code search via Herd gets us most of the value.

4. **Simulation is the safety layer** - Not complex intent models. Just simulate, show changes, get confirmation.

5. **Cache aggressively** - Token classifications don't change. Cache for 24 hours. Opportunity checks cache for 5 minutes.

6. **Fail gracefully** - Unverified? Say so. Can't classify? Show raw functions and let LLM reason. API error? Surface it.
