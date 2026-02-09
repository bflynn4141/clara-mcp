# AUDIT-001: Chain/Address Mismatch — Testnet Contracts Used on Mainnet

**Severity:** Critical
**Date:** 2026-02-08
**Status:** Confirmed, not yet fixed
**Discovered by:** Self-audit during bounty system test

---

## Summary

Clara's bounty system (`work_register`, `work_post`, `work_browse`, `work_list`) silently fails on Base mainnet because `CLARA_NETWORK=testnet` in the production MCP config causes Sepolia contract addresses to be used for on-chain calls, while the wallet signs on Base mainnet. Transactions succeed (EVM allows calling EOAs with calldata) but have no effect.

## Impact

- **Funds at risk:** Low. USDC `approve` targets the real USDC contract, but `transferFrom` never executes because the "escrow" address is an EOA. Approved amount (~1.10 USDC per bounty) could be drained if an attacker deploys a malicious contract at the same address on mainnet.
- **Functional impact:** Total. The entire bounty lifecycle (register, post, browse, list, claim, submit, approve) is non-functional on mainnet.
- **User experience:** Misleading. Clara reports "Agent Registered!" and "Bounty Created!" with real tx hashes, but nothing actually happened on-chain.

## Root Cause

Two independent config paths control chain behavior:

1. **Signing chain** — determined by wallet/Para SDK → always Base mainnet (8453)
2. **Contract addresses** — determined by `CLARA_NETWORK` env var → set to `testnet` in `~/.claude.json`

```typescript
// src/config/clara-contracts.ts:45-49
export function getClaraNetwork(): ClaraNetwork {
  const env = process.env.CLARA_NETWORK?.toLowerCase();
  if (env === 'testnet') return 'testnet';
  return 'mainnet'; // Default to mainnet
}
```

The testnet addresses are Mock contracts deployed on Base Sepolia:
- `identityRegistry: 0xAee21064f9f7c24fd052CC3598A60Cc50591d1B3` (MockIdentityRegistry)
- `bountyFactory: 0xB53989afAac1Ab17f9a5d9920B48B90e93AFB73C` (BountyFactory v2)

These are EOAs on Base mainnet — no contract code exists at these addresses.

## Reproduction

1. Ensure `CLARA_NETWORK=testnet` in Clara MCP env config
2. Run `work_register` → tx succeeds, reports agent registered
3. Run `work_post` → tx succeeds, reports bounty created with escrow
4. Run `work_list` or `work_browse` → returns empty (indexer can't find events that were never emitted)
5. Check tx targets on Basescan → they're EOAs, not contracts

## Evidence

| Transaction | Target | On-chain Reality |
|-------------|--------|------------------|
| Register (0x6e2df024...) | 0xAee2...1b3 | EOA, walletType: "eoa", 0 txs |
| Approve USDC (0xca5b2cc6...) | 0x8335...2913 | Real USDC contract (succeeded) |
| Post Bounty (0x205d712d...) | 0xB539...73c | EOA, walletType: "eoa", 0 txs |

## Recommended Fixes

### P0: Fix the config
Remove `CLARA_NETWORK=testnet` from `~/.claude.json` or set to `mainnet`.

### P1: Add chain validation
```typescript
// Before any bounty contract call, verify code exists:
const code = await client.getBytecode({ address: contractAddress });
if (!code || code === '0x') {
  throw new Error(`No contract at ${contractAddress} on chain ${chainId}. Check CLARA_NETWORK config.`);
}
```

### P2: Couple chain ID to network config
```typescript
export function validateNetworkChain(signingChainId: number): void {
  const network = getClaraNetwork();
  const expected = network === 'testnet' ? 84532 : 8453;
  if (signingChainId !== expected) {
    throw new Error(
      `Chain mismatch: CLARA_NETWORK=${network} expects chain ${expected}, but wallet is on ${signingChainId}`
    );
  }
}
```

### P3: Revoke dangling approvals
Users who ran `work_post` with testnet config on mainnet have USDC approvals to EOA addresses. While low risk, these should be revoked.

## Affected Wallet

- Address: `0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd`
- USDC approval to `0xB539...73c` revoked via tx `0xab911768...`
- Gas spent on no-op transactions: ~3 txs × ~$0.01 = ~$0.03
