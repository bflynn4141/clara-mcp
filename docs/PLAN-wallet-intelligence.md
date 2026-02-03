# Wallet Intelligence System - Implementation Plan

## Vision

Transform Clara from a "transaction executor" into a "protocol-fluent financial co-pilot" that can understand and suggest actions for ANY smart contract, not just pre-integrated protocols.

```
User has tokens → Clara analyzes contracts → Clara suggests actions → User approves → Clara executes
```

---

## Core Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Wallet Intelligence System                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────┐     ┌────────────────┐     ┌────────────────┐      │
│  │   OBSERVATION  │     │ CLASSIFICATION │     │   DISCOVERY    │      │
│  │    Layer       │ →   │    Engine      │ →   │    Engine      │      │
│  └────────────────┘     └────────────────┘     └────────────────┘      │
│         │                       │                      │                │
│    Zerion API              Herd MCP               Herd MCP             │
│    • Balances              • ABI analysis         • Code search        │
│    • History               • Function sigs        • Related contracts  │
│    • Approvals             • Pattern matching     • Protocol graph     │
│                                                                          │
│  ┌────────────────┐     ┌────────────────┐     ┌────────────────┐      │
│  │  OPPORTUNITY   │     │    ACTION      │     │   EXECUTION    │      │
│  │   Detection    │ ←   │   Generation   │ →   │    Layer       │      │
│  └────────────────┘     └────────────────┘     └────────────────┘      │
│         │                       │                      │                │
│    LLM reasoning           Dynamic calldata        Para signing        │
│    • Prioritization        • From ABI              • Simulation        │
│    • Risk assessment       • Multi-step            • Transaction       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Token Classification Engine

**Goal:** Given any token address, determine what TYPE of token it is and what capabilities it has.

### 1.1 Pattern Library

Define recognizable patterns based on function signatures:

```typescript
// src/intelligence/patterns.ts

export const TOKEN_PATTERNS = {
  // Governance tokens (can delegate, vote)
  governance: {
    required: ['delegate', 'delegates'],
    optional: ['vote', 'propose', 'getVotes', 'getPastVotes'],
    standards: ['ERC20Votes', 'IGovernor'],
  },

  // LP tokens (represent liquidity positions)
  lpToken: {
    required: ['token0', 'token1', 'getReserves'],
    optional: ['mint', 'burn', 'swap'],
    standards: ['IUniswapV2Pair'],
  },

  // Concentrated liquidity NFT positions
  clPosition: {
    required: ['positions', 'tokenOfOwnerByIndex'],
    optional: ['collect', 'increaseLiquidity', 'decreaseLiquidity'],
    standards: ['INonfungiblePositionManager'],
  },

  // Yield-bearing / vault tokens (ERC4626)
  yieldBearing: {
    required: ['asset', 'convertToAssets', 'convertToShares'],
    optional: ['deposit', 'withdraw', 'redeem'],
    standards: ['IERC4626'],
  },

  // Staking receipt tokens
  stakingReceipt: {
    required: ['stake', 'unstake'],
    optional: ['earned', 'getReward', 'claimReward', 'cooldown'],
    standards: [],
  },

  // Vesting contracts
  vesting: {
    required: ['release', 'vestedAmount'],
    optional: ['releasable', 'released', 'start', 'duration'],
    standards: ['VestingWallet'],
  },

  // Vote-escrowed tokens (locked governance)
  veToken: {
    required: ['create_lock', 'locked'],
    optional: ['increase_amount', 'increase_unlock_time', 'withdraw'],
    standards: ['IVotingEscrow'],
  },

  // Rebasing tokens
  rebasing: {
    required: ['sharesOf', 'getSharesByPooledEth'],
    optional: ['submit', 'getTotalShares'],
    standards: ['IStETH'],
  },

  // Basic ERC20 (fallback)
  basicErc20: {
    required: ['transfer', 'approve', 'balanceOf'],
    optional: ['permit'],
    standards: ['IERC20'],
  },
};
```

### 1.2 Classification Function

```typescript
// src/intelligence/classifier.ts

import { getProviderRegistry } from '../providers/index.js';
import { TOKEN_PATTERNS } from './patterns.js';

export interface TokenClassification {
  address: string;
  chain: string;
  type: keyof typeof TOKEN_PATTERNS;
  confidence: 'high' | 'medium' | 'low';
  capabilities: string[];        // Available functions
  standards: string[];           // Detected standards
  metadata: {
    name?: string;
    symbol?: string;
    decimals?: number;
    totalSupply?: string;
  };
  relatedContracts: Array<{     // Discovered related contracts
    address: string;
    role: string;               // 'staking', 'governance', 'rewards', etc.
    confidence: 'high' | 'medium' | 'low';
  }>;
}

export async function classifyToken(
  address: string,
  chain: string
): Promise<TokenClassification> {
  const registry = getProviderRegistry();

  // Step 1: Get contract metadata from Herd
  const metadata = await registry.getContractMetadata({
    address,
    chain,
    includeAbi: true,
    includeSourceCode: false,
  });

  if (!metadata.success || !metadata.data) {
    throw new Error(`Could not fetch contract metadata: ${metadata.error}`);
  }

  const { abi, name, tokenInfo } = metadata.data;

  // Step 2: Extract function signatures
  const functions = abi
    .filter((item: any) => item.type === 'function')
    .map((item: any) => item.name);

  // Step 3: Match against patterns
  const matches = matchPatterns(functions);

  // Step 4: Determine primary type
  const primaryType = determinePrimaryType(matches);

  // Step 5: Build classification result
  return {
    address,
    chain,
    type: primaryType.type,
    confidence: primaryType.confidence,
    capabilities: functions,
    standards: detectStandards(abi),
    metadata: {
      name: name || tokenInfo?.name,
      symbol: tokenInfo?.symbol,
      decimals: tokenInfo?.decimals,
    },
    relatedContracts: [], // Populated in Phase 2
  };
}

function matchPatterns(functions: string[]): Map<string, number> {
  const scores = new Map<string, number>();

  for (const [patternName, pattern] of Object.entries(TOKEN_PATTERNS)) {
    let score = 0;
    const requiredMatches = pattern.required.filter(fn =>
      functions.some(f => f.toLowerCase() === fn.toLowerCase())
    );

    // Must have all required functions
    if (requiredMatches.length === pattern.required.length) {
      score += pattern.required.length * 2;

      // Bonus for optional matches
      const optionalMatches = pattern.optional.filter(fn =>
        functions.some(f => f.toLowerCase() === fn.toLowerCase())
      );
      score += optionalMatches.length;
    }

    scores.set(patternName, score);
  }

  return scores;
}
```

### 1.3 New Tool: `wallet_analyze_holding`

```typescript
// src/tools/analyze-holding.ts

export const analyzeHoldingToolDefinition = {
  name: 'wallet_analyze_holding',
  description: `Analyze a token you hold to understand what it is and what you can do with it.

**What it does:**
- Identifies the token type (governance, LP, yield-bearing, etc.)
- Lists available actions (stake, vote, claim, etc.)
- Finds related contracts (staking, rewards, governance)
- Assesses opportunities and risks

**Example:**
\`\`\`json
{
  "token": "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9",
  "chain": "ethereum"
}
\`\`\`

Works with any verified contract - no pre-integration needed.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      token: {
        type: 'string',
        description: 'Token address (0x...) or symbol if well-known',
      },
      chain: {
        type: 'string',
        enum: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'],
        default: 'ethereum',
      },
    },
    required: ['token'],
  },
};
```

### 1.4 Files to Create

```
src/intelligence/
├── patterns.ts          # Token pattern definitions
├── classifier.ts        # Classification logic
├── capabilities.ts      # Map types to available actions
└── index.ts             # Exports

src/tools/
├── analyze-holding.ts   # New tool implementation
```

---

## Phase 2: Protocol Discovery Engine

**Goal:** Given a classified token, find all related contracts (staking, governance, rewards, etc.)

### 2.1 Discovery Strategies

```typescript
// src/intelligence/discovery.ts

export interface DiscoveryStrategy {
  name: string;
  applicableTo: string[];  // Token types this strategy works for
  execute: (token: TokenClassification) => Promise<RelatedContract[]>;
}

export const DISCOVERY_STRATEGIES: DiscoveryStrategy[] = [

  // Strategy 1: Factory backtracking
  // Many tokens are created by factories that also create related contracts
  {
    name: 'factory-backtrack',
    applicableTo: ['lpToken', 'yieldBearing'],
    async execute(token) {
      // Search for factory that created this token
      // Factory often creates staking/reward contracts too
      const registry = getProviderRegistry();
      const result = await registry.searchCode({
        addresses: [token.address],
        chain: token.chain,
        query: 'factory OR Factory OR createPair OR deploy',
      });
      // Parse results to find factory address
      // Then query factory for related contracts
    },
  },

  // Strategy 2: Event log analysis
  // Look for events that reference this token
  {
    name: 'event-references',
    applicableTo: ['governance', 'stakingReceipt', 'basicErc20'],
    async execute(token) {
      // Search for contracts that emit events mentioning this token
      // e.g., Staked(address indexed user, uint256 amount)
      // where the staking contract holds this token
    },
  },

  // Strategy 3: Code reference search
  // Find contracts that import or reference this token
  {
    name: 'code-references',
    applicableTo: ['governance', 'basicErc20'],
    async execute(token) {
      const registry = getProviderRegistry();

      // Search for contracts that reference this token address
      const result = await registry.searchCode({
        query: `${token.address} OR IERC20(${token.address.slice(0, 10)})`,
        chain: token.chain,
      });

      // Filter results to find staking/governance contracts
      // that accept this token
    },
  },

  // Strategy 4: Known protocol patterns
  // For recognized protocols, use known contract relationships
  {
    name: 'known-protocols',
    applicableTo: ['*'],
    async execute(token) {
      // Check if this is a known protocol based on:
      // - Contract name patterns
      // - Verified contract names
      // - Code signatures

      // If recognized, return known related contracts
      // e.g., "AAVE" token → Safety Module, Governance contracts
    },
  },

  // Strategy 5: Same deployer analysis
  // Contracts from same deployer are often related
  {
    name: 'same-deployer',
    applicableTo: ['*'],
    async execute(token) {
      // Get deployer of this token
      // Find other contracts deployed by same address
      // Filter by relevance (staking, governance keywords)
    },
  },
];
```

### 2.2 Relationship Graph

```typescript
// src/intelligence/graph.ts

export interface ProtocolGraph {
  token: string;                    // Root token address
  chain: string;
  nodes: Map<string, GraphNode>;    // All related contracts
  edges: GraphEdge[];               // Relationships between contracts
}

export interface GraphNode {
  address: string;
  type: 'token' | 'staking' | 'governance' | 'rewards' | 'factory' | 'unknown';
  name?: string;
  capabilities: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  relationship: 'stakes' | 'governs' | 'rewards' | 'creates' | 'references';
}

export async function buildProtocolGraph(
  token: TokenClassification
): Promise<ProtocolGraph> {
  const graph: ProtocolGraph = {
    token: token.address,
    chain: token.chain,
    nodes: new Map(),
    edges: [],
  };

  // Add root token
  graph.nodes.set(token.address, {
    address: token.address,
    type: 'token',
    name: token.metadata.symbol,
    capabilities: token.capabilities,
  });

  // Run all applicable discovery strategies
  for (const strategy of DISCOVERY_STRATEGIES) {
    if (strategy.applicableTo.includes('*') ||
        strategy.applicableTo.includes(token.type)) {
      const related = await strategy.execute(token);

      for (const contract of related) {
        if (!graph.nodes.has(contract.address)) {
          graph.nodes.set(contract.address, {
            address: contract.address,
            type: contract.role as any,
            name: contract.name,
            capabilities: contract.capabilities || [],
          });

          graph.edges.push({
            from: token.address,
            to: contract.address,
            relationship: inferRelationship(token.type, contract.role),
          });
        }
      }
    }
  }

  return graph;
}
```

### 2.3 Files to Create/Modify

```
src/intelligence/
├── discovery.ts         # Discovery strategies
├── graph.ts             # Protocol relationship graph
├── strategies/
│   ├── factory.ts       # Factory backtracking
│   ├── events.ts        # Event log analysis
│   ├── references.ts    # Code reference search
│   └── deployer.ts      # Same deployer analysis
```

---

## Phase 3: Opportunity Detection

**Goal:** For classified tokens with discovered relationships, identify actionable opportunities.

### 3.1 Opportunity Types

```typescript
// src/intelligence/opportunities.ts

export interface Opportunity {
  id: string;
  type: OpportunityType;
  priority: 'high' | 'medium' | 'low';
  urgency?: 'immediate' | 'soon' | 'whenever';

  title: string;
  description: string;

  token: string;           // Token this opportunity is for
  targetContract: string;  // Contract to interact with
  action: string;          // Function to call

  estimatedValue?: {
    amount: string;
    token: string;
    usdValue?: string;
  };

  risks: string[];

  // For time-sensitive opportunities
  deadline?: string;

  // Pre-built transaction (if possible)
  transaction?: {
    to: string;
    data: string;
    value?: string;
  };
}

export type OpportunityType =
  | 'claim_rewards'      // Unclaimed staking/LP rewards
  | 'governance_vote'    // Active proposal to vote on
  | 'stake'              // Can stake for yield
  | 'unstake'            // Can unstake (cooldown ready)
  | 'rebalance_lp'       // LP position needs attention
  | 'compound'           // Can compound rewards
  | 'vesting_claim'      // Vested tokens available
  | 'airdrop_claim'      // Unclaimed airdrop
  | 'approval_risk'      // Risky approval detected
  | 'yield_opportunity'  // Better yield available elsewhere
  ;
```

### 3.2 Opportunity Detectors

```typescript
// src/intelligence/detectors/

// Detector for unclaimed rewards
export async function detectUnclaimedRewards(
  token: TokenClassification,
  graph: ProtocolGraph,
  userAddress: string
): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];

  // Find staking/reward contracts in the graph
  const rewardContracts = Array.from(graph.nodes.values())
    .filter(n => n.type === 'staking' || n.type === 'rewards');

  for (const contract of rewardContracts) {
    // Check for common reward claim patterns
    if (contract.capabilities.includes('earned') ||
        contract.capabilities.includes('claimableReward')) {

      // Query the contract for user's claimable amount
      const claimable = await queryClaimable(contract.address, userAddress);

      if (claimable.gt(0)) {
        opportunities.push({
          id: `claim-${contract.address}`,
          type: 'claim_rewards',
          priority: 'medium',
          title: `Claim ${claimable} rewards`,
          description: `You have unclaimed rewards from ${contract.name || 'staking'}`,
          token: token.address,
          targetContract: contract.address,
          action: 'getReward', // or 'claim', 'claimReward' - detect from ABI
          estimatedValue: { amount: claimable.toString(), token: token.address },
          risks: [],
        });
      }
    }
  }

  return opportunities;
}

// Detector for governance opportunities
export async function detectGovernanceOpportunities(
  token: TokenClassification,
  graph: ProtocolGraph,
  userAddress: string
): Promise<Opportunity[]> {
  // Find governance contracts
  // Check for active proposals
  // Check if user has voting power
  // Check if user has already voted
}

// Detector for LP health
export async function detectLPOpportunities(
  token: TokenClassification,
  userAddress: string
): Promise<Opportunity[]> {
  // For Uniswap V3 positions: check if in range
  // For V2 positions: check for impermanent loss
  // Suggest rebalancing if needed
}
```

### 3.3 New Tool: `wallet_opportunities`

```typescript
// src/tools/opportunities.ts

export const opportunitiesToolDefinition = {
  name: 'wallet_opportunities',
  description: `Scan your holdings and find actionable opportunities.

**What it finds:**
- Unclaimed rewards and airdrops
- Staking opportunities for your tokens
- Active governance votes you can participate in
- LP positions that need attention
- Risky approvals to revoke

**Example:**
\`\`\`json
{
  "chain": "ethereum",
  "minValueUsd": "10"
}
\`\`\`

Returns prioritized list of actions you can take.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      chain: {
        type: 'string',
        enum: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'],
        default: 'base',
      },
      minValueUsd: {
        type: 'string',
        default: '1',
        description: 'Minimum USD value to consider',
      },
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter to specific opportunity types',
      },
    },
  },
};
```

---

## Phase 4: Action Generation & Execution

**Goal:** Generate transaction calldata dynamically from ABI analysis.

### 4.1 Action Generator

```typescript
// src/intelligence/actions.ts

export interface ActionPlan {
  steps: ActionStep[];
  estimatedGas: string;
  warnings: string[];
}

export interface ActionStep {
  description: string;
  transaction: {
    to: string;
    data: string;
    value: string;
  };
  requiresApproval?: {
    token: string;
    spender: string;
    amount: string;
  };
}

export async function generateActionPlan(
  opportunity: Opportunity,
  userAddress: string
): Promise<ActionPlan> {
  const steps: ActionStep[] = [];

  // Get ABI for target contract
  const registry = getProviderRegistry();
  const metadata = await registry.getContractMetadata({
    address: opportunity.targetContract,
    includeAbi: true,
  });

  const abi = metadata.data?.abi;
  if (!abi) throw new Error('Could not fetch contract ABI');

  // Find the target function
  const targetFn = abi.find(
    (item: any) => item.type === 'function' && item.name === opportunity.action
  );

  if (!targetFn) throw new Error(`Function ${opportunity.action} not found`);

  // Check if approval is needed
  if (needsApproval(opportunity, userAddress)) {
    steps.push(await generateApprovalStep(opportunity, userAddress));
  }

  // Generate main action
  steps.push({
    description: opportunity.title,
    transaction: {
      to: opportunity.targetContract,
      data: encodeFunction(targetFn, getArgs(opportunity, userAddress)),
      value: '0',
    },
  });

  return {
    steps,
    estimatedGas: await estimateGas(steps),
    warnings: generateWarnings(opportunity),
  };
}
```

### 4.2 Multi-Step Execution

```typescript
// src/intelligence/executor.ts

export async function executeActionPlan(
  plan: ActionPlan,
  walletId: string
): Promise<ExecutionResult> {
  const results: TransactionResult[] = [];

  for (const step of plan.steps) {
    // Simulate first
    const simulation = await simulateTransaction(step.transaction);
    if (!simulation.success) {
      return { success: false, error: simulation.error, completedSteps: results };
    }

    // Execute
    const result = await signAndSendTransaction(walletId, step.transaction);
    results.push(result);

    // Wait for confirmation before next step
    await waitForConfirmation(result.txHash);
  }

  return { success: true, results };
}
```

---

## Phase 5: Proactive Briefings

**Goal:** Automatically analyze wallet state and surface insights.

### 5.1 New Tool: `wallet_briefing`

```typescript
// src/tools/briefing.ts

export const briefingToolDefinition = {
  name: 'wallet_briefing',
  description: `Get a personalized briefing on your wallet state and opportunities.

**What you get:**
- New tokens received since last check
- Pending actions (unclaimed, expiring, etc.)
- Portfolio health assessment
- Risk alerts

**Example:**
\`\`\`json
{
  "chain": "base",
  "since": "24h"
}
\`\`\`

Perfect for starting a session: "What should I do today?"`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      chain: {
        type: 'string',
        enum: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'],
      },
      since: {
        type: 'string',
        enum: ['1h', '24h', '7d', '30d'],
        default: '24h',
      },
    },
  },
};

export async function handleBriefingRequest(
  args: Record<string, unknown>
): Promise<ToolResponse> {
  const chain = args.chain as string || 'base';
  const since = args.since as string || '24h';

  const session = await getSession();
  if (!session?.address) {
    return errorResponse('Wallet not connected');
  }

  // 1. Get current holdings
  const holdings = await getHoldings(session.address, chain);

  // 2. Get recent transactions
  const recentTxs = await getRecentTransactions(session.address, chain, since);

  // 3. Identify new inflows
  const newTokens = identifyNewTokens(holdings, recentTxs);

  // 4. Classify all significant holdings
  const classifications = await Promise.all(
    holdings
      .filter(h => h.valueUsd > 10)
      .map(h => classifyToken(h.address, chain))
  );

  // 5. Build protocol graphs
  const graphs = await Promise.all(
    classifications.map(c => buildProtocolGraph(c))
  );

  // 6. Detect all opportunities
  const opportunities = await detectAllOpportunities(
    classifications,
    graphs,
    session.address
  );

  // 7. Generate briefing
  return formatBriefing({
    holdings,
    newTokens,
    classifications,
    opportunities,
    chain,
    since,
  });
}
```

---

## Implementation Timeline

### Week 1: Foundation
- [ ] Create `src/intelligence/` directory structure
- [ ] Implement pattern library (`patterns.ts`)
- [ ] Implement token classifier (`classifier.ts`)
- [ ] Create `wallet_analyze_holding` tool
- [ ] Test with 10 diverse tokens (governance, LP, yield, etc.)

### Week 2: Discovery
- [ ] Implement factory backtracking strategy
- [ ] Implement code reference search strategy
- [ ] Implement same-deployer strategy
- [ ] Build protocol graph data structure
- [ ] Test discovery on AAVE, UNI, CRV ecosystems

### Week 3: Opportunities
- [ ] Implement unclaimed rewards detector
- [ ] Implement governance opportunity detector
- [ ] Implement LP health detector
- [ ] Create `wallet_opportunities` tool
- [ ] Test with real wallet positions

### Week 4: Actions & Briefings
- [ ] Implement action plan generator
- [ ] Implement multi-step executor
- [ ] Create `wallet_briefing` tool
- [ ] Integration testing
- [ ] Documentation

---

## File Structure (Final)

```
src/
├── intelligence/
│   ├── index.ts
│   ├── patterns.ts              # Token type patterns
│   ├── classifier.ts            # Token classification
│   ├── capabilities.ts          # Type → capabilities mapping
│   ├── discovery.ts             # Protocol discovery orchestrator
│   ├── graph.ts                 # Protocol relationship graph
│   ├── opportunities.ts         # Opportunity types & detection
│   ├── actions.ts               # Action plan generation
│   ├── executor.ts              # Multi-step execution
│   │
│   ├── strategies/              # Discovery strategies
│   │   ├── factory.ts
│   │   ├── events.ts
│   │   ├── references.ts
│   │   └── deployer.ts
│   │
│   └── detectors/               # Opportunity detectors
│       ├── rewards.ts
│       ├── governance.ts
│       ├── lp-health.ts
│       ├── vesting.ts
│       └── approvals.ts
│
├── tools/
│   ├── analyze-holding.ts       # NEW: Deep token analysis
│   ├── opportunities.ts         # NEW: Opportunity scanner
│   ├── briefing.ts              # NEW: Wallet briefing
│   └── ... (existing tools)
│
└── providers/
    └── ... (existing Herd/Zerion integration)
```

---

## Success Metrics

1. **Classification Accuracy**
   - 95%+ correct type identification on top 100 tokens
   - Handles unknown contracts gracefully

2. **Discovery Coverage**
   - Finds staking contracts for 80%+ of stakeable tokens
   - Finds governance for 90%+ of governance tokens

3. **Opportunity Value**
   - Surfaces $X in unclaimed rewards per wallet (track aggregate)
   - Users claim Y% of surfaced opportunities

4. **User Experience**
   - Briefing generates in <5 seconds
   - Single token analysis in <2 seconds

---

## Open Questions

1. **Caching Strategy**
   - How long to cache token classifications?
   - How often to refresh opportunity detection?

2. **Chain Prioritization**
   - Start with Base + Ethereum?
   - Add L2s based on user demand?

3. **Rate Limiting**
   - Herd MCP limits?
   - Zerion API limits?
   - Batching strategies?

4. **Edge Cases**
   - Unverified contracts (can't analyze source)
   - Proxy contracts (need implementation lookup)
   - Complex multi-hop relationships
