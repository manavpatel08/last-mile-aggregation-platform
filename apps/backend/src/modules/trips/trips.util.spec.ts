import { describe, it, expect } from 'vitest';
import { calculateWaitingChargePaise } from './trips.util.js';

describe('calculateWaitingChargePaise', () => {
  const baseArrival = new Date('2026-11-21T10:00:00.000Z');

  it('should return 0 when driver arrival or boarding timestamp is missing', () => {
    expect(calculateWaitingChargePaise(null, new Date())).toBe(0);
    expect(calculateWaitingChargePaise(new Date(), null)).toBe(0);
    expect(calculateWaitingChargePaise(undefined, undefined)).toBe(0);
  });

  it('should return 0 when boardedAt is before or equal to driverArrivedAt', () => {
    const arrival = new Date('2026-11-21T10:00:00.000Z');
    const earlier = new Date('2026-11-21T09:59:00.000Z');
    expect(calculateWaitingChargePaise(arrival, earlier)).toBe(0);
    expect(calculateWaitingChargePaise(arrival, arrival)).toBe(0);
  });

  it('should return 0 for waiting times under 5 minutes', () => {
    const boarding1m = new Date(baseArrival.getTime() + 60 * 1000);
    const boarding4m59s = new Date(baseArrival.getTime() + (4 * 60 + 59) * 1000);
    expect(calculateWaitingChargePaise(baseArrival, boarding1m)).toBe(0);
    expect(calculateWaitingChargePaise(baseArrival, boarding4m59s)).toBe(0);
  });

  // Test all boundary cases specified in prompt:
  describe('Prompt Boundary Cases Verification', () => {
    it('5:00 elapsed -> ₹0 (0 paise)', () => {
      const boarding = new Date(baseArrival.getTime() + 300 * 1000); // exactly 5m 00s
      expect(calculateWaitingChargePaise(baseArrival, boarding)).toBe(0);
    });

    it('5:01 elapsed -> ₹5 (500 paise)', () => {
      const boarding = new Date(baseArrival.getTime() + 301 * 1000); // 5m 01s
      expect(calculateWaitingChargePaise(baseArrival, boarding)).toBe(500);
    });

    it('6:00 elapsed -> ₹5 (500 paise)', () => {
      const boarding = new Date(baseArrival.getTime() + 360 * 1000); // 6m 00s
      expect(calculateWaitingChargePaise(baseArrival, boarding)).toBe(500);
    });

    it('6:01 elapsed -> ₹10 (1000 paise)', () => {
      const boarding = new Date(baseArrival.getTime() + 361 * 1000); // 6m 01s
      expect(calculateWaitingChargePaise(baseArrival, boarding)).toBe(1000);
    });

    it('7:01 elapsed -> ₹15 (1500 paise)', () => {
      const boarding = new Date(baseArrival.getTime() + 421 * 1000); // 7m 01s
      expect(calculateWaitingChargePaise(baseArrival, boarding)).toBe(1500);
    });

    it('8:01 elapsed -> ₹20 (2000 paise)', () => {
      const boarding = new Date(baseArrival.getTime() + 481 * 1000); // 8m 01s
      expect(calculateWaitingChargePaise(baseArrival, boarding)).toBe(2000);
    });

    it('9:01 elapsed -> ₹25 (2500 paise)', () => {
      const boarding = new Date(baseArrival.getTime() + 541 * 1000); // 9m 01s
      expect(calculateWaitingChargePaise(baseArrival, boarding)).toBe(2500);
    });

    it('10:00 elapsed -> ₹25 (2500 paise)', () => {
      const boarding = new Date(baseArrival.getTime() + 600 * 1000); // 10m 00s
      expect(calculateWaitingChargePaise(baseArrival, boarding)).toBe(2500);
    });

    it('10:01 elapsed -> capped at ₹25 (2500 paise)', () => {
      const boarding = new Date(baseArrival.getTime() + 601 * 1000); // 10m 01s
      expect(calculateWaitingChargePaise(baseArrival, boarding)).toBe(2500);
    });

    it('15:00 elapsed -> capped at ₹25 (2500 paise)', () => {
      const boarding = new Date(baseArrival.getTime() + 900 * 1000); // 15m 00s
      expect(calculateWaitingChargePaise(baseArrival, boarding)).toBe(2500);
    });
  });
});
