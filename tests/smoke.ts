#!/usr/bin/env npx tsx
/**
 * Clara MCP Smoke Test
 *
 * Tests all 45+ tools for basic functionality.
 * Safe to run with a real wallet - only uses read-only operations
 * or quote-only modes for transaction tools.
 *
 * Run: npx tsx tests/smoke.ts
 */

import { spawn, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

// Config
const SESSION_PATH = process.env.CLARA_SESSION_PATH ?? join(homedir(), ".clara", "session.enc");
const SERVER_CMD = process.env.CLARA_SERVER_CMD ?? "node";
const SERVER_ARGS = process.env.CLARA_SERVER_ARGS?.split(" ").filter(Boolean) ?? ["dist/index.js"];
const TIMEOUT_MS = 15000;
const WALLET_ADDRESS = "0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd";

// Colors for output
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function log(status: "PASS" | "FAIL" | "SKIP", tool: string, detail?: string, ms?: number) {
  const color = status === "PASS" ? GREEN : status === "FAIL" ? RED : YELLOW;
  const timing = ms != null ? ` ${DIM}${ms}ms${RESET}` : "";
  const suffix = detail ? ` (${detail})` : "";
  console.log(`${color}${status}${RESET}: ${tool}${suffix}${timing}`);
}

function fail(msg: string): never {
  console.error(`\n${RED}FATAL: ${msg}${RESET}`);
  process.exit(1);
}

// ─── Tool Catalog ───────────────────────────────────────────────
// Every tool registered in the server must appear here.
// Categories: readOnly, readOnlyAuth, slow, quoteOnly, simulation, skipped

const HERD = process.env.HERD_ENABLED === "true";
const ZERION = !!process.env.ZERION_API_KEY;

interface TestDef { name: string; args: Record<string, any> }
interface SkipDef { name: string; reason: string }

const TOOLS: {
  readOnly: TestDef[];
  readOnlyAuth: TestDef[];
  slow: TestDef[];
  quoteOnly: TestDef[];
  simulation: TestDef[];
  skipped: SkipDef[];
} = {
  // ─── No auth required, fast ───
  readOnly: [
    { name: "wallet_status", args: {} },
    { name: "wallet_spending_limits", args: { action: "view" } },
    { name: "wallet_opportunities", args: { asset: "USDC" } },
    { name: "wallet_ens_check", args: { name: "vitalik" } },
    { name: "wallet_lookup_name", args: { address: WALLET_ADDRESS } },
    // Marketplace read-only (no auth)
    { name: "work_browse", args: {} },
    { name: "work_find", args: {} },
    { name: "work_profile", args: { address: WALLET_ADDRESS } },
    { name: "work_reputation", args: { address: WALLET_ADDRESS } },
    { name: "challenge_browse", args: {} },
    // Conditional on env
    ...(HERD ? [{ name: "wallet_analyze_contract", args: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" } }] : []),
    ...(ZERION ? [{ name: "wallet_history", args: { days: 7 } }] : []),
  ],

  // ─── Auth required but read-only (safe) ───
  readOnlyAuth: [
    { name: "wallet_approvals", args: { chain: "base" } },
    { name: "wallet_inbox", args: {} },
    { name: "wallet_thread", args: { with: WALLET_ADDRESS } },
    { name: "work_list", args: {} },
  ],

  // ─── Slow tools (30s timeout) ───
  slow: [
    { name: "wallet_dashboard", args: {} },
  ],

  // ─── Quote/simulate only (safe — no real tx) ───
  quoteOnly: [
    { name: "wallet_swap", args: { fromToken: "ETH", toToken: "USDC", amount: "0.001", chain: "base", action: "quote" } },
  ],

  // ─── Simulation tools (read contract, no tx) ───
  simulation: [
    // wallet_call needs Herd for ABI fetch, or inline ABI
    ...(HERD ? [{ name: "wallet_call", args: {
      contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      function: "totalSupply",
      chain: "base",
    } }] : []),
  ],

  // ─── Skipped — would move funds, require specific state, or mutate chain ───
  skipped: [
    // Session management
    { name: "wallet_setup", reason: "tested separately on first run" },
    { name: "wallet_logout", reason: "would destroy session" },
    // Transactions (spend funds)
    { name: "wallet_send", reason: "sends real funds" },
    { name: "wallet_pay_x402", reason: "spends funds via x402" },
    { name: "wallet_claim_airdrop", reason: "would claim airdrop" },
    { name: "wallet_executePrepared", reason: "needs preparedTxId from wallet_call" },
    // Signing
    { name: "wallet_sign_message", reason: "signs with wallet key" },
    { name: "wallet_sign_typed_data", reason: "signs typed data with wallet key" },
    // ENS write ops
    { name: "wallet_register_ens", reason: "would register ENS (costs ETH)" },
    { name: "wallet_register_name", reason: "would register on-chain name" },
    // Gas sponsorship
    { name: "wallet_sponsor_gas", reason: "would request gas from faucet" },
    // Messaging write
    { name: "wallet_message", reason: "sends a message to another address" },
    // Bounty write ops
    { name: "work_register", reason: "registers agent on-chain (costs gas)" },
    { name: "work_post", reason: "posts bounty (locks USDC in escrow)" },
    { name: "work_claim", reason: "claims bounty (requires open bounty)" },
    { name: "work_approve_bond", reason: "approves token for bond" },
    { name: "work_submit", reason: "submits work (requires claimed bounty)" },
    { name: "work_approve", reason: "approves submission (requires poster role)" },
    { name: "work_cancel", reason: "cancels bounty (requires poster role)" },
    { name: "work_reject", reason: "rejects submission (requires poster role)" },
    { name: "work_rate", reason: "rates counterparty (requires completed bounty)" },
    // Challenge write ops
    { name: "challenge_post", reason: "creates challenge (locks USDC in escrow)" },
    { name: "challenge_submit", reason: "submits to challenge (requires active challenge)" },
    { name: "challenge_score", reason: "scores submissions (requires poster role)" },
    { name: "challenge_claim", reason: "claims prize (requires scored challenge)" },
    // Challenge read ops that need a real address
    { name: "challenge_detail", reason: "needs real challenge address" },
    { name: "challenge_leaderboard", reason: "needs real challenge address" },
    // Conditional skips
    ...(HERD ? [] : [
      { name: "wallet_analyze_contract", reason: "needs HERD_ENABLED=true" },
      { name: "wallet_call", reason: "needs HERD_ENABLED=true for ABI fetch" },
    ]),
    ...(ZERION ? [] : [{ name: "wallet_history", reason: "needs ZERION_API_KEY" }]),
  ],
};

// ─── MCP Client ─────────────────────────────────────────────────

class McpClient {
  private child: ChildProcess;
  private rl: readline.Interface;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor() {
    this.child = spawn(SERVER_CMD, SERVER_ARGS, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: join(homedir(), "clara-mcp"),
    });

    this.rl = readline.createInterface({ input: this.child.stdout! });

    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const msg = JSON.parse(trimmed);
        if (msg?.id == null) return;

        const p = this.pending.get(msg.id);
        if (!p) return;

        this.pending.delete(msg.id);
        clearTimeout(p.timer);

        if (msg.error) {
          p.reject(new Error(msg.error.message ?? "Unknown error"));
        } else {
          p.resolve(msg.result);
        }
      } catch {
        // Ignore non-JSON lines
      }
    });
  }

  async send(method: string, params?: any, timeoutMs: number = TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });
  }

  notify(method: string, params?: any) {
    this.child.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
    );
  }

  async callTool(name: string, args: Record<string, any>, timeoutMs?: number): Promise<any> {
    return this.send("tools/call", { name, arguments: args }, timeoutMs);
  }

  close() {
    try { this.rl.close(); } catch {}
    try { this.child.kill(); } catch {}
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function getErrorText(result: any): string {
  if (result?.content?.[0]?.text) {
    const text = result.content[0].text;
    const firstLine = text.split('\n')[0];
    return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
  }
  return 'unknown error';
}

async function runTests(
  client: McpClient,
  section: string,
  tools: TestDef[],
  timeoutMs: number = TIMEOUT_MS,
): Promise<{ passed: number; failed: number }> {
  if (tools.length === 0) return { passed: 0, failed: 0 };

  console.log(`\n--- ${section} ---`);
  let passed = 0;
  let failed = 0;

  for (const tool of tools) {
    const start = Date.now();
    try {
      const result = await client.callTool(tool.name, tool.args, timeoutMs);
      const ms = Date.now() - start;
      if (result?.isError) {
        log("FAIL", tool.name, getErrorText(result), ms);
        failed++;
      } else {
        log("PASS", tool.name, undefined, ms);
        passed++;
      }
    } catch (e: any) {
      const ms = Date.now() - start;
      log("FAIL", tool.name, e.message, ms);
      failed++;
    }
  }
  return { passed, failed };
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("Clara MCP Smoke Test");
  console.log("====================");

  const client = new McpClient();
  const hasSession = existsSync(SESSION_PATH);
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  try {
    // Initialize MCP connection
    await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "clara-smoke", version: "1.0.0" },
    });
    client.notify("notifications/initialized");

    // Verify tools are available
    const { tools } = await client.send("tools/list", {});
    console.log(`\nServer has ${tools.length} tools`);

    // ─── Drift detection ───
    const serverToolNames = new Set(tools.map((t: any) => t.name));
    const allTestNames = new Set([
      ...TOOLS.readOnly.map(t => t.name),
      ...TOOLS.readOnlyAuth.map(t => t.name),
      ...TOOLS.slow.map(t => t.name),
      ...TOOLS.quoteOnly.map(t => t.name),
      ...TOOLS.simulation.map(t => t.name),
      ...TOOLS.skipped.map(t => t.name),
    ]);

    const untested = [...serverToolNames].filter(n => !allTestNames.has(n));
    const stale = [...allTestNames].filter(n => !serverToolNames.has(n));

    if (untested.length) console.log(`${YELLOW}DRIFT${RESET}: ${untested.length} untested: ${untested.join(', ')}`);
    if (stale.length) console.log(`${YELLOW}STALE${RESET}: ${stale.length} removed from server: ${stale.join(', ')}`);

    // ─── Setup wallet if needed ───
    if (!hasSession) {
      console.log("\n--- Wallet Setup ---");
      try {
        const result = await client.callTool("wallet_setup", { email: "bflynn4141@gmail.com" });
        if (result?.isError) {
          log("FAIL", "wallet_setup", getErrorText(result));
          totalFailed++;
        } else {
          log("PASS", "wallet_setup");
          totalPassed++;
        }
      } catch (e: any) {
        log("FAIL", "wallet_setup", e.message);
        throw new Error("Cannot continue without wallet setup");
      }
    }

    // ─── Run test categories ───
    let r: { passed: number; failed: number };

    r = await runTests(client, "Read-Only (no auth)", TOOLS.readOnly);
    totalPassed += r.passed; totalFailed += r.failed;

    r = await runTests(client, "Read-Only (auth required)", TOOLS.readOnlyAuth);
    totalPassed += r.passed; totalFailed += r.failed;

    r = await runTests(client, "Slow (30s timeout)", TOOLS.slow, 30000);
    totalPassed += r.passed; totalFailed += r.failed;

    r = await runTests(client, "Quote Only", TOOLS.quoteOnly);
    totalPassed += r.passed; totalFailed += r.failed;

    r = await runTests(client, "Simulation (read contract)", TOOLS.simulation);
    totalPassed += r.passed; totalFailed += r.failed;

    // ─── Log skipped ───
    console.log("\n--- Skipped (would mutate state) ---");
    for (const tool of TOOLS.skipped) {
      log("SKIP", tool.name, tool.reason);
      totalSkipped++;
    }

    // ─── Summary ───
    const tested = totalPassed + totalFailed;
    const total = tested + totalSkipped;
    console.log("\n====================");
    console.log(`Tested:  ${GREEN}${totalPassed} passed${RESET}, ${RED}${totalFailed} failed${RESET} (${tested} tools)`);
    console.log(`Skipped: ${YELLOW}${totalSkipped}${RESET}`);
    console.log(`Total:   ${total} tools in catalog${untested.length ? `, ${RED}${untested.length} drifted${RESET}` : ""}`);

    if (untested.length) {
      console.log(`\n${YELLOW}Add to test catalog:${RESET} ${untested.join(', ')}`);
    }
    if (stale.length) {
      console.log(`\n${YELLOW}Remove from catalog:${RESET} ${stale.join(', ')}`);
    }

    client.close();
    process.exit(totalFailed > 0 ? 1 : 0);

  } catch (e: any) {
    client.close();
    fail(e.message);
  }
}

main();
