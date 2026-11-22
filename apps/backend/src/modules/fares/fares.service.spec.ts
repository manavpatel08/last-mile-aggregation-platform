import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  UnprocessableEntityException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FaresService } from './fares.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { RoutingService } from '../routing/routing.service.js';

describe('FaresService (Tariff Arithmetic & Allocation Formula)', () => {
  let faresService: FaresService;

  beforeEach(() => {
    // Instantiate with mock dependencies for pure arithmetic verification
    faresService = new FaresService(
      {} as PrismaService,
      {} as LocationsService,
      {} as RoutingService,
      { get: () => false } as unknown as ConfigService,
    );
  });

  describe('calculateSoloFarePaise', () => {
    it('should calculate solo fare correctly for 4,200m distance (₹62.00)', () => {
      const fare = faresService.calculateSoloFarePaise(4200, 2000, 1000, 2000);
      expect(fare).toBe(6200); // ₹20 base + ₹42 distance = ₹62.00
    });

    it('should calculate solo fare correctly for 3,500m distance (₹55.00)', () => {
      const fare = faresService.calculateSoloFarePaise(3500, 2000, 1000, 2000);
      expect(fare).toBe(5500); // ₹20 base + ₹35 distance = ₹55.00
    });

    it('should enforce minimum fare floor of 2,000 paise (₹20.00) for short rides', () => {
      const fare = faresService.calculateSoloFarePaise(0, 2000, 1000, 2000);
      expect(fare).toBe(2000);
    });
  });

  describe('allocateSharedFares (Proportional Solo-Fare Allocation)', () => {
    it('should match Section 4.1 worked numerical example (3 passengers, exact reconciliation)', () => {
      // Kudasan (3.5km => ₹55), Koba (5.0km => ₹70), Infocity (7.2km => ₹92)
      const members = [
        { id: 'p1', soloFarePaise: 5500, ceilingPaise: 5500 },
        { id: 'p2', soloFarePaise: 7000, ceilingPaise: 7000 },
        { id: 'p3', soloFarePaise: 9200, ceilingPaise: 9200 },
      ];

      // Total shared distance = 8,800m => G = 2000 + 8800 = 10,800 paise (₹108.00)
      const allocations = faresService.allocateSharedFares(
        members,
        8800,
        2000,
        1000,
      );

      const p1 = allocations.find((a) => a.id === 'p1');
      const p2 = allocations.find((a) => a.id === 'p2');
      const p3 = allocations.find((a) => a.id === 'p3');

      expect(p1?.allocatedFarePaise).toBe(2700); // ₹27.00 (50.9% savings)
      expect(p2?.allocatedFarePaise).toBe(3500); // ₹35.00 (50.0% savings)
      expect(p3?.allocatedFarePaise).toBe(4600); // ₹46.00 (50.0% savings)

      const sum = allocations.reduce((acc, a) => acc + a.allocatedFarePaise, 0);
      expect(sum).toBe(10800); // Sum matches group fare G exactly
    });

    it('should match Section 4.2 worked numerical example (4 passengers with Delta = +₹1 discrepancy)', () => {
      const members = [
        { id: 'p1', soloFarePaise: 3500, ceilingPaise: 3500 },
        { id: 'p2', soloFarePaise: 4200, ceilingPaise: 4200 },
        { id: 'p3', soloFarePaise: 5800, ceilingPaise: 5800 },
        { id: 'p4', soloFarePaise: 6500, ceilingPaise: 6500 },
      ];

      // Total shared distance = 9,500m => G = 2000 + 9500 = 11,500 paise (₹115.00)
      const allocations = faresService.allocateSharedFares(
        members,
        9500,
        2000,
        1000,
      );

      const p1 = allocations.find((a) => a.id === 'p1');
      const p2 = allocations.find((a) => a.id === 'p2');
      const p3 = allocations.find((a) => a.id === 'p3');
      const p4 = allocations.find((a) => a.id === 'p4');

      expect(p1?.allocatedFarePaise).toBe(2000); // ₹20.00
      expect(p2?.allocatedFarePaise).toBe(2400); // ₹24.00
      expect(p3?.allocatedFarePaise).toBe(3300); // ₹33.00
      expect(p4?.allocatedFarePaise).toBe(3800); // ₹37.00 + ₹1.00 discrepancy = ₹38.00

      const sum = allocations.reduce((acc, a) => acc + a.allocatedFarePaise, 0);
      expect(sum).toBe(11500); // Exactly reconciled to G = 11500
    });

    it('should strictly guarantee no passenger exceeds their agreed fare ceiling', () => {
      const members = [
        { id: 'p1', soloFarePaise: 2500, ceilingPaise: 2500 },
        { id: 'p2', soloFarePaise: 3000, ceilingPaise: 3000 },
      ];

      const allocations = faresService.allocateSharedFares(
        members,
        3000,
        2000,
        1000,
      );
      for (const a of allocations) {
        const member = members.find((m) => m.id === a.id)!;
        expect(a.allocatedFarePaise).toBeLessThanOrEqual(member.ceilingPaise);
        expect(a.allocatedFarePaise).toBeGreaterThanOrEqual(2000);
      }
    });

    it('should use lexicographical ID tie-breaking when solo reference fares are equal', () => {
      // Two passengers with identical solo fares
      const members = [
        { id: 'passenger-b', soloFarePaise: 5000, ceilingPaise: 5000 },
        { id: 'passenger-a', soloFarePaise: 5000, ceilingPaise: 5000 },
      ];

      // G = 2000 + 4100 = 6100. Raw allocation is 3050 each -> rounded to 3100 each = 6200.
      // Delta is 6100 - 6200 = -100. Must deduct 100 paise from the first in sort order.
      // passenger-a sorts before passenger-b lexicographically.
      const allocations = faresService.allocateSharedFares(
        members,
        4100,
        2000,
        1000,
      );

      const aAlloc = allocations.find((a) => a.id === 'passenger-a');
      const bAlloc = allocations.find((a) => a.id === 'passenger-b');

      expect(aAlloc?.allocatedFarePaise).toBe(3000);
      expect(bAlloc?.allocatedFarePaise).toBe(3100);
      expect(aAlloc!.allocatedFarePaise + bAlloc!.allocatedFarePaise).toBe(6100);
    });

    it('should throw UnprocessableEntityException (422) if discrepancy cannot be reconciled without violating ceilings', () => {
      // Extremely low ceilings that prevent absorbing delta
      const members = [
        { id: 'p1', soloFarePaise: 3000, ceilingPaise: 2000 },
        { id: 'p2', soloFarePaise: 3000, ceilingPaise: 2000 },
      ];

      // Group fare = 2000 + 4000 = 6000 paise.
      // Ceilings are 2000 each -> Max possible sum is 4000, which cannot equal 6000.
      expect(() =>
        faresService.allocateSharedFares(members, 4000, 2000, 1000),
      ).toThrow(UnprocessableEntityException);
    });

    it('should reconcile and allocate whole-rupee fares for fractional distance remainder (7,624.9m demo case)', () => {
      // Failing scenario from live OSRM route: distance = 7624.9m
      // Passenger 1 ceiling = 5349, Passenger 2 ceiling = 9545
      const members = [
        { id: 'p1', soloFarePaise: 5349, ceilingPaise: 5349 },
        { id: 'p2', soloFarePaise: 9545, ceilingPaise: 9545 },
      ];

      // G = 2000 + round((7624.9/1000 * 1000) / 100) * 100 = 2000 + 7600 = 9600 paise
      const allocations = faresService.allocateSharedFares(
        members,
        7624.9,
        2000,
        1000,
      );

      const p1 = allocations.find((a) => a.id === 'p1');
      const p2 = allocations.find((a) => a.id === 'p2');

      expect(p1).toBeDefined();
      expect(p2).toBeDefined();

      // Each allocation must be a whole rupee (multiple of 100 paise)
      expect(p1!.allocatedFarePaise % 100).toBe(0);
      expect(p2!.allocatedFarePaise % 100).toBe(0);

      // Sum must equal group fare G (9600 paise) exactly
      const sum = allocations.reduce((acc, a) => acc + a.allocatedFarePaise, 0);
      expect(sum).toBe(9600);
      expect(p1!.allocatedFarePaise).toBe(3400); // ₹34.00
      expect(p2!.allocatedFarePaise).toBe(6200); // ₹62.00

      // Neither passenger exceeds their agreed fare ceiling
      expect(p1!.allocatedFarePaise).toBeLessThanOrEqual(5349);
      expect(p2!.allocatedFarePaise).toBeLessThanOrEqual(9545);
      expect(p1!.allocatedFarePaise).toBeGreaterThanOrEqual(2000);
      expect(p2!.allocatedFarePaise).toBeGreaterThanOrEqual(2000);
    });

    it('should reconcile and allocate whole-rupee fares for fractional distance rounding upward (5,380.6m, 3 passengers)', () => {
      const members = [
        { id: 'p1', soloFarePaise: 4000, ceilingPaise: 4000 },
        { id: 'p2', soloFarePaise: 5000, ceilingPaise: 5000 },
        { id: 'p3', soloFarePaise: 6000, ceilingPaise: 6000 },
      ];

      // G = 2000 + round((5380.6 / 100) * 100) = 2000 + 5400 = 7400 paise
      const allocations = faresService.allocateSharedFares(
        members,
        5380.6,
        2000,
        1000,
      );

      const sum = allocations.reduce((acc, a) => acc + a.allocatedFarePaise, 0);
      expect(sum).toBe(7400);

      for (const a of allocations) {
        const member = members.find((m) => m.id === a.id)!;
        expect(a.allocatedFarePaise % 100).toBe(0);
        expect(a.allocatedFarePaise).toBeLessThanOrEqual(member.ceilingPaise);
        expect(a.allocatedFarePaise).toBeGreaterThanOrEqual(2000);
      }
    });
  });

  describe('generateQuote (Fallback Safety)', () => {
    it('should throw ServiceUnavailableException (503 ROUTING_UNAVAILABLE) in production when route is fallback', async () => {
      const prodConfig = {
        get: (key: string) => (key === 'demoMode' ? false : undefined),
      } as unknown as ConfigService;

      const mockLocations = {
        validateDestination: vi
          .fn()
          .mockResolvedValue({ isInsideServiceRegion: true }),
      } as unknown as LocationsService;

      const mockRouting = new RoutingService(prodConfig);
      vi.spyOn(mockRouting, 'getRoute').mockResolvedValue({
        distanceMeters: 4000,
        durationSec: 500,
        source: 'FALLBACK',
        isFallback: true,
      });

      const mockPrisma = {
        $queryRaw: vi.fn().mockResolvedValue([
          {
            id: 'point-1',
            name: 'PDEU Gate',
            latitude: 23.155,
            longitude: 72.6668,
          },
        ]),
        fareConfig: {
          findFirst: vi.fn().mockResolvedValue({
            baseFarePaise: 2000,
            perKmRatePaise: 1000,
            minFarePaise: 2000,
            version: 1,
          }),
        },
      } as unknown as PrismaService;

      const service = new FaresService(
        mockPrisma,
        mockLocations,
        mockRouting,
        prodConfig,
      );

      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        await expect(
          service.generateQuote('user-1', {
            pickupPointId: '00000000-0000-0000-0000-000000000001',
            destination: { latitude: 23.16, longitude: 72.67 },
          }),
        ).rejects.toThrow(ServiceUnavailableException);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should allow quote generation when demoMode is enabled, even if route is fallback', async () => {
      const demoConfig = {
        get: (key: string) => (key === 'demoMode' ? true : undefined),
      } as unknown as ConfigService;

      const mockLocations = {
        validateDestination: vi
          .fn()
          .mockResolvedValue({ isInsideServiceRegion: true }),
      } as unknown as LocationsService;

      const mockRouting = new RoutingService(demoConfig);
      vi.spyOn(mockRouting, 'getRoute').mockResolvedValue({
        distanceMeters: 4000,
        durationSec: 500,
        source: 'FALLBACK',
        isFallback: true,
      });

      const mockPrisma = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'point-1',
              name: 'PDEU Gate',
              latitude: 23.155,
              longitude: 72.6668,
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 'quote-123',
              expires_at: new Date(Date.now() + 120000),
            },
          ]),
        fareConfig: {
          findFirst: vi.fn().mockResolvedValue({
            baseFarePaise: 2000,
            perKmRatePaise: 1000,
            minFarePaise: 2000,
            version: 1,
          }),
        },
      } as unknown as PrismaService;

      const service = new FaresService(
        mockPrisma,
        mockLocations,
        mockRouting,
        demoConfig,
      );

      const quote = await service.generateQuote('user-1', {
        pickupPointId: '00000000-0000-0000-0000-000000000001',
        destination: { latitude: 23.16, longitude: 72.67 },
      });

      expect(quote).toBeDefined();
      expect(quote.quoteId).toBe('quote-123');
    });

    it('should reject fallback in non-test, non-demo mode (e.g. development without demo flag)', async () => {
      const devConfig = {
        get: (key: string) => (key === 'demoMode' ? false : undefined),
      } as unknown as ConfigService;

      const mockLocations = {
        validateDestination: vi
          .fn()
          .mockResolvedValue({ isInsideServiceRegion: true }),
      } as unknown as LocationsService;

      const mockRouting = new RoutingService(devConfig);
      vi.spyOn(mockRouting, 'getRoute').mockResolvedValue({
        distanceMeters: 4000,
        durationSec: 500,
        source: 'FALLBACK',
        isFallback: true,
      });

      const mockPrisma = {
        $queryRaw: vi.fn().mockResolvedValue([
          {
            id: 'point-1',
            name: 'PDEU Gate',
            latitude: 23.155,
            longitude: 72.6668,
          },
        ]),
        fareConfig: {
          findFirst: vi.fn().mockResolvedValue({
            baseFarePaise: 2000,
            perKmRatePaise: 1000,
            minFarePaise: 2000,
            version: 1,
          }),
        },
      } as unknown as PrismaService;

      const service = new FaresService(
        mockPrisma,
        mockLocations,
        mockRouting,
        devConfig,
      );

      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      try {
        await expect(
          service.generateQuote('user-1', {
            pickupPointId: '00000000-0000-0000-0000-000000000001',
            destination: { latitude: 23.16, longitude: 72.67 },
          }),
        ).rejects.toThrow(ServiceUnavailableException);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });
});
