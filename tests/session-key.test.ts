/**
 * Tests for session-key.ts
 *
 * Covers:
 * - Ephemeral keypair generation
 * - SIWE delegation message format
 * - Session key caching and expiry
 * - clearSessionKey invalidation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getOrCreateSessionKey,
  getCurrentSessionKey,
  clearSessionKey,
} from '../src/auth/session-key.js';

// ─── Setup ──────────────────────────────────────────────

const WALLET = '0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd';

// Mock sign function — simulates Para MPC sign returning a hex sig
let mockSignFn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearSessionKey();
  mockSignFn = vi.fn().mockResolvedValue('0x' + 'ab'.repeat(65));
});

// ─── getOrCreateSessionKey ──────────────────────────────

describe('getOrCreateSessionKey', () => {
  it('generates a valid session key', async () => {
    const sk = await getOrCreateSessionKey(WALLET, mockSignFn);

    // Key structure
    expect(sk.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(sk.publicKey).toMatch(/^0x[0-9a-f]{66}$/); // compressed: 33 bytes
    expect(sk.publicKeyUncompressed).toMatch(/^0x[0-9a-f]{130}$/); // uncompressed: 65 bytes

    // Session metadata
    expect(sk.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(sk.walletAddress).toBe(WALLET);

    // Timestamps
    const issuedAt = new Date(sk.issuedAt).getTime();
    const expiresAt = new Date(sk.expiresAt).getTime();
    expect(expiresAt - issuedAt).toBe(24 * 60 * 60 * 1000); // 24h TTL
  });

  it('calls signFn with SIWE message', async () => {
    await getOrCreateSessionKey(WALLET, mockSignFn);

    expect(mockSignFn).toHaveBeenCalledOnce();
    const message = mockSignFn.mock.calls[0][0];

    // SIWE message format checks
    expect(message).toContain('clara-proxy.bflynn4141.workers.dev');
    // SIWE uses EIP-55 checksummed address
    expect(message.toLowerCase()).toContain(WALLET.toLowerCase());
    expect(message).toContain('Delegate HTTP request signing to session key: ');
    expect(message).toContain('Chain ID: 8453');
    expect(message).toContain('urn:clara:scope:sign');
    expect(message).toContain('urn:clara:scope:send');
    expect(message).toContain('urn:clara:scope:message');
  });

  it('embeds session public key in SIWE statement', async () => {
    const sk = await getOrCreateSessionKey(WALLET, mockSignFn);
    const message = mockSignFn.mock.calls[0][0];

    // The SIWE statement should contain the compressed public key
    expect(message).toContain(sk.publicKey);
  });

  it('returns cached key on second call', async () => {
    const sk1 = await getOrCreateSessionKey(WALLET, mockSignFn);
    const sk2 = await getOrCreateSessionKey(WALLET, mockSignFn);

    expect(sk1).toBe(sk2); // exact same object reference
    expect(mockSignFn).toHaveBeenCalledOnce(); // only signed once
  });

  it('invalidates cache for different wallet address', async () => {
    const sk1 = await getOrCreateSessionKey(WALLET, mockSignFn);
    const OTHER_WALLET = '0x1111111111111111111111111111111111111111';
    const sk2 = await getOrCreateSessionKey(OTHER_WALLET, mockSignFn);

    expect(sk1.walletAddress).toBe(WALLET);
    expect(sk2.walletAddress).toBe(OTHER_WALLET);
    expect(sk1.sessionId).not.toBe(sk2.sessionId);
    expect(mockSignFn).toHaveBeenCalledTimes(2);
  });

  it('stores delegation signature from signFn', async () => {
    const expectedSig = '0x' + 'cd'.repeat(65);
    const signFn = vi.fn().mockResolvedValue(expectedSig);
    const sk = await getOrCreateSessionKey(WALLET, signFn);

    expect(sk.delegationSignature).toBe(expectedSig);
  });
});

// ─── getCurrentSessionKey ───────────────────────────────

describe('getCurrentSessionKey', () => {
  it('returns null when no session key exists', () => {
    expect(getCurrentSessionKey()).toBeNull();
  });

  it('returns the key after creation', async () => {
    await getOrCreateSessionKey(WALLET, mockSignFn);
    const sk = getCurrentSessionKey();
    expect(sk).not.toBeNull();
    expect(sk!.walletAddress).toBe(WALLET);
  });
});

// ─── clearSessionKey ────────────────────────────────────

describe('clearSessionKey', () => {
  it('removes the cached key', async () => {
    await getOrCreateSessionKey(WALLET, mockSignFn);
    expect(getCurrentSessionKey()).not.toBeNull();

    clearSessionKey();
    expect(getCurrentSessionKey()).toBeNull();
  });

  it('forces re-creation on next call', async () => {
    await getOrCreateSessionKey(WALLET, mockSignFn);
    clearSessionKey();

    const signFn = vi.fn().mockResolvedValue('0x' + 'ee'.repeat(65));
    const sk = await getOrCreateSessionKey(WALLET, signFn);

    expect(signFn).toHaveBeenCalledOnce(); // Had to sign again
    expect(sk.delegationSignature).toBe('0x' + 'ee'.repeat(65));
  });
});
