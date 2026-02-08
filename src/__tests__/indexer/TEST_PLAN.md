# Bounty Indexer Test Plan

Comprehensive test plan for the Clara embedded bounty indexer.
Each section maps to a source file, with every test case listed in vitest `describe`/`it` format.

---

## Project Setup Notes

- **Test runner**: vitest v4.0.18
- **Config**: `vitest.config.ts` includes `src/**/*.test.ts`
- **Module system**: ESM (`"type": "module"` in package.json, `NodeNext` module resolution)
- **tsconfig**: `src/__tests__` is excluded from compilation (vitest handles it directly)
- **Key dependency**: `viem ^2.0.0` (for `parseEventLogs`, `formatUnits`, `Hex` types)

### Mocking Strategy (Global)

All tests should mock external dependencies to ensure isolation:

1. **`fs` module** (`readFileSync`, `writeFileSync`, `mkdirSync`, `existsSync`) — mock via `vi.mock('fs')` for store.ts tests
2. **`os` module** (`homedir`) — mock to return a temp dir so tests never touch real `~/.clara/`
3. **`viem` getLogs / getBlockNumber** — mock the public client returned by `getClaraPublicClient()`
4. **`../config/clara-contracts.js`** — mock `getBountyContracts()`, `getClaraContracts()`, `getClaraPublicClient()`, and `FACTORY_DEPLOY_BLOCK`
5. **`./sync.js` (for queries)** — mock `getIndex()` to inject test index state
6. **`./store.js` (for sync)** — mock `loadIndex()` and `saveIndex()` to avoid disk I/O
7. **`process.env`** — use `vi.stubEnv()` for CLARA_NETWORK, CLARA_INDEXER_URL, CLARA_INDEXER_API_KEY

### Test File Layout

```
src/__tests__/indexer/
  types.test.ts        — STATUS_MAP completeness
  store.test.ts        — load/save/corrupt/network-switch/defaults
  queries.test.ts      — all query functions + filter combos
  sync.test.ts         — event parsing, chunking, polling, incremental sync
  work-helpers.test.ts — formatRawAmount, parseTaskURI, getTaskSummary, getTokenMeta, etc.
  work-browse.test.ts  — handleWorkBrowse integration with local indexer
  work-list.test.ts    — handleWorkList integration with local indexer
  contracts.test.ts    — FACTORY_DEPLOY_BLOCK per network, event ABI structure
```

---

## 1. types.test.ts — `describe('types')`

### `describe('STATUS_MAP')`

| # | Test (`it(...)`) | What it validates | Key assertions |
|---|---|---|---|
| 1 | `it('maps all 6 Solidity enum indices (0-5) to string statuses')` | Every index from the Bounty.Status enum has an entry | `Object.keys(STATUS_MAP).length === 6`; keys are `[0,1,2,3,4,5]` |
| 2 | `it('maps index 0 to open')` | First enum value | `STATUS_MAP[0] === 'open'` |
| 3 | `it('maps index 1 to claimed')` | | `STATUS_MAP[1] === 'claimed'` |
| 4 | `it('maps index 2 to submitted')` | | `STATUS_MAP[2] === 'submitted'` |
| 5 | `it('maps index 3 to approved')` | | `STATUS_MAP[3] === 'approved'` |
| 6 | `it('maps index 4 to expired')` | | `STATUS_MAP[4] === 'expired'` |
| 7 | `it('maps index 5 to cancelled')` | | `STATUS_MAP[5] === 'cancelled'` |
| 8 | `it('returns undefined for out-of-range indices')` | No unexpected entries beyond 0-5 | `STATUS_MAP[6] === undefined`; `STATUS_MAP[-1] === undefined` |
| 9 | `it('all values are valid BountyStatus strings')` | Type safety at runtime | Every value is one of `'open','claimed','submitted','approved','expired','cancelled'` |

**Mocking**: None needed — pure data.

---

## 2. store.test.ts — `describe('store')`

### Mocking Strategy

- Mock `fs` (`readFileSync`, `writeFileSync`, `mkdirSync`, `existsSync`)
- Mock `os.homedir()` → `/mock/home`
- Mock `../config/clara-contracts.js`:
  - `getBountyContracts()` → `{ bountyFactory: '0xFactoryAddr' }`
  - `getClaraContracts()` → `{ chainId: 84532 }`
  - `FACTORY_DEPLOY_BLOCK` → `37897669n`

### `describe('loadIndex')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 1 | `it('creates .clara dir if missing')` | `ensureDir()` calls `mkdirSync` with recursive | `mkdirSync` called with `'/mock/home/.clara'` and `{ recursive: true }` |
| 2 | `it('returns default index when file does not exist')` | Fresh start behavior | `existsSync` returns false → result has `lastBlock === 37897669`, `factoryAddress === '0xfactoryaddr'`, `chainId === 84532`, `bounties === {}` |
| 3 | `it('loads valid index from disk')` | Happy path persistence | `readFileSync` returns valid JSON → result matches stored data |
| 4 | `it('returns default index when JSON is corrupt')` | Fail-safe on malformed file | `readFileSync` returns `'{broken'` → result is default index |
| 5 | `it('returns default index when factory address changed (network switch)')` | Detects testnet→mainnet switch | Stored JSON has `factoryAddress: '0xOLD'` but `getBountyContracts()` returns `'0xFactoryAddr'` → resets to default |
| 6 | `it('fills in missing lastBlock with FACTORY_DEPLOY_BLOCK')` | Handles partial/legacy index files | Stored JSON has `lastBlock: undefined` → result.lastBlock === `37897669` |
| 7 | `it('fills in missing bounties with empty object')` | Handles partial index | Stored JSON has `bounties: undefined` → `result.bounties` is `{}` |
| 8 | `it('preserves existing bounties on load')` | Doesn't lose data | Stored JSON has 2 bounties → result has both bounties intact |

### `describe('saveIndex')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 9 | `it('creates .clara dir before writing')` | `ensureDir()` called | `mkdirSync` called before `writeFileSync` |
| 10 | `it('writes JSON with 2-space indentation')` | Human-readable output | `writeFileSync` called with `JSON.stringify(index, null, 2)` |
| 11 | `it('writes to ~/.clara/bounties.json')` | Correct file path | `writeFileSync` first arg is `'/mock/home/.clara/bounties.json'` |

---

## 3. queries.test.ts — `describe('queries')`

### Mocking Strategy

- Mock `./sync.js` → `getIndex()` returns a test `BountyIndex` with controlled bounties
- Create test fixtures: a mix of open/claimed/submitted/approved/expired/cancelled bounties with varied skills, amounts, deadlines

### Test Fixtures

```typescript
// 6 bounties, one per status, diverse skills and amounts
const FIXTURES: Record<string, BountyRecord> = {
  '0xopen1':     { status: 'open', skillTags: ['solidity', 'defi'], amount: '1000000000000000000', deadline: future+3d, ... },
  '0xopen2':     { status: 'open', skillTags: ['typescript'],       amount: '5000000000000000000', deadline: future+1d, ... },
  '0xclaimed':   { status: 'claimed', claimer: '0xclaimer1', ... },
  '0xsubmitted': { status: 'submitted', claimer: '0xclaimer1', proofURI: '...', ... },
  '0xapproved':  { status: 'approved', ... },
  '0xexpired':   { status: 'expired', ... },
};
```

### `describe('getOpenBounties')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 1 | `it('returns open bounties by default when no filters given')` | Default status filter | Result contains only status === 'open' bounties |
| 2 | `it('filters by explicit status')` | `{ status: 'claimed' }` | Returns only 'claimed' bounties |
| 3 | `it('filters by skill (case-insensitive partial match)')` | `{ skill: 'SOLID' }` | Returns bounties where any skillTag includes 'solid' |
| 4 | `it('filters by minAmount')` | `{ minAmount: 2000000000000000000 }` | Only bounties with `BigInt(amount) >= min` |
| 5 | `it('filters by maxAmount')` | `{ maxAmount: 2000000000000000000 }` | Only bounties with `BigInt(amount) <= max` |
| 6 | `it('combines skill + minAmount + maxAmount filters')` | Multiple simultaneous filters | Intersection of all filter criteria |
| 7 | `it('sorts by deadline ascending (soonest first)')` | Sort order | First result has smallest deadline |
| 8 | `it('respects limit parameter')` | `{ limit: 1 }` | Returns at most 1 result |
| 9 | `it('defaults limit to 50')` | Default limit | With 60 open bounties, returns 50 |
| 10 | `it('returns empty array when no bounties match')` | Empty result | `{ skill: 'nonexistent' }` → `[]` |
| 11 | `it('returns empty array when index is null (not initialized)')` | Pre-init state | `getIndex()` returns `null` → `[]` |

### `describe('getBountyByAddress')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 12 | `it('returns bounty by exact lowercase address')` | Direct lookup | `getBountyByAddress('0xopen1')` returns the record |
| 13 | `it('normalizes address to lowercase before lookup')` | Case-insensitive | `getBountyByAddress('0xOPEN1')` still finds it |
| 14 | `it('returns null for unknown address')` | Miss | `getBountyByAddress('0xunknown')` → `null` |
| 15 | `it('returns null when index is null')` | Pre-init | `null` |

### `describe('getBountiesByPoster')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 16 | `it('returns all bounties posted by the given address')` | Filter by poster | All results have `poster === addr` |
| 17 | `it('normalizes poster address to lowercase')` | Case-insensitive | Works with mixed-case input |
| 18 | `it('returns empty array for unknown poster')` | Miss | `[]` |

### `describe('getBountiesByClaimer')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 19 | `it('returns bounties claimed by the given address')` | Filter by claimer | All results have `claimer === addr` |
| 20 | `it('returns empty array when no bounties have been claimed')` | No claimers | `[]` |
| 21 | `it('normalizes claimer address')` | Case-insensitive | Works with mixed-case |

### `describe('getIndexStats')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 22 | `it('returns correct counts for each status')` | Aggregation | `openCount === 2`, `claimedCount === 1`, etc. |
| 23 | `it('returns totalBounties as sum of all')` | Total | `totalBounties === 6` |
| 24 | `it('returns lastSyncedBlock from index')` | Block checkpoint | Matches `index.lastBlock` |
| 25 | `it('returns zero counts when index is null')` | Pre-init | All counts 0, lastSyncedBlock 0 |
| 26 | `it('returns zero counts when bounties is empty')` | Fresh index | All counts 0 |

---

## 4. sync.test.ts — `describe('sync')`

### Mocking Strategy

- Mock `../config/clara-contracts.js`:
  - `getClaraPublicClient()` → mock client with `getLogs()` and `getBlockNumber()`
  - `getBountyContracts()` → `{ bountyFactory: '0xFactory' }`
  - `BOUNTY_FACTORY_EVENTS` and `BOUNTY_EVENTS` → use the real ABI arrays (imported)
  - `FACTORY_DEPLOY_BLOCK` → `100n`
- Mock `./store.js`:
  - `loadIndex()` → returns test index state
  - `saveIndex()` → spy to capture saved state
- Reset module-level `index` variable between tests (use `vi.resetModules()` or re-import)

### `describe('getIndex')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 1 | `it('returns null before initialization')` | Pre-sync state | `getIndex() === null` |
| 2 | `it('returns the in-memory index after syncFromChain')` | Post-sync | `getIndex()` matches the loaded/updated index |

### `describe('syncFromChain')`

#### Event Parsing

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 3 | `it('creates BountyRecord from BountyCreated event')` | Factory event → new record | Record has correct `bountyAddress`, `poster`, `token`, `amount`, `deadline`, `taskURI`, `skillTags`, `status === 'open'`, `createdBlock`, `createdTxHash` |
| 4 | `it('lowercases bountyAddress, poster, and token')` | Address normalization | All stored addresses are lowercase regardless of input casing |
| 5 | `it('converts bigint amount to string')` | Serialization | `record.amount === '1000000000000000000'` (not BigInt) |
| 6 | `it('converts bigint deadline to number')` | Serialization | `record.deadline` is a JS number |
| 7 | `it('copies skillTags as mutable array')` | Spread readonly → mutable | `Array.isArray(record.skillTags)` and modifiable |
| 8 | `it('does not overwrite existing bounty on duplicate BountyCreated')` | Idempotency | If address already in index, original record preserved |

#### Lifecycle Events

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 9 | `it('applies BountyClaimed → sets status, claimer, claimerAgentId')` | Claim event | `status === 'claimed'`, `claimer` is lowercase, `claimerAgentId` is number |
| 10 | `it('applies WorkSubmitted → sets status, proofURI')` | Submit event | `status === 'submitted'`, `proofURI` is string |
| 11 | `it('applies BountyApproved → sets status to approved')` | Approve event | `status === 'approved'` |
| 12 | `it('applies BountyExpired → sets status to expired')` | Expire event | `status === 'expired'` |
| 13 | `it('applies BountyCancelled → sets status to cancelled')` | Cancel event | `status === 'cancelled'` |
| 14 | `it('sets updatedBlock on all lifecycle events')` | Block tracking | `record.updatedBlock === blockNumber` |
| 15 | `it('ignores lifecycle events for unknown bounty addresses')` | Safety check | No crash, no new record created |

#### Chunking & Incremental Sync

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 16 | `it('skips sync when fromBlock > latestBlock (already up to date)')` | No-op early return | `getLogs` never called, `saveIndex` never called |
| 17 | `it('fetches single chunk when range <= MAX_BLOCK_RANGE')` | Small range | `getLogs` called once with `fromBlock`/`toBlock` |
| 18 | `it('splits into multiple chunks when range > MAX_BLOCK_RANGE')` | Large range | `getLogs` called `ceil(range / 10000)` times with correct `fromBlock`/`toBlock` per chunk |
| 19 | `it('checkpoints lastBlock after each chunk')` | Progress saving | After processing, `index.lastBlock` equals `chunkEnd` for each chunk |
| 20 | `it('saves index to disk after full sync')` | Persistence | `saveIndex` called once at end with updated index |
| 21 | `it('loads index from store on first call')` | Lazy initialization | `loadIndex()` called on first `syncFromChain()`, not on subsequent calls |
| 22 | `it('uses lastBlock + 1 as fromBlock for incremental sync')` | No overlap | If `index.lastBlock === 100`, `fromBlock === 101n` |
| 23 | `it('only fetches lifecycle logs when bounties exist')` | Optimization | When `index.bounties` is empty, second `getLogs` call is skipped |

#### Edge Cases

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 24 | `it('handles empty getLogs response (no events in range)')` | Empty blocks | Index unchanged except lastBlock |
| 25 | `it('handles mixed creation + lifecycle events in same chunk')` | Multi-event chunk | Both new records created and existing records updated |
| 26 | `it('handles null transactionHash in log')` | Missing tx hash | `createdTxHash === ''` (fallback) |

### `describe('startPolling / stopPolling')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 27 | `it('starts interval that calls syncFromChain periodically')` | Polling setup | `setInterval` called with correct interval; `syncFromChain` called on tick |
| 28 | `it('does not start duplicate polling if already running')` | Idempotency | Calling `startPolling` twice → only one `setInterval` |
| 29 | `it('stopPolling clears the interval')` | Cleanup | `clearInterval` called; subsequent ticks don't fire |
| 30 | `it('swallows sync errors during polling without crashing')` | Error resilience | If `syncFromChain` throws, polling continues; error logged to console.error |

**Mocking for polling**: Use `vi.useFakeTimers()` to control `setInterval`/`clearInterval` and `vi.advanceTimersByTime()`.

---

## 5. work-helpers.test.ts — `describe('work-helpers')`

### Mocking Strategy

- Mock `fs` for `getLocalAgentId`/`saveLocalAgentId` tests
- Mock `os.homedir()` for file path tests
- No mocking needed for pure formatting functions

### `describe('getIndexerUrl')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 1 | `it('returns CLARA_INDEXER_URL from env')` | Env override | `process.env.CLARA_INDEXER_URL = 'http://custom:9999'` → returns it |
| 2 | `it('defaults to http://localhost:8787')` | Default | No env set → `'http://localhost:8787'` |

### `describe('indexerFetch')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 3 | `it('prepends base URL to path')` | URL construction | `fetch` called with `'http://localhost:8787/api/bounties'` |
| 4 | `it('sets Content-Type header')` | Default headers | `headers['Content-Type'] === 'application/json'` |
| 5 | `it('adds Authorization header when CLARA_INDEXER_API_KEY is set')` | API key injection | `headers['Authorization'] === 'Bearer test-key'` |
| 6 | `it('omits Authorization header when no API key')` | No key | `Authorization` not in headers |

**Mocking**: Mock global `fetch` via `vi.stubGlobal('fetch', vi.fn())`.

### `describe('getLocalAgentId / saveLocalAgentId')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 7 | `it('returns null when agent.json does not exist')` | First run | `readFileSync` throws → `null` |
| 8 | `it('returns agentId from valid agent.json')` | Stored agent | `readFileSync` returns `{ agentId: 42, name: 'test', registeredAt: '...' }` → `42` |
| 9 | `it('returns null when agent.json is corrupt')` | Bad JSON | `readFileSync` returns `'{'` → `null` |
| 10 | `it('saveLocalAgentId creates dir and writes file')` | Save path | `mkdirSync` and `writeFileSync` called with correct args |

### `describe('toDataUri')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 11 | `it('encodes JSON object to base64 data URI')` | Encoding | Result starts with `'data:application/json;base64,'` |
| 12 | `it('round-trips through parseTaskURI')` | Roundtrip integrity | `parseTaskURI(toDataUri(obj))` deep-equals `obj` |

### `describe('formatAddress')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 13 | `it('truncates standard 42-char address to 0x1234...5678')` | Normal case | `formatAddress('0x1234567890abcdef1234567890abcdef12345678')` → `'0x1234...5678'` |
| 14 | `it('returns short strings unchanged')` | Edge case | `formatAddress('0x12')` → `'0x12'` |
| 15 | `it('returns empty string unchanged')` | Edge case | `formatAddress('')` → `''` |

### `describe('formatDeadline')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 16 | `it('returns "expired" for past timestamps')` | Expired | timestamp < now → `'expired'` |
| 17 | `it('returns days and hours for multi-day deadlines')` | Days format | `'2d 5h'` style |
| 18 | `it('returns hours only when < 1 day')` | Hours format | `'5h'` style |
| 19 | `it('returns minutes when < 1 hour')` | Minutes format | `'30m'` style |

**Mocking**: Use `vi.useFakeTimers()` with `vi.setSystemTime()` to control `Date.now()`.

### `describe('parseDeadline')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 20 | `it('parses ISO date string')` | `'2025-03-01'` | Returns Unix timestamp in seconds |
| 21 | `it('parses "3 days" relative')` | Relative days | `now + 3 * 86400` |
| 22 | `it('parses "24 hours" relative')` | Relative hours | `now + 24 * 3600` |
| 23 | `it('parses "1 week" relative')` | Relative weeks | `now + 604800` |
| 24 | `it('parses "30 min" relative')` | Relative minutes | `now + 30 * 60` |
| 25 | `it('accepts variant unit names: d, h, w, m')` | Short units | All single-letter variants work |
| 26 | `it('throws on invalid format')` | Error case | `'next tuesday'` → throws with descriptive message |

### `describe('formatAmount')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 27 | `it('formats stablecoins with 2 decimal places')` | USDC, USDT, DAI | `formatAmount('100.5', 'USDC')` → `'100.50 USDC'` |
| 28 | `it('formats other tokens with 4 decimal places')` | Non-stable | `formatAmount('1.23456', 'ETH')` → `'1.2346 ETH'` |
| 29 | `it('handles NaN amount gracefully')` | Invalid input | `formatAmount('abc', 'TOKEN')` → `'abc TOKEN'` |

### `describe('getTokenMeta')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 30 | `it('returns CLARA meta for known CLARA token address')` | Known token | `{ symbol: 'CLARA', decimals: 18 }` |
| 31 | `it('normalizes address to lowercase for lookup')` | Case-insensitive | Mixed-case input still matches |
| 32 | `it('returns fallback { symbol: TOKEN, decimals: 18 } for unknown address')` | Unknown | Default fallback |

### `describe('formatRawAmount')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 33 | `it('converts raw bigint string to formatted amount with symbol')` | Full pipeline | `formatRawAmount('1000000000000000000', claraAddr)` → `'1.0000 CLARA'` |
| 34 | `it('uses token decimals from getTokenMeta')` | Decimal handling | 18 decimals for CLARA, 18 default for unknown |
| 35 | `it('handles zero amount')` | Edge case | `formatRawAmount('0', addr)` → `'0.0000 TOKEN'` |

### `describe('parseTaskURI')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 36 | `it('parses data:application/json;base64,... URI')` | Base64 data URI | Returns parsed JSON object |
| 37 | `it('parses plain JSON string')` | Fallback | `parseTaskURI('{"title":"test"}')` → `{ title: 'test' }` |
| 38 | `it('returns null for invalid base64')` | Error handling | `parseTaskURI('data:application/json;base64,!!!')` → `null` |
| 39 | `it('returns null for non-JSON string')` | Error handling | `parseTaskURI('just text')` → `null` |
| 40 | `it('returns null for empty string')` | Edge case | `null` |

### `describe('getTaskSummary')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 41 | `it('returns title field when present')` | Primary field | `{ title: 'My Task' }` → `'My Task'` |
| 42 | `it('returns summary field when no title')` | Fallback 1 | `{ summary: 'Do this' }` → `'Do this'` |
| 43 | `it('returns truncated description (100 chars) when no title or summary')` | Fallback 2 | Long description → first 100 chars |
| 44 | `it('returns "(no title)" when data has none of the fields')` | Last resort | `{}` → `'(no title)'` |
| 45 | `it('returns "(unable to parse task)" for unparseable URI')` | Parse failure | Invalid URI → error message |

---

## 6. work-browse.test.ts — `describe('handleWorkBrowse')`

### Mocking Strategy

- Mock `../indexer/index.js` → `getOpenBounties` to return controlled data
- Mock `./work-helpers.js` → `formatAddress`, `formatDeadline`, `formatRawAmount`, `getTaskSummary` (or use real implementations with controlled inputs)

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 1 | `it('returns formatted bounty list for default open status')` | Happy path | Content text includes status header, amount, deadline, skills, contract address |
| 2 | `it('passes all filter args to getOpenBounties')` | Arg forwarding | `getOpenBounties` called with `{ status: 'claimed', skill: 'rust', minAmount: 5, maxAmount: 100, limit: 3 }` |
| 3 | `it('defaults status to "open" and limit to 10')` | Defaults | When no args, `getOpenBounties` called with `status: 'open'`, `limit: 10` |
| 4 | `it('returns "no bounties found" message when list is empty')` | Empty state | Content includes "No open bounties found" and "Create one with `work_post`" |
| 5 | `it('includes skill filter in "no bounties" message')` | Context in empty | `{ skill: 'rust' }` → message includes `matching skill "rust"` |
| 6 | `it('formats each bounty with separator, amount, deadline, skills, poster, contract')` | Output structure | Each bounty block has `---`, bold amount, deadline, skills line, poster, contract |
| 7 | `it('shows "any" when bounty has no skillTags')` | Empty skills | `skillTags: []` → `Skills: any` |
| 8 | `it('returns error result on exception')` | Error handling | `getOpenBounties` throws → `isError: true`, message includes error text |
| 9 | `it('includes CTA to work_claim at the end')` | Call-to-action | Last line includes `work_claim bountyAddress="0x..."` |

---

## 7. work-list.test.ts — `describe('handleWorkList')`

### Mocking Strategy

- Mock `../indexer/index.js` → `getBountiesByPoster`, `getBountiesByClaimer`
- Create a mock `ToolContext` with `walletAddress`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 1 | `it('returns bounties posted by wallet when role=poster')` | Poster filter | `getBountiesByPoster` called with `ctx.walletAddress`; `getBountiesByClaimer` NOT called |
| 2 | `it('returns bounties claimed by wallet when role=claimer')` | Claimer filter | `getBountiesByClaimer` called; `getBountiesByPoster` NOT called |
| 3 | `it('returns both posted and claimed when role=all')` | Combined | Both functions called |
| 4 | `it('defaults role to "all"')` | Default | No `role` arg → both called |
| 5 | `it('deduplicates when same address is both poster and claimer')` | Dedup | Address is poster AND claimer of same bounty → appears once |
| 6 | `it('groups results by status')` | Grouping | Output has `### Open (N)`, `### Claimed (N)` sections |
| 7 | `it('labels bounties as "Posted" or "Claimed" based on role')` | Role label | Bounty where `poster === walletAddress` shows "Posted"; where `claimer === walletAddress` shows "Claimed" |
| 8 | `it('returns "no bounties found" when both queries return empty')` | Empty state | Message includes role and suggests `work_post` and `work_browse` |
| 9 | `it('returns error result on exception')` | Error handling | `isError: true` |

---

## 8. contracts.test.ts — `describe('clara-contracts')`

### Mocking Strategy

- Use `vi.stubEnv('CLARA_NETWORK', ...)` to toggle testnet/mainnet

### `describe('FACTORY_DEPLOY_BLOCK')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 1 | `it('is 37897669n for testnet')` | Testnet deploy block | Set `CLARA_NETWORK=testnet`, re-import → `FACTORY_DEPLOY_BLOCK === 37897669n` |
| 2 | `it('is 41844986n for mainnet')` | Mainnet deploy block | Set `CLARA_NETWORK=mainnet`, re-import → `FACTORY_DEPLOY_BLOCK === 41844986n` |

### `describe('BOUNTY_FACTORY_EVENTS')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 3 | `it('has exactly 1 event: BountyCreated')` | ABI structure | `BOUNTY_FACTORY_EVENTS.length === 1`; `[0].name === 'BountyCreated'` |
| 4 | `it('BountyCreated has 7 inputs with correct names and types')` | Field structure | Inputs: `bountyAddress(address,indexed)`, `poster(address,indexed)`, `token(address)`, `amount(uint256)`, `deadline(uint256)`, `taskURI(string)`, `skillTags(string[])` |

### `describe('BOUNTY_EVENTS')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 5 | `it('has exactly 5 lifecycle events')` | ABI structure | `BOUNTY_EVENTS.length === 5` |
| 6 | `it('includes BountyClaimed with claimer(indexed) and agentId')` | Event shape | Correct inputs |
| 7 | `it('includes WorkSubmitted with claimer(indexed) and proofURI')` | Event shape | Correct inputs |
| 8 | `it('includes BountyApproved with claimer(indexed) and amount')` | Event shape | Correct inputs |
| 9 | `it('includes BountyExpired with poster(indexed) and amount')` | Event shape | Correct inputs |
| 10 | `it('includes BountyCancelled with poster(indexed) and amount')` | Event shape | Correct inputs |

### `describe('getBountyContracts')`

| # | Test | What it validates | Key assertions |
|---|---|---|---|
| 11 | `it('returns testnet addresses when CLARA_NETWORK=testnet')` | Testnet config | `bountyFactory === '0xfe92C74A3c1d81fE2927f0Bfd116D956dee6bCA7'` |
| 12 | `it('returns mainnet addresses when CLARA_NETWORK=mainnet')` | Mainnet config | `bountyFactory === '0x4fDd9E7014959503B91e4C21c0B25f1955413C75'` |
| 13 | `it('defaults to mainnet when CLARA_NETWORK is unset')` | Default behavior | No env → mainnet addresses |

---

## Summary

| File | Test Count | Priority |
|------|-----------|----------|
| types.test.ts | 9 | Low (pure data, quick win) |
| store.test.ts | 11 | High (persistence correctness) |
| queries.test.ts | 26 | High (query logic, filter combos) |
| sync.test.ts | 30 | Critical (event parsing, chunking) |
| work-helpers.test.ts | 45 | Medium (formatting, parsing utils) |
| work-browse.test.ts | 9 | Medium (tool output formatting) |
| work-list.test.ts | 9 | Medium (tool output formatting) |
| contracts.test.ts | 13 | Low (config validation) |
| **Total** | **152** | |

### Implementation Order (recommended for test writers)

1. **types.test.ts** — Zero mocking, builds confidence in foundation
2. **contracts.test.ts** — Low mocking, validates config constants
3. **work-helpers.test.ts** — Pure functions first, then fs-dependent ones
4. **store.test.ts** — Mocked fs, tests persistence layer
5. **queries.test.ts** — Mocked getIndex, tests all query logic
6. **sync.test.ts** — Most complex mocking (viem client, timers, module state)
7. **work-browse.test.ts** — Integration with indexer queries
8. **work-list.test.ts** — Integration with indexer queries + ToolContext
