# Spec: ENS CCIP-Read Gateway for Clara

**Status:** Draft
**Author:** Brian + Claude
**Date:** 2026-02-08
**Depends on:** Parent .eth domain registration

---

## Overview

Clara agents get free, instant, ENS-resolvable subnames (e.g., `brian.clarapay.eth`). Names resolve from any ENS-compatible wallet (MetaMask, Rainbow, etc.) without requiring Clara to be installed.

This enables:
- Human-readable agent identity across all of Ethereum
- External payments to Clara agents by name
- Interoperability with bounty contracts (anyone can pay `brian.clarapay.eth`)
- Agent discovery via standard ENS resolution

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    ENS CCIP-Read System                       │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 1. Ethereum Mainnet (one-time setup)                    │ │
│  │    ├── parent.eth domain (owned by Clara multisig)      │ │
│  │    ├── OffchainResolver contract (deployed once)        │ │
│  │    │   └── Stores: gateway URL + signing key pubkey     │ │
│  │    └── parent.eth resolver → OffchainResolver           │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 2. Clara Proxy (Cloudflare Worker)                      │ │
│  │    ├── POST /ens/register                               │ │
│  │    │   └── Store: name → address in KV                  │ │
│  │    ├── POST /ens/unregister                             │ │
│  │    │   └── Remove name from KV                          │ │
│  │    ├── GET  /ens/lookup/:name                           │ │
│  │    │   └── Simple JSON lookup (for Clara internal use)  │ │
│  │    ├── GET  /ens/list                                   │ │
│  │    │   └── List all registered names (directory)        │ │
│  │    └── POST /ens/resolve                                │ │
│  │        └── EIP-3668 CCIP-Read gateway handler           │ │
│  │        └── Receives encoded resolution request          │ │
│  │        └── Looks up name in KV                          │ │
│  │        └── Signs response with gateway private key      │ │
│  │        └── Returns signed response                      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 3. Clara MCP (new tools)                                │ │
│  │    ├── wallet_register_name                             │ │
│  │    │   └── Claim a free subname                         │ │
│  │    └── Enhanced wallet_send / work_post                 │ │
│  │        └── Accept ENS names in to/payee fields          │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Component 1: On-Chain Setup (Ethereum Mainnet)

### 1.1 Parent Domain

- Register an available `.eth` domain (e.g., `clarapay.eth`) — $5/yr for 5+ chars
- Fund registration from Clara wallet with ETH on mainnet
- Can use the existing `wallet_register_ens` tool we just built

### 1.2 OffchainResolver Contract

Deploy a resolver contract that implements EIP-3668 (CCIP-Read). When queried for any subname under `parent.eth`, it reverts with `OffchainLookup`:

```solidity
// Simplified — based on ensdomains/offchain-resolver reference
contract OffchainResolver is IExtendedResolver, IERC165 {
    string public url;                    // Gateway URL
    mapping(address => bool) public signers; // Authorized signing keys

    function resolve(bytes calldata name, bytes calldata data)
        external view override returns (bytes memory)
    {
        // Revert with OffchainLookup — tells clients to query our gateway
        revert OffchainLookup(
            address(this),
            urls,              // [gateway URL]
            callData,          // encoded request
            this.resolveWithProof.selector,
            extraData
        );
    }

    function resolveWithProof(bytes calldata response, bytes calldata extraData)
        external view returns (bytes memory)
    {
        // Verify the gateway's signature
        // Return the resolved data if valid
    }
}
```

**Reference implementation:** https://github.com/ensdomains/offchain-resolver

### 1.3 Configuration

After deployment:
1. Set `parent.eth`'s resolver to the OffchainResolver contract address
2. Configure gateway URL(s) in the resolver (e.g., `https://clara-proxy.bflynn-me.workers.dev/ens/resolve`)
3. Register the signing key's public address in the resolver

---

## Component 2: Clara Proxy Gateway Routes

### 2.1 KV Storage Schema

**KV Namespace:** `CLARA_ENS` (Cloudflare Workers KV)

```
Key:    "name:brian"
Value:  {
  "address": "0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd",
  "agentId": 42,
  "registeredAt": "2026-02-08T12:00:00Z",
  "registeredBy": "0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd"
}

Key:    "addr:0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd"
Value:  "brian"
(Reverse lookup: address → name)
```

### 2.2 API Routes

#### POST /ens/register
Register a new subname.

```
Request:
{
  "name": "brian",
  "address": "0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd",
  "agentId": 42                  // Optional: link to ERC-8004 identity
}

Headers:
  X-Clara-Auth: <wallet signature of "register:{name}:{address}:{timestamp}">

Response (200):
{
  "success": true,
  "name": "brian",
  "fullName": "brian.clarapay.eth",
  "address": "0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd"
}

Response (409 - already taken):
{
  "error": "name_taken",
  "message": "brian.clarapay.eth is already registered"
}
```

**Validation rules:**
- Name: 3-20 chars, alphanumeric + hyphens, no leading/trailing hyphens
- Address: valid EVM address (checksummed)
- Auth: must be signed by the address being registered (prevents squatting others' names)
- One name per address (can change, but can't hold multiple)

#### POST /ens/unregister
Release a subname.

```
Request:
{ "name": "brian" }

Headers:
  X-Clara-Auth: <wallet signature of "unregister:{name}:{timestamp}">

Response (200):
{ "success": true, "name": "brian", "released": true }
```

#### GET /ens/lookup/:name
Simple lookup (for Clara internal use, no CCIP-Read overhead).

```
Response (200):
{
  "name": "brian",
  "fullName": "brian.clarapay.eth",
  "address": "0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd",
  "agentId": 42
}

Response (404):
{ "error": "not_found", "message": "brian is not registered" }
```

#### GET /ens/list
Directory of all registered names.

```
Response (200):
{
  "names": [
    { "name": "brian", "address": "0x8744...", "agentId": 42 },
    { "name": "alice", "address": "0xabcd...", "agentId": 7 }
  ],
  "total": 2
}
```

#### POST /ens/resolve
**EIP-3668 CCIP-Read Gateway Handler**

This is the core of the system. ENS clients (MetaMask, viem, ethers) call this endpoint when resolving `*.clarapay.eth`.

```
Request: (EIP-3668 format)
{
  "sender": "0x<resolver-contract-address>",
  "data": "0x<encoded-resolution-request>"
}

Response: (EIP-3668 format)
{
  "data": "0x<abi-encoded-response-signed-by-gateway-key>"
}
```

The gateway:
1. Decodes the request to extract the subname being resolved
2. Looks up the name in KV
3. ABI-encodes the response (address, text records, etc.)
4. Signs it with the gateway's private key (stored as Worker secret)
5. Returns the signed response

### 2.3 Gateway Signing Key

- **Private key:** Stored as a Cloudflare Worker secret (`GATEWAY_SIGNING_KEY`)
- **Public key/address:** Registered in the on-chain OffchainResolver contract
- **Key rotation:** Deploy new key to Worker, update resolver contract
- **Security:** Key compromise = attacker can resolve names to wrong addresses. Mitigate with monitoring + fast rotation.

---

## Component 3: Clara MCP Tool

### 3.1 wallet_register_name

```
Tool: wallet_register_name
Description: Claim a free ENS subname (e.g., brian.clarapay.eth).
             Your name resolves in MetaMask, Rainbow, and any ENS-compatible wallet.

InputSchema:
  name: string (required) — The subname to claim (e.g., "brian")

Flow:
  1. Validate name (3-20 chars, alphanumeric + hyphens)
  2. Check availability: GET /ens/lookup/{name}
  3. If taken, return error with suggestion
  4. Sign registration message with Para wallet
  5. POST /ens/register with signature
  6. Return: "✓ brian.clarapay.eth is yours! Anyone can send tokens to this name."

Config:
  requiresAuth: true
  gasPreflight: false (no on-chain tx needed!)
  touchesSession: true
```

### 3.2 ENS Resolution in Existing Tools

Enhance `wallet_send` and `work_post` to accept ENS names:

```
Before: wallet_send to="0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd" amount="100"
After:  wallet_send to="brian.clarapay.eth" amount="100"
```

Resolution path:
1. If `to` ends with `.eth` → resolve via Clara internal API first (`/ens/lookup`)
2. Fallback: resolve via ENS on-chain (for non-Clara ENS names like `vitalik.eth`)
3. Use resolved address for the transaction

---

## Resolution Flow (How It Works End-to-End)

### Internal (within Clara)

```
User: "send 100 USDC to brian"
Clara:
  1. GET /ens/lookup/brian → { address: "0x8744..." }
  2. wallet_send(to="0x8744...", amount="100", token="USDC")
```

Fast, no ENS/CCIP overhead. Just a KV lookup.

### External (MetaMask, Rainbow, any wallet)

```
User types "brian.clarapay.eth" in MetaMask send field:
  1. MetaMask → ENS Universal Resolver → clarapay.eth resolver
  2. OffchainResolver reverts with OffchainLookup(gateway_url, ...)
  3. MetaMask → POST https://clara-proxy.../ens/resolve
  4. Gateway: lookup "brian" in KV → 0x8744...
  5. Gateway: sign response with gateway key
  6. MetaMask: verify signature against resolver's registered signer
  7. MetaMask: resolved! Send to 0x8744...
```

### External (smart contract interaction)

```
Anyone can interact with Clara bounty contracts using ENS names:
  1. Resolve brian.clarapay.eth → 0x8744...
  2. Call BountyFactory.createBounty(payee=0x8744..., ...)
  3. Brian sees the bounty via Clara's indexer
```

---

## Security Considerations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Gateway key compromise | High | Store as Worker secret, implement key rotation, monitor resolution patterns |
| Gateway downtime | Medium | Multiple gateway URLs in resolver, health monitoring |
| Name squatting | Low | One name per address, auth required, governance policy |
| Phishing (similar names) | Low | Normalize names (UTS-46), warn on confusable characters |
| DNS of Worker domain compromised | High | Use multiple gateway domains, pin TLS certs in resolver |

---

## Dependencies

1. **Parent .eth domain** — Need to register one (blocker)
2. **OffchainResolver contract** — Can use ensdomains/offchain-resolver reference
3. **Gateway signing key** — Generate and store as Worker secret
4. **Cloudflare KV namespace** — Create `CLARA_ENS` in Wrangler config
5. **Para wallet signing** — For auth on registration (already exists)

---

## Open Questions

1. **Parent domain name** — What .eth name to register? `clarapay.eth` is available.
2. **Name expiry** — Should subnames expire after inactivity? If so, how long?
3. **Name changes** — Can a user change their name? One rename per month?
4. **Multiple names** — Can an address have multiple names? (Recommended: no, one primary)
5. **Resolver contract** — Deploy custom or use ensdomains reference directly?
6. **Text records** — Should the gateway support ENS text records (avatar, description, url)?
