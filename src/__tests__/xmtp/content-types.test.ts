/**
 * Tests for XMTP content type encoding/decoding.
 *
 * Covers CLARA_V1 message format, extractText cross-protocol
 * interop (GLORP_V1), and edge cases in parsing.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeClaraMessage,
  decodeClaraMessage,
  isClaraMessage,
  extractText,
} from '../../xmtp/content-types.js';

describe('CLARA_V1 Content Types', () => {
  describe('encodeClaraMessage', () => {
    it('encodes a basic text message with CLARA_V1 prefix', () => {
      const encoded = encodeClaraMessage({ text: 'hello' });
      expect(encoded).toMatch(/^CLARA_V1:/);
      expect(encoded).toContain('"text":"hello"');
      expect(encoded).toContain('"v":1');
    });

    it('includes context when provided', () => {
      const encoded = encodeClaraMessage({
        text: 'payment sent',
        context: { txHash: '0xabc123', action: 'payment' },
      });
      const decoded = JSON.parse(encoded.slice('CLARA_V1:'.length));
      expect(decoded.context.txHash).toBe('0xabc123');
      expect(decoded.context.action).toBe('payment');
    });

    it('includes replyTo when provided', () => {
      const encoded = encodeClaraMessage({
        text: 'yes',
        replyTo: 'msg_abc123',
      });
      const decoded = JSON.parse(encoded.slice('CLARA_V1:'.length));
      expect(decoded.replyTo).toBe('msg_abc123');
    });

    it('always sets v to 1', () => {
      const encoded = encodeClaraMessage({ text: 'test' });
      const decoded = JSON.parse(encoded.slice('CLARA_V1:'.length));
      expect(decoded.v).toBe(1);
    });
  });

  describe('decodeClaraMessage', () => {
    it('decodes a valid CLARA_V1 message', () => {
      const raw = 'CLARA_V1:{"text":"hello","v":1}';
      const decoded = decodeClaraMessage(raw);
      expect(decoded).not.toBeNull();
      expect(decoded!.text).toBe('hello');
      expect(decoded!.v).toBe(1);
    });

    it('returns null for non-CLARA_V1 messages', () => {
      expect(decodeClaraMessage('just a plain message')).toBeNull();
      expect(decodeClaraMessage('GLORP_V1:{"text":"hi","v":1}')).toBeNull();
      expect(decodeClaraMessage('')).toBeNull();
    });

    it('returns null for invalid JSON after prefix', () => {
      expect(decodeClaraMessage('CLARA_V1:not-json')).toBeNull();
      expect(decodeClaraMessage('CLARA_V1:{broken')).toBeNull();
    });

    it('returns null if text field is missing or wrong type', () => {
      expect(decodeClaraMessage('CLARA_V1:{"v":1}')).toBeNull();
      expect(decodeClaraMessage('CLARA_V1:{"text":42,"v":1}')).toBeNull();
    });

    it('returns null if version is not 1', () => {
      expect(decodeClaraMessage('CLARA_V1:{"text":"hi","v":2}')).toBeNull();
      expect(decodeClaraMessage('CLARA_V1:{"text":"hi","v":0}')).toBeNull();
    });

    it('roundtrips with encodeClaraMessage', () => {
      const original = {
        text: 'payment received',
        context: { txHash: '0xdef456', action: 'payment' as const, senderName: 'alice' },
        replyTo: 'msg_xyz',
      };
      const encoded = encodeClaraMessage(original);
      const decoded = decodeClaraMessage(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.text).toBe(original.text);
      expect(decoded!.context?.txHash).toBe('0xdef456');
      expect(decoded!.replyTo).toBe('msg_xyz');
    });
  });

  describe('isClaraMessage', () => {
    it('returns true for CLARA_V1 prefixed strings', () => {
      expect(isClaraMessage('CLARA_V1:anything')).toBe(true);
      expect(isClaraMessage('CLARA_V1:')).toBe(true);
    });

    it('returns false for other strings', () => {
      expect(isClaraMessage('plain text')).toBe(false);
      expect(isClaraMessage('GLORP_V1:{"text":"hi"}')).toBe(false);
      expect(isClaraMessage('')).toBe(false);
    });
  });

  describe('extractText', () => {
    it('extracts text from CLARA_V1 messages', () => {
      const encoded = encodeClaraMessage({ text: 'tx confirmed!' });
      expect(extractText(encoded)).toBe('tx confirmed!');
    });

    it('extracts text from GLORP_V1 messages (interop)', () => {
      const glorpMsg = 'GLORP_V1:{"text":"hello from glorp","scope":"test"}';
      expect(extractText(glorpMsg)).toBe('hello from glorp');
    });

    it('returns raw string for plain text messages', () => {
      expect(extractText('just a normal message')).toBe('just a normal message');
    });

    it('returns raw string for broken GLORP_V1 JSON', () => {
      expect(extractText('GLORP_V1:not-json')).toBe('GLORP_V1:not-json');
    });

    it('returns raw string for GLORP_V1 without text field', () => {
      expect(extractText('GLORP_V1:{"scope":"test"}')).toBe('GLORP_V1:{"scope":"test"}');
    });

    it('handles unicode text', () => {
      const encoded = encodeClaraMessage({ text: '🚀 shipped it!' });
      expect(extractText(encoded)).toBe('🚀 shipped it!');
    });

    it('handles empty text', () => {
      const encoded = encodeClaraMessage({ text: '' });
      // decodeClaraMessage checks typeof text === 'string', empty string is valid
      expect(extractText(encoded)).toBe('');
    });
  });
});
