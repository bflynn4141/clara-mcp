#!/usr/bin/env npx tsx
/**
 * Proper x402 v2 Payment Flow Test
 *
 * Implements the official x402 v2 protocol using EIP-3009 TransferWithAuthorization.
 *
 * Key differences from our initial implementation:
 * 1. Header: PAYMENT-SIGNATURE (not X-PAYMENT)
 * 2. Signing: EIP-712 against USDC contract (not custom x402 domain)
 * 3. Payload: authorization object (not paymentId)
 */

import { hashTypedData, type Hex, keccak256, toHex, randomBytes } from 'viem';
import { getSession, touchSession } from './src/storage/session.js';

// Clara proxy URL
const CLARA_PROXY = 'https://clara-proxy.bflynn4141.workers.dev';

// EIP-3009 TransferWithAuthorization types (from x402 spec)
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * Sign raw hash via Clara proxy
 */
async function signRaw(walletId: string, hash: Hex, userAddress: string): Promise<Hex> {
  const response = await fetch(
    `${CLARA_PROXY}/api/v1/wallets/${walletId}/sign-raw`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Clara-Address': userAddress,
      },
      body: JSON.stringify({ data: hash }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Signing failed: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as { signature: string };
  // Ensure 0x prefix
  const sig = result.signature.startsWith('0x') ? result.signature : `0x${result.signature}`;
  return sig as Hex;
}

/**
 * Sign typed data by hashing locally and signing the hash
 */
async function signTypedData(
  walletId: string,
  userAddress: string,
  domain: { name: string; version: string; chainId: number; verifyingContract: Hex },
  types: Record<string, Array<{ name: string; type: string }>>,
  message: Record<string, unknown>
): Promise<Hex> {
  const primaryType = Object.keys(types).find(k => k !== 'EIP712Domain') || Object.keys(types)[0];

  console.log('   Computing EIP-712 hash...');
  console.log('   Domain:', JSON.stringify(domain));
  console.log('   Primary type:', primaryType);

  // Compute the typed data hash using viem
  const hash = hashTypedData({
    domain,
    types,
    primaryType,
    message,
  });

  console.log(`   Hash: ${hash}`);

  // Sign the hash
  return signRaw(walletId, hash, userAddress);
}

/**
 * Generate a random nonce (bytes32)
 */
function createNonce(): Hex {
  // Create a random 32-byte nonce
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

async function main() {
  console.log('🔐 Proper x402 v2 Payment Flow Test\n');

  // 1. Get wallet session
  const session = await getSession();
  if (!session?.authenticated || !session.walletId || !session.address) {
    console.error('❌ No wallet session found. Run wallet_setup first.');
    process.exit(1);
  }

  await touchSession();
  console.log(`✅ Wallet: ${session.address}`);
  console.log(`   Wallet ID: ${session.walletId}\n`);

  // 2. Get payment details from enrichx402.com
  const testUrl = 'https://enrichx402.com/api/exa/contents';
  const testBody = { urls: ['https://x402.org'] };

  console.log(`📡 Testing: ${testUrl}`);
  console.log(`   Body: ${JSON.stringify(testBody)}\n`);

  const initialResponse = await fetch(testUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testBody),
  });

  console.log(`   Initial status: ${initialResponse.status}`);

  if (initialResponse.status !== 402) {
    console.log('   Not a 402 - exiting');
    process.exit(0);
  }

  // 3. Parse payment details (v2 format)
  const paymentRequired = initialResponse.headers.get('payment-required');
  if (!paymentRequired) {
    console.log('   Missing PAYMENT-REQUIRED header');
    process.exit(1);
  }

  const decoded = JSON.parse(Buffer.from(paymentRequired, 'base64').toString('utf-8'));
  console.log('\n   ✅ Parsed payment details (v2):');
  console.log(`      x402Version: ${decoded.x402Version}`);

  if (decoded.x402Version !== 2 || !decoded.accepts || decoded.accepts.length === 0) {
    console.log('   Invalid v2 format');
    process.exit(1);
  }

  const paymentOption = decoded.accepts[0];
  console.log(`      Scheme: ${paymentOption.scheme}`);
  console.log(`      Network: ${paymentOption.network}`);
  console.log(`      Recipient: ${paymentOption.payTo}`);
  console.log(`      Amount: ${paymentOption.amount} ($${Number(paymentOption.amount) / 1e6})`);
  console.log(`      Asset: ${paymentOption.asset}`);
  console.log(`      Extra: ${JSON.stringify(paymentOption.extra)}`);

  // 4. Verify we have the token's EIP-712 domain params
  if (!paymentOption.extra?.name || !paymentOption.extra?.version) {
    console.log('   Missing EIP-712 domain params in extra field');
    process.exit(1);
  }

  // 5. Create EIP-3009 TransferWithAuthorization signature
  const chainId = parseInt(paymentOption.network.split(':')[1], 10);
  const now = Math.floor(Date.now() / 1000);
  const nonce = createNonce();

  const authorization = {
    from: session.address as Hex,
    to: paymentOption.payTo as Hex,
    value: BigInt(paymentOption.amount),
    validAfter: BigInt(now - 600),  // 10 minutes ago
    validBefore: BigInt(now + paymentOption.maxTimeoutSeconds),
    nonce,
  };

  console.log('\n   📝 EIP-3009 Authorization:');
  console.log(`      from: ${authorization.from}`);
  console.log(`      to: ${authorization.to}`);
  console.log(`      value: ${authorization.value}`);
  console.log(`      validAfter: ${authorization.validAfter}`);
  console.log(`      validBefore: ${authorization.validBefore}`);
  console.log(`      nonce: ${nonce}`);

  // The EIP-712 domain is the USDC TOKEN CONTRACT, not x402
  const domain = {
    name: paymentOption.extra.name,
    version: paymentOption.extra.version,
    chainId,
    verifyingContract: paymentOption.asset as Hex,
  };

  console.log('\n   🔑 EIP-712 Domain (USDC contract):');
  console.log(`      name: ${domain.name}`);
  console.log(`      version: ${domain.version}`);
  console.log(`      chainId: ${domain.chainId}`);
  console.log(`      verifyingContract: ${domain.verifyingContract}`);

  // Sign the TransferWithAuthorization message
  console.log('\n   ✍️  Signing TransferWithAuthorization...');
  const signature = await signTypedData(
    session.walletId!,
    session.address!,
    domain,
    TRANSFER_WITH_AUTHORIZATION_TYPES,
    authorization
  );
  console.log(`   Signature: ${signature.slice(0, 40)}...`);

  // 6. Create the x402 v2 payment payload
  const paymentPayload = {
    x402Version: 2,
    resource: decoded.resource,
    accepted: paymentOption,
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
    },
  };

  console.log('\n   📦 Payment Payload:');
  console.log(JSON.stringify(paymentPayload, null, 2));

  // Base64 encode for the header
  const paymentSignatureHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  // 7. Make the paid request with PAYMENT-SIGNATURE header
  console.log('\n   📤 Making paid request with PAYMENT-SIGNATURE header...');
  const paidResponse = await fetch(testUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': paymentSignatureHeader,  // Note: Not X-PAYMENT!
    },
    body: JSON.stringify(testBody),
  });

  console.log(`   Response status: ${paidResponse.status}`);

  // Log relevant response headers
  console.log('\n   📋 Response headers:');
  paidResponse.headers.forEach((value, key) => {
    if (key.toLowerCase().includes('payment') || key.toLowerCase().includes('x-')) {
      console.log(`      ${key}: ${value.slice(0, 100)}`);
    }
  });

  // 8. Check result
  if (paidResponse.ok) {
    console.log('\n✅ Payment successful!');
    console.log(`   Amount paid: $${Number(paymentOption.amount) / 1e6}`);

    const contentType = paidResponse.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await paidResponse.json();
      console.log('\n📄 Response (truncated):');
      const preview = JSON.stringify(data, null, 2).slice(0, 1000);
      console.log(preview + (preview.length >= 1000 ? '...' : ''));
    }
  } else {
    console.log('\n❌ Payment failed');
    const text = await paidResponse.text();
    console.log(`   Response: ${text.slice(0, 500)}`);

    // Check if there's an error in the payment-required header
    const newPaymentRequired = paidResponse.headers.get('payment-required');
    if (newPaymentRequired) {
      const newDecoded = JSON.parse(Buffer.from(newPaymentRequired, 'base64').toString('utf-8'));
      if (newDecoded.error) {
        console.log(`\n   Error from server: ${newDecoded.error}`);
      }
    }
  }

  console.log('\n✨ Test complete');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
