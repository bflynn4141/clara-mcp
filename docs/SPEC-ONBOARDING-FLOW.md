# Spec: Clara Unified Onboarding Flow

**Status:** Implemented
**Author:** Brian + Claude
**Date:** 2026-02-08
**Updated:** 2026-02-09
**Depends on:** SPEC-ENS-CCIP-GATEWAY.md
**Implementation:** CLAUDE.md orchestration (no new MCP tools — AI calls existing tools in sequence)

---

## Overview

New Clara users go through a unified onboarding that creates their wallet, assigns them an ENS subname, and registers them as an ERC-8004 agent — all in one flow. After onboarding, they have:

1. A **wallet** (Para-managed, email-based)
2. A **name** (e.g., `brian.claraid.eth` — resolvable everywhere)
3. An **agent identity** (ERC-8004 NFT on Base, with full registration file)
4. They're **ready to work** (can browse bounties, get hired, get paid by name)

---

## The Flow

```
┌────────────────────────────────────────────────────────────────┐
│                  Clara Unified Onboarding                      │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Step 1: WALLET                                           │  │
│  │                                                          │  │
│  │  User: "I want to set up Clara"                          │  │
│  │  Clara: wallet_setup email="user@gmail.com"              │  │
│  │  Result: 0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd      │  │
│  │                                                          │  │
│  │  [If wallet already exists, skip to Step 2]              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          ↓                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Step 2: NAME                                             │  │
│  │                                                          │  │
│  │  Clara: "What name do you want? This will be your        │  │
│  │          identity that people can use to find and pay     │  │
│  │          you. For example: brian.claraid.eth"            │  │
│  │                                                          │  │
│  │  User: "brian"                                           │  │
│  │                                                          │  │
│  │  Clara: wallet_register_name name="brian"                │  │
│  │    → Check availability via /ens/lookup/brian             │  │
│  │    → If taken: suggest alternatives (brian1, b-flynn)     │  │
│  │    → If available: POST /ens/register                    │  │
│  │    → Result: brian.claraid.eth ✓                         │  │
│  │                                                          │  │
│  │  [No on-chain tx. Instant. Free.]                        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          ↓                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Step 3: AGENT REGISTRATION (ERC-8004)                    │  │
│  │                                                          │  │
│  │  Clara: "What skills do you have? What services do       │  │
│  │          you offer?"                                     │  │
│  │                                                          │  │
│  │  User: skills=["solidity", "auditing"]                   │  │
│  │        description="Smart contract security researcher"  │  │
│  │                                                          │  │
│  │  Clara: work_register(                                   │  │
│  │    name="Brian",                                         │  │
│  │    skills=["solidity", "auditing"],                      │  │
│  │    description="Smart contract security researcher",     │  │
│  │    ensName="brian.claraid.eth"      ← NEW FIELD          │  │
│  │  )                                                       │  │
│  │                                                          │  │
│  │  Internally:                                             │  │
│  │    1. Build ERC-8004 registration file (see below)       │  │
│  │    2. Upload to IPFS or clara-proxy                      │  │
│  │    3. Call IdentityRegistry.register(registrationURI)    │  │
│  │    4. Get agentId = 42                                   │  │
│  │    5. Update KV: brian → { address, agentId: 42 }        │  │
│  │    6. Save to ~/.clara/agent.json                        │  │
│  │                                                          │  │
│  │  [On-chain tx on Base. Gas ~$0.01]                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          ↓                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Step 4: READY                                            │  │
│  │                                                          │  │
│  │  Clara:                                                  │  │
│  │  ┌────────────────────────────────────────────────┐      │  │
│  │  │ ✅ You're all set!                              │      │  │
│  │  │                                                │      │  │
│  │  │ Name:    brian.claraid.eth                      │      │  │
│  │  │ Agent:   #42                                   │      │  │
│  │  │ Wallet:  0x8744...affd                         │      │  │
│  │  │ Skills:  solidity, auditing                    │      │  │
│  │  │                                                │      │  │
│  │  │ People can now:                                │      │  │
│  │  │ • Send tokens to brian.claraid.eth             │      │  │
│  │  │ • Hire you for bounties by name                │      │  │
│  │  │ • Look up your reputation on-chain             │      │  │
│  │  └────────────────────────────────────────────────┘      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## ERC-8004 Registration File (Updated Format)

Currently, `work_register` creates a minimal metadata blob:
```json
{
  "name": "Brian",
  "skills": ["solidity"],
  "description": "...",
  "platform": "clara",
  "registeredAt": "2026-02-08T..."
}
```

**Updated to proper ERC-8004 registration file:**

```json
{
  "type": "AgentRegistration",
  "name": "Brian",
  "description": "Smart contract security researcher",
  "image": "",
  "services": [
    {
      "type": "ENS",
      "endpoint": "brian.claraid.eth"
    },
    {
      "type": "agentWallet",
      "endpoint": "eip155:8453:0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd"
    }
  ],
  "skills": ["solidity", "auditing"],
  "x402Support": true,
  "active": true,
  "registrations": [
    {
      "agentRegistry": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      "agentId": "42"
    }
  ]
}
```

**Changes from current format:**
1. Added `type: "AgentRegistration"` (ERC-8004 convention)
2. Added `services` array with ENS and wallet endpoints
3. Added `x402Support: true` (Clara supports x402 payments)
4. Added `active: true` flag
5. Added `registrations` array (back-link to on-chain identity)
6. Moved `skills` to top level (not nested in metadata)

### Registration File Hosting

**Options (in order of preference):**

1. **Clara Proxy endpoint** — `https://clara-proxy.bflynn-me.workers.dev/agents/{agentId}.json`
   - Pros: Fast, no extra dependency, updatable
   - Cons: Centralized

2. **IPFS via Pinata/Filebase** — `ipfs://bafybeig...`
   - Pros: Decentralized, content-addressed, immutable
   - Cons: Slow, can't update without new CID, costs money

3. **Data URI** (current approach) — `data:application/json;base64,...`
   - Pros: No hosting needed, self-contained
   - Cons: Can't be updated, limited size, not browsable

**Recommendation:** Start with Clara Proxy endpoint for easy updates. Add IPFS as optional for users who want immutable registration.

---

## Changes Required

### 1. clara-proxy (Cloudflare Worker)

| Route | Purpose | Priority |
|-------|---------|----------|
| `POST /ens/register` | Register a subname in KV | P0 |
| `GET /ens/lookup/:name` | Internal name resolution | P0 |
| `POST /ens/resolve` | CCIP-Read gateway handler | P0 |
| `GET /ens/list` | Directory of registered names | P1 |
| `POST /ens/unregister` | Release a subname | P1 |
| `GET /agents/:agentId.json` | Host registration files | P1 |

**Wrangler config additions:**
```toml
[[kv_namespaces]]
binding = "CLARA_ENS"
id = "..." # Create via `wrangler kv:namespace create CLARA_ENS`

[vars]
ENS_PARENT_DOMAIN = "claraid.eth"

# Secrets (via `wrangler secret put`):
# GATEWAY_SIGNING_KEY = "0x..." (private key for CCIP-Read response signing)
```

### 2. clara-mcp (MCP Server)

| File | Change | Priority |
|------|--------|----------|
| `src/tools/ens-name.ts` (new) | `wallet_register_name` tool | P0 |
| `src/tools/work-register.ts` | Update metadata to ERC-8004 registration file format | P0 |
| `src/tools/work-register.ts` | Accept `ensName` param, include in registration | P0 |
| `src/services/ens.ts` | Add `resolveInternalName()` for Clara subname lookups | P1 |
| `src/tools/send.ts` | Accept ENS names in `to` field | P1 |
| `src/tools/work-post.ts` | Accept ENS names in payee field | P2 |

### 3. On-Chain (Ethereum Mainnet)

| Action | Purpose | Priority |
|--------|---------|----------|
| Register parent.eth domain | Prerequisite for everything | P0 (manual) |
| Deploy OffchainResolver | CCIP-Read resolver contract | P0 |
| Set resolver for parent.eth | Point to OffchainResolver | P0 |
| Register gateway signing key in resolver | Authorize Clara's gateway | P0 |

---

## User Experience: "Engage Brian for Work"

After onboarding, the magical flow works like this:

```
Alice: "I want to engage brian for a work trial.
        100 USDC for one week. Ship the ENS integration."

Clara (internally):
  1. Resolve "brian" → GET /ens/lookup/brian
     → { address: "0x8744...", agentId: 42 }

  2. Verify agent exists → check indexer for agentId 42
     → { name: "Brian", skills: ["solidity"], reputation: 4.8/5 }

  3. Create bounty → work_post(
       amount="100",
       token="USDC",
       deadline="1 week",
       taskSummary="Ship the ENS integration",
       payee="brian"   // Resolved to 0x8744...
     )

  4. Result:
     "✅ Bounty posted for Brian (brian.claraid.eth)
      Amount: 100 USDC
      Deadline: Feb 15, 2026
      Bond: 10 USDC (poster) + 10 USDC (worker)

      Brian can claim this with `work_claim`"
```

**Note:** The bounty contract itself stores the raw address (0x8744...), not the ENS name. The ENS name is for UX only. This is important — the contract doesn't depend on ENS resolution at execution time.

---

## Migration: Existing Agents

Agents registered before this update have the old metadata format. Migration path:

1. **No forced migration** — old agents keep working
2. **Voluntary upgrade** — `work_register --update` to update registration file
3. **Subname claim** — existing agents can call `wallet_register_name` separately
4. **Indexer handles both formats** — detect old vs new metadata by presence of `type` field

---

## Resolved Questions

1. **Onboarding trigger** — **CLAUDE.md orchestration.** No new tool. AI calls `wallet_setup` → `wallet_register_name` → `work_register` in sequence, guided by AskUserQuestion at each step. Also auto-detects new wallets.
2. **Skills taxonomy** — **Hybrid.** AskUserQuestion presents 4 common skills (Solidity, TypeScript, React, Security) as multi-select, with "Other" for free-form input.
3. **Profile photos** — **Not now.** Keep it lean. Can add later.
4. **Social links** — **Not now.** Keep it lean. Can add later.
5. **Agent discovery via ENS** — Already implemented via `resolve-address.ts`. Bare names resolve to claraid.eth subnames.
6. **Domain** — **claraid.eth** (registered 2026-02-09, owner 0x8744..affd).
