# Clara System Architecture

## High-Level Overview

```mermaid
flowchart TB
    subgraph User["👤 User's Machine"]
        CC[Claude Code<br/>AI Agent]
        MCP[Clara MCP Server<br/>Node.js]
        Session[(~/.clara/<br/>session.enc)]
    end

    subgraph Cloud["☁️ Cloud Infrastructure"]
        Proxy[Clara Proxy<br/>Cloudflare Worker]
        KV[(KV Storage<br/>Usage Tracking)]
        Para[Para API<br/>MPC Signing]
    end

    subgraph Chain["⛓️ Base Mainnet"]
        Credits[ClaraCredits<br/>Contract]
        USDC[USDC<br/>Token]
        APIs[x402 APIs]
    end

    CC <-->|MCP Protocol| MCP
    MCP <-->|Read/Write| Session
    MCP <-->|HTTPS| Proxy
    Proxy <-->|Track Usage| KV
    Proxy <-->|Sign Requests| Para
    Proxy <-->|Check Credits| Credits
    MCP <-->|Pay & Fetch| APIs
    APIs <-->|Settle| USDC
    Credits <-->|Deposit/Spend| USDC

    style CC fill:#6366f1,color:#fff
    style MCP fill:#22c55e,color:#fff
    style Proxy fill:#f97316,color:#fff
    style Credits fill:#3b82f6,color:#fff
```

## Component Responsibilities

```mermaid
flowchart LR
    subgraph MCP["Clara MCP Server"]
        Tools[40+ Tools]
        Limits[Spending Limits]
        History[Payment History]
    end

    subgraph Proxy["Clara Proxy"]
        Auth[API Key Injection]
        Free[Free Tier Check]
        Credit[Credit Verification]
        Track[Usage Tracking]
    end

    subgraph Para["Para Wallet"]
        MPC[MPC Key Shards]
        Sign[Transaction Signing]
        Wallet[Wallet Management]
    end

    Tools --> Auth
    Auth --> Credit
    Credit --> Sign
    Sign --> Track

    style MCP fill:#22c55e,color:#fff
    style Proxy fill:#f97316,color:#fff
    style Para fill:#8b5cf6,color:#fff
```

## Data Flow: Sending a Transaction

```mermaid
sequenceDiagram
    participant U as User
    participant C as Claude Code
    participant M as Clara MCP
    participant P as Clara Proxy
    participant A as Para API
    participant R as Base RPC

    U->>C: "send 0.1 ETH to alice.eth"
    C->>M: wallet_send(to, amount)

    Note over M: Build transaction<br/>(nonce, gas, data)

    M->>P: POST /sign-raw<br/>X-Clara-Address: 0x...

    Note over P: Check free tier<br/>or on-chain credits

    P->>A: POST /sign-raw<br/>X-API-Key: [injected]
    A-->>P: signature
    P-->>M: signature

    Note over M: Assemble signed tx

    M->>R: eth_sendRawTransaction
    R-->>M: txHash
    M-->>C: Success + txHash
    C-->>U: "Sent! View on Basescan"
```

## Credit System Flow

```mermaid
flowchart TD
    subgraph Bootstrap["🆓 Bootstrap (New Users)"]
        New[New User] --> Free{Free Tier<br/>< 1000 ops?}
        Free -->|Yes| Allow1[Allow Signing]
        Free -->|No| Check
    end

    subgraph Paid["💰 Paid Tier"]
        Check{Has On-Chain<br/>Credits?}
        Check -->|Yes| Allow2[Allow Signing]
        Check -->|No| Block[402: Deposit Required]
    end

    subgraph Settlement["📊 Settlement"]
        Allow1 --> Track1[Track in KV<br/>free:address]
        Allow2 --> Track2[Track in KV<br/>usage:address]
        Track2 --> Cron[Hourly Cron]
        Cron --> Spend[Call spend() on contract]
    end

    style Bootstrap fill:#22c55e,color:#fff
    style Paid fill:#3b82f6,color:#fff
    style Settlement fill:#f97316,color:#fff
```

## Security Model

```mermaid
flowchart LR
    subgraph Local["🔒 Local (User Controls)"]
        Key[Encryption Key<br/>~/.clara/.key]
        Session[Session Data<br/>AES-256-GCM]
        Limits[Spending Limits]
    end

    subgraph Proxy["🛡️ Proxy (Rate Limits)"]
        API[Para API Key<br/>Secret]
        Credits[Credit Check]
        Usage[Usage Tracking]
    end

    subgraph Para["🔐 Para (MPC)"]
        Shard1[User Shard]
        Shard2[Para Shard]
        Neither[Neither party<br/>has full key]
    end

    Key --> Session
    Session --> Limits
    API --> Credits
    Shard1 --> Neither
    Shard2 --> Neither

    style Local fill:#22c55e,color:#fff
    style Proxy fill:#f97316,color:#fff
    style Para fill:#8b5cf6,color:#fff
```

## Tool Categories

```mermaid
mindmap
  root((Clara MCP))
    Session
      wallet_setup
      wallet_status
      wallet_logout
      wallet_dashboard
    Core Wallet
      wallet_balance
      wallet_send
      wallet_sign_message
      wallet_history
      wallet_simulate
    DeFi
      wallet_swap
      wallet_bridge
      wallet_earn
    x402 Payments
      wallet_pay_x402
      wallet_discover_x402
      wallet_browse_x402
    Controls
      wallet_spending_limits
      wallet_spending_history
    Clara Tokens
      wallet_cca_bid
      wallet_stake
      wallet_claim_dividends
```
