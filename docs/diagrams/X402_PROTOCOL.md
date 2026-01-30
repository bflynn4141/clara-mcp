# x402 Protocol Architecture

## What is x402?

**x402** implements the HTTP 402 "Payment Required" status code for micropayments. It enables pay-per-request APIs without accounts, subscriptions, or API keys.

## Protocol Flow

```mermaid
sequenceDiagram
    participant C as Client (Clara)
    participant A as API Provider
    participant F as Facilitator
    participant B as Blockchain

    C->>A: 1. GET /api/premium-data
    A-->>C: 2. 402 Payment Required<br/>X-Payment-Request: {amount, token, recipient}

    Note over C: 3. Parse payment details<br/>Check spending limits<br/>Sign EIP-712 authorization

    C->>A: 4. GET /api/premium-data<br/>X-Payment: [signed authorization]

    Note over A: 5. Verify signature

    A->>F: 6. Submit for settlement
    F->>B: 7. Execute on-chain transfer
    B-->>F: 8. Confirmed
    F-->>A: 9. Settlement confirmed

    A-->>C: 10. 200 OK + premium content
```

## Payment Header Format

```mermaid
flowchart LR
    subgraph Request["Initial Request"]
        R1[GET /api/data]
    end

    subgraph Response402["402 Response"]
        H1[X-Payment-Request]
        H2[amount: 1000]
        H3[token: USDC]
        H4[recipient: 0x...]
        H5[chainId: 8453]
        H6[deadline: timestamp]
    end

    subgraph Retry["Retry with Payment"]
        R2[GET /api/data]
        P1[X-Payment: base64]
    end

    Request --> Response402
    Response402 --> Retry

    style Request fill:#ef4444,color:#fff
    style Response402 fill:#f97316,color:#fff
    style Retry fill:#22c55e,color:#fff
```

## EIP-712 Typed Data Structure

```mermaid
flowchart TB
    subgraph Domain["Domain Separator"]
        D1[name: x402]
        D2[version: 1]
        D3[chainId: 8453]
        D4[verifyingContract: 0x...]
    end

    subgraph Types["Type Definitions"]
        T1["Payment: [<br/>  payer: address,<br/>  recipient: address,<br/>  amount: uint256,<br/>  token: address,<br/>  nonce: uint256,<br/>  deadline: uint256<br/>]"]
    end

    subgraph Message["Message"]
        M1[payer: 0x8744...]
        M2[recipient: 0xabc...]
        M3[amount: 1000]
        M4[token: USDC]
        M5[nonce: 42]
        M6[deadline: 1706745600]
    end

    Domain --> Hash[EIP-712 Hash]
    Types --> Hash
    Message --> Hash
    Hash --> Signature[ECDSA Signature]

    style Domain fill:#3b82f6,color:#fff
    style Types fill:#8b5cf6,color:#fff
    style Message fill:#22c55e,color:#fff
```

## Discovery Protocol

```mermaid
flowchart LR
    subgraph Discovery["/.well-known/x402"]
        V[version: 1.0]
        S[supported: true]
        Ch[chains: 8453, 1]
        T[tokens: USDC, ETH]
        E[endpoints: /api/*]
        P[pricing: $0.001/req]
    end

    subgraph DNS["_x402.domain.com TXT"]
        TXT["v=x402; url=..."]
    end

    Client[Clara] -->|Check| Discovery
    Client -->|Fallback| DNS

    style Discovery fill:#22c55e,color:#fff
    style DNS fill:#f97316,color:#fff
```

## Settlement Models

```mermaid
flowchart TB
    subgraph Immediate["⚡ Immediate Settlement"]
        I1[Client signs] --> I2[Provider submits tx]
        I2 --> I3[On-chain transfer]
        I3 --> I4[Content delivered]
        I5[Latency: 2-5 seconds]
    end

    subgraph Facilitated["🚀 Facilitated Settlement"]
        F1[Client signs] --> F2[Provider caches sig]
        F2 --> F3[Content delivered]
        F3 --> F4[Batch settlement later]
        F5[Latency: Instant content]
    end

    subgraph PreAuth["💳 Pre-authorized"]
        P1[Client deposits to facilitator]
        P1 --> P2[Instant micropayments]
        P2 --> P3[Off-chain accounting]
        P4[Latency: Instant]
    end

    style Immediate fill:#ef4444,color:#fff
    style Facilitated fill:#f97316,color:#fff
    style PreAuth fill:#22c55e,color:#fff
```

## Clara's x402 Implementation

```mermaid
flowchart TD
    subgraph Tools["Clara x402 Tools"]
        Pay[wallet_pay_x402<br/>Pay for 402-gated content]
        Discover[wallet_discover_x402<br/>Check domain support]
        Browse[wallet_browse_x402<br/>Browse ecosystem]
    end

    subgraph Flow["Payment Flow"]
        F1[Detect 402 response]
        F2[Parse X-Payment-Request]
        F3[Check spending limits]
        F4{Amount OK?}
        F5[Sign EIP-712]
        F6[Retry with X-Payment]
        F7[Return content]
        F8[Record spending]
        F9[Require approval]
    end

    Pay --> F1
    F1 --> F2
    F2 --> F3
    F3 --> F4
    F4 -->|Yes| F5
    F4 -->|No/Large| F9
    F5 --> F6
    F6 --> F7
    F7 --> F8

    style Tools fill:#22c55e,color:#fff
    style Flow fill:#3b82f6,color:#fff
```

## Security Features

```mermaid
flowchart LR
    subgraph Replay["🔄 Replay Protection"]
        N[Unique nonce per payment]
        D[Deadline limits validity]
        Ch[ChainId in domain]
    end

    subgraph Limits["💰 Spending Limits"]
        L1[Per-request: $1.00]
        L2[Per-day: $10.00]
        L3[Approval threshold: $0.50]
    end

    subgraph Verify["✅ Verification"]
        V1[Provider verifies signature]
        V2[Facilitator verifies again]
        V3[On-chain for disputes]
    end

    Replay --> Safe[Safe Payments]
    Limits --> Safe
    Verify --> Safe

    style Replay fill:#22c55e,color:#fff
    style Limits fill:#f97316,color:#fff
    style Verify fill:#3b82f6,color:#fff
```

## Benefits

```mermaid
flowchart TB
    subgraph Providers["For API Providers"]
        P1[No API keys to manage]
        P2[Per-request monetization]
        P3[Instant global payments]
        P4[No chargebacks]
        P5[No billing infrastructure]
    end

    subgraph Clients["For Clients"]
        C1[No accounts to create]
        C2[Pay only for usage]
        C3[No credit cards]
        C4[Programmable spending]
        C5[Works with AI agents]
    end

    Providers --> Win[Win-Win]
    Clients --> Win

    style Providers fill:#22c55e,color:#fff
    style Clients fill:#3b82f6,color:#fff
    style Win fill:#f97316,color:#fff
```

## Full System Context

```mermaid
flowchart TB
    subgraph User["User"]
        Agent[AI Agent<br/>Claude Code]
    end

    subgraph Clara["Clara"]
        MCP[Clara MCP]
        Proxy[Clara Proxy]
        Para[Para Wallet]
    end

    subgraph x402["x402 Ecosystem"]
        APIs[x402 APIs]
        Facilitator[x402.org<br/>Facilitator]
    end

    subgraph Chain["Base Mainnet"]
        USDC[USDC]
        Contract[Facilitator<br/>Contract]
    end

    Agent <--> MCP
    MCP <--> Proxy
    Proxy <--> Para
    MCP <--> APIs
    APIs <--> Facilitator
    Facilitator <--> Contract
    Contract <--> USDC

    style User fill:#6366f1,color:#fff
    style Clara fill:#22c55e,color:#fff
    style x402 fill:#f97316,color:#fff
    style Chain fill:#3b82f6,color:#fff
```
