# Clara + Herd User Stories

Real-world test scenarios using trending contracts. These stories test the Herd integration
with contracts that users are actually interacting with today.

---

## Trending Contracts Reference

### Ethereum Mainnet (chainId: 1)
| Contract | Address | Category |
|----------|---------|----------|
| Tether USDT | `0xdac17f958d2ee523a2206206994597c13d831ec7` | Stablecoin |
| Circle USDC | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | Stablecoin |
| Uniswap V4 Universal Router | `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` | DEX |
| MetaMask Swap Router | `0x881d40237659c251811cec9c364ef91dc08d300c` | Aggregator |
| Pendle Token | `0x808507121b80c02388fad14726482e061b8da827` | Yield Protocol |
| Lido stETH | `0xae7ab96520de3a18e5e111b5eaab095312d7fe84` | Liquid Staking |
| EigenLayer StrategyManager | `0x858646372CC42E1A627fcE94aa7A7033e7CF075A` | Restaking |

### Base (chainId: 8453)
| Contract | Address | Category |
|----------|---------|----------|
| Aerodrome Router | `0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43` | DEX |
| AERO Token | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` | Governance |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Stablecoin |
| cbETH | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` | Liquid Staking |

---

## User Story 1: Pre-Transaction Risk Check

### Scenario 1.1: Known Safe Contract
**User intent:** "I want to swap ETH for USDC on Uniswap"

```
User: "Is it safe to use this contract? 0x66a9893cc07d91d95644aedd05d03f95e1dba8af"

Expected Clara Response:
- Contract Name: Uniswap V4 Universal Router
- Verified: Yes
- Age: Deployed [X months ago]
- Risk Level: LOW (known protocol)
- Recommendation: PROCEED
```

**Test with:** `wallet_analyze_contract address=0x66a9893cc07d91d95644aedd05d03f95e1dba8af chain=ethereum`

---

### Scenario 1.2: Upgradeable Proxy (Medium Risk)
**User intent:** "Someone told me to use this DeFi protocol"

```
User: "Check this contract before I deposit: 0x858646372CC42E1A627fcE94aa7A7033e7CF075A"

Expected Clara Response:
- Contract Name: EigenLayer StrategyManager (Proxy)
- Verified: Yes
- Risk Level: MEDIUM (upgradeable)
- Flags:
  - Upgradeable proxy pattern detected
  - Admin can modify implementation
- Owner/Admin: [multisig address]
- Recommendation: CAUTION - reputable protocol but upgradeable
```

**Test with:** `wallet_analyze_contract address=0x858646372CC42E1A627fcE94aa7A7033e7CF075A chain=ethereum`

---

### Scenario 1.3: Unknown/Suspicious Contract
**User intent:** "Found this token on Twitter, looks promising"

```
User: "Is this contract legit? 0x1234567890123456789012345678901234567890"

Expected Clara Response:
- Contract Name: Unknown
- Verified: NO
- Risk Level: HIGH
- Flags:
  - Unverified source code
  - Cannot analyze functions
  - Unable to assess admin capabilities
- Recommendation: AVOID - cannot verify safety
```

**Test with:** `wallet_analyze_contract address=0x1234567890123456789012345678901234567890 chain=ethereum`

---

### Scenario 1.4: Base DEX Interaction
**User intent:** "I want to trade on Aerodrome"

```
User: "Analyze the Aerodrome router on Base: 0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43"

Expected Clara Response:
- Contract Name: Aerodrome Router
- Chain: Base
- Verified: Yes
- Transaction Count: 900K+
- Risk Level: LOW
- Key Functions: swapExactTokensForTokens, addLiquidity, removeLiquidity
- Recommendation: PROCEED - established Base DEX
```

**Test with:** `wallet_analyze_contract address=0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43 chain=base`

---

## User Story 2: Token Utility Discovery

### Scenario 2.1: What Can I Do With AERO?
**User intent:** "I got some AERO tokens, what are they for?"

```
User: "What can I do with my AERO tokens? 0x940181a94A35A4569E4529A3CDfB74e38FD98631"

Expected Clara Response:
- Token: AERO (Aerodrome Finance)
- Standard: ERC-20 + VE Governance
- Current Price: $X.XX
- Detected Capabilities:
  1. Lock for veAERO (vote-escrow)
  2. Vote on pool emissions
  3. Earn trading fees from voted pools
  4. Trade on Aerodrome DEX
- Top Functions:
  - lock(uint256 amount, uint256 duration)
  - vote(address[] pools, uint256[] weights)
  - claimFees()
```

**Test with:** `wallet_analyze_contract address=0x940181a94A35A4569E4529A3CDfB74e38FD98631 chain=base`

---

### Scenario 2.2: Understanding Pendle
**User intent:** "I heard Pendle lets me trade yield, how does it work?"

```
User: "Explain Pendle token: 0x808507121b80c02388fad14726482e061b8da827"

Expected Clara Response:
- Token: PENDLE
- Protocol: Yield tokenization
- Current Price: $X.XX
- Capabilities:
  1. Lock for vePENDLE (vote-escrow)
  2. Boost yield in Pendle pools
  3. Vote on incentives allocation
  4. Earn protocol revenue share
- Related Contracts:
  - Market Factory: [address]
  - Router: [address]
```

**Test with:** `wallet_analyze_contract address=0x808507121b80c02388fad14726482e061b8da827 chain=ethereum`

---

### Scenario 2.3: Liquid Staking Token
**User intent:** "What's the difference between ETH and stETH?"

```
User: "Analyze stETH: 0xae7ab96520de3a18e5e111b5eaab095312d7fe84"

Expected Clara Response:
- Token: stETH (Lido Staked Ether)
- Type: Liquid Staking Derivative
- Backed by: Staked ETH validators
- Capabilities:
  1. Rebasing (balance increases daily)
  2. Use as collateral on Aave, Compound
  3. Trade on DEXs
  4. Wrap to wstETH for non-rebasing
- Current APY: ~3.5%
- Key Functions:
  - submit(address referral) - stake ETH
  - unwrap() - convert to ETH (via queue)
```

**Test with:** `wallet_analyze_contract address=0xae7ab96520de3a18e5e111b5eaab095312d7fe84 chain=ethereum`

---

## User Story 3: Transaction Decoder

### Scenario 3.1: Understand a Swap
**User intent:** "What did this transaction do?"

```
User: "Explain this tx: [recent Uniswap swap hash]"

Expected Clara Response:
- Intent: Swapped ETH for USDC via Uniswap V3
- Steps:
  1. Sent 1.5 ETH
  2. Routed: ETH → WETH → USDC
  3. Received 3,420 USDC
- Fees:
  - Gas: 0.005 ETH ($12)
  - Swap fee: 0.3%
- Events: Swap, Transfer
```

**To test:** Find a recent swap tx on Etherscan and use `wallet_analyze_tx`

---

### Scenario 3.2: Complex DeFi Transaction
**User intent:** "I see this pending transaction, what's it doing?"

```
User: "Decode: [EigenLayer deposit tx hash]"

Expected Clara Response:
- Intent: Deposited stETH into EigenLayer for restaking
- Contract: StrategyManager
- Function: depositIntoStrategy(strategy, token, amount)
- Steps:
  1. Approved stETH spending
  2. Deposited 10 stETH into stETH strategy
  3. Received restaking shares
- Risk: Funds now subject to AVS slashing conditions
```

---

### Scenario 3.3: Failed Transaction Analysis
**User intent:** "Why did my transaction fail?"

```
User: "What went wrong? [failed tx hash]"

Expected Clara Response:
- Status: FAILED
- Revert Reason: "INSUFFICIENT_OUTPUT_AMOUNT"
- Analysis:
  - You tried to swap with 0.5% slippage
  - Price moved 1.2% during execution
  - Transaction reverted to protect you
- Suggestion: Retry with higher slippage tolerance (1-2%)
```

---

## User Story 5: Approval Analysis

### Scenario 5.1: Standard DEX Approval
**User intent:** "Aerodrome wants unlimited USDC approval"

```
User: "Should I approve unlimited USDC to 0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43?"

Expected Clara Response:
- Spender: Aerodrome Router
- Token: USDC
- Requested: Unlimited
- Risk Assessment:
  ✅ Verified contract
  ✅ 900K+ transactions
  ✅ Only spends on swap/liquidity operations
  ⚠️ Unlimited means no per-tx limit
- Recommendation: SAFE
- Options:
  1. Approve unlimited (convenient)
  2. Approve exact amount (more secure)
  3. Approve and revoke after use
```

**Test with:** `wallet_analyze_contract` on the spender, check for transferFrom patterns

---

### Scenario 5.2: Suspicious Approval Request
**User intent:** "New DEX wants approval, never heard of it"

```
User: "This site wants USDC approval: 0xdeadbeef..."

Expected Clara Response:
- Spender: Unknown Contract
- Token: USDC
- Requested: Unlimited
- Risk Assessment:
  ❌ Unverified contract
  ❌ No transaction history
  ❌ Cannot verify what functions exist
- Recommendation: AVOID
- Warning: Approving could allow draining all USDC
```

---

### Scenario 5.3: Reviewing Existing Approvals
**User intent:** "What have I approved in the past?"

```
User: "Show my token approvals"

Expected Clara Response:
(Uses wallet_approvals tool + Herd for context)

Active Approvals:
1. USDC → Uniswap Router
   - Amount: Unlimited
   - Last used: 2 days ago
   - Risk: LOW ✅

2. USDC → Unknown (0xabc...)
   - Amount: Unlimited
   - Last used: Never
   - Risk: HIGH ⚠️ (unverified contract)

Recommendation: Revoke approval #2
```

---

## Test Execution Checklist

### Prerequisites
- [ ] HERD_ENABLED=true
- [ ] Herd MCP package available
- [ ] Clara MCP running

### Test Commands

```bash
# 1. Pre-Transaction Risk Check
clara> wallet_analyze_contract address=0x66a9893cc07d91d95644aedd05d03f95e1dba8af chain=ethereum
clara> wallet_analyze_contract address=0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43 chain=base
clara> wallet_analyze_contract address=0x1234567890123456789012345678901234567890 chain=ethereum

# 2. Token Utility Discovery
clara> wallet_analyze_contract address=0x940181a94A35A4569E4529A3CDfB74e38FD98631 chain=base
clara> wallet_analyze_contract address=0x808507121b80c02388fad14726482e061b8da827 chain=ethereum
clara> wallet_analyze_contract address=0xae7ab96520de3a18e5e111b5eaab095312d7fe84 chain=ethereum

# 3. Transaction Decoder (need real tx hashes)
clara> wallet_analyze_tx hash=0x... chain=ethereum

# 5. Approval Analysis
clara> wallet_analyze_contract address=0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43 chain=base
clara> wallet_approvals
```

---

## Sample Conversation Flows

### Flow A: New User Discovers Aerodrome

```
User: "I want to trade on Base, what's the best DEX?"

Clara: Based on TVL and activity, Aerodrome is Base's leading DEX with $X in liquidity.
       Would you like me to analyze the contract before you use it?

User: "Yes, check it"

Clara: [calls wallet_analyze_contract]
       ✅ Aerodrome Router is safe to use
       - Verified contract with 900K+ transactions
       - Standard DEX functions (swap, add/remove liquidity)
       - No admin drain functions

       Ready to swap?

User: "Yes, swap 100 USDC for ETH"

Clara: [calls wallet_swap with risk context already cached]
```

### Flow B: User Researches New Token

```
User: "I got airdropped some PENDLE tokens. What are they?"

Clara: [calls wallet_analyze_contract for PENDLE]

       📊 PENDLE Analysis

       Pendle is a yield tokenization protocol. Your PENDLE tokens let you:
       1. Lock for vePENDLE to earn protocol fees
       2. Vote on where incentives go
       3. Boost your yields in Pendle pools

       Current price: $X.XX

       Want me to show you staking options?
```

### Flow C: Transaction Investigation

```
User: "I see a weird transaction in my history. What happened?"

Clara: Which transaction? Share the hash and I'll decode it.

User: "0xabc123..."

Clara: [calls wallet_analyze_tx]

       🔍 Transaction Decoded

       This was a MEV sandwich attack on your swap:

       1. Attacker front-ran your swap, buying before you
       2. Your swap executed at worse price
       3. Attacker sold immediately after, profiting $12

       Your loss: ~$12 in extra slippage

       Tip: Use private RPC or MEV-protected swaps to prevent this.
```

---

## Success Metrics

| Story | Success Criteria |
|-------|------------------|
| Risk Check | Returns verification status, age, flags for ALL contracts |
| Token Utility | Identifies token type, capabilities, and related actions |
| Tx Decoder | Explains intent, steps, and fees in plain English |
| Approval Analysis | Assesses spender safety and provides clear recommendation |

---

## Sources

- [Etherscan Gas Tracker](https://etherscan.io/gastracker)
- [Aerodrome Finance](https://aerodrome.finance)
- [Pendle Documentation](https://docs.pendle.finance)
- [The Block - Top Gas Consumers](https://www.theblock.co/data/on-chain-metrics/ethereum/top-20-gas-consuming-smart-contracts-30d)
- [DeFi Llama](https://defillama.com)
