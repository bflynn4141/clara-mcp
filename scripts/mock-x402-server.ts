#!/usr/bin/env npx tsx
/**
 * Mock x402 Server for Testing
 *
 * A simple HTTP server that returns 402 responses with proper x402 headers.
 * Use this to test Clara's x402 client implementation end-to-end.
 *
 * Usage:
 *   npx tsx scripts/mock-x402-server.ts
 *
 * Then test with:
 *   curl -D - http://localhost:4020/api/weather
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';

const PORT = 4020;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYTO_ADDRESS = '0x1E54dd08e5FD673d3F96080B35d973f0EB840353';

// ANSI colors
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function log(msg: string) {
  console.log(`${CYAN}[server]${RESET} ${msg}`);
}

/**
 * Create a v2 402 response payload
 */
function createV2PaymentRequired(url: string, priceUsd: number) {
  // Convert USD to USDC base units (6 decimals)
  const amount = Math.floor(priceUsd * 1_000_000).toString();

  return {
    x402Version: 2,
    resource: {
      url,
      description: 'Premium API data',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453', // Base mainnet
        asset: USDC_BASE,
        amount,
        payTo: PAYTO_ADDRESS,
        maxTimeoutSeconds: 300,
        extra: {
          name: 'USD Coin',
          version: '2',
        },
      },
    ],
  };
}

/**
 * Create a v2 402 response WITHOUT token domain (to test fallback)
 */
function createV2PaymentRequiredNoExtra(url: string, priceUsd: number) {
  const amount = Math.floor(priceUsd * 1_000_000).toString();

  return {
    x402Version: 2,
    resource: {
      url,
      description: 'Premium API data (no extra)',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: USDC_BASE,
        amount,
        payTo: PAYTO_ADDRESS,
        maxTimeoutSeconds: 300,
        extra: {}, // Empty - Clara should use fallback domain
      },
    ],
  };
}

/**
 * Create a v1 402 response payload (legacy)
 */
function createV1PaymentRequired(url: string, priceUsd: number) {
  const amount = Math.floor(priceUsd * 1_000_000).toString();

  return {
    payTo: PAYTO_ADDRESS,
    maxAmountRequired: amount,
    asset: USDC_BASE,
    network: 'base',
    validUntil: Math.floor(Date.now() / 1000) + 300,
    paymentId: '0x' + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join(''),
    description: 'Legacy v1 payment',
  };
}

/**
 * Verify a payment signature (mock - just checks format)
 */
function verifyPayment(paymentHeader: string | undefined, version: 'v1' | 'v2'): boolean {
  if (!paymentHeader) return false;

  try {
    const decoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
    const payload = JSON.parse(decoded);

    if (version === 'v2') {
      // v2 should have x402Version, payload with signature and authorization
      return (
        payload.x402Version === 2 &&
        payload.payload?.signature &&
        payload.payload?.authorization
      );
    } else {
      // v1 should have payer, signature, paymentId
      return payload.payer && payload.signature && payload.paymentId;
    }
  } catch {
    return false;
  }
}

/**
 * Handle incoming requests
 */
function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = req.url || '/';
  const fullUrl = `http://localhost:${PORT}${url}`;

  log(`${req.method} ${url}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PAYMENT, PAYMENT-SIGNATURE, X-Clara-Address');
  res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, WWW-Authenticate');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: 'mock-x402-server' }));
    return;
  }

  // v2 endpoint with token domain
  if (url === '/api/weather' || url === '/api/v2-with-domain') {
    const paymentSig = req.headers['payment-signature'] as string | undefined;

    if (verifyPayment(paymentSig, 'v2')) {
      log(`${GREEN}Payment verified!${RESET}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: {
          temperature: 72,
          conditions: 'Sunny',
          location: 'San Francisco',
        },
        payment: {
          received: true,
          version: 2,
        },
      }));
      return;
    }

    // Return 402
    const payload = createV2PaymentRequired(fullUrl, 0.001); // $0.001
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    log(`${YELLOW}Returning 402 (v2 with domain)${RESET}`);
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': encoded,
    });
    res.end(JSON.stringify({ error: 'Payment Required', x402Version: 2 }));
    return;
  }

  // v2 endpoint WITHOUT token domain (test fallback)
  if (url === '/api/v2-no-domain') {
    const paymentSig = req.headers['payment-signature'] as string | undefined;

    if (verifyPayment(paymentSig, 'v2')) {
      log(`${GREEN}Payment verified (fallback domain)!${RESET}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: { message: 'Fallback domain worked!' },
        payment: { received: true, version: 2, usedFallback: true },
      }));
      return;
    }

    const payload = createV2PaymentRequiredNoExtra(fullUrl, 0.002);
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    log(`${YELLOW}Returning 402 (v2 NO domain - test fallback)${RESET}`);
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': encoded,
    });
    res.end(JSON.stringify({ error: 'Payment Required', x402Version: 2, note: 'no domain in extra' }));
    return;
  }

  // v1 endpoint (legacy)
  if (url === '/api/v1-legacy') {
    const paymentHeader = req.headers['x-payment'] as string | undefined;

    if (verifyPayment(paymentHeader, 'v1')) {
      log(`${GREEN}Payment verified (v1)!${RESET}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: { message: 'Legacy v1 payment worked!' },
        payment: { received: true, version: 1 },
      }));
      return;
    }

    const payload = createV1PaymentRequired(fullUrl, 0.001);
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    log(`${YELLOW}Returning 402 (v1 legacy)${RESET}`);
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': encoded,
    });
    res.end(JSON.stringify({ error: 'Payment Required', version: 1 }));
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'Not Found',
    availableEndpoints: [
      '/api/weather - v2 with token domain ($0.001)',
      '/api/v2-with-domain - v2 with token domain ($0.001)',
      '/api/v2-no-domain - v2 WITHOUT token domain (test fallback) ($0.002)',
      '/api/v1-legacy - v1 legacy format ($0.001)',
      '/health - health check',
    ],
  }));
}

// Start server
const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`
${CYAN}╔═══════════════════════════════════════════════════════════════╗
║               Mock x402 Server                                ║
║               Testing Clara's x402 Client                     ║
╚═══════════════════════════════════════════════════════════════╝${RESET}

Server running at: ${GREEN}http://localhost:${PORT}${RESET}

Available endpoints:
  ${YELLOW}/api/weather${RESET}       - v2 with token domain ($0.001)
  ${YELLOW}/api/v2-no-domain${RESET}  - v2 WITHOUT token domain (test fallback)
  ${YELLOW}/api/v1-legacy${RESET}     - v1 legacy format
  ${YELLOW}/health${RESET}            - health check

Test with curl:
  curl -D - http://localhost:${PORT}/api/weather

Or use Clara's wallet_pay_x402 tool:
  wallet_pay_x402 url="http://localhost:${PORT}/api/weather"

Press Ctrl+C to stop.
`);
});
