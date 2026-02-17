# SPEC: Cryptographic Request Authentication (ERC-8128 Path)

**Status:** Draft
**Date:** 2026-02-10
**Authors:** Brian Flynn, Claude (research), GPT-5.2 (second opinion)

---

## Problem

Clara Proxy authenticates requests using a plain `X-Clara-Address` header:

```
MCP Server → X-Clara-Address: 0x8744...affd → Proxy trusts it blindly
```

The proxy validates only the **format** (40-char hex), not **ownership**. Any client that knows the proxy URL can impersonate any address. With Clara now serving multiple users, this is a live vulnerability — not theoretical.

**Attack surface:**
- Spoof `X-Clara-Address` to drain another user's free tier quota
- Trigger Para signing operations on behalf of another wallet
- Register/modify ENS subnames for addresses you don't own
- Spend on-chain credits belonging to another user

---

## Threat Model

| Actor | Access | Risk |
|-------|--------|------|
| Legitimate user (own MCP) | Full local control | Low — they own their session |
| Malicious user (own MCP) | Knows proxy URL | **High** — can set any X-Clara-Address |
| Network attacker (MITM) | Can intercept HTTPS (unlikely with TLS) | Medium — replay captured requests |
| Compromised MCP host | Full local + session keys | High — but out of scope (device compromise) |

**Assumption:** TLS between MCP and Proxy is intact. The threat is **other Clara users**, not network attackers.

---

## Solution: Two-Phase Approach

### Phase 1 — SIWE + Session Key Delegation (Ship Now)

Use battle-tested standards to close the security gap immediately.

```
┌─────────────────────────────────────────────────────────────┐
│                     SESSION ESTABLISHMENT                     │
│                                                               │
│  MCP (Para MPC wallet)                                       │
│    │                                                          │
│    ├── 1. Generate ephemeral keypair (local, instant)        │
│    │      sessionKey = crypto.generateKeyPairSync('ec')      │
│    │                                                          │
│    ├── 2. SIWE sign delegation (MPC, ~300ms, ONE TIME)       │
│    │      message = {                                         │
│    │        domain: "clara-proxy.bflynn4141.workers.dev",     │
│    │        address: "0x8744...affd",                         │
│    │        statement: "Delegate signing to session key",     │
│    │        uri: "https://clara-proxy.bflynn4141.workers.dev",│
│    │        sessionPublicKey: sessionKey.publicKey,           │
│    │        expirationTime: now + 24h,                        │
│    │        chainId: 8453,                                    │
│    │        nonce: random(),                                  │
│    │      }                                                   │
│    │      delegation = para.signMessage(message)  ← MPC      │
│    │                                                          │
│    └── 3. Send delegation to proxy for session creation      │
│           POST /auth/session                                  │
│           { siweMessage, signature, sessionPublicKey }        │
│                                                               │
│  Proxy                                                        │
│    ├── Verify SIWE signature → recover address                │
│    ├── Verify sessionPublicKey matches delegation             │
│    ├── Store: { address, sessionPubKey, expiry } in KV       │
│    └── Return: sessionId                                      │
│                                                               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     PER-REQUEST SIGNING                       │
│                                                               │
│  MCP (every request to proxy)                                │
│    │                                                          │
│    ├── Sign request components with session key (LOCAL, <1ms)│
│    │     components = {                                       │
│    │       method: "POST",                                    │
│    │       path: "/api/v1/wallets/{id}/sign-typed-data",     │
│    │       bodyDigest: sha256(body),                          │
│    │       timestamp: Date.now(),                             │
│    │       nonce: crypto.randomUUID(),                        │
│    │     }                                                    │
│    │     signature = sessionKey.sign(canonicalize(components))│
│    │                                                          │
│    └── Attach to request:                                     │
│          X-Clara-Address: 0x8744...affd                      │
│          X-Clara-Session: {sessionId}                         │
│          X-Clara-Signature: {signature}                       │
│          X-Clara-Timestamp: {timestamp}                       │
│          X-Clara-Nonce: {nonce}                               │
│                                                               │
│  Proxy (verification middleware)                              │
│    ├── Look up session by X-Clara-Session                     │
│    ├── Verify session not expired                             │
│    ├── Verify X-Clara-Address matches session.address         │
│    ├── Reconstruct signed message from request components     │
│    ├── Verify signature against session.publicKey             │
│    ├── Check nonce not replayed (KV-based nonce cache)        │
│    ├── Check timestamp within ±60s of server time             │
│    └── If valid → proceed. If invalid → 401.                 │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Phase 2 — ERC-8128 Conformance (When Spec Stabilizes)

Replace the custom per-request signing with `@slicekit/erc8128` (or the finalized standard library). The session key delegation layer stays the same — only the request signature format changes.

**Migration:** Replace `X-Clara-Signature` + custom canonicalization with RFC 9421 `Signature` + `Signature-Input` headers per ERC-8128.

**Trigger for Phase 2:** ERC-8128 reaches Review or Last Call status on eips.ethereum.org.

---

## Affected Files

### MCP Side (`clara-mcp/src/`)

| File | Change | Priority |
|------|--------|----------|
| **`src/auth/session-key.ts`** (NEW) | Generate ephemeral keypair, sign delegation via SIWE, cache session key locally | P0 |
| **`src/auth/request-signer.ts`** (NEW) | Sign outgoing requests with session key (wraps fetch) | P0 |
| `src/para/client.ts:144,178` | Replace raw `X-Clara-Address` with signed request via `request-signer` | P0 |
| `src/para/account.ts:48` | Same — use `request-signer` wrapper | P0 |
| `src/tools/sign.ts:56,171` | Same | P0 |
| `src/tools/messaging.ts:488` | Same | P1 |
| `src/tools/sponsor-gas.ts:50` | Same | P1 |
| `src/storage/session.ts` | Extend session to store ephemeral key + delegation + sessionId | P0 |
| `src/middleware.ts` | Add session key initialization on first tool call | P0 |

### Proxy Side (`clara-proxy/src/`)

| File | Change | Priority |
|------|--------|----------|
| **`src/auth-middleware.js`** (NEW) | Verify session + per-request signature | P0 |
| `src/index.js:1122-1143` | Replace regex-only validation with `auth-middleware` call | P0 |
| `wrangler.toml` | Add KV namespace for nonce cache + session store | P0 |

### New Dependencies

| Package | Side | Purpose |
|---------|------|---------|
| `siwe` | MCP + Proxy | ERC-4361 message creation + verification |
| `@noble/secp256k1` or `@noble/curves` | MCP | Ephemeral key generation + local signing |
| (Phase 2) `@slicekit/erc8128` | Both | RFC 9421 + Ethereum signing |

---

## Session Key Delegation Detail

### Why Not MPC Per-Request?

Para's 2-of-2 MPC signing requires a round-trip to cloud HSMs:
- **Latency:** ~300-500ms per `signMessage()`
- **For tx signing:** Acceptable (user clicks "send", waits briefly)
- **For HTTP auth:** Unacceptable (every API call adds 300ms)

### Delegation Statement (SIWE Format)

```
clara-proxy.bflynn4141.workers.dev wants you to sign in with your Ethereum account:
0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd

Delegate HTTP request signing to session key:
0x04a1b2c3...{sessionPublicKeyHex}

URI: https://clara-proxy.bflynn4141.workers.dev
Version: 1
Chain ID: 8453
Nonce: {random}
Issued At: 2026-02-10T12:00:00Z
Expiration Time: 2026-02-11T12:00:00Z
Resources:
- urn:clara:scope:sign
- urn:clara:scope:send
- urn:clara:scope:message
```

### Scoped Delegation (Future)

The `Resources` field enables fine-grained scoping:
- `urn:clara:scope:read` — read-only operations (balance, history)
- `urn:clara:scope:sign` — signing operations
- `urn:clara:scope:send` — token transfers (highest risk)
- `urn:clara:scope:message` — messaging operations

Phase 1 grants all scopes. Future versions can require MPC step-up for `send` operations above a threshold.

---

## Request Canonicalization (Phase 1)

Until ERC-8128 finalizes, use a simple deterministic format:

```
CLARA-REQUEST-SIG-V1
POST
/api/v1/wallets/8229cbb1-09aa-40cd-aedc-2072c0fcbf06/sign-typed-data
sha256:a3b2c1d4...{bodyDigest}
1707566400
{nonce}
```

**Components (in order):**
1. Version tag: `CLARA-REQUEST-SIG-V1`
2. HTTP method (uppercase)
3. Request path including query string (e.g., `/api/v1/wallets?param=value`)
4. Body digest: `sha256:{hex}` (empty string hash if no body)
5. Unix timestamp (seconds)
6. Nonce (UUID v4)

Sign with ECDSA secp256k1 (same curve as Ethereum), recover with `ecrecover`.

**Why not RFC 9421 in Phase 1?** Simplicity. RFC 9421 has Structured Fields parsing complexity that's unnecessary when both client and server are ours. Phase 2 adopts RFC 9421 via ERC-8128 for interoperability.

---

## Proxy Verification Flow

```javascript
// clara-proxy/src/auth-middleware.js

async function verifyRequest(request, env) {
  const address = request.headers.get("X-Clara-Address");
  const sessionId = request.headers.get("X-Clara-Session");
  const signature = request.headers.get("X-Clara-Signature");
  const timestamp = request.headers.get("X-Clara-Timestamp");
  const nonce = request.headers.get("X-Clara-Nonce");

  // 1. All headers required
  if (!address || !sessionId || !signature || !timestamp || !nonce) {
    return { ok: false, error: "MISSING_AUTH_HEADERS" };
  }

  // 2. Look up session
  const session = await env.SESSIONS.get(sessionId, "json");
  if (!session || session.address !== address) {
    return { ok: false, error: "INVALID_SESSION" };
  }

  // 3. Check session expiry
  if (Date.now() > session.expiresAt) {
    await env.SESSIONS.delete(sessionId);
    return { ok: false, error: "SESSION_EXPIRED" };
  }

  // 4. Timestamp freshness (±60s)
  const ts = parseInt(timestamp);
  if (Math.abs(Date.now() / 1000 - ts) > 60) {
    return { ok: false, error: "TIMESTAMP_STALE" };
  }

  // 5. Replay protection
  const nonceKey = `nonce:${nonce}`;
  const seen = await env.NONCES.get(nonceKey);
  if (seen) {
    return { ok: false, error: "NONCE_REPLAYED" };
  }
  // Store nonce with TTL matching timestamp window
  await env.NONCES.put(nonceKey, "1", { expirationTtl: 120 });

  // 6. Reconstruct and verify signature
  const body = await request.clone().text();
  const bodyDigest = await sha256hex(body);
  const url = new URL(request.url);
  const message = [
    "CLARA-REQUEST-SIG-V1",
    request.method,
    url.pathname,
    `sha256:${bodyDigest}`,
    timestamp,
    nonce,
  ].join("\n");

  const recoveredKey = ecrecover(message, signature);
  if (recoveredKey !== session.sessionPublicKey) {
    return { ok: false, error: "SIGNATURE_INVALID" };
  }

  return { ok: true, address: session.address };
}
```

---

## Backward Compatibility

### Migration Period

Both signed and unsigned requests are accepted during migration:

1. **Week 1-2:** Deploy proxy with optional signature verification. Log warnings for unsigned requests.
2. **Week 3:** Update all MCP server instances to sign requests.
3. **Week 4:** Enforce signatures. Reject unsigned requests with 401 + helpful error message.

### Error Response for Unsigned Requests

```json
{
  "error": "AUTH_SIGNATURE_REQUIRED",
  "code": "SIGNATURE_REQUIRED",
  "message": "This endpoint requires signed requests. Update your Clara MCP server: npm update clara-mcp",
  "docs": "https://github.com/clara/docs/SPEC-ERC8128-AUTH.md"
}
```

---

## MPC Step-Up for High-Risk Operations (Future)

For operations above a spend threshold (e.g., > $100 transfer), require a fresh MPC signature instead of relying on the session key alone:

```
Regular request:  Session key signature → proceed
Step-up request:  Session key signature + MPC challenge-response → proceed
```

The proxy would:
1. Accept the session-key-signed request
2. Return `403 STEP_UP_REQUIRED` with a challenge nonce
3. MCP signs the nonce via MPC (Para signMessage, 300ms)
4. MCP re-submits with both session signature + MPC signature
5. Proxy verifies both → proceed

This provides defense-in-depth: even a stolen session key can't authorize large transfers.

---

## ERC-8128 Alignment (Phase 2)

When ERC-8128 reaches Review status, the Phase 1 implementation maps cleanly:

| Phase 1 (Custom) | Phase 2 (ERC-8128) |
|---|---|
| `X-Clara-Signature` header | `Signature` header (RFC 9421) |
| `X-Clara-Timestamp` | `created` param in `Signature-Input` |
| `X-Clara-Nonce` | `nonce` param in `Signature-Input` |
| Custom canonicalization | RFC 9421 message component canonicalization |
| ECDSA secp256k1 verify | Same (Ethereum-native) |
| Session key delegation | Same (SIWE stays) |

**Estimated migration effort:** ~2-4 hours. Replace `request-signer.ts` internals and `auth-middleware.js` verification. The delegation layer and session management are untouched.

---

## Known Risks & Open Questions

### ERC-8128 Draft Risks (from Ethereum Magicians discussion)
- `keyid` format/namespace not finalized
- Multi-algorithm signaling TBD
- Replay protection compliance level undefined
- RFC 9421 Structured Fields can be mangled by HTTP intermediaries

### Open Questions
1. **Session key storage:** Encrypt ephemeral private key at rest (like session.enc) or keep in-memory only? In-memory is safer but requires re-delegation on MCP restart.
2. **KV namespace limits:** Cloudflare KV has eventual consistency (~60s). Is this acceptable for nonce replay protection? Alternative: use Durable Objects for strong consistency.
3. **Multi-chain sessions:** Should delegation be per-chain or universal? Current design is universal (one session key for all chains).
4. **Revocation:** How does a user revoke a compromised session key? Options: proxy endpoint `DELETE /auth/session/{id}` or automatic expiry only.

---

## Implementation Estimate

| Component | Effort | Blocked By |
|-----------|--------|------------|
| `src/auth/session-key.ts` | 3-4h | Nothing |
| `src/auth/request-signer.ts` | 2-3h | session-key.ts |
| Proxy `auth-middleware.js` | 3-4h | Nothing (parallel) |
| Wiring into existing fetch calls (6 files) | 2-3h | request-signer.ts |
| Proxy wrangler.toml + KV setup | 30min | Nothing |
| Tests (MCP side) | 2-3h | request-signer.ts |
| Tests (Proxy side) | 2-3h | auth-middleware.js |
| Migration period monitoring | 1 week | Deployment |
| **Total Phase 1** | **~2-3 days** | |
| **Phase 2 (ERC-8128 swap)** | **~4h** | ERC-8128 finalization |

---

## References

- [ERC-8128: Signed HTTP Requests with Ethereum](https://eip.tools/eip/8128) — Draft
- [ERC-8128 Reference Implementation (slice-so)](https://github.com/slice-so/erc8128) — `@slicekit/erc8128` on npm
- [ERC-4361: Sign-In with Ethereum (SIWE)](https://eips.ethereum.org/EIPS/eip-4361) — Final
- [RFC 9421: HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421) — Standard
- [Ethereum Magicians: ERC-8128 Discussion](https://ethereum-magicians.org/t/erc-8128-signed-http-requests-with-ethereum/27515)
- Clara Proxy source: `/Users/brianflynn/clara-proxy/src/index.js`
- Clara MCP auth flow: `/Users/brianflynn/clara-mcp/src/para/client.ts`
- Prior security work: `/Users/brianflynn/clara-mcp/docs/AUDIT-001-CHAIN-MISMATCH.md`
