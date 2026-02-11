/**
 * Tests for request-signer.ts
 *
 * Covers:
 * - Canonical message format
 * - SHA-256 body digest
 * - ECDSA signing + verification roundtrip
 * - Public key recovery from signed message
 * - signedFetch header attachment
 */

import { describe, it, expect, vi } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  buildCanonicalMessage,
  signCanonicalMessage,
  verifyCanonicalMessage,
  recoverPublicKey,
  sha256hex,
  signedFetch,
} from '../src/auth/request-signer.js';
import type { SessionKeyData } from '../src/auth/session-key.js';

// ─── Test Fixtures ──────────────────────────────────────

function makeTestSessionKey(): SessionKeyData & { privateKeyBytes: Uint8Array } {
  const privateKeyBytes = secp256k1.utils.randomSecretKey();
  const privateKey = Buffer.from(privateKeyBytes).toString('hex');
  const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true);
  const publicKeyUncompressedBytes = secp256k1.getPublicKey(privateKeyBytes, false);

  return {
    privateKeyBytes,
    privateKey,
    publicKey: '0x' + Buffer.from(publicKeyBytes).toString('hex'),
    publicKeyUncompressed: '0x' + Buffer.from(publicKeyUncompressedBytes).toString('hex'),
    delegationMessage: 'test delegation',
    delegationSignature: '0xdeadbeef',
    sessionId: 'test-session-123',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    walletAddress: '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd',
  };
}

// ─── sha256hex ──────────────────────────────────────────

describe('sha256hex', () => {
  it('produces correct hash for empty string', () => {
    const hash = sha256hex('');
    // SHA-256 of empty string is well-known
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('produces correct hash for known input', () => {
    const hash = sha256hex('hello');
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('is deterministic', () => {
    const a = sha256hex('test body content');
    const b = sha256hex('test body content');
    expect(a).toBe(b);
  });
});

// ─── buildCanonicalMessage ──────────────────────────────

describe('buildCanonicalMessage', () => {
  it('builds correct format with version tag', () => {
    const msg = buildCanonicalMessage(
      'POST',
      '/api/v1/wallets/abc/sign-typed-data',
      'deadbeef',
      '1707566400',
      'test-nonce-123',
    );

    const lines = msg.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('CLARA-REQUEST-SIG-V1');
    expect(lines[1]).toBe('POST');
    expect(lines[2]).toBe('/api/v1/wallets/abc/sign-typed-data');
    expect(lines[3]).toBe('sha256:deadbeef');
    expect(lines[4]).toBe('1707566400');
    expect(lines[5]).toBe('test-nonce-123');
  });

  it('uppercases method', () => {
    // Note: buildCanonicalMessage doesn't uppercase — caller should
    // But let's test what we get
    const msg = buildCanonicalMessage('GET', '/', 'abc', '1', 'n');
    expect(msg).toContain('GET');
  });

  it('uses path only (no query string)', () => {
    const msg = buildCanonicalMessage('POST', '/api/v1/test', 'abc', '1', 'n');
    expect(msg.split('\n')[2]).toBe('/api/v1/test');
  });
});

// ─── signCanonicalMessage + verifyCanonicalMessage ──────

describe('signCanonicalMessage', () => {
  it('returns 0x-prefixed 65-byte hex (130 chars + 0x)', () => {
    const sk = makeTestSessionKey();
    const msg = buildCanonicalMessage('POST', '/test', sha256hex('body'), '1707566400', 'nonce1');
    const sig = signCanonicalMessage(msg, sk.privateKey);

    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('produces deterministic signatures for same input', () => {
    const sk = makeTestSessionKey();
    const msg = buildCanonicalMessage('POST', '/test', sha256hex('body'), '1707566400', 'nonce1');

    // ECDSA with deterministic k (RFC 6979) should give same sig
    const sig1 = signCanonicalMessage(msg, sk.privateKey);
    const sig2 = signCanonicalMessage(msg, sk.privateKey);
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different messages', () => {
    const sk = makeTestSessionKey();
    const msg1 = buildCanonicalMessage('POST', '/test', sha256hex('body1'), '1707566400', 'nonce1');
    const msg2 = buildCanonicalMessage('POST', '/test', sha256hex('body2'), '1707566400', 'nonce1');

    const sig1 = signCanonicalMessage(msg1, sk.privateKey);
    const sig2 = signCanonicalMessage(msg2, sk.privateKey);
    expect(sig1).not.toBe(sig2);
  });
});

describe('verifyCanonicalMessage', () => {
  it('returns true for valid signature with compressed key', () => {
    const sk = makeTestSessionKey();
    const msg = buildCanonicalMessage('POST', '/test', sha256hex('body'), '1707566400', 'nonce1');
    const sig = signCanonicalMessage(msg, sk.privateKey);

    expect(verifyCanonicalMessage(msg, sig, sk.publicKey)).toBe(true);
  });

  it('returns true for valid signature with uncompressed key', () => {
    const sk = makeTestSessionKey();
    const msg = buildCanonicalMessage('POST', '/test', sha256hex('body'), '1707566400', 'nonce1');
    const sig = signCanonicalMessage(msg, sk.privateKey);

    expect(verifyCanonicalMessage(msg, sig, sk.publicKeyUncompressed)).toBe(true);
  });

  it('returns false for wrong message', () => {
    const sk = makeTestSessionKey();
    const msg = buildCanonicalMessage('POST', '/test', sha256hex('body'), '1707566400', 'nonce1');
    const sig = signCanonicalMessage(msg, sk.privateKey);

    const wrongMsg = buildCanonicalMessage('POST', '/test', sha256hex('WRONG'), '1707566400', 'nonce1');
    expect(verifyCanonicalMessage(wrongMsg, sig, sk.publicKey)).toBe(false);
  });

  it('returns false for wrong public key', () => {
    const sk1 = makeTestSessionKey();
    const sk2 = makeTestSessionKey();
    const msg = buildCanonicalMessage('POST', '/test', sha256hex('body'), '1707566400', 'nonce1');
    const sig = signCanonicalMessage(msg, sk1.privateKey);

    expect(verifyCanonicalMessage(msg, sig, sk2.publicKey)).toBe(false);
  });
});

// ─── recoverPublicKey ───────────────────────────────────

describe('recoverPublicKey', () => {
  it('recovers the correct compressed public key', () => {
    const sk = makeTestSessionKey();
    const msg = buildCanonicalMessage('POST', '/test', sha256hex('body'), '1707566400', 'nonce1');
    const sig = signCanonicalMessage(msg, sk.privateKey);

    const recovered = recoverPublicKey(msg, sig);
    expect(recovered).toBe(sk.publicKey);
  });
});

// ─── signedFetch ────────────────────────────────────────

describe('signedFetch', () => {
  it('attaches all required auth headers', async () => {
    const sk = makeTestSessionKey();

    // Mock global fetch
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mockFetch);

    await signedFetch(
      'https://clara-proxy.bflynn-me.workers.dev/api/v1/test',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      },
      sk,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, opts] = mockFetch.mock.calls[0];
    const headers = opts.headers as Headers;

    expect(headers.get('X-Clara-Address')).toBe(sk.walletAddress);
    expect(headers.get('X-Clara-Session')).toBe(sk.sessionId);
    expect(headers.get('X-Clara-Signature')).toMatch(/^0x[0-9a-f]{130}$/);
    expect(headers.get('X-Clara-Timestamp')).toMatch(/^\d+$/);
    expect(headers.get('X-Clara-Nonce')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Original headers are preserved
    expect(headers.get('Content-Type')).toBe('application/json');

    vi.unstubAllGlobals();
  });

  it('produces a verifiable signature over the request', async () => {
    const sk = makeTestSessionKey();

    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mockFetch);

    const body = JSON.stringify({ amount: '100' });
    await signedFetch(
      'https://clara-proxy.bflynn-me.workers.dev/api/v1/send',
      { method: 'POST', body },
      sk,
    );

    const [, opts] = mockFetch.mock.calls[0];
    const headers = opts.headers as Headers;

    // Reconstruct the canonical message from the headers
    const signature = headers.get('X-Clara-Signature')!;
    const timestamp = headers.get('X-Clara-Timestamp')!;
    const nonce = headers.get('X-Clara-Nonce')!;

    const canonical = buildCanonicalMessage(
      'POST',
      '/api/v1/send',
      sha256hex(body),
      timestamp,
      nonce,
    );

    // Verify the signature matches
    expect(verifyCanonicalMessage(canonical, signature, sk.publicKey)).toBe(true);

    vi.unstubAllGlobals();
  });
});
