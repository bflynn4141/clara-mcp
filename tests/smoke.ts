#!/usr/bin/env npx tsx
/**
 * Clara MCP Smoke Test
 *
 * Tests all 15 tools for basic functionality.
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
const SKIP_SESSION_CHECK = process.env.SKIP_SESSION_CHECK === "true";

// Test address (burn address - safe for simulations)
const TEST_ADDRESS = "0x000000000000000000000000000000000000dEaD";

// Colors for output
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function log(status: "PASS" | "FAIL" | "SKIP", tool: string, detail?: string) {
  const color = status === "PASS" ? GREEN : status === "FAIL" ? RED : YELLOW;
  const suffix = detail ? ` (${detail})` : "";
  console.log(`${color}${status}${RESET}: ${tool}${suffix}`);
}

function fail(msg: string): never {
  console.error(`\n${RED}FATAL: ${msg}${RESET}`);
  process.exit(1);
}

/**
 * All 15 Clara tools organized by safety level
 */
const TOOLS = {
  // Safe read-only tools
  readOnly: [
    { name: "wallet_status", args: {} },
    { name: "wallet_approvals", args: { chain: "base" } },
    { name: "wallet_spending_limits", args: { action: "view" } },
    // wallet_analyze_contract tested conditionally below
    // Only test if Herd is enabled
    ...(process.env.HERD_ENABLED === "true" ? [{ name: "wallet_analyze_contract", args: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" } }] : []),
    // Only test history if API key is present
    ...(process.env.ZERION_API_KEY ? [{ name: "wallet_history", args: { days: 7 } }] : []),
  ],

  // Slow tools (30s timeout)
  slow: [
    { name: "wallet_dashboard", args: {} },
  ],

  // Safe simulation/signing (no real tx)
  simulation: [] as Array<{ name: string; args: Record<string, any> }>,

  // Quote-only mode (safe - no actual transactions)
  quoteOnly: [
    {
      name: "wallet_swap",
      args: { fromToken: "ETH", toToken: "USDC", amount: "0.001", chain: "base", action: "quote" }
    },
  ],

  // Skipped - would move funds, require specific state, or don't exist in server
  skipped: [
    { name: "wallet_setup", reason: "tested separately if needed" },
    { name: "wallet_logout", reason: "would break session" },
    { name: "wallet_send", reason: "would send real funds" },
    { name: "wallet_pay_x402", reason: "would spend funds" },
    { name: "wallet_sign_message", reason: "requires active proxy session with X-Clara-Address header" },
    { name: "wallet_sign_typed_data", reason: "requires valid typed data and proxy session" },
    { name: "wallet_call", reason: "prepares a contract call, needs valid contract target" },
    { name: "wallet_executePrepared", reason: "needs a preparedTxId from wallet_call" },
    // Conditionally skip if Herd not enabled
    ...(process.env.HERD_ENABLED === "true" ? [] : [{ name: "wallet_analyze_contract", reason: "needs HERD_ENABLED=true env var" }]),
    // Conditionally skip if no API key
    ...(process.env.ZERION_API_KEY ? [] : [{ name: "wallet_history", reason: "needs ZERION_API_KEY env var" }]),
  ],
};

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
        // Ignore non-JSON lines (like console.error from server)
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

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    return this.send("tools/call", { name, arguments: args });
  }

  close() {
    try { this.rl.close(); } catch {}
    try { this.child.kill(); } catch {}
  }
}

async function main() {
  console.log("Clara MCP Smoke Test");
  console.log("====================\n");

  const client = new McpClient();
  const hasSession = existsSync(SESSION_PATH);
  let passed = 0;
  let failed = 0;
  let skipped = 0;

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
    console.log(`Found ${tools.length} tools\n`);

    // --- Drift detection ---
    const serverToolNames = new Set(tools.map((t: any) => t.name));
    const testToolNames = new Set([
      ...TOOLS.readOnly.map(t => t.name),
      ...TOOLS.slow.map(t => t.name),
      ...TOOLS.simulation.map(t => t.name),
      ...TOOLS.quoteOnly.map(t => t.name),
      ...TOOLS.skipped.map(t => t.name),
    ]);

    const untested = [...serverToolNames].filter(n => !testToolNames.has(n));
    const missing = [...testToolNames].filter(n => !serverToolNames.has(n));

    if (untested.length) console.log(`${YELLOW}WARNING${RESET}: Untested tools (in server but not in test): ${untested.join(', ')}`);
    if (missing.length) console.log(`${YELLOW}WARNING${RESET}: Test references missing tools (in test but not in server): ${missing.join(', ')}`);
    if (untested.length || missing.length) console.log("");

    // Helper to extract error message from result
    const getErrorText = (result: any): string => {
      if (result?.content?.[0]?.text) {
        const text = result.content[0].text;
        // Get first line or first 80 chars
        const firstLine = text.split('\n')[0];
        return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
      }
      return 'unknown error';
    };

    // Setup wallet if no session exists
    if (!hasSession) {
      console.log("--- Wallet Setup (no existing session) ---");
      try {
        // Use email for portable wallet
        const setupResult = await client.callTool("wallet_setup", {
          email: "bflynn4141@gmail.com"
        });
        if (setupResult?.isError) {
          log("FAIL", "wallet_setup", getErrorText(setupResult));
          failed++;
        } else {
          log("PASS", "wallet_setup");
          passed++;
        }
      } catch (e: any) {
        log("FAIL", "wallet_setup", e.message);
        failed++;
        // Can't continue without session
        throw new Error("Cannot continue without wallet setup");
      }
      console.log("");
    }

    // Test read-only tools
    console.log("--- Read-Only Tools ---");
    for (const tool of TOOLS.readOnly) {
      try {
        const result = await client.callTool(tool.name, tool.args);
        if (result?.isError) {
          log("FAIL", tool.name, getErrorText(result));
          failed++;
        } else {
          log("PASS", tool.name);
          passed++;
        }
      } catch (e: any) {
        log("FAIL", tool.name, e.message);
        failed++;
      }
    }

    // Test simulation tools
    if (TOOLS.simulation.length > 0) {
      console.log("\n--- Simulation Tools ---");
      for (const tool of TOOLS.simulation) {
        try {
          const result = await client.callTool(tool.name, tool.args);
          if (result?.isError) {
            log("FAIL", tool.name, getErrorText(result));
            failed++;
          } else {
            log("PASS", tool.name);
            passed++;
          }
        } catch (e: any) {
          log("FAIL", tool.name, e.message);
          failed++;
        }
      }
    }

    // Test slow tools (longer timeout)
    console.log("\n--- Slow Tools (30s timeout) ---");
    for (const tool of TOOLS.slow) {
      try {
        const result = await client.send("tools/call", {
          name: tool.name,
          arguments: tool.args,
        }, 30000); // 30s timeout
        if (result?.isError) {
          log("FAIL", tool.name, getErrorText(result));
          failed++;
        } else {
          log("PASS", tool.name);
          passed++;
        }
      } catch (e: any) {
        log("FAIL", tool.name, e.message);
        failed++;
      }
    }

    // Test quote-only tools
    if (TOOLS.quoteOnly.length > 0) {
      console.log("\n--- Quote-Only Tools ---");
      for (const tool of TOOLS.quoteOnly) {
        try {
          const result = await client.callTool(tool.name, tool.args);
          if (result?.isError) {
            log("FAIL", tool.name, getErrorText(result));
            failed++;
          } else {
            log("PASS", tool.name);
            passed++;
          }
        } catch (e: any) {
          log("FAIL", tool.name, e.message);
          failed++;
        }
      }
    }

    // Log skipped tools
    console.log("\n--- Skipped Tools ---");
    for (const tool of TOOLS.skipped) {
      log("SKIP", tool.name, tool.reason);
      skipped++;
    }

    // Summary
    console.log("\n====================");
    console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET}`);
    console.log(`Total: ${passed + failed + skipped} tools\n`);

    // Drift summary
    if (untested.length || missing.length) {
      console.log(`${YELLOW}DRIFT DETECTED${RESET}: Run with updated TOOLS config to fix.`);
      if (untested.length) console.log(`  Add to test: ${untested.join(', ')}`);
      if (missing.length) console.log(`  Remove from test: ${missing.join(', ')}`);
      console.log("");
    }

    client.close();
    process.exit(failed > 0 ? 1 : 0);

  } catch (e: any) {
    client.close();
    fail(e.message);
  }
}

main();
