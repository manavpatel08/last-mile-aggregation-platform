import { describe, it, expect, beforeEach } from 'vitest';
import {
  PermutationSolver,
  CandidateMember,
  MatrixData,
} from './permutation-solver.service.js';

describe('PermutationSolver', () => {
  let solver: PermutationSolver;

  beforeEach(() => {
    solver = new PermutationSolver();
  });

  const createMember = (
    id: string,
    minutesAgo = 0,
    minGroupPref = 2,
  ): CandidateMember => ({
    bookingId: `b-${id}`,
    passengerId: `p-${id}`,
    destination: { latitude: 23.2 + Number(id) * 0.01, longitude: 72.6 + Number(id) * 0.01 },
    agreedFareCeilingPaise: 5000,
    minGroupPreference: minGroupPref,
    createdAt: new Date(Date.now() - minutesAgo * 60000),
    maxWaitDeadline: new Date(Date.now() + 60000),
  });

  describe('Permutation Counts and Basic Evaluation', () => {
    it('should evaluate 2-passenger group with 2 permutations and pick optimal sequence', () => {
      const members = [createMember('1', 5), createMember('2', 2)];

      // Pickup = 0, D1 = 1, D2 = 2
      // Sequence A: 0 -> 1 -> 2
      //   Leg 0->1: duration 100s, dist 1000m
      //   Leg 1->2: duration 20s, dist 200m
      //   Total duration: 120s
      //   Direct D1: 100s, Shared D1: 100s => Detour = 0%
      //   Direct D2: 110s, Shared D2: 120s => Detour = (120-110)/110 = 9.09% <= 25%
      // Sequence B: 0 -> 2 -> 1
      //   Leg 0->2: duration 110s
      //   Leg 2->1: duration 30s
      //   Total duration: 140s
      const matrix: MatrixData = {
        durations: [
          [0, 100, 110], // from 0
          [100, 0, 20],  // from 1
          [110, 30, 0],  // from 2
        ],
        distances: [
          [0, 1000, 1100],
          [1000, 0, 200],
          [1100, 300, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      };

      const result = solver.solve(members, matrix);
      expect(result).not.toBeNull();
      expect(result!.groupSize).toBe(2);
      expect(result!.totalRouteDurationSec).toBe(120);
      expect(result!.orderedEvaluations[0].bookingId).toBe('b-1');
      expect(result!.orderedEvaluations[1].bookingId).toBe('b-2');
      expect(result!.orderedEvaluations[0].calculatedDetourPercent).toBe(0);
      expect(result!.orderedEvaluations[1].calculatedDetourPercent).toBeCloseTo(9.09, 1);
    });

    it('should evaluate 3-passenger group across all 6 permutations and select minimum duration', () => {
      const members = [createMember('1'), createMember('2'), createMember('3')];

      // Linear corridor: 0 -> 1 -> 2 -> 3
      // 0->1: 100s, 1->2: 50s, 2->3: 50s
      // Directs: 0->1=100s, 0->2=140s, 0->3=180s
      const matrix: MatrixData = {
        durations: [
          [0, 100, 140, 180],
          [100, 0, 50, 90],
          [140, 50, 0, 50],
          [180, 90, 50, 0],
        ],
        distances: [
          [0, 1000, 1500, 2000],
          [1000, 0, 500, 1000],
          [1500, 500, 0, 500],
          [2000, 1000, 500, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      };

      const result = solver.solve(members, matrix);
      expect(result).not.toBeNull();
      expect(result!.groupSize).toBe(3);
      expect(result!.totalRouteDurationSec).toBe(200); // 100 + 50 + 50
      expect(result!.orderedEvaluations.map((e) => e.bookingId)).toEqual(['b-1', 'b-2', 'b-3']);
      // Detours:
      // P1: (100 - 100)/100 = 0%
      // P2: (150 - 140)/140 = 7.14%
      // P3: (200 - 180)/180 = 11.11%
      expect(result!.maxDetourPercent).toBeCloseTo(11.11, 1);
    });

    it('should evaluate 4-passenger group across all 24 permutations', () => {
      const members = [
        createMember('1'),
        createMember('2'),
        createMember('3'),
        createMember('4'),
      ];

      // Corridor: 0 -> 1 -> 2 -> 3 -> 4
      const matrix: MatrixData = {
        durations: [
          [0, 100, 180, 260, 340],
          [100, 0, 80, 160, 240],
          [180, 80, 0, 80, 160],
          [260, 160, 80, 0, 80],
          [340, 240, 160, 80, 0],
        ],
        distances: [
          [0, 1000, 1800, 2600, 3400],
          [1000, 0, 800, 1600, 2400],
          [1800, 800, 0, 800, 1600],
          [2600, 1600, 800, 0, 800],
          [3400, 2400, 1600, 800, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      };

      const result = solver.solve(members, matrix);
      expect(result).not.toBeNull();
      expect(result!.groupSize).toBe(4);
      expect(result!.totalRouteDurationSec).toBe(340);
      expect(result!.orderedEvaluations.map((e) => e.bookingId)).toEqual([
        'b-1',
        'b-2',
        'b-3',
        'b-4',
      ]);
    });
  });

  describe('Detour Constraint Boundaries (25.00%)', () => {
    it('should ACCEPT a route with an exact 25.00% detour', () => {
      const members = [createMember('1'), createMember('2')];

      // Direct to D2 = 100s. Shared to D2 = 125s => Detour = (125-100)/100 = 25.00%
      const matrix: MatrixData = {
        durations: [
          [0, 80, 100],
          [80, 0, 45], // 80 + 45 = 125s
          [100, 45, 0],
        ],
        distances: [
          [0, 800, 1000],
          [800, 0, 450],
          [1000, 450, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      };

      const result = solver.solve(members, matrix);
      expect(result).not.toBeNull();
      expect(result!.maxDetourPercent).toBe(25);
    });

    it('should REJECT a candidate if any passenger has a detour just above 25% (e.g. 25.01%)', () => {
      const members = [createMember('1'), createMember('2')];

      // Direct to D2 = 100s. Shared to D2 = 125.1s => Detour = 25.1% > 25.00%
      // Reversed sequence: 0 -> 2 -> 1:
      // Direct to D1 = 80s. Shared to D1 = 100 + 45 = 145s => Detour = (145-80)/80 = 81.25% > 25%
      const matrix: MatrixData = {
        durations: [
          [0, 80, 100],
          [80, 0, 45.1], // 80 + 45.1 = 125.1s
          [100, 45, 0],
        ],
        distances: [
          [0, 800, 1000],
          [800, 0, 451],
          [1000, 450, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      };

      const result = solver.solve(members, matrix);
      expect(result).toBeNull();
    });

    it('should return null when all permutations violate the detour limit', () => {
      const members = [createMember('1'), createMember('2')];

      // Completely divergent routes: D1 is north (100s), D2 is south (100s).
      // Between D1 and D2 is 150s.
      // Seq 1 (0->1->2): D2 shared = 100 + 150 = 250s (Detour = 150% > 25%)
      // Seq 2 (0->2->1): D1 shared = 100 + 150 = 250s (Detour = 150% > 25%)
      const matrix: MatrixData = {
        durations: [
          [0, 100, 100],
          [100, 0, 150],
          [100, 150, 0],
        ],
        distances: [
          [0, 1000, 1000],
          [1000, 0, 1500],
          [1000, 1500, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      };

      const result = solver.solve(members, matrix);
      expect(result).toBeNull();
    });
  });

  describe('Routing Safety and Invalid Baseline Handling', () => {
    it('should REJECT matrix if isFallback is true', () => {
      const members = [createMember('1'), createMember('2')];
      const matrix: MatrixData = {
        durations: [
          [0, 100, 110],
          [100, 0, 20],
          [110, 20, 0],
        ],
        distances: [
          [0, 1000, 1100],
          [1000, 0, 200],
          [1100, 200, 0],
        ],
        source: 'FALLBACK',
        isFallback: true,
      };

      const result = solver.solve(members, matrix);
      expect(result).toBeNull();
    });

    it('should reject matrix if source is not authoritative OSRM even if isFallback is false', () => {
      const members = [createMember('1'), createMember('2')];
      const matrix: MatrixData = {
        durations: [
          [0, 100, 110],
          [100, 0, 20],
          [110, 20, 0],
        ],
        distances: [
          [0, 1000, 1100],
          [1000, 0, 200],
          [1100, 200, 0],
        ],
        source: 'APPROXIMATE',
        isFallback: false,
      };

      const result = solver.solve(members, matrix);
      expect(result).toBeNull();
    });

    it('should handle zero or negative direct duration safely by rejecting permutation', () => {
      const members = [createMember('1'), createMember('2')];
      const matrix: MatrixData = {
        durations: [
          [0, 0, 100], // Direct to D1 is 0s (invalid)
          [0, 0, 20],
          [100, 20, 0],
        ],
        distances: [
          [0, 0, 1000],
          [0, 0, 200],
          [1000, 200, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      };

      const result = solver.solve(members, matrix);
      expect(result).toBeNull();
    });

    it('should reject invalid group sizes (< 2 or > 4)', () => {
      const matrix: MatrixData = {
        durations: [[0]],
        distances: [[0]],
        source: 'OSRM',
        isFallback: false,
      };

      expect(solver.solve([createMember('1')], matrix)).toBeNull();
      expect(
        solver.solve(
          [
            createMember('1'),
            createMember('2'),
            createMember('3'),
            createMember('4'),
            createMember('5'),
          ],
          matrix,
        ),
      ).toBeNull();
    });
  });

  describe('Hierarchical Ranking & Deterministic Tie-Breaking', () => {
    it('Priority 1: should prioritize larger group size over shorter duration (4-pax > 3-pax > 2-pax)', () => {
      const group2 = {
        members: [createMember('1'), createMember('2')],
        orderedEvaluations: [],
        totalRouteDurationSec: 100, // shorter
        totalRouteDistanceMeters: 1000,
        maxDetourPercent: 5,
        oldestBookingCreatedAt: new Date(1000),
        groupSize: 2,
      };

      const group4 = {
        members: [
          createMember('1'),
          createMember('2'),
          createMember('3'),
          createMember('4'),
        ],
        orderedEvaluations: [],
        totalRouteDurationSec: 300, // longer
        totalRouteDistanceMeters: 3000,
        maxDetourPercent: 15,
        oldestBookingCreatedAt: new Date(2000),
        groupSize: 4,
      };

      // compareCandidates(a, b) < 0 means a is better than b
      expect(solver.compareCandidates(group4, group2)).toBeLessThan(0);
      expect(solver.compareCandidates(group2, group4)).toBeGreaterThan(0);
    });

    it('Priority 2: should prioritize lower total duration when group sizes are equal', () => {
      const candA = {
        members: [createMember('1'), createMember('2')],
        orderedEvaluations: [],
        totalRouteDurationSec: 150,
        totalRouteDistanceMeters: 1500,
        maxDetourPercent: 10,
        oldestBookingCreatedAt: new Date(1000),
        groupSize: 2,
      };

      const candB = {
        members: [createMember('1'), createMember('3')],
        orderedEvaluations: [],
        totalRouteDurationSec: 180,
        totalRouteDistanceMeters: 1800,
        maxDetourPercent: 5,
        oldestBookingCreatedAt: new Date(1000),
        groupSize: 2,
      };

      expect(solver.compareCandidates(candA, candB)).toBeLessThan(0);
    });

    it('Priority 3: should prioritize lower maximum individual detour when total durations are tied', () => {
      const candA = {
        members: [createMember('1'), createMember('2')],
        orderedEvaluations: [],
        totalRouteDurationSec: 200,
        totalRouteDistanceMeters: 2000,
        maxDetourPercent: 12.5,
        oldestBookingCreatedAt: new Date(1000),
        groupSize: 2,
      };

      const candB = {
        members: [createMember('1'), createMember('3')],
        orderedEvaluations: [],
        totalRouteDurationSec: 200,
        totalRouteDistanceMeters: 2000,
        maxDetourPercent: 18.0,
        oldestBookingCreatedAt: new Date(1000),
        groupSize: 2,
      };

      expect(solver.compareCandidates(candA, candB)).toBeLessThan(0);
    });

    it('Priority 4: should prioritize older booking timestamp when durations and detours are tied', () => {
      const candOld = {
        members: [createMember('1', 10), createMember('2', 5)],
        orderedEvaluations: [],
        totalRouteDurationSec: 200,
        totalRouteDistanceMeters: 2000,
        maxDetourPercent: 10,
        oldestBookingCreatedAt: new Date('2026-11-20T10:00:00Z'), // older
        groupSize: 2,
      };

      const candNew = {
        members: [createMember('3', 2), createMember('4', 1)],
        orderedEvaluations: [],
        totalRouteDurationSec: 200,
        totalRouteDistanceMeters: 2000,
        maxDetourPercent: 10,
        oldestBookingCreatedAt: new Date('2026-11-20T10:05:00Z'), // newer
        groupSize: 2,
      };

      expect(solver.compareCandidates(candOld, candNew)).toBeLessThan(0);
    });

    it('Priority 5: deterministic tie-break using sorted booking IDs when all metrics are equal', () => {
      const candA = {
        members: [createMember('1'), createMember('3')],
        orderedEvaluations: [
          { bookingId: 'b-1', dropoffSequenceOrder: 1 } as any,
          { bookingId: 'b-3', dropoffSequenceOrder: 2 } as any,
        ],
        totalRouteDurationSec: 200,
        totalRouteDistanceMeters: 2000,
        maxDetourPercent: 10,
        oldestBookingCreatedAt: new Date('2026-11-20T10:00:00Z'),
        groupSize: 2,
      };

      const candB = {
        members: [createMember('1'), createMember('4')],
        orderedEvaluations: [
          { bookingId: 'b-1', dropoffSequenceOrder: 1 } as any,
          { bookingId: 'b-4', dropoffSequenceOrder: 2 } as any,
        ],
        totalRouteDurationSec: 200,
        totalRouteDistanceMeters: 2000,
        maxDetourPercent: 10,
        oldestBookingCreatedAt: new Date('2026-11-20T10:00:00Z'),
        groupSize: 2,
      };

      // 'b-1,b-3' < 'b-1,b-4'
      expect(solver.compareCandidates(candA, candB)).toBeLessThan(0);
      expect(solver.compareCandidates(candB, candA)).toBeGreaterThan(0);
    });
  });

  describe('Performance Benchmark (24 Permutations for 4 Passengers)', () => {
    it('should evaluate 24 permutations rapidly in under 1 millisecond', () => {
      const members = [
        createMember('1'),
        createMember('2'),
        createMember('3'),
        createMember('4'),
      ];

      const matrix: MatrixData = {
        durations: [
          [0, 100, 180, 260, 340],
          [100, 0, 80, 160, 240],
          [180, 80, 0, 80, 160],
          [260, 160, 80, 0, 80],
          [340, 240, 160, 80, 0],
        ],
        distances: [
          [0, 1000, 1800, 2600, 3400],
          [1000, 0, 800, 1600, 2400],
          [1800, 800, 0, 800, 1600],
          [2600, 1600, 800, 0, 800],
          [3400, 2400, 1600, 800, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      };

      // Warmup
      for (let i = 0; i < 50; i++) {
        solver.solve(members, matrix);
      }

      const iterations = 1000;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        solver.solve(members, matrix);
      }
      const elapsedMs = performance.now() - start;
      const avgMsPerSolve = elapsedMs / iterations;

      console.log(
        `[BENCHMARK] PermutationSolver: ${iterations} evaluations of 24 permutations completed in ${elapsedMs.toFixed(2)}ms (avg: ${avgMsPerSolve.toFixed(4)}ms per 4-pax cluster)`,
      );

      // Verify mathematically that it evaluates safely without error
      expect(avgMsPerSolve).toBeLessThan(1.0); // Strict sanity bound, well under 1ms
    });
  });
});
