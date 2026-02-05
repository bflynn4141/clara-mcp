#!/usr/bin/env node
/**
 * MCP Full Handshake Validation Script
 *
 * Tests the complete MCP handshake: initialize -> initialized -> tools/list
 * This proves the server works correctly with the MCP protocol.
 *
 * Usage: node test-mcp-handshake.mjs
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, 'dist/index.js');

console.log('🧪 MCP Full Handshake Validation\n');
console.log(`Testing: ${SERVER_PATH}\n`);

const proc = spawn('node', [SERVER_PATH], {
  env: {
    ...process.env,
    NODE_ENV: undefined,
    HERD_ENABLED: 'false',
    CLARA_PROXY_URL: process.env.CLARA_PROXY_URL || 'https://clara-proxy.bflynn-me.workers.dev',
    PARA_WALLET_ID: process.env.PARA_WALLET_ID || '8229cbb1-09aa-40cd-aedc-2072c0fcbf06',
    PARA_WALLET_ADDRESS: process.env.PARA_WALLET_ADDRESS || '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd',
    BASE_RPC_URL: process.env.BASE_RPC_URL || 'https://base-mainnet.core.chainstack.com/eef78ddd7411fa114cb54c177309b6aa',
    ZERION_API_KEY: process.env.ZERION_API_KEY || 'zk_dev_9b2d0b0098d14b1e914790778932f3a4',
  },
});

let responses = [];
let serverReady = false;

// Read JSON-RPC responses from stdout line by line
const rl = createInterface({
  input: proc.stdout,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  try {
    const json = JSON.parse(line);
    responses.push(json);
    console.log(`📥 Response ${responses.length}:`, JSON.stringify(json, null, 2).slice(0, 500) + '...');
  } catch (e) {
    console.log(`⚠️  Non-JSON stdout line: ${line}`);
  }
});

proc.stderr.on('data', (chunk) => {
  const msg = chunk.toString();
  if (msg.includes('Clara MCP Server running on stdio')) {
    serverReady = true;
    console.log('✅ Server started, beginning handshake...\n');
    startHandshake();
  }
});

proc.on('error', (err) => {
  console.error('❌ Process error:', err);
  process.exit(1);
});

function sendMessage(msg) {
  console.log(`📤 Sending:`, JSON.stringify(msg));
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

async function startHandshake() {
  // Step 1: Initialize
  console.log('\n--- Step 1: Initialize ---\n');
  sendMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0',
      },
    },
  });

  // Wait for response
  await waitForResponse(1);

  // Step 2: Send initialized notification
  console.log('\n--- Step 2: Initialized Notification ---\n');
  sendMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  // Small delay for notification processing
  await sleep(100);

  // Step 3: List tools
  console.log('\n--- Step 3: List Tools ---\n');
  sendMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });

  await waitForResponse(2);

  // Analyze results
  console.log('\n' + '='.repeat(60));
  console.log('TEST RESULTS');
  console.log('='.repeat(60) + '\n');

  const initResponse = responses.find(r => r.id === 1);
  const toolsResponse = responses.find(r => r.id === 2);

  // Check initialize response
  if (initResponse?.result?.serverInfo) {
    console.log('✅ Initialize: SUCCESS');
    console.log(`   Server: ${initResponse.result.serverInfo.name} v${initResponse.result.serverInfo.version}`);
  } else {
    console.log('❌ Initialize: FAILED');
    console.log('   Response:', JSON.stringify(initResponse));
  }

  // Check tools response
  if (toolsResponse?.result?.tools) {
    const tools = toolsResponse.result.tools;
    console.log(`✅ List Tools: SUCCESS (${tools.length} tools)`);
    console.log('\n   Available tools:');
    for (const tool of tools) {
      console.log(`   - ${tool.name}`);
    }

    // Check for core tools
    const coreTools = ['wallet_setup', 'wallet_dashboard', 'wallet_balance', 'wallet_pay_x402'];
    const missingCore = coreTools.filter(t => !tools.find(tool => tool.name === t));
    if (missingCore.length > 0) {
      console.log(`\n⚠️  Missing core tools: ${missingCore.join(', ')}`);
    } else {
      console.log('\n✅ All core Clara tools present');
    }
  } else {
    console.log('❌ List Tools: FAILED');
    console.log('   Response:', JSON.stringify(toolsResponse));
  }

  // Final verdict
  console.log('\n' + '='.repeat(60));
  if (initResponse?.result && toolsResponse?.result?.tools?.length > 0) {
    console.log('🎉 MCP HANDSHAKE: FULLY WORKING');
    console.log('   The Clara MCP server is ready for use!');
    console.log('\n   To fix Claude Code, restart it with:');
    console.log('   1. Exit Claude Code completely (Ctrl+C or type "exit")');
    console.log('   2. Restart with: claude');
    console.log('   3. The Clara tools should now load correctly');
  } else {
    console.log('❌ MCP HANDSHAKE: FAILED');
  }
  console.log('='.repeat(60) + '\n');

  proc.kill('SIGTERM');
  process.exit(initResponse?.result && toolsResponse?.result?.tools?.length > 0 ? 0 : 1);
}

function waitForResponse(id) {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (responses.find(r => r.id === id)) {
        clearInterval(check);
        resolve();
      }
    }, 100);

    // Timeout after 10 seconds
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 10000);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Timeout if server doesn't start
setTimeout(() => {
  if (!serverReady) {
    console.error('❌ Server failed to start within 10 seconds');
    proc.kill('SIGTERM');
    process.exit(1);
  }
}, 10000);

// Clean up on ctrl+c
process.on('SIGINT', () => {
  proc.kill('SIGTERM');
  process.exit(1);
});
