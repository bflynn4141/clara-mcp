/**
 * MCP Stdio Protocol Test
 *
 * This test validates that the Clara MCP server doesn't pollute stdout,
 * which would break the JSON-RPC protocol over stdio.
 *
 * The MCP protocol uses stdin/stdout for JSON-RPC communication.
 * Any non-JSON output to stdout will cause the handshake to fail.
 *
 * Related bug: Pino logger was configured with `destination: 1` (stdout)
 * in dev mode, which broke MCP communication.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_PATH = join(__dirname, '../../dist/index.js');
const STARTUP_TIMEOUT = 10000; // 10 seconds for server to start

describe('MCP Stdio Protocol', () => {
  let serverProcess: ChildProcess | null = null;

  afterEach(() => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      serverProcess = null;
    }
  });

  /**
   * Test that stdout contains ONLY valid JSON-RPC messages during startup.
   *
   * This test catches the bug where console.log or pino with destination:1
   * sends logs to stdout, breaking the MCP protocol.
   */
  it('should not output non-JSON to stdout during startup', async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    serverProcess = spawn('node', [SERVER_PATH], {
      env: {
        ...process.env,
        // Ensure we're testing in the same mode that breaks
        NODE_ENV: undefined, // Not production = dev mode
        // Disable Herd to avoid external dependencies
        HERD_ENABLED: 'false',
      },
    });

    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString());
    });

    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    // Wait for server to start (it outputs "Clara MCP Server running on stdio" to stderr)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timeout'));
      }, STARTUP_TIMEOUT);

      serverProcess?.stderr?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Clara MCP Server running on stdio')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess?.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      serverProcess?.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0 && code !== null) {
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });

    // Give a moment for any async logs to flush
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check stdout - should be empty (MCP server doesn't send messages until initialized)
    const stdout = stdoutChunks.join('');

    // If there's ANY stdout during startup, it's a bug
    if (stdout.length > 0) {
      // Check if it's valid JSON-RPC (which would be acceptable)
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          // Valid JSON-RPC has jsonrpc field
          if (!parsed.jsonrpc) {
            throw new Error('Not a JSON-RPC message');
          }
        }
      } catch {
        // Not valid JSON-RPC - this is the bug!
        throw new Error(
          `Server output non-JSON-RPC data to stdout during startup, breaking MCP protocol:\n\n` +
          `STDOUT (should be empty or valid JSON-RPC):\n${stdout}\n\n` +
          `STDERR (logs should go here):\n${stderrChunks.join('')}`
        );
      }
    }

    // Verify that logs went to stderr (expected behavior)
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('Clara MCP Server running on stdio');
  });

  /**
   * Test that MCP initialize handshake works correctly.
   *
   * This is the critical test - if stdout is polluted, the handshake fails.
   */
  it('should respond to initialize request with valid JSON-RPC', async () => {
    serverProcess = spawn('node', [SERVER_PATH], {
      env: {
        ...process.env,
        NODE_ENV: undefined,
        HERD_ENABLED: 'false',
      },
    });

    const stdoutChunks: string[] = [];

    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString());
    });

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timeout'));
      }, STARTUP_TIMEOUT);

      serverProcess?.stderr?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Clara MCP Server running on stdio')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess?.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Clear any pre-handshake output
    stdoutChunks.length = 0;

    // Send MCP initialize request
    const initializeRequest = JSON.stringify({
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

    serverProcess.stdin?.write(initializeRequest + '\n');

    // Wait for response
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`No response to initialize. stdout: ${stdoutChunks.join('')}`));
      }, 5000);

      const checkResponse = () => {
        const output = stdoutChunks.join('');
        if (output.includes('"jsonrpc"')) {
          clearTimeout(timeout);
          resolve();
        }
      };

      serverProcess?.stdout?.on('data', checkResponse);
    });

    // Parse the response
    const output = stdoutChunks.join('');
    const lines = output.trim().split('\n').filter(Boolean);

    // Every line should be valid JSON-RPC
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(
          `Server output non-JSON to stdout during handshake:\n` +
          `Line: ${line}\n\n` +
          `Full output: ${output}`
        );
      }

      expect(parsed).toHaveProperty('jsonrpc', '2.0');
    }

    // Should have a successful response to our initialize request
    const response = JSON.parse(lines[lines.length - 1]);
    expect(response).toHaveProperty('id', 1);
    expect(response).toHaveProperty('result');
    expect(response.result).toHaveProperty('serverInfo');
  });

  /**
   * Test that tools/list works after initialization.
   *
   * This confirms the full handshake succeeds and tools are available.
   */
  it('should list tools after successful initialization', async () => {
    serverProcess = spawn('node', [SERVER_PATH], {
      env: {
        ...process.env,
        NODE_ENV: undefined,
        HERD_ENABLED: 'false',
      },
    });

    const stdoutChunks: string[] = [];

    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString());
    });

    // Wait for server ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Startup timeout')), STARTUP_TIMEOUT);
      serverProcess?.stderr?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Clara MCP Server running on stdio')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    // Initialize
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });
    serverProcess.stdin?.write(initRequest + '\n');

    // Wait for init response
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Init timeout')), 5000);
      const check = () => {
        if (stdoutChunks.join('').includes('"serverInfo"')) {
          clearTimeout(timeout);
          resolve();
        }
      };
      serverProcess?.stdout?.on('data', check);
    });

    // Send initialized notification
    serverProcess.stdin?.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');

    // Clear and request tools
    stdoutChunks.length = 0;

    const listToolsRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    serverProcess.stdin?.write(listToolsRequest + '\n');

    // Wait for tools response
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Tools list timeout')), 5000);
      const check = () => {
        if (stdoutChunks.join('').includes('"tools"')) {
          clearTimeout(timeout);
          resolve();
        }
      };
      serverProcess?.stdout?.on('data', check);
    });

    // Parse response
    const output = stdoutChunks.join('');
    const response = JSON.parse(output.trim().split('\n').pop()!);

    expect(response).toHaveProperty('id', 2);
    expect(response).toHaveProperty('result');
    expect(response.result).toHaveProperty('tools');
    expect(Array.isArray(response.result.tools)).toBe(true);
    expect(response.result.tools.length).toBeGreaterThan(0);

    // Verify Clara's core tools are present
    const toolNames = response.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('wallet_setup');
    expect(toolNames).toContain('wallet_dashboard');
    expect(toolNames).toContain('wallet_send');
  });
});

