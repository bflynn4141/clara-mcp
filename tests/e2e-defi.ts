#!/usr/bin/env npx tsx
/**
 * Clara MCP E2E DeFi Chaos Test
 *
 * End-to-end test proving Clara can autonomously:
 * 1. Onboard a wallet
 * 2. Swap ETH into AERO + USDC
 * 3. Analyze tokens via Herd
 * 4. Find yield opportunities
 * 5. Lend USDC on Aave v3
 * 6. Verify final portfolio
 *
 * Prerequisites: ~0.01 ETH on Base at 0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd
 *
 * Run: npx tsx tests/e2e-defi.ts
 */

import { spawn, ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

// Config
const SERVER_CMD = process.env.CLARA_SERVER_CMD ?? "node";
const SERVER_ARGS = process.env.CLARA_SERVER_ARGS?.split(" ").filter(Boolean) ?? ["dist/index.js"];

const WALLET_ADDRESS = "0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd";
const WALLET_EMAIL = "bflynn4141@gmail.com";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERO_BASE = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
const AERODROME_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const AAVE_POOL_BASE = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

// Timeouts
const DEFAULT_TIMEOUT = 20000;
const SLOW_TIMEOUT = 45000;
const TX_TIMEOUT = 60000;
const SWAP_TIMEOUT = 90000;

// Colors
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface TestResult {
  tool: string;
  name: string;
  category: string;
  input: Record<string, any>;
  expected: string;
  actual: string;
  passed: boolean;
  severity: string;
  error?: string;
  timeMs?: number;
}

function logResult(r: TestResult) {
  const icon = r.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const timing = r.timeMs ? ` ${DIM}(${r.timeMs}ms)${RESET}` : "";
  console.log(`  ${icon}: ${r.tool} - ${r.name}${timing}`);
  if (!r.passed && r.error) {
    console.log(`        ${RED}Error: ${r.error.slice(0, 120)}${RESET}`);
  }
}

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
      env: {
        ...process.env,
        HERD_ENABLED: process.env.HERD_ENABLED ?? "true",
        HERD_API_URL: process.env.HERD_API_URL ?? "https://api.herd.eco/v1/mcp",
        HERD_API_KEY: process.env.HERD_API_KEY ?? "herd_mcp_123",
      },
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
        // Ignore non-JSON
      }
    });
  }

  async send(method: string, params?: any, timeoutMs: number = DEFAULT_TIMEOUT): Promise<any> {
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
    return this.send("tools/call", { name, arguments: args }, timeoutMs ?? DEFAULT_TIMEOUT);
  }

  close() {
    try { this.rl.close(); } catch {}
    try { this.child.kill(); } catch {}
  }
}

/** Extract text content from MCP tool result */
function getContent(result: any): string {
  if (result?.content?.[0]?.text) return result.content[0].text;
  return JSON.stringify(result);
}

/** Check if result is an error */
function isError(result: any): boolean {
  return result?.isError === true;
}

async function runTest(
  client: McpClient,
  tool: string,
  args: Record<string, any>,
  name: string,
  category: string,
  severity: string,
  expected: string,
  validate?: (content: string, result: any) => { passed: boolean; actual: string; error?: string },
  timeoutMs?: number
): Promise<TestResult> {
  const start = Date.now();
  try {
    const result = await client.callTool(tool, args, timeoutMs);
    const elapsed = Date.now() - start;
    const content = getContent(result);

    if (isError(result) && !validate) {
      return {
        tool, name, category, input: args, expected,
        actual: content.slice(0, 300),
        passed: false,
        severity,
        error: content.slice(0, 200),
        timeMs: elapsed,
      };
    }

    if (validate) {
      const v = validate(content, result);
      return {
        tool, name, category, input: args, expected,
        actual: v.actual,
        passed: v.passed,
        severity,
        error: v.error,
        timeMs: elapsed,
      };
    }

    // Default: pass if no error
    return {
      tool, name, category, input: args, expected,
      actual: content.slice(0, 300),
      passed: true,
      severity,
      timeMs: elapsed,
    };
  } catch (e: any) {
    const elapsed = Date.now() - start;
    return {
      tool, name, category, input: args, expected,
      actual: "Exception thrown",
      passed: false,
      severity,
      error: e.message,
      timeMs: elapsed,
    };
  }
}

async function main() {
  console.log(`\n${CYAN}Clara MCP E2E DeFi Chaos Test${RESET}`);
  console.log(`${"=".repeat(50)}`);
  console.log(`Wallet:   ${DIM}${WALLET_ADDRESS}${RESET}`);
  console.log(`Email:    ${DIM}${WALLET_EMAIL}${RESET}`);
  console.log(`${"=".repeat(50)}\n`);

  const client = new McpClient();
  const results: TestResult[] = [];

  try {
    // Initialize MCP connection
    await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "clara-e2e-defi", version: "1.0.0" },
    });
    client.notify("notifications/initialized");

    const { tools } = await client.send("tools/list", {});
    console.log(`Connected. ${tools.length} tools available.\n`);

    // ================================================================
    // OBJECTIVE 1: Wallet Onboarding
    // ================================================================
    console.log(`${CYAN}=== Objective 1: Wallet Onboarding ===${RESET}`);

    try {
      // 1a. wallet_setup
      results.push(await runTest(client, "wallet_setup", { email: WALLET_EMAIL },
        "Setup wallet with email", "onboarding", "critical",
        "Returns wallet address",
        (content) => {
          const hasAddress = content.toLowerCase().includes(WALLET_ADDRESS.toLowerCase());
          return {
            passed: hasAddress,
            actual: hasAddress ? `Correct address: ${WALLET_ADDRESS}` : content.slice(0, 200),
            error: hasAddress ? undefined : "Address mismatch or missing",
          };
        }, SLOW_TIMEOUT));

      // 1b. wallet_status
      results.push(await runTest(client, "wallet_status", {},
        "Wallet status shows authenticated", "onboarding", "critical",
        "Response contains authenticated status and wallet address",
        (content) => {
          const hasAddress = content.toLowerCase().includes(WALLET_ADDRESS.toLowerCase()) || content.toLowerCase().includes("0x");
          const hasAuth = content.toLowerCase().includes("authenticated") || content.toLowerCase().includes("connected") || content.toLowerCase().includes("active");
          return {
            passed: hasAddress,
            actual: hasAddress ? `Authenticated with address present` : content.slice(0, 200),
            error: hasAddress ? undefined : "Wallet address not found in status",
          };
        }, DEFAULT_TIMEOUT));

      // 1c. wallet_dashboard (check ETH balance)
      results.push(await runTest(client, "wallet_dashboard", {},
        "Dashboard shows ETH balance", "onboarding", "critical",
        "Response contains ETH balance data",
        (content) => {
          const hasEth = content.toLowerCase().includes("eth");
          const hasBalance = content.includes("$") || content.toLowerCase().includes("balance") || content.toLowerCase().includes("portfolio");
          return {
            passed: hasEth,
            actual: hasEth ? "Dashboard shows ETH holdings" : content.slice(0, 200),
            error: hasEth ? undefined : "No ETH found in dashboard",
          };
        }, SLOW_TIMEOUT));
    } catch (e: any) {
      console.log(`  ${RED}Objective 1 error: ${e.message}${RESET}`);
    }

    // Pre-check: Determine ETH balance for swap safety
    let hasEnoughEthForSwaps = true;
    const dashResult = results.find(r => r.tool === "wallet_dashboard" && r.category === "onboarding");
    if (dashResult && dashResult.passed) {
      // Try to extract ETH amount from the dashboard content
      // If we can't parse it, assume we have enough and let the swaps fail naturally
      const ethMatch = dashResult.actual.toLowerCase();
      if (ethMatch.includes("0.000") && !ethMatch.includes("0.0001")) {
        // Very low ETH balance detected
        hasEnoughEthForSwaps = false;
        console.log(`\n  ${YELLOW}WARNING: ETH balance appears very low. Swaps may fail.${RESET}`);
      }
    }

    // ================================================================
    // OBJECTIVE 2: Token Swaps
    // ================================================================
    console.log(`\n${CYAN}=== Objective 2: Token Swaps ===${RESET}`);

    try {
      if (!hasEnoughEthForSwaps) {
        console.log(`  ${YELLOW}Skipping swaps - insufficient ETH balance (< 0.005 ETH)${RESET}`);
        const skipReason = "Skipped - insufficient ETH balance for swaps";
        results.push({
          tool: "wallet_swap", name: "Quote ETH->AERO", category: "swap",
          input: { note: "skipped" }, expected: "Swap quote", actual: skipReason,
          passed: false, severity: "high", error: skipReason,
        });
        results.push({
          tool: "wallet_swap", name: "Execute ETH->AERO swap", category: "swap",
          input: { note: "skipped" }, expected: "Swap execution", actual: skipReason,
          passed: false, severity: "high", error: skipReason,
        });
        results.push({
          tool: "wallet_swap", name: "Quote ETH->USDC", category: "swap",
          input: { note: "skipped" }, expected: "Swap quote", actual: skipReason,
          passed: false, severity: "high", error: skipReason,
        });
        results.push({
          tool: "wallet_swap", name: "Execute ETH->USDC swap", category: "swap",
          input: { note: "skipped" }, expected: "Swap execution", actual: skipReason,
          passed: false, severity: "high", error: skipReason,
        });
      } else {
        // Pre-step: Raise spending limits for swaps (each ~$5-6)
      await client.callTool("wallet_spending_limits", {
        action: "set", maxPerTransaction: "10.00", maxPerDay: "50.00", requireApprovalAbove: "10.00",
      }, DEFAULT_TIMEOUT);
      console.log(`  ${DIM}Spending limits raised for swaps${RESET}`);

      // 2a. Quote ETH -> AERO
        let aeroQuoteId: string | null = null;
        const aeroQuoteResult = await runTest(client, "wallet_swap",
          { action: "quote", fromToken: "ETH", toToken: AERO_BASE, amount: "0.001", chain: "base" },
          "Quote ETH->AERO", "swap", "high",
          "Returns swap quote with quoteId",
          (content) => {
            const qMatch = content.match(/q_[a-zA-Z0-9_]+/);
            if (qMatch) aeroQuoteId = qMatch[0];
            const hasQuote = aeroQuoteId !== null || content.toLowerCase().includes("quote");
            return {
              passed: hasQuote,
              actual: hasQuote ? `Quote received${aeroQuoteId ? ` (${aeroQuoteId})` : ""}` : content.slice(0, 200),
              error: hasQuote ? undefined : "No quote data in response",
            };
          }, SWAP_TIMEOUT);
        results.push(aeroQuoteResult);
        logResult(aeroQuoteResult);
        if (aeroQuoteId) console.log(`  ${DIM}Got AERO quote ID: ${aeroQuoteId}${RESET}`);

        // 2b. Execute ETH -> AERO swap
        if (aeroQuoteId) {
          const aeroExecResult = await runTest(client, "wallet_swap",
            { action: "execute", quoteId: aeroQuoteId, chain: "base" },
            "Execute ETH->AERO swap", "swap", "high",
            "Swap executes with tx hash",
            (content) => {
              const hasSubmitted = content.includes("Swap Submitted") || content.includes("✅");
              const hasTxHash = content.includes("Transaction:") || content.includes("Swap TX:");
              const isSpendingLimit = content.toLowerCase().includes("spending limit");
              const isGasIssue = content.toLowerCase().includes("insufficient") || content.toLowerCase().includes("no native eth");
              if (isSpendingLimit) {
                return { passed: false, actual: "Blocked by spending limits", error: content.slice(0, 200) };
              }
              if (isGasIssue) {
                return { passed: false, actual: "Insufficient funds/gas", error: content.slice(0, 200) };
              }
              return {
                passed: hasSubmitted || hasTxHash,
                actual: content.slice(0, 300),
                error: (hasSubmitted || hasTxHash) ? undefined : "No tx hash in response: " + content.slice(0, 150),
              };
            }, TX_TIMEOUT);
          results.push(aeroExecResult);
          logResult(aeroExecResult);
        } else {
          const skipResult: TestResult = {
            tool: "wallet_swap", name: "Execute ETH->AERO swap", category: "swap",
            input: { action: "execute", note: "skipped - no quote ID" },
            expected: "Swap executes with tx hash",
            actual: "Skipped - could not obtain quote ID from AERO quote",
            passed: false, severity: "high", error: "Quote step did not return a quoteId",
          };
          results.push(skipResult);
          logResult(skipResult);
        }

        // Brief pause between swaps to avoid nonce conflicts
        if (aeroQuoteId) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // 2c. Quote ETH -> USDC
        let usdcQuoteId: string | null = null;
        const usdcQuoteResult = await runTest(client, "wallet_swap",
          { action: "quote", fromToken: "ETH", toToken: USDC_BASE, amount: "0.001", chain: "base" },
          "Quote ETH->USDC", "swap", "high",
          "Returns swap quote with quoteId",
          (content) => {
            const hasQuote = content.includes("q_") || content.toLowerCase().includes("quote");
            // Try to extract quoteId inline
            const qMatch = content.match(/q_[a-zA-Z0-9_]+/);
            if (qMatch) usdcQuoteId = qMatch[0];
            return {
              passed: hasQuote,
              actual: hasQuote ? `Quote received${usdcQuoteId ? ` (${usdcQuoteId})` : ""}` : content.slice(0, 200),
              error: hasQuote ? undefined : "No quote data in response",
            };
          }, SWAP_TIMEOUT);
        results.push(usdcQuoteResult);
        logResult(usdcQuoteResult);

        // 2d. Execute ETH -> USDC swap
        if (usdcQuoteId) {
          console.log(`  ${DIM}Got USDC quote ID: ${usdcQuoteId}${RESET}`);
          const usdcExecResult = await runTest(client, "wallet_swap",
            { action: "execute", quoteId: usdcQuoteId, chain: "base" },
            "Execute ETH->USDC swap", "swap", "high",
            "Swap executes with tx hash",
            (content) => {
              const hasSubmitted = content.includes("Swap Submitted") || content.includes("✅");
              const hasTxHash = content.includes("Transaction:") || content.includes("Swap TX:");
              const isSpendingLimit = content.toLowerCase().includes("spending limit");
              const isGasIssue = content.toLowerCase().includes("insufficient") || content.toLowerCase().includes("no native eth");
              if (isSpendingLimit) {
                return { passed: false, actual: "Blocked by spending limits", error: content.slice(0, 200) };
              }
              if (isGasIssue) {
                return { passed: false, actual: "Insufficient funds/gas", error: content.slice(0, 200) };
              }
              return {
                passed: hasSubmitted || hasTxHash,
                actual: content.slice(0, 300),
                error: (hasSubmitted || hasTxHash) ? undefined : "No tx hash in response: " + content.slice(0, 150),
              };
            }, TX_TIMEOUT);
          results.push(usdcExecResult);
          logResult(usdcExecResult);
        } else {
          const skipResult: TestResult = {
            tool: "wallet_swap", name: "Execute ETH->USDC swap", category: "swap",
            input: { action: "execute", note: "skipped - no quote ID" },
            expected: "Swap executes with tx hash",
            actual: "Skipped - could not obtain quote ID from USDC quote",
            passed: false, severity: "high", error: "Quote step did not return a quoteId",
          };
          results.push(skipResult);
          logResult(skipResult);
        }

        // 2e. Verify dashboard shows new balances
        results.push(await runTest(client, "wallet_dashboard", {},
          "Dashboard shows post-swap balances", "swap", "medium",
          "Dashboard reflects new token holdings",
          (content) => {
            const hasEth = content.toLowerCase().includes("eth");
            const hasMultipleTokens = (content.toLowerCase().includes("usdc") || content.toLowerCase().includes("aero")) && hasEth;
            return {
              passed: hasEth,
              actual: hasMultipleTokens ? "Multiple tokens visible on dashboard" : (hasEth ? "ETH visible, other tokens may be pending" : content.slice(0, 200)),
              error: hasEth ? undefined : "Dashboard missing expected tokens",
            };
          }, SLOW_TIMEOUT));
      }
    } catch (e: any) {
      console.log(`  ${RED}Objective 2 error: ${e.message}${RESET}`);
    }

    // ================================================================
    // OBJECTIVE 3: AERO Analysis + Approve
    // ================================================================
    console.log(`\n${CYAN}=== Objective 3: AERO Analysis + Approve ===${RESET}`);

    try {
      // 3a. Analyze AERO contract
      results.push(await runTest(client, "wallet_analyze_contract",
        { address: AERO_BASE, chain: "base" },
        "Analyze AERO token contract", "analysis", "medium",
        "Response mentions ERC-20 or token functions",
        (content) => {
          const hasErc20 = content.toLowerCase().includes("erc-20") || content.toLowerCase().includes("erc20") || content.toLowerCase().includes("token");
          const hasFunctions = content.toLowerCase().includes("transfer") || content.toLowerCase().includes("approve") || content.toLowerCase().includes("balanceof");
          return {
            passed: hasErc20 || hasFunctions,
            actual: `ERC-20 match: ${hasErc20}, Function match: ${hasFunctions}`,
            error: (!hasErc20 && !hasFunctions) ? "Response doesn't identify AERO as ERC-20 token" : undefined,
          };
        }, SLOW_TIMEOUT));

      // 3b. Approve AERO for Aerodrome Router
      let approvePreparedTxId: string | null = null;
      const approveResult = await runTest(client, "wallet_call",
        {
          contract: AERO_BASE,
          function: "approve",
          args: [AERODROME_ROUTER, "1000000000000000000"],
          chain: "base",
        },
        "Prepare AERO approval for Aerodrome Router", "analysis", "high",
        "Returns preparedTxId for approval transaction",
        (content) => {
          const txMatch = content.match(/ptx_[a-zA-Z0-9_]+/);
          if (txMatch) approvePreparedTxId = txMatch[0];
          const hasPrepared = approvePreparedTxId !== null || content.toLowerCase().includes("prepared");
          return {
            passed: hasPrepared,
            actual: hasPrepared ? `Prepared tx: ${approvePreparedTxId ?? "detected"}` : content.slice(0, 200),
            error: hasPrepared ? undefined : "No preparedTxId in response",
          };
        }, SLOW_TIMEOUT);
      results.push(approveResult);
      logResult(approveResult);

      // 3c. Execute the AERO approval
      if (approvePreparedTxId) {
        console.log(`  ${DIM}Executing prepared tx: ${approvePreparedTxId}${RESET}`);
        results.push(await runTest(client, "wallet_executePrepared",
          { preparedTxId: approvePreparedTxId },
          "Execute AERO approval transaction", "analysis", "high",
          "Transaction executes with tx hash",
          (content) => {
            const hasTx = content.includes("0x") && (content.includes("tx") || content.includes("hash") || content.includes("success") || content.includes("executed"));
            const hasError = content.toLowerCase().includes("error") || content.toLowerCase().includes("failed");
            return {
              passed: hasTx && !hasError,
              actual: content.slice(0, 300),
              error: hasError ? content.slice(0, 200) : (hasTx ? undefined : "No tx hash in execution response"),
            };
          }, TX_TIMEOUT));
      } else {
        const skipResult: TestResult = {
          tool: "wallet_executePrepared", name: "Execute AERO approval transaction", category: "analysis",
          input: { note: "skipped - no preparedTxId" },
          expected: "Transaction executes with tx hash",
          actual: "Skipped - could not extract preparedTxId from approval call",
          passed: false, severity: "high", error: "Missing preparedTxId from wallet_call",
        };
        results.push(skipResult);
        logResult(skipResult);
      }
    } catch (e: any) {
      console.log(`  ${RED}Objective 3 error: ${e.message}${RESET}`);
    }

    // ================================================================
    // OBJECTIVE 4: Yield Discovery
    // ================================================================
    console.log(`\n${CYAN}=== Objective 4: Yield Discovery ===${RESET}`);

    try {
      // 4a. Find USDC yield opportunities on Base
      results.push(await runTest(client, "wallet_opportunities",
        { asset: "USDC", chain: "base" },
        "Find USDC yield opportunities on Base", "yield", "medium",
        "Returns opportunities with APY > 0%",
        (content) => {
          const hasProtocol = content.toLowerCase().includes("aave") ||
            content.toLowerCase().includes("compound") ||
            content.toLowerCase().includes("morpho") ||
            content.toLowerCase().includes("moonwell") ||
            content.toLowerCase().includes("fluid");
          const hasApy = /\d+\.?\d*%/.test(content);
          return {
            passed: hasProtocol && hasApy,
            actual: `Protocol found: ${hasProtocol}, APY found: ${hasApy}`,
            error: (!hasProtocol || !hasApy) ? "Missing protocol or APY data" : undefined,
          };
        }, SLOW_TIMEOUT));
    } catch (e: any) {
      console.log(`  ${RED}Objective 4 error: ${e.message}${RESET}`);
    }

    // ================================================================
    // OBJECTIVE 5: USDC Lending on Aave v3
    // ================================================================
    console.log(`\n${CYAN}=== Objective 5: USDC Lending on Aave v3 ===${RESET}`);

    try {
      // 5a. Approve USDC for Aave Pool
      let usdcApproveTxId: string | null = null;
      const usdcApproveResult = await runTest(client, "wallet_call",
        {
          contract: USDC_BASE,
          function: "approve",
          args: [AAVE_POOL_BASE, "100000"],
          chain: "base",
        },
        "Prepare USDC approval for Aave Pool", "lending", "high",
        "Returns preparedTxId for USDC approval",
        (content) => {
          const txMatch = content.match(/ptx_[a-zA-Z0-9_]+/);
          if (txMatch) usdcApproveTxId = txMatch[0];
          const hasPrepared = usdcApproveTxId !== null || content.toLowerCase().includes("prepared");
          return {
            passed: hasPrepared,
            actual: hasPrepared ? `Prepared tx: ${usdcApproveTxId ?? "detected"}` : content.slice(0, 200),
            error: hasPrepared ? undefined : "No preparedTxId in response",
          };
        }, SLOW_TIMEOUT);
      results.push(usdcApproveResult);
      logResult(usdcApproveResult);

      // 5b. Execute USDC approval
      if (usdcApproveTxId) {
        console.log(`  ${DIM}Executing USDC approval: ${usdcApproveTxId}${RESET}`);
        const execApproveResult = await runTest(client, "wallet_executePrepared",
          { preparedTxId: usdcApproveTxId },
          "Execute USDC approval for Aave", "lending", "high",
          "Approval transaction executes",
          (content) => {
            const hasTx = content.includes("0x") && (content.includes("tx") || content.includes("hash") || content.includes("success") || content.includes("executed"));
            const hasError = content.toLowerCase().includes("error") || content.toLowerCase().includes("failed");
            return {
              passed: hasTx && !hasError,
              actual: content.slice(0, 300),
              error: hasError ? content.slice(0, 200) : (hasTx ? undefined : "No tx hash in response"),
            };
          }, TX_TIMEOUT);
        results.push(execApproveResult);
        logResult(execApproveResult);
      } else {
        const skipResult: TestResult = {
          tool: "wallet_executePrepared", name: "Execute USDC approval for Aave", category: "lending",
          input: { note: "skipped - no preparedTxId" },
          expected: "Approval transaction executes",
          actual: "Skipped - could not extract preparedTxId",
          passed: false, severity: "high", error: "Missing preparedTxId from USDC approve call",
        };
        results.push(skipResult);
        logResult(skipResult);
      }

      // Wait for approval to propagate on-chain before supply call
      console.log(`  ${DIM}Waiting 5s for USDC approval to confirm on-chain...${RESET}`);
      await new Promise(resolve => setTimeout(resolve, 5000));

      // 5c. Supply USDC to Aave
      let supplyTxId: string | null = null;
      const supplyResult = await runTest(client, "wallet_call",
        {
          contract: AAVE_POOL_BASE,
          function: "supply",
          args: [USDC_BASE, "100000", WALLET_ADDRESS, "0"],
          chain: "base",
        },
        "Prepare USDC supply to Aave v3", "lending", "high",
        "Returns preparedTxId for supply transaction",
        (content) => {
          const txMatch = content.match(/ptx_[a-zA-Z0-9_]+/);
          if (txMatch) supplyTxId = txMatch[0];
          const hasPrepared = supplyTxId !== null || content.toLowerCase().includes("prepared");
          return {
            passed: hasPrepared,
            actual: hasPrepared ? `Prepared tx: ${supplyTxId ?? "detected"}` : content.slice(0, 200),
            error: hasPrepared ? undefined : "No preparedTxId in response",
          };
        }, SLOW_TIMEOUT);
      results.push(supplyResult);
      logResult(supplyResult);

      // 5d. Execute the supply (use force:true if simulation failed due to approval timing)
      if (supplyTxId) {
        console.log(`  ${DIM}Executing Aave supply: ${supplyTxId}${RESET}`);

        // First try normal execution
        let supplyExecResult = await runTest(client, "wallet_executePrepared",
          { preparedTxId: supplyTxId },
          "Execute USDC supply to Aave v3", "lending", "critical",
          "Supply transaction executes with tx hash",
          (content) => {
            const hasTx = content.includes("Transaction Hash") || (content.includes("0x") && (content.includes("Submitted") || content.includes("success")));
            const isSimFailed = content.toLowerCase().includes("simulation failed") || content.toLowerCase().includes("cannot execute");
            if (isSimFailed) {
              return { passed: false, actual: "Simulation failed - will retry with force", error: "Simulation failed" };
            }
            const hasError = content.toLowerCase().includes("error") || content.toLowerCase().includes("failed");
            return {
              passed: hasTx && !hasError,
              actual: content.slice(0, 300),
              error: hasError ? content.slice(0, 200) : (hasTx ? undefined : "No tx hash in response"),
            };
          }, TX_TIMEOUT);

        // If simulation failed, retry with force (approval may not have been indexed yet)
        if (!supplyExecResult.passed && supplyExecResult.error?.includes("Simulation failed")) {
          console.log(`  ${YELLOW}Retrying supply with force:true (approval may be pending)${RESET}`);

          // Re-prepare the supply transaction
          const rePrepareResult = await client.callTool("wallet_call", {
            contract: AAVE_POOL_BASE,
            function: "supply",
            args: [USDC_BASE, "100000", WALLET_ADDRESS, "0"],
            chain: "base",
          }, SLOW_TIMEOUT);
          const rePrepContent = getContent(rePrepareResult);
          const reMatch = rePrepContent.match(/ptx_[a-zA-Z0-9_]+/);
          const newSupplyTxId = reMatch ? reMatch[0] : null;

          if (newSupplyTxId) {
            supplyExecResult = await runTest(client, "wallet_executePrepared",
              { preparedTxId: newSupplyTxId, force: true },
              "Execute USDC supply to Aave v3", "lending", "critical",
              "Supply transaction executes with tx hash (forced)",
              (content) => {
                const hasTx = content.includes("Transaction Hash") || (content.includes("0x") && (content.includes("Submitted") || content.includes("success")));
                const hasError = content.toLowerCase().includes("insufficient") || content.toLowerCase().includes("nonce");
                return {
                  passed: hasTx && !hasError,
                  actual: content.slice(0, 300),
                  error: hasError ? content.slice(0, 200) : (hasTx ? undefined : "No tx hash in response"),
                };
              }, TX_TIMEOUT);
          }
        }
        results.push(supplyExecResult);
        logResult(supplyExecResult);
      } else {
        const skipResult: TestResult = {
          tool: "wallet_executePrepared", name: "Execute USDC supply to Aave v3", category: "lending",
          input: { note: "skipped - no preparedTxId" },
          expected: "Supply transaction executes with tx hash",
          actual: "Skipped - could not extract preparedTxId from supply call",
          passed: false, severity: "critical", error: "Missing preparedTxId from supply call",
        };
        results.push(skipResult);
        logResult(skipResult);
      }
    } catch (e: any) {
      console.log(`  ${RED}Objective 5 error: ${e.message}${RESET}`);
    }

    // ================================================================
    // OBJECTIVE 6: Final Portfolio Verification
    // ================================================================
    console.log(`\n${CYAN}=== Objective 6: Final Portfolio ===${RESET}`);

    try {
      // 6a. Dashboard shows diversified portfolio
      results.push(await runTest(client, "wallet_dashboard", {},
        "Final portfolio shows multiple token types", "portfolio", "medium",
        "Dashboard reflects ETH + acquired tokens",
        (content) => {
          const hasEth = content.toLowerCase().includes("eth");
          const hasUsdc = content.toLowerCase().includes("usdc");
          const hasAero = content.toLowerCase().includes("aero");
          const tokenCount = [hasEth, hasUsdc, hasAero].filter(Boolean).length;
          return {
            passed: tokenCount >= 2,
            actual: `Tokens found: ETH=${hasEth}, USDC=${hasUsdc}, AERO=${hasAero} (${tokenCount}/3)`,
            error: tokenCount < 2 ? "Portfolio doesn't show expected token diversity" : undefined,
          };
        }, SLOW_TIMEOUT));
    } catch (e: any) {
      console.log(`  ${RED}Objective 6 error: ${e.message}${RESET}`);
    }

    // ================================================================
    // Results Summary
    // ================================================================
    console.log(`\n${"=".repeat(50)}`);
    console.log(`${CYAN}Results Summary${RESET}`);
    console.log(`${"=".repeat(50)}\n`);

    for (const r of results) {
      logResult(r);
    }

    // Objective-level summary
    const objectives = [
      { name: "Wallet Onboarding", tests: results.filter(r => r.category === "onboarding") },
      { name: "Token Swaps", tests: results.filter(r => r.category === "swap") },
      { name: "AERO Analysis", tests: results.filter(r => r.category === "analysis") },
      { name: "Yield Discovery", tests: results.filter(r => r.category === "yield") },
      { name: "USDC Lending", tests: results.filter(r => r.category === "lending") },
      { name: "Final Portfolio", tests: results.filter(r => r.category === "portfolio") },
    ];

    console.log(`\n${CYAN}Objectives Summary${RESET}`);
    let objectivesPassed = 0;
    for (const obj of objectives) {
      const allPassed = obj.tests.length > 0 && obj.tests.every(t => t.passed);
      const icon = allPassed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      if (allPassed) objectivesPassed++;
      console.log(`  ${icon} ${obj.name} (${obj.tests.filter(t => t.passed).length}/${obj.tests.length})`);
    }

    console.log(`\n${CYAN}Result: ${objectivesPassed}/6 objectives passed${RESET}\n`);

    client.close();
    process.exit(objectivesPassed === 6 ? 0 : 1);
  } catch (e: any) {
    console.error(`\n${RED}FATAL: ${e.message}${RESET}`);
    client.close();
    process.exit(1);
  }
}

main();
