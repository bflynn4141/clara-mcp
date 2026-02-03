/**
 * Safety Module Tests
 *
 * Tests for contract safety checks and simulation result handling.
 */

import { describe, it, expect } from 'vitest';
import { isSafeToProceed, type SimulationSafetyResult, type SafetyWarning } from '../safety.js';

describe('Safety Module', () => {
  describe('isSafeToProceed', () => {
    it('should return false when transaction will revert', () => {
      const result: SimulationSafetyResult = {
        success: false,
        willRevert: true,
        revertReason: 'Insufficient balance',
        balanceChanges: [],
        warnings: [],
      };

      expect(isSafeToProceed(result)).toBe(false);
    });

    it('should return false when there are danger warnings', () => {
      const dangerWarning: SafetyWarning = {
        severity: 'danger',
        code: 'UNVERIFIED_CONTRACT',
        title: 'Unverified Contract',
        description: 'Contract is not verified',
      };

      const result: SimulationSafetyResult = {
        success: true,
        willRevert: false,
        balanceChanges: [],
        warnings: [dangerWarning],
      };

      expect(isSafeToProceed(result)).toBe(false);
    });

    it('should return true when only info/warning level warnings exist', () => {
      const warnings: SafetyWarning[] = [
        {
          severity: 'warning',
          code: 'NEW_CONTRACT',
          title: 'Recently Deployed',
          description: 'Contract is new',
        },
        {
          severity: 'info',
          code: 'HIGH_VALUE',
          title: 'High Value',
          description: 'Transaction sends 2 ETH',
        },
      ];

      const result: SimulationSafetyResult = {
        success: true,
        willRevert: false,
        balanceChanges: [],
        warnings,
      };

      expect(isSafeToProceed(result)).toBe(true);
    });

    it('should return false when simulation unavailable (mandatory simulation policy)', () => {
      // GPT-5.2 recommendation: block when simulation unavailable
      // This enforces "mandatory simulation" - can't proceed without verification
      const result: SimulationSafetyResult = {
        success: false,
        willRevert: false,
        simulationUnavailable: true,
        balanceChanges: [],
        warnings: [{
          severity: 'danger',  // Updated: now danger level since it blocks
          code: 'SIMULATION_UNAVAILABLE',
          title: 'Simulation Unavailable',
          description: 'Network timeout',
        }],
      };

      expect(isSafeToProceed(result)).toBe(false);
    });

    it('should return true when no warnings exist', () => {
      const result: SimulationSafetyResult = {
        success: true,
        willRevert: false,
        balanceChanges: [],
        warnings: [],
        gasEstimate: '21000',
      };

      expect(isSafeToProceed(result)).toBe(true);
    });

    it('should return false for simulation failed danger warning', () => {
      const result: SimulationSafetyResult = {
        success: false,
        willRevert: true,
        revertReason: 'Transaction would revert',
        balanceChanges: [],
        warnings: [{
          severity: 'danger',
          code: 'SIMULATION_FAILED',
          title: 'Transaction Would Fail',
          description: 'Transaction would revert',
        }],
      };

      expect(isSafeToProceed(result)).toBe(false);
    });
  });

  describe('Warning Severity Handling', () => {
    it('should correctly identify danger severity', () => {
      const warnings: SafetyWarning[] = [
        { severity: 'info', code: 'INFO', title: 'Info', description: 'Info' },
        { severity: 'warning', code: 'WARN', title: 'Warning', description: 'Warning' },
        { severity: 'danger', code: 'DANGER', title: 'Danger', description: 'Danger' },
      ];

      const hasDanger = warnings.some(w => w.severity === 'danger');
      const hasWarning = warnings.some(w => w.severity === 'warning');
      const hasInfo = warnings.some(w => w.severity === 'info');

      expect(hasDanger).toBe(true);
      expect(hasWarning).toBe(true);
      expect(hasInfo).toBe(true);
    });
  });

  describe('Simulation Result Structure', () => {
    it('should have all required fields for success', () => {
      const result: SimulationSafetyResult = {
        success: true,
        willRevert: false,
        balanceChanges: [],
        warnings: [],
        gasEstimate: '50000',
      };

      expect(result.success).toBe(true);
      expect(result.willRevert).toBe(false);
      expect(Array.isArray(result.balanceChanges)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(result.gasEstimate).toBeDefined();
    });

    it('should have revertReason when willRevert is true', () => {
      const result: SimulationSafetyResult = {
        success: false,
        willRevert: true,
        revertReason: 'ERC20: insufficient allowance',
        balanceChanges: [],
        warnings: [],
      };

      expect(result.willRevert).toBe(true);
      expect(result.revertReason).toBeDefined();
      expect(result.revertReason).toContain('insufficient');
    });

    it('should support simulationUnavailable flag (GPT-5.2 feature)', () => {
      const result: SimulationSafetyResult = {
        success: false,
        willRevert: false,
        simulationUnavailable: true,
        balanceChanges: [],
        warnings: [],
      };

      expect(result.simulationUnavailable).toBe(true);
      expect(result.willRevert).toBe(false);
    });
  });
});
