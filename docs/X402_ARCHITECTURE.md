# x402 Protocol Architecture

x402 is a protocol for HTTP-native micropayments using blockchain signatures. It enables API providers to charge per-request without requiring accounts, subscriptions, or API keys.

## Protocol Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            x402 PAYMENT FLOW                                 │
└─────────────────────────────────────────────────────────────────────────────┘

     Client (Clara)                                    API Provider
          │                                                  │
          │  1. GET /api/premium-data                        │
          │─────────────────────────────────────────────────►│
          │                                                  │
          │  2. 402 Payment Required                         │
          │     X-Payment-Request: {                         │
          │       "amount": "1000",                          │
          │       "token": "0x833589...USDC",                │
          │       "recipient": "0xabc...",                   │
          │       "chainId": 8453                            │
          │     }                                            │
          │◄─────────────────────────────────────────────────│
          │                                                  │
          │  3. Sign EIP-712 Payment Authorization           │
          │     ┌─────────────────────────────────┐          │
          │     │ domain: {                       │          │
          │     │   name: "x402",                 │          │
          │     │   version: "1",                 │          │
          │     │   chainId: 8453                 │          │
          │     │ }                               │          │
          │     │ types: { Payment: [...] }       │          │
          │     │ message: {                      │          │
          │     │   amount, token, recipient,     │          │
          │     │   nonce, deadline               │          │
          │     │ }                               │          │
          │     └─────────────────────────────────┘          │
          │                                                  │
          │  4. GET /api/premium-data                        │
          │     X-Payment: <base64-encoded-signature>        │
          │─────────────────────────────────────────────────►│
          │                                                  │
          │                    5. Verify signature           │
          │                    6. Execute payment on-chain   │
          │                    7. Return data                │
          │                                                  │
          │  200 OK                                          │
          │  { "data": "premium content" }                   │
          │◄─────────────────────────────────────────────────│
          │                                                  │
```

## Core Concepts

### HTTP 402 Payment Required

The 402 status code was reserved in HTTP/1.1 for "future use" in digital payments. x402 implements this vision:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
X-Payment-Request: eyJhbW91bnQiOiIxMDAwIi4uLn0=

{
  "error": "Payment required",
  "payment": {
    "amount": "1000",
    "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "recipient": "0x1234567890abcdef1234567890abcdef12345678",
    "chainId": 8453,
    "deadline": 1706745600
  }
}
```

### EIP-712 Typed Data Signing

Payments are authorized via EIP-712 signatures (no on-chain transaction required from client):

```typescript
const typedData = {
  domain: {
    name: "x402",
    version: "1",
    chainId: 8453,
    verifyingContract: "0x..." // Facilitator contract
  },
  types: {
    Payment: [
      { name: "payer", type: "address" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "token", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" }
    ]
  },
  message: {
    payer: "0x8744...",      // Client's address
    recipient: "0xabc...",   // API provider
    amount: 1000n,           // In token units
    token: "0x8335...",      // USDC address
    nonce: 42n,              // Prevents replay
    deadline: 1706745600n    // Signature expiry
  }
};
```

## Architecture Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           x402 ECOSYSTEM                                     │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│   CLIENT (Clara)     │     │   API PROVIDER       │     │   FACILITATOR    │
│                      │     │                      │     │   (x402.org)     │
│  • Detect 402        │     │  • Return 402        │     │                  │
│  • Parse payment req │     │  • Verify signature  │     │  • Settlement    │
│  • Sign EIP-712      │────►│  • Submit to facil.  │────►│  • On-chain tx   │
│  • Retry with sig    │     │  • Serve content     │     │  • Escrow        │
│                      │     │                      │     │                  │
└──────────────────────┘     └──────────────────────┘     └──────────────────┘
         │                            │                           │
         │                            │                           │
         ▼                            ▼                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              BASE MAINNET                                     │
│                                                                              │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────┐  │
│  │ Client Wallet   │    │ Provider Wallet │    │ x402 Facilitator        │  │
│  │ 0x8744...       │    │ 0xabc...        │    │ Contract                │  │
│  │                 │    │                 │    │                         │  │
│  │ USDC Balance    │───►│ USDC Balance    │    │ • verifySignature()    │  │
│  │                 │    │                 │    │ • executePayment()      │  │
│  └─────────────────┘    └─────────────────┘    │ • batchSettle()         │  │
│                                                 └─────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Clara's x402 Implementation

### Tools Provided

| Tool | Purpose |
|------|---------|
| `wallet_pay_x402` | Pay for a 402-gated resource |
| `wallet_discover_x402` | Check if domain supports x402 |
| `wallet_browse_x402` | Browse x402 ecosystem |

### Payment Flow in Clara

```typescript
// 1. User requests x402-gated content
const response = await fetch("https://api.example.com/data");

// 2. Detect 402 and parse payment requirements
if (response.status === 402) {
  const paymentRequest = parsePaymentRequest(response);

  // 3. Check spending limits
  if (paymentRequest.amount > spendingLimit) {
    throw new Error("Exceeds spending limit");
  }

  // 4. Sign payment authorization (EIP-712)
  const signature = await signTypedData(
    paymentRequest.domain,
    paymentRequest.types,
    paymentRequest.message
  );

  // 5. Retry with payment header
  const paidResponse = await fetch("https://api.example.com/data", {
    headers: {
      "X-Payment": encodePayment(signature, paymentRequest)
    }
  });

  return paidResponse;
}
```

### Spending Limits

Clara enforces spending limits to prevent runaway costs:

| Limit Type | Default | Description |
|------------|---------|-------------|
| Per-request | $1.00 | Max for single payment |
| Per-domain/hour | $10.00 | Hourly cap per API |
| Per-session | $50.00 | Total session limit |

## Discovery Protocol

API providers advertise x402 support via `/.well-known/x402`:

```
GET https://api.example.com/.well-known/x402
```

```json
{
  "version": "1.0",
  "supported": true,
  "chains": [8453, 1, 42161],
  "tokens": [
    {
      "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "symbol": "USDC",
      "chainId": 8453
    }
  ],
  "facilitator": "https://x402.org/api/v1",
  "endpoints": [
    {
      "path": "/api/premium/*",
      "pricing": {
        "amount": "1000",
        "token": "USDC",
        "unit": "request"
      }
    }
  ]
}
```

## Settlement Models

### Immediate Settlement
```
Client signs → Provider submits tx → On-chain transfer → Content delivered
Latency: ~2-5 seconds (block confirmation)
```

### Facilitated Settlement
```
Client signs → Provider caches sig → Content delivered → Batch settlement later
Latency: Instant content, settlement async
```

### Pre-authorized Balance
```
Client deposits to facilitator → Instant micropayments against balance
Latency: Instant (off-chain accounting)
```

## Sequence Diagram: Full Flow

```
┌────────┐     ┌────────┐     ┌────────┐     ┌────────┐     ┌────────┐
│ User   │     │ Claude │     │ Clara  │     │ API    │     │ Facil. │
│        │     │ Code   │     │ MCP    │     │        │     │        │
└───┬────┘     └───┬────┘     └───┬────┘     └───┬────┘     └───┬────┘
    │              │              │              │              │
    │ "Get weather │              │              │              │
    │  for NYC"    │              │              │              │
    │─────────────►│              │              │              │
    │              │              │              │              │
    │              │ wallet_pay_  │              │              │
    │              │ x402(url)    │              │              │
    │              │─────────────►│              │              │
    │              │              │              │              │
    │              │              │ GET /weather │              │
    │              │              │─────────────►│              │
    │              │              │              │              │
    │              │              │ 402 Payment  │              │
    │              │              │ Required     │              │
    │              │              │◄─────────────│              │
    │              │              │              │              │
    │              │              │ Check limits │              │
    │              │              │ Sign EIP-712 │              │
    │              │              │ (via Para)   │              │
    │              │              │              │              │
    │              │              │ GET /weather │              │
    │              │              │ X-Payment:...│              │
    │              │              │─────────────►│              │
    │              │              │              │              │
    │              │              │              │ Submit to    │
    │              │              │              │ facilitator  │
    │              │              │              │─────────────►│
    │              │              │              │              │
    │              │              │              │    OK        │
    │              │              │              │◄─────────────│
    │              │              │              │              │
    │              │              │ 200 OK       │              │
    │              │              │ {weather...} │              │
    │              │              │◄─────────────│              │
    │              │              │              │              │
    │              │ Weather data │              │              │
    │              │◄─────────────│              │              │
    │              │              │              │              │
    │ "It's 72°F   │              │              │              │
    │  and sunny"  │              │              │              │
    │◄─────────────│              │              │              │
    │              │              │              │              │
```

## Security Considerations

### Replay Protection
- Nonces prevent signature reuse
- Deadlines limit signature validity window
- Domain separator includes chainId

### Spending Limits
- Per-request caps prevent large unauthorized charges
- Per-domain limits prevent runaway loops
- Session limits provide upper bound

### Signature Verification
- Provider MUST verify signature before serving content
- Facilitator verifies again before settlement
- On-chain verification for disputes

## Benefits of x402

| For API Providers | For Clients |
|-------------------|-------------|
| No API keys to manage | No accounts to create |
| Per-request monetization | Pay only for what you use |
| Instant global payments | No credit cards |
| No chargebacks | Programmable spending |
| No billing infrastructure | Works with AI agents |

## Integration Example

### For API Providers (Node.js)
```javascript
import { x402Middleware } from '@x402/middleware';

app.use('/api/premium', x402Middleware({
  recipient: '0x...',
  pricing: { amount: '1000', token: 'USDC' },
  facilitator: 'https://x402.org/api/v1'
}));

app.get('/api/premium/data', (req, res) => {
  // This only runs if payment verified
  res.json({ data: 'premium content' });
});
```

### For Clients (Clara MCP)
```typescript
// Automatic - Clara handles 402 transparently
const result = await tools.wallet_pay_x402({
  url: 'https://api.example.com/premium/data'
});
// Returns the data, payment handled automatically
```

## Related Standards

- **EIP-712**: Typed structured data hashing and signing
- **EIP-191**: Signed data standard
- **HTTP 402**: Payment Required status code
- **RFC 8905**: Payment pointer for Web Monetization

## Resources

- x402 Specification: https://x402.org/spec
- Reference Implementation: https://github.com/x402/x402
- Facilitator API Docs: https://x402.org/docs
