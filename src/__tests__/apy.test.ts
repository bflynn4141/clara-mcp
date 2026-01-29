/**
 * Unit tests for APY calculation utilities
 *
 * Tests the pure functions in src/para/apy.ts:
 * - formatUSD: USD amount formatting
 * - formatAPY: APY percentage formatting
 * - formatPayback: Payback period formatting
 * - q96ToDecimal: Q96 fixed-point conversion
 * - formatETH: ETH amount formatting
 * - weiToNumber: Safe bigint to number conversion
 */

import { describe, it, expect } from 'vitest';
import {
  formatUSD,
  formatAPY,
  formatPayback,
  q96ToDecimal,
  formatETH,
  weiToNumber,
} from '../para/apy.js';

describe('formatUSD', () => {
  it('formats millions correctly', () => {
    expect(formatUSD(1_500_000)).toBe('$1.5M');
    expect(formatUSD(10_000_000)).toBe('$10.0M');
    expect(formatUSD(1_000_000)).toBe('$1.0M');
  });

  it('formats tens of thousands correctly', () => {
    expect(formatUSD(50_000)).toBe('$50k');
    expect(formatUSD(10_000)).toBe('$10k');
    expect(formatUSD(99_999)).toBe('$100k');
  });

  it('formats thousands correctly', () => {
    expect(formatUSD(1_234)).toBe('$1.2k');
    expect(formatUSD(5_500)).toBe('$5.5k');
    expect(formatUSD(1_000)).toBe('$1.0k');
  });

  it('formats small amounts correctly', () => {
    expect(formatUSD(123.45)).toBe('$123.45');
    expect(formatUSD(1.5)).toBe('$1.50');
    expect(formatUSD(0.5)).toBe('$0.5000');
    expect(formatUSD(0.0001)).toBe('$0.0001');
  });

  it('handles zero', () => {
    expect(formatUSD(0)).toBe('$0.00');
  });

  it('handles very small positive numbers', () => {
    expect(formatUSD(0.00001)).toBe('$0.0000');
  });
});

describe('formatAPY', () => {
  it('formats normal APY percentages', () => {
    expect(formatAPY(12.5)).toBe('12.5%');
    expect(formatAPY(5.0)).toBe('5.0%');
    expect(formatAPY(99.9)).toBe('99.9%');
  });

  it('formats high APY (100+) without decimals', () => {
    expect(formatAPY(150)).toBe('150%');
    expect(formatAPY(500)).toBe('500%');
    expect(formatAPY(999)).toBe('999%');
  });

  it('formats very high APY in thousands', () => {
    expect(formatAPY(1500)).toBe('1.5k%');
    expect(formatAPY(10000)).toBe('10.0k%');
  });

  it('returns dash for zero', () => {
    expect(formatAPY(0)).toBe('—');
  });

  it('returns dash for infinity', () => {
    expect(formatAPY(Infinity)).toBe('—');
    expect(formatAPY(-Infinity)).toBe('—');
  });

  it('returns dash for NaN', () => {
    expect(formatAPY(NaN)).toBe('—');
  });
});

describe('formatPayback', () => {
  it('formats years correctly', () => {
    expect(formatPayback(5.5)).toBe('5.5 yrs');
    expect(formatPayback(2.0)).toBe('2.0 yrs');
    expect(formatPayback(10.3)).toBe('10.3 yrs');
  });

  it('formats months for less than a year', () => {
    expect(formatPayback(0.5)).toBe('6 mo');
    expect(formatPayback(0.25)).toBe('3 mo');
    expect(formatPayback(0.083)).toBe('1 mo'); // ~1 month
  });

  it('caps at 100+ years', () => {
    expect(formatPayback(100)).toBe('100+ yrs');
    expect(formatPayback(150)).toBe('100+ yrs');
    expect(formatPayback(1000)).toBe('100+ yrs');
  });

  it('returns dash for infinity', () => {
    expect(formatPayback(Infinity)).toBe('—');
  });

  it('returns dash for zero or negative', () => {
    expect(formatPayback(0)).toBe('—');
    expect(formatPayback(-5)).toBe('—');
  });

  it('returns dash for NaN', () => {
    expect(formatPayback(NaN)).toBe('—');
  });
});

describe('q96ToDecimal', () => {
  it('converts zero correctly', () => {
    expect(q96ToDecimal(0n)).toBe(0);
  });

  it('converts Q96 value representing 1.0', () => {
    // 2^96 = 79228162514264337593543950336
    const Q96 = BigInt('79228162514264337593543950336');
    const result = q96ToDecimal(Q96);
    expect(result).toBeCloseTo(1.0, 10);
  });

  it('converts Q96 value representing 0.5', () => {
    const Q96 = BigInt('79228162514264337593543950336');
    const halfQ96 = Q96 / 2n;
    const result = q96ToDecimal(halfQ96);
    expect(result).toBeCloseTo(0.5, 10);
  });

  it('converts Q96 value representing 0.001 (typical token price)', () => {
    const Q96 = BigInt('79228162514264337593543950336');
    // 0.001 * Q96
    const priceQ96 = Q96 / 1000n;
    const result = q96ToDecimal(priceQ96);
    expect(result).toBeCloseTo(0.001, 6);
  });

  it('handles very large Q96 values without overflow', () => {
    // This is a value that would overflow Number() directly
    const largeQ96 = BigInt('792281625142643375935439503360000'); // 10000 * Q96
    const result = q96ToDecimal(largeQ96);
    expect(result).toBeCloseTo(10000, 5);
  });

  it('handles very small Q96 values', () => {
    const Q96 = BigInt('79228162514264337593543950336');
    // 0.000001 * Q96
    const tinyQ96 = Q96 / 1_000_000n;
    const result = q96ToDecimal(tinyQ96);
    expect(result).toBeCloseTo(0.000001, 9);
  });
});

describe('formatETH', () => {
  it('formats large amounts in thousands', () => {
    const oneThousandEth = BigInt('1000000000000000000000'); // 1000 ETH
    expect(formatETH(oneThousandEth)).toBe('1.0k ETH');

    const fiveThousandEth = BigInt('5000000000000000000000'); // 5000 ETH
    expect(formatETH(fiveThousandEth)).toBe('5.0k ETH');
  });

  it('formats whole ETH amounts', () => {
    const oneEth = BigInt('1000000000000000000'); // 1 ETH
    expect(formatETH(oneEth)).toBe('1.00 ETH');

    const tenEth = BigInt('10000000000000000000'); // 10 ETH
    expect(formatETH(tenEth)).toBe('10.00 ETH');
  });

  it('formats fractional ETH amounts', () => {
    const halfEth = BigInt('500000000000000000'); // 0.5 ETH
    expect(formatETH(halfEth)).toBe('0.5000 ETH');

    const pointOneEth = BigInt('100000000000000000'); // 0.1 ETH
    expect(formatETH(pointOneEth)).toBe('0.1000 ETH');
  });

  it('formats very small amounts', () => {
    const smallAmount = BigInt('100000000000000'); // 0.0001 ETH
    expect(formatETH(smallAmount)).toBe('0.000100 ETH');
  });

  it('formats zero', () => {
    expect(formatETH(0n)).toBe('0.000000 ETH');
  });

  it('handles amounts that would overflow Number() directly', () => {
    // 1 million ETH in wei - this is > 2^53 and would overflow
    const millionEth = BigInt('1000000000000000000000000'); // 1,000,000 ETH
    expect(formatETH(millionEth)).toBe('1000.0k ETH');
  });
});

describe('weiToNumber', () => {
  it('converts ETH wei correctly (18 decimals)', () => {
    const oneEth = BigInt('1000000000000000000');
    expect(weiToNumber(oneEth, 18)).toBe(1);

    const twoPointFiveEth = BigInt('2500000000000000000');
    expect(weiToNumber(twoPointFiveEth, 18)).toBe(2.5);
  });

  it('converts USDC amounts correctly (6 decimals)', () => {
    const oneUsdc = BigInt('1000000');
    expect(weiToNumber(oneUsdc, 6)).toBe(1);

    const hundredUsdc = BigInt('100000000');
    expect(weiToNumber(hundredUsdc, 6)).toBe(100);
  });

  it('converts WBTC amounts correctly (8 decimals)', () => {
    const oneWbtc = BigInt('100000000');
    expect(weiToNumber(oneWbtc, 8)).toBe(1);

    const halfWbtc = BigInt('50000000');
    expect(weiToNumber(halfWbtc, 8)).toBe(0.5);
  });

  it('handles zero', () => {
    expect(weiToNumber(0n, 18)).toBe(0);
    expect(weiToNumber(0n, 6)).toBe(0);
  });

  it('handles very large values without overflow', () => {
    // 1 billion tokens with 18 decimals
    const billion = BigInt('1000000000000000000000000000');
    const result = weiToNumber(billion, 18);
    expect(result).toBeCloseTo(1_000_000_000, 5);
  });

  it('defaults to 18 decimals', () => {
    const oneEth = BigInt('1000000000000000000');
    expect(weiToNumber(oneEth)).toBe(1);
  });
});

describe('BigInt overflow prevention', () => {
  /**
   * These tests verify that our functions correctly handle values
   * that would overflow JavaScript's Number.MAX_SAFE_INTEGER (2^53 - 1).
   *
   * For reference:
   * - 2^53 ≈ 9.007 × 10^15
   * - 1 ETH in wei = 10^18 = 1,000,000,000,000,000,000
   * - So even 0.01 ETH (10^16 wei) is larger than MAX_SAFE_INTEGER
   */

  it('formatETH handles 100 ETH without precision loss', () => {
    const hundredEth = BigInt('100000000000000000000'); // 100 ETH
    // This is 10^20 which is way above MAX_SAFE_INTEGER
    expect(formatETH(hundredEth)).toBe('100.00 ETH');
  });

  it('weiToNumber handles large staking positions', () => {
    // 10 million tokens staked (common for meme coins)
    const tenMillion = BigInt('10000000000000000000000000'); // 10^25 wei
    const result = weiToNumber(tenMillion, 18);
    expect(result).toBeCloseTo(10_000_000, 5);
  });

  it('q96ToDecimal handles realistic auction prices', () => {
    // Typical CCA clearing price might be 0.0001 - 0.01 ETH per token
    const Q96 = BigInt('79228162514264337593543950336');

    // 0.001 ETH per token
    const priceQ96 = Q96 / 1000n;
    expect(q96ToDecimal(priceQ96)).toBeCloseTo(0.001, 6);

    // 0.0001 ETH per token
    const smallPriceQ96 = Q96 / 10000n;
    expect(q96ToDecimal(smallPriceQ96)).toBeCloseTo(0.0001, 7);
  });
});
