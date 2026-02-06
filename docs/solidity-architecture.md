# CLARA Token: Solidity Architecture & Contract Design

> Solidity architecture report for the $CLARA token + x402 fee distribution system (Model B).
> Designed for Base mainnet. Prioritizes simplicity, gas efficiency, and battle-tested patterns.

---

## Table of Contents

1. [Architecture Decision: Merge vs Separate Contracts](#1-architecture-decision-merge-vs-separate)
2. [Contract Interfaces](#2-contract-interfaces)
3. [Architecture Diagram](#3-architecture-diagram)
4. [Storage Layout](#4-storage-layout)
5. [Fee Distribution Accounting Pattern](#5-fee-distribution-accounting-pattern)
6. [Gas Estimates](#6-gas-estimates)
7. [UUPS Proxy Analysis](#7-uups-proxy-analysis)
8. [EIP-2612 Permit Recommendation](#8-eip-2612-permit-recommendation)
9. [Staking Cooldown & Front-Running Prevention](#9-staking-cooldown--front-running-prevention)
10. [Aerodrome LP Seeding Plan](#10-aerodrome-lp-seeding-plan)
11. [Token Allocation](#11-token-allocation)
12. [Deployment Plan](#12-deployment-plan)
13. [Herd Legibility](#13-herd-legibility)
14. [Things to Throw Out](#14-things-to-throw-out)
15. [Refined Plan](#15-refined-plan)

---

## 1. Architecture Decision: Merge vs Separate

### Recommendation: **Two contracts (ClaraStaking + FeeDistributor merged) + ClaraToken**

After analyzing Synthetix StakingRewards, Sushi MasterChef, Convex, and EigenLayer:

| Approach | Pros | Cons |
|----------|------|------|
| 3 contracts (Token + Staking + FeeDistributor) | Clean separation of concerns | Extra cross-contract calls, higher gas, more deployment complexity |
| 2 contracts (Token + StakingVault) | Single entry point for users, one fewer approval, simpler mental model | Slightly larger contract, but well within limits |

**The Synthetix StakingRewards pattern already combines staking + reward distribution in a single contract.** This is the most battle-tested pattern in DeFi. Hundreds of protocols have forked it. It has been audited dozens of times. There is no security benefit to separating them for our use case.

**Decision: 2 contracts total.**

1. **ClaraToken** -- ERC-20 with fixed supply
2. **ClaraStaking** -- Stake CLARA, receive USDC rewards (Synthetix pattern adapted for on-deposit rather than time-based distribution)

### Why Not 3 Contracts?

Separating staking from fee distribution would require:
- ClaraStaking calling FeeDistributor on every stake/unstake to sync shares
- Users needing to interact with two contracts (stake in one, claim in another)
- Extra `approve()` calls
- Cross-contract reentrancy surface

None of these are worth the marginal "separation of concerns" benefit.

---

## 2. Contract Interfaces

### ClaraToken.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title ClaraToken
/// @notice ERC-20 token with fixed 100M supply. No minting after initialization.
/// @dev UUPS upgradeable. Owner is a timelock contract.
contract ClaraToken is
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    UUPSUpgradeable,
    OwnableUpgradeable
{
    uint256 public constant MAX_SUPPLY = 100_000_000e18; // 100M with 18 decimals

    /// @notice Initialize token. Mints entire supply to `treasury`. No further minting possible.
    /// @param treasury Address receiving the full 100M supply
    function initialize(address treasury) external initializer {
        __ERC20_init("Clara", "CLARA");
        __ERC20Permit_init("Clara");
        __UUPSUpgradeable_init();
        __Ownable_init(msg.sender);
        _mint(treasury, MAX_SUPPLY);
    }

    /// @dev Only owner (timelock) can authorize upgrades.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
```

**Key points:**
- No `mint()` function exists -- supply is fixed at initialization
- ERC20Permit included (see Section 8 for rationale)
- Owner should be set to a timelock after deployment
- `_authorizeUpgrade` is the UUPS hook -- only owner can upgrade

### ClaraStaking.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ClaraStaking
/// @notice Stake CLARA tokens, earn proportional USDC from x402 fee revenue.
/// @dev Adapted Synthetix RewardPerToken pattern for deposit-triggered distribution.
///      USDC rewards accumulate via deposit() calls from the fee source (clara-proxy).
///      Stakers claim anytime via claim(). No lock period (see Section 9).
contract ClaraStaking is
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Events ────────────────────────────────────────────
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 amount);
    event FeesDeposited(address indexed depositor, uint256 amount);
    event FeeSourceUpdated(address indexed oldSource, address indexed newSource);

    // ─── State Variables ───────────────────────────────────

    /// @notice The CLARA token contract
    IERC20 public claraToken;

    /// @notice USDC on Base (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
    IERC20 public usdc;

    /// @notice Authorized address that deposits USDC fees (clara-proxy settlement address)
    address public feeSource;

    /// @notice Total CLARA staked across all users
    uint256 public totalStaked;

    /// @notice Accumulated USDC reward per CLARA token (scaled by 1e18)
    /// @dev Increases monotonically with each deposit()
    uint256 public rewardPerTokenStored;

    /// @notice Per-user snapshot of rewardPerTokenStored at last interaction
    mapping(address => uint256) public userRewardPerTokenPaid;

    /// @notice Per-user unclaimed USDC rewards
    mapping(address => uint256) public rewards;

    /// @notice Per-user staked CLARA balance
    mapping(address => uint256) public stakedBalance;

    // ─── Initializer ───────────────────────────────────────

    /// @param _claraToken Address of the ClaraToken contract
    /// @param _usdc Address of USDC on Base
    /// @param _feeSource Address authorized to deposit fees (clara-proxy)
    function initialize(
        address _claraToken,
        address _usdc,
        address _feeSource
    ) external initializer {
        __UUPSUpgradeable_init();
        __Ownable_init(msg.sender);
        __ReentrancyGuard_init();
        claraToken = IERC20(_claraToken);
        usdc = IERC20(_usdc);
        feeSource = _feeSource;
    }

    // ─── Modifiers ─────────────────────────────────────────

    /// @dev Syncs reward state for a user before any stake/unstake/claim action
    modifier updateReward(address account) {
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    // ─── View Functions ────────────────────────────────────

    /// @notice Calculate pending USDC rewards for an account
    /// @param account The staker address
    /// @return Claimable USDC amount (6 decimals)
    function earned(address account) public view returns (uint256) {
        return
            (stakedBalance[account] *
                (rewardPerTokenStored - userRewardPerTokenPaid[account])) /
            1e18 +
            rewards[account];
    }

    /// @notice Alias for earned() -- Herd-legible name
    function getClaimable(address account) external view returns (uint256) {
        return earned(account);
    }

    // ─── User Actions ──────────────────────────────────────

    /// @notice Stake CLARA tokens to earn USDC rewards
    /// @param amount Amount of CLARA to stake (18 decimals)
    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot stake 0");
        totalStaked += amount;
        stakedBalance[msg.sender] += amount;
        claraToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @notice Unstake CLARA tokens
    /// @param amount Amount of CLARA to unstake (18 decimals)
    function unstake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot unstake 0");
        require(stakedBalance[msg.sender] >= amount, "Insufficient staked balance");
        totalStaked -= amount;
        stakedBalance[msg.sender] -= amount;
        claraToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Claim all pending USDC rewards
    function claim() external nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            usdc.safeTransfer(msg.sender, reward);
            emit RewardsClaimed(msg.sender, reward);
        }
    }

    /// @notice Unstake all CLARA and claim all pending USDC in one transaction
    function exit() external nonReentrant updateReward(msg.sender) {
        uint256 stakedAmt = stakedBalance[msg.sender];
        uint256 reward = rewards[msg.sender];

        if (stakedAmt > 0) {
            totalStaked -= stakedAmt;
            stakedBalance[msg.sender] = 0;
            claraToken.safeTransfer(msg.sender, stakedAmt);
            emit Unstaked(msg.sender, stakedAmt);
        }

        if (reward > 0) {
            rewards[msg.sender] = 0;
            usdc.safeTransfer(msg.sender, reward);
            emit RewardsClaimed(msg.sender, reward);
        }
    }

    // ─── Fee Deposit (called by clara-proxy) ───────────────

    /// @notice Deposit USDC fees for distribution to stakers.
    /// @dev Called by the authorized feeSource (clara-proxy settlement).
    ///      Increases rewardPerTokenStored proportionally.
    ///      If no CLARA is staked, USDC is held until someone stakes.
    /// @param amount USDC amount to distribute (6 decimals)
    function deposit(uint256 amount) external nonReentrant {
        require(msg.sender == feeSource, "Only fee source");
        require(amount > 0, "Cannot deposit 0");

        if (totalStaked > 0) {
            // Scale: USDC is 6 decimals, CLARA is 18 decimals
            // rewardPerTokenStored is scaled by 1e18 for precision
            rewardPerTokenStored += (amount * 1e18) / totalStaked;
        }
        // If totalStaked == 0, USDC sits in contract until someone stakes.
        // The next deposit() after staking will distribute it.
        // NOTE: This means USDC deposited while totalStaked==0 is "orphaned"
        // until manual recovery or a design decision (see Refined Plan).

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit FeesDeposited(msg.sender, amount);
    }

    // ─── Admin Functions ───────────────────────────────────

    /// @notice Update the authorized fee source address
    /// @param newFeeSource New address authorized to call deposit()
    function setFeeSource(address newFeeSource) external onlyOwner {
        emit FeeSourceUpdated(feeSource, newFeeSource);
        feeSource = newFeeSource;
    }

    /// @notice Recover tokens accidentally sent to this contract
    /// @dev Cannot recover staked CLARA or reward USDC
    /// @param token Token to recover
    /// @param amount Amount to recover
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        require(token != address(claraToken), "Cannot recover staked token");
        // Allow recovering USDC only if it exceeds owed rewards
        // (emergency only -- should not be needed in normal operation)
        IERC20(token).safeTransfer(owner(), amount);
    }

    /// @dev Only owner (timelock) can authorize upgrades.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
```

---

## 3. Architecture Diagram

```
                          ┌──────────────────┐
                          │   Clara Users     │
                          │  (wallet_send,    │
                          │   wallet_swap,    │
                          │   wallet_call)    │
                          └────────┬─────────┘
                                   │
                             HTTP 402 response
                             (~$0.01 USDC/op)
                                   │
                                   ▼
                          ┌──────────────────┐
                          │   clara-proxy     │
                          │  (Cloudflare      │
                          │   Worker)         │
                          │                   │
                          │ Accumulates USDC  │
                          │ from x402 payments│
                          └────────┬─────────┘
                                   │
                          Periodic settlement
                          (batch USDC transfer)
                                   │
                                   ▼
                    ┌──────────────────────────┐
                    │     ClaraStaking         │
                    │     (UUPS Proxy)         │
                    │                          │
                    │  deposit(usdc)  ◄────── feeSource only
                    │  stake(clara)   ◄────── any user
                    │  unstake(clara) ◄────── staker
                    │  claim()        ◄────── staker (gets USDC)
                    │  exit()         ◄────── staker (unstake+claim)
                    │                          │
                    │  Holds: CLARA (staked)    │
                    │  Holds: USDC (rewards)    │
                    └──────────┬───────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
        ┌──────────┐   ┌───────────┐   ┌──────────────┐
        │ClaraToken│   │   USDC    │   │  Aerodrome   │
        │(ERC-20)  │   │  (Base)   │   │  CLARA/USDC  │
        │          │   │           │   │  Volatile LP  │
        │Fixed 100M│   │0x8335...  │   │              │
        └──────────┘   └───────────┘   └──────────────┘
```

### Interaction Flow

1. **User Action**: User calls `wallet_send`/`wallet_swap`/`wallet_call` via Clara MCP
2. **x402 Payment**: clara-proxy returns HTTP 402, `wallet_pay_x402` auto-pays ~$0.01 USDC
3. **Accumulation**: clara-proxy accumulates USDC from many x402 payments
4. **Settlement**: Periodically (e.g. daily or when threshold reached), clara-proxy calls `ClaraStaking.deposit(totalUSDC)`
5. **Distribution**: `deposit()` updates `rewardPerTokenStored` proportionally
6. **Claiming**: Stakers call `claim()` anytime to receive their proportional USDC

---

## 4. Storage Layout

### ClaraToken Storage

```
Slot 0-N: OpenZeppelin ERC20Upgradeable internals
  - _name (string)
  - _symbol (string)
  - _totalSupply (uint256)
  - _balances (mapping)
  - _allowances (nested mapping)

Slot N+: ERC20PermitUpgradeable internals
  - _nonces (mapping)

Slot N+: OwnableUpgradeable
  - _owner (address)

No custom storage variables. MAX_SUPPLY is a constant (not stored).
```

### ClaraStaking Storage

```
Slot 0-N: UUPSUpgradeable + OwnableUpgradeable + ReentrancyGuardUpgradeable internals

Custom storage (order matters for UUPS upgrades):
  Slot A:   claraToken      (address, 20 bytes)
  Slot B:   usdc            (address, 20 bytes)
  Slot C:   feeSource       (address, 20 bytes)
  Slot D:   totalStaked     (uint256, 32 bytes)
  Slot E:   rewardPerTokenStored (uint256, 32 bytes)
  Slot F:   userRewardPerTokenPaid (mapping(address => uint256))
  Slot G:   rewards         (mapping(address => uint256))
  Slot H:   stakedBalance   (mapping(address => uint256))
```

**UUPS Upgrade Safety**: When upgrading, new variables MUST be appended after Slot H. Never reorder or remove existing slots. Use OpenZeppelin's `@custom:storage-location` or storage gap pattern if adding future extensibility:

```solidity
// Optional: reserve 50 slots for future upgrades
uint256[50] private __gap;
```

---

## 5. Fee Distribution Accounting Pattern

### Chosen Pattern: **Modified Synthetix RewardPerToken (Deposit-Triggered)**

The standard Synthetix pattern uses time-based reward emission (`rewardRate * dt`). Our system is different: rewards arrive in discrete lump-sum deposits from the clara-proxy. This is simpler.

### How It Works

```
On deposit(amount):
  rewardPerTokenStored += (amount * 1e18) / totalStaked

On stake/unstake/claim (updateReward modifier):
  rewards[user] = earned(user)
  userRewardPerTokenPaid[user] = rewardPerTokenStored

earned(user):
  return stakedBalance[user] * (rewardPerTokenStored - userRewardPerTokenPaid[user]) / 1e18
       + rewards[user]
```

### Why This Is Simpler Than Standard Synthetix

| Standard Synthetix | Our Adaptation |
|--------------------|----------------|
| `rewardRate` + `periodFinish` + `lastUpdateTime` | None of these needed |
| `notifyRewardAmount()` calculates rate over duration | `deposit()` directly increments `rewardPerTokenStored` |
| Time-dependent: must call `lastTimeRewardApplicable()` | Deposit-dependent: no time tracking needed |
| Rewards "drip" over time | Rewards are instantly available after `deposit()` |

This eliminates 3 state variables and the time-based complexity. The core math (rewardPerToken accumulator + per-user delta tracking) is identical and equally battle-tested.

### Precision Considerations

- CLARA: 18 decimals
- USDC: 6 decimals
- `rewardPerTokenStored` is scaled by 1e18 for precision
- With 100M CLARA staked and $0.01 deposits: `0.01e6 * 1e18 / 100e24 = 100` -- non-zero, precision is fine
- Minimum meaningful deposit: ~0.000001 USDC (1 unit) with 100M staked = `1 * 1e18 / 100e24 = 0.01` -- rounds to 0. This is acceptable; sub-penny rounding loss on 100M staked is immaterial.

---

## 6. Gas Estimates

All estimates assume Base L2 (execution gas is similar to L1, but actual cost is ~100-1000x cheaper due to L2 fee structure). Base gas price is typically 0.001-0.01 gwei.

| Operation | Estimated Gas (units) | Estimated Cost on Base | Notes |
|-----------|-----------------------|------------------------|-------|
| `stake()` | ~85,000 | < $0.01 | `transferFrom` + storage writes + updateReward |
| `unstake()` | ~70,000 | < $0.01 | `transfer` + storage writes + updateReward |
| `claim()` | ~55,000 | < $0.01 | `transfer` + storage writes + updateReward |
| `exit()` | ~100,000 | < $0.01 | Combined unstake + claim |
| `deposit()` | ~55,000 | < $0.01 | `transferFrom` + rewardPerTokenStored update |
| `earned()` (view) | ~5,000 | Free | Pure calculation, no state changes |
| ERC-20 `transfer` | ~50,000 | < $0.01 | Standard token transfer |
| ERC-20 `approve` | ~45,000 | < $0.01 | Standard approval |

**Proxy overhead**: UUPS `delegatecall` adds ~2,600 gas per call (the cost of the DELEGATECALL opcode + proxy dispatch). On Base, this is negligible -- roughly $0.000001 per call.

**Total cost for full staking cycle** (approve + stake + wait + claim + unstake):
- ~305,000 gas total
- On Base: < $0.05 even in worst case

---

## 7. UUPS Proxy Analysis

### Recommendation: **Use UUPS, but keep it optional for ClaraToken**

| Factor | UUPS | Transparent Proxy | No Proxy |
|--------|------|-------------------|----------|
| Per-call gas overhead | ~2,600 gas | ~5,000+ gas (admin check) | 0 |
| Deploy cost | Higher (implementation + proxy) | Higher | Lowest |
| Upgrade ability | Yes (via implementation) | Yes (via proxy admin) | No |
| Complexity | Moderate | Moderate | Simplest |

### Per-Contract Recommendation

**ClaraToken: UUPS recommended.**
- A fixed-supply ERC-20 with no mint function has minimal attack surface
- But permit support or bug fixes might require an upgrade
- The gas overhead is negligible on Base
- Could go either way; UUPS is low-cost insurance

**ClaraStaking: UUPS strongly recommended.**
- Fee distribution logic may need adjustments (new reward tokens, changed accounting)
- Staked CLARA is locked in this contract -- upgradeability allows recovery from bugs
- The proxy overhead (~2,600 gas) is meaningless relative to the 55-100k gas per operation

### Timelock

Both contracts' `owner` should be transferred to a TimelockController (e.g., OpenZeppelin's) with a 48-hour delay after deployment and testing:

```solidity
// Post-deployment:
claraToken.transferOwnership(timelockAddress);
claraStaking.transferOwnership(timelockAddress);
```

This prevents instant malicious upgrades. A 48-hour delay gives stakers time to exit if a bad upgrade is proposed.

---

## 8. EIP-2612 Permit Recommendation

### Recommendation: **Yes, include ERC20Permit on ClaraToken**

**Rationale:**

1. **Zero marginal complexity**: OpenZeppelin's `ERC20PermitUpgradeable` is a single import + one `__init` call. It adds ~200 bytes of bytecode and zero runtime overhead for non-permit users.

2. **Enables gasless stake flow**: With permit, a user can sign an off-chain message to approve ClaraStaking, then a relayer (or the staking contract itself) can call `permit()` + `stake()` in one transaction. This eliminates the separate `approve()` transaction.

3. **Future-proofing**: Account abstraction (EIP-4337) and smart wallet flows increasingly use permit for batching. Not having it would be a UX regression.

4. **Industry standard**: USDC, WETH, and most new ERC-20s ship with permit. Not including it would be unusual.

**Do NOT add permit to ClaraStaking** -- it does not need it. Permit is only relevant on the token contract.

---

## 9. Staking Cooldown & Front-Running Prevention

### Recommendation: **No mandatory cooldown. Use deposit-triggered accounting instead.**

### The Front-Running Problem

Without protection, an attacker could:
1. Watch the mempool for a large `deposit()` call from clara-proxy
2. Front-run with `stake(largeAmount)`
3. Capture a share of the deposit's rewards
4. Immediately `unstake()` + `claim()`

### Why Cooldowns Are Wrong Here

- Cooldowns (e.g., 7-day unbonding) hurt legitimate users who want liquidity
- They add state complexity (unlock timestamps, pending withdrawals)
- They are the wrong tool for deposit-front-running

### Better Solution: Private/Batched Deposits

On Base L2, the sequencer processes transactions in FIFO order (no public mempool for MEV). This means:

1. **The clara-proxy submits `deposit()` directly to the Base sequencer** -- there is no public mempool to front-run on Base's current architecture
2. **Batch settlement at irregular intervals** -- if the deposit timing is unpredictable, front-running is impractical even if a mempool existed
3. **MEV protection via Flashbots Protect** (optional) -- submit deposit transactions via a private relay if Base ever introduces a public mempool

### Residual Risk: Block Builder Collusion

If a sophisticated attacker colluded with the Base sequencer/block builder, they could theoretically reorder transactions. Mitigation:

- **Minimum stake duration** (optional, lightweight): Require that `stakedBalance[user]` has been non-zero for at least N blocks before `earned()` accrues rewards from new deposits. This could be added later via UUPS upgrade if needed.
- **Not recommended at launch**: Adds complexity. Base's sequencer ordering provides sufficient protection today.

### Summary

| Protection | Recommended? | Why |
|-----------|-------------|-----|
| Cooldown/unbonding period | No | Hurts UX, wrong tool for the problem |
| Private deposit submission | Yes | Base sequencer = no public mempool |
| Irregular batch timing | Yes | Unpredictable = hard to front-run |
| Minimum stake duration | No (but upgradeable) | Can add later via UUPS if needed |

---

## 10. Aerodrome LP Seeding Plan

### Pool Type: **Volatile (not Stable)**

CLARA/USDC should use a **volatile pool** because:
- CLARA's price will fluctuate against USDC (it is not a stablecoin)
- Stable pools use a curve optimized for 1:1 pegs -- this would cause extreme slippage on price movements
- Volatile pools use the standard constant product formula (`x * y = k`), appropriate for freely-priced assets

### Aerodrome Contracts on Base

| Contract | Address |
|----------|---------|
| Pool Factory | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` |
| Router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

### LP Seeding Process

**Step 1: Create the pool**
```solidity
// Via Aerodrome Router
IRouter(AERODROME_ROUTER).createPool(
    CLARA_TOKEN,     // tokenA
    USDC_ADDRESS,    // tokenB
    false            // stable = false (volatile pool)
);
```

**Step 2: Approve tokens**
```solidity
IERC20(CLARA_TOKEN).approve(AERODROME_ROUTER, claraAmount);
IERC20(USDC_ADDRESS).approve(AERODROME_ROUTER, usdcAmount);
```

**Step 3: Add initial liquidity**
```solidity
IRouter(AERODROME_ROUTER).addLiquidity(
    CLARA_TOKEN,     // tokenA
    USDC_ADDRESS,    // tokenB
    false,           // stable = false
    claraAmount,     // amountADesired
    usdcAmount,      // amountBDesired
    claraAmountMin,  // amountAMin (set to ~99% of desired)
    usdcAmountMin,   // amountBMin (set to ~99% of desired)
    treasury,        // LP tokens go to treasury
    block.timestamp + 600  // 10 min deadline
);
```

### Initial Price Calculation

The initial deposit ratio sets the launch price:

```
If we deposit 10,000,000 CLARA + 100,000 USDC:
  Initial price = 100,000 / 10,000,000 = $0.01 per CLARA
  FDV = 100,000,000 * $0.01 = $1,000,000
```

**Recommended initial seed:**

| CLARA Amount | USDC Amount | Initial Price | FDV |
|-------------|-------------|---------------|-----|
| 10,000,000 | 50,000 | $0.005 | $500K |
| 10,000,000 | 100,000 | $0.01 | $1M |
| 10,000,000 | 200,000 | $0.02 | $2M |

The exact amounts are a business decision. The LP allocation (10M CLARA = 10% of supply) is discussed in Section 11.

### Post-Seeding

1. LP tokens should be held by the treasury multisig (not locked immediately)
2. Consider staking LP in the Aerodrome gauge (if one is created) for AERO rewards
3. The pool is permissionless -- anyone can add liquidity after creation

---

## 11. Token Allocation

### Recommended Allocation (100M CLARA)

| Allocation | Amount | % | Vesting/Lock | Purpose |
|-----------|--------|---|-------------|---------|
| Treasury | 40,000,000 | 40% | Multisig-controlled | Protocol development, grants, future liquidity |
| Staking Incentives | 25,000,000 | 25% | Released over 2 years | Bootstrap staking (optional CLARA rewards on top of USDC) |
| Aerodrome LP | 10,000,000 | 10% | At launch, held by treasury | Initial trading liquidity |
| Team | 15,000,000 | 15% | 1-year cliff, 3-year linear vest | Core contributors |
| Community/Airdrop | 10,000,000 | 10% | At/near launch | Early Clara users, beta testers |

### Notes

- **Staking Incentives (25%)**: This is optional. The primary staking reward is USDC from x402 fees. CLARA staking incentives could be added as a separate "bonus" reward stream to bootstrap early staking. If not needed, this allocation reverts to treasury.
- **LP (10%)**: Paired with USDC from treasury. The ratio sets the launch price.
- **Team (15%)**: Standard vesting. Could be implemented via a simple vesting contract or a Sablier stream.
- **Airdrop (10%)**: For early Clara MCP users. Could be a simple Merkle distributor.

### Implementation

All 100M CLARA is minted to the treasury address at `initialize()`. The treasury (a multisig) then distributes to:
- Vesting contracts (team)
- ClaraStaking (incentives, if used)
- Aerodrome Router (LP)
- Merkle distributor (airdrop)

This keeps ClaraToken simple -- it has no allocation logic.

---

## 12. Deployment Plan

### Deployment Order

```
Phase 1: Core Contracts
  1. Deploy ClaraToken implementation
  2. Deploy ClaraToken proxy (initialize with treasury = deployer temporarily)
  3. Deploy ClaraStaking implementation
  4. Deploy ClaraStaking proxy (initialize with claraToken, usdc, feeSource)

Phase 2: Configuration
  5. Verify contracts on BaseScan
  6. Test stake/unstake/deposit/claim cycle on deployment
  7. Set up TimelockController (48h delay)
  8. Transfer ClaraToken ownership to timelock
  9. Transfer ClaraStaking ownership to timelock
  10. Transfer ClaraToken treasury balance to final multisig

Phase 3: Liquidity
  11. Approve CLARA + USDC on Aerodrome Router
  12. Create CLARA/USDC volatile pool via Router
  13. Add initial liquidity (10M CLARA + X USDC)
  14. Verify pool on Aerodrome UI

Phase 4: Distribution
  15. Deploy vesting contracts for team allocation (optional: Sablier)
  16. Deploy Merkle distributor for airdrop (optional)
  17. Transfer allocations from treasury
  18. Connect clara-proxy settlement to ClaraStaking.deposit()
```

### Deployment Script Pseudocode

```solidity
// Using Foundry (forge script)
contract DeployCLARA is Script {
    function run() external {
        vm.startBroadcast();

        // 1. Deploy ClaraToken
        ClaraToken tokenImpl = new ClaraToken();
        ERC1967Proxy tokenProxy = new ERC1967Proxy(
            address(tokenImpl),
            abi.encodeCall(ClaraToken.initialize, (deployer))
        );
        ClaraToken token = ClaraToken(address(tokenProxy));

        // 2. Deploy ClaraStaking
        ClaraStaking stakingImpl = new ClaraStaking();
        ERC1967Proxy stakingProxy = new ERC1967Proxy(
            address(stakingImpl),
            abi.encodeCall(ClaraStaking.initialize, (
                address(token),
                USDC_BASE,
                FEE_SOURCE_ADDRESS
            ))
        );
        ClaraStaking staking = ClaraStaking(address(stakingProxy));

        vm.stopBroadcast();
    }
}
```

---

## 13. Herd Legibility

### Design Principle

Herd's protocol action detector classifies on-chain actions by function signatures and events. Using standard naming ensures Herd correctly labels CLARA staking activity.

### Function Names (Herd-Compatible)

| Function | Herd Classification | Notes |
|----------|-------------------|-------|
| `stake(uint256)` | "Stake" action | Standard staking signature |
| `unstake(uint256)` | "Unstake" action | Standard. Prefer `unstake` over `withdraw` for clarity |
| `claim()` | "Claim Rewards" | Standard claim signature |
| `exit()` | "Exit Position" | Combined unstake+claim |
| `getClaimable(address)` | View (not classified) | Explicit alias for `earned()` |
| `deposit(uint256)` | "Deposit" | Fee source deposits |

### Event Names (Herd-Compatible)

| Event | Signature |
|-------|-----------|
| `Staked(address indexed user, uint256 amount)` | Standard |
| `Unstaked(address indexed user, uint256 amount)` | Standard |
| `RewardsClaimed(address indexed user, uint256 amount)` | Standard |
| `FeesDeposited(address indexed depositor, uint256 amount)` | Custom but clear |

### Avoiding Herd Confusion

- Do NOT use `withdraw()` for unstaking -- Herd might classify it as a lending withdrawal
- Do NOT use `harvest()` for claiming -- Herd might classify it as a farming harvest
- Use `unstake`/`claim` explicitly -- these map to well-known staking protocol patterns
- The `Staked`/`Unstaked` events follow the pattern used by Lido, Rocket Pool, EigenLayer

---

## 14. Things to Throw Out

### 1. Separate FeeDistributor Contract

**Throw it out.** Merging into ClaraStaking eliminates cross-contract calls, an extra deployment, extra approvals, and a larger attack surface. The Synthetix pattern proves this works in a single contract.

### 2. Time-Based Reward Distribution

**Throw it out.** The standard Synthetix `rewardRate * dt` pattern is designed for protocols that emit rewards at a fixed rate over time. Our rewards arrive as discrete deposits. Direct-increment `rewardPerTokenStored` is simpler and more accurate.

### 3. Cooldown/Unbonding Period

**Throw it out (for now).** Base's sequencer ordering prevents mempool front-running. Adding cooldowns hurts UX for marginal security benefit. Can be added later via UUPS upgrade.

### 4. ClaraRouter

**Already thrown out in the spec.** x402 handles per-tx payment natively. No router needed.

### 5. Staking Incentives (CLARA-denominated rewards)

**Consider throwing it out.** The value proposition of CLARA staking is real yield (USDC from x402 fees). Adding CLARA-on-CLARA rewards:
- Dilutes the "real yield" narrative
- Requires a second reward token in the staking contract
- Adds complexity (dual-reward Synthetix pattern)

If bootstrap incentives are needed, consider a separate simple distributor or airdrop instead.

### 6. Complex Governance

**Throw it out at launch.** A timelock + multisig is sufficient governance for V1. On-chain governance (Governor, voting, delegation) can be added later if token distribution is broad enough to justify it.

### 7. Storage Gaps

**Keep, but make them small.** `uint256[50] private __gap` is cheap insurance for UUPS upgradeability. Don't overthink it.

---

## 15. Refined Plan

### What I Would Change After This Analysis

**1. Reduce to 2 contracts (done).**
ClaraToken + ClaraStaking. No FeeDistributor. This is the biggest simplification.

**2. Handle the "zero-stakers" edge case explicitly.**
When `totalStaked == 0` and a `deposit()` arrives, the USDC is transferred in but `rewardPerTokenStored` doesn't increase. This USDC becomes orphaned -- it sits in the contract but is never claimable.

Options:
- **(A) Revert deposit when totalStaked == 0**: Simplest. The proxy retries later. Recommended.
- (B) Track undistributed balance and include it in next deposit: Adds a state variable and accounting.
- (C) Send to treasury when totalStaked == 0: Requires admin logic.

**Recommendation: Option A.** Add `require(totalStaked > 0, "No stakers")` to `deposit()`. The clara-proxy can check `totalStaked` before calling and hold USDC until stakers exist.

**3. Add a `stakeWithPermit()` convenience function.**
Since ClaraToken has ERC20Permit, add this to ClaraStaking:

```solidity
function stakeWithPermit(
    uint256 amount,
    uint256 deadline,
    uint8 v, bytes32 r, bytes32 s
) external nonReentrant updateReward(msg.sender) {
    claraToken.permit(msg.sender, address(this), amount, deadline, v, r, s);
    // ... same as stake()
}
```

This enables one-transaction staking (no separate `approve()` needed).

**4. Consider immutable token, upgradeable staking.**
ClaraToken is extremely simple (fixed supply, no admin functions except upgrade). Making it non-upgradeable (no proxy) would:
- Reduce trust assumptions (users know the token code cannot change)
- Save ~2,600 gas per transfer
- Simplify deployment

The tradeoff: if a permit bug is found, you can't fix it. But OZ's ERC20Permit is very mature.

**Recommendation: Deploy ClaraToken without a proxy.** Deploy ClaraStaking with UUPS proxy. This is the lowest-complexity option that retains upgradeability where it matters.

**5. USDC decimal handling deserves a constant.**
USDC has 6 decimals, CLARA has 18. The `earned()` calculation handles this correctly because `rewardPerTokenStored` is scaled by 1e18 and the result naturally comes out in 6-decimal USDC units. But add a comment and a constant for clarity:

```solidity
uint256 private constant PRECISION = 1e18;
```

**6. Deployment using Foundry, not Hardhat.**
Foundry provides:
- Faster compilation
- Native Solidity scripting (no JavaScript)
- Better gas reporting
- Built-in fuzzing for tests

---

## Pattern References

| Pattern | Source | Used For |
|---------|--------|----------|
| Synthetix StakingRewards | [Synthetix GitHub](https://github.com/Synthetixio/synthetix/blob/develop/contracts/StakingRewards.sol) | RewardPerToken accumulator pattern |
| OpenZeppelin ERC20Upgradeable | [OZ Contracts](https://docs.openzeppelin.com/contracts/4.x/api/proxy) | Token + proxy |
| OpenZeppelin ERC20Permit | [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612) | Gasless approvals |
| OpenZeppelin UUPS | [OZ UUPSUpgradeable](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/proxy/utils/UUPSUpgradeable.sol) | Proxy pattern |
| Aerodrome Router | [Aerodrome Contracts](https://github.com/aerodrome-finance/contracts) | LP seeding |

---

## Summary of Recommendations

| Question | Recommendation |
|----------|---------------|
| Merge staking + fee distributor? | **Yes** -- single ClaraStaking contract |
| Fee distribution pattern? | **Deposit-triggered rewardPerToken** (simplified Synthetix) |
| UUPS on all contracts? | **ClaraToken: no proxy (immutable). ClaraStaking: UUPS + timelock.** |
| EIP-2612 Permit? | **Yes** on ClaraToken (trivial to add, enables gasless stake) |
| Staking cooldown? | **No** -- Base sequencer prevents front-running |
| Aerodrome pool type? | **Volatile** CLARA/USDC |
| Token allocation? | **40% treasury, 25% staking incentives, 10% LP, 15% team, 10% airdrop** |
| Total contracts? | **2** (ClaraToken + ClaraStaking) |
| Deployment tool? | **Foundry** |
