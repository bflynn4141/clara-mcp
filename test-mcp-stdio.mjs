#!/usr/bin/env node
/**
 * MCP Stdio Protocol Validation Script
 *
 * Tests that Clara MCP server doesn't pollute stdout during startup.
 * Stdout pollution breaks the JSON-RPC protocol.
 *
 * Usage: node test-mcp-stdio.mjs
 *
 * Expected result BEFORE fix:
 *   ❌ FAIL: stdout has content (protocol broken)
 *
 * Expected result AFTER fix:
 *   ✅ PASS: stdout is empty (no pollution)
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, 'dist/index.js');

console.log('🧪 MCP Stdio Protocol Validation\n');
console.log(`Testing: ${SERVER_PATH}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV || '(not set, will use dev mode)'}\n`);

const proc = spawn('node', [SERVER_PATH], {
  env: {
    ...process.env,
    NODE_ENV: undefined, // Force dev mode (where the bug manifests)
    HERD_ENABLED: 'false', // Disable external dependencies
  },
});

let stdout = '';
let stderr = '';
let serverReady = false;

proc.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
  // Log immediately so we can see what's happening
  console.log('📤 [STDOUT - should be EMPTY]:', JSON.stringify(chunk.toString()));
});

proc.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
  if (chunk.toString().includes('Clara MCP Server running on stdio')) {
    serverReady = true;
  }
});

proc.on('error', (err) => {
  console.error('❌ Process error:', err);
  process.exit(1);
});

// Wait for server to start, then check results
const timeout = setTimeout(() => {
  proc.kill('SIGTERM');

  console.log('\n' + '='.repeat(60));
  console.log('TEST RESULTS');
  console.log('='.repeat(60) + '\n');

  // Check if server started
  if (!serverReady) {
    console.log('⚠️  WARNING: Server may not have started properly');
    console.log('stderr:', stderr);
  } else {
    console.log('✅ Server started successfully\n');
  }

  // THE CRITICAL TEST: stdout should be empty
  if (stdout.length === 0) {
    console.log('✅ PASS: stdout is empty (MCP protocol will work)');
    console.log('\n📝 All logs correctly went to stderr:');
    console.log('-'.repeat(40));
    console.log(stderr);
    process.exit(0);
  } else {
    console.log('❌ FAIL: stdout has content (MCP protocol BROKEN!)\n');
    console.log('📤 Problematic stdout content:');
    console.log('-'.repeat(40));
    console.log(stdout);
    console.log('-'.repeat(40));
    console.log('\n📝 stderr (expected log destination):');
    console.log('-'.repeat(40));
    console.log(stderr);
    console.log('-'.repeat(40));
    console.log('\n💡 FIX: In logger.ts, change pino destination from 1 (stdout) to 2 (stderr)');
    process.exit(1);
  }
}, 5000);

// Clean up on ctrl+c
process.on('SIGINT', () => {
  clearTimeout(timeout);
  proc.kill('SIGTERM');
  process.exit(1);
});
