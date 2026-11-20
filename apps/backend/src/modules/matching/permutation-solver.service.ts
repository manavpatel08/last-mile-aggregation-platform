import { Injectable, Logger } from '@nestjs/common';

export interface CandidateMember {
  bookingId: string;
  passengerId: string;
  destination: { latitude: number; longitude: number };
  agreedFareCeilingPaise: number;
  minGroupPreference: number;
  createdAt: Date;
  maxWaitDeadline: Date;
}

export interface PermutationMemberEvaluation {
  bookingId: string;
  dropoffSequenceOrder: number; // 1-indexed (1, 2, 3, 4)
  directDistanceMeters: number;
  directDurationSec: number;
  sharedDistanceMeters: number;
  sharedDurationSec: number;
  calculatedDetourPercent: number; // e.g. 15.25
}

export interface FeasiblePermutationResult {
  members: CandidateMember[];
  orderedEvaluations: PermutationMemberEvaluation[];
  totalRouteDurationSec: number;
  totalRouteDistanceMeters: number;
  maxDetourPercent: number;
  oldestBookingCreatedAt: Date;
  groupSize: number;
}

export interface MatrixData {
  durations: number[][]; // seconds, (k+1) x (k+1)
  distances?: number[][]; // meters, (k+1) x (k+1)
  source?: string;
  isFallback?: boolean;
}

// Precomputed permutation index tuples to avoid allocations in hot loop
const PERMUTATIONS_2: ReadonlyArray<ReadonlyArray<number>> = [
  [1, 2],
  [2, 1],
];

const PERMUTATIONS_3: ReadonlyArray<ReadonlyArray<number>> = [
  [1, 2, 3],
  [1, 3, 2],
  [2, 1, 3],
  [2, 3, 1],
  [3, 1, 2],
  [3, 2, 1],
];

const PERMUTATIONS_4: ReadonlyArray<ReadonlyArray<number>> = [
  [1, 2, 3, 4],
  [1, 2, 4, 3],
  [1, 3, 2, 4],
  [1, 3, 4, 2],
  [1, 4, 2, 3],
  [1, 4, 3, 2],
  [2, 1, 3, 4],
  [2, 1, 4, 3],
  [2, 3, 1, 4],
  [2, 3, 4, 1],
  [2, 4, 1, 3],
  [2, 4, 3, 1],
  [3, 1, 2, 4],
  [3, 1, 4, 2],
  [3, 2, 1, 4],
  [3, 2, 4, 1],
  [3, 4, 1, 2],
  [3, 4, 2, 1],
  [4, 1, 2, 3],
  [4, 1, 3, 2],
  [4, 2, 1, 3],
  [4, 2, 3, 1],
  [4, 3, 1, 2],
  [4, 3, 2, 1],
];

export const MAX_ALLOWED_DETOUR_PERCENT = 25.0;
const EPSILON = 1e-6; // Account for floating-point precision at boundary

@Injectable()
export class PermutationSolver {
  private readonly logger = new Logger(PermutationSolver.name);

  /**
   * Evaluates all k! drop-off sequences for a candidate group of 2-4 passengers
   * against the provided (k+1) x (k+1) road-network duration & distance matrix.
   *
   * Enforces strict maximum 25.00% individual passenger detour.
   * Rejects immediately if matrix indicates approximate geodesic fallback.
   *
   * Returns the best feasible permutation for the group, or null if no permutation is feasible.
   */
  solve(
    members: CandidateMember[],
    matrix: MatrixData,
  ): FeasiblePermutationResult | null {
    const k = members.length;
    if (k < 2 || k > 4) {
      this.logger.debug(`Invalid group size for permutation solver: ${k}`);
      return null;
    }

    // Critical Routing Safety: Haversine/geodesic fallback or non-OSRM source cannot be treated as authoritative road metrics
    if (
      matrix.isFallback === true ||
      matrix.source === 'FALLBACK' ||
      (matrix.source !== undefined && matrix.source !== 'OSRM')
    ) {
      this.logger.warn(
        `PermutationSolver: Rejected matrix because source is not authoritative OSRM (source=${matrix.source}, isFallback=${matrix.isFallback})`,
      );
      return null;
    }

    const expectedDim = k + 1;
    if (
      !matrix.durations ||
      matrix.durations.length < expectedDim
    ) {
      this.logger.warn('PermutationSolver: Incomplete matrix dimensions provided');
      return null;
    }

    const permutations = this.getPermutations(k);
    if (!permutations) {
      return null;
    }

    let bestResult: FeasiblePermutationResult | null = null;

    // Find earliest booking creation timestamp for tie-breaking
    let oldestBookingCreatedAt = members[0].createdAt;
    for (let i = 1; i < k; i++) {
      if (members[i].createdAt < oldestBookingCreatedAt) {
        oldestBookingCreatedAt = members[i].createdAt;
      }
    }

    for (let pIdx = 0; pIdx < permutations.length; pIdx++) {
      const perm = permutations[pIdx];
      let isFeasible = true;
      let totalRouteDurationSec = 0;
      let totalRouteDistanceMeters = 0;
      let maxDetourPercent = 0;

      // Cumulative metrics along the route: origin (0) -> perm[0] -> perm[1] ... -> perm[k-1]
      let currentLegOrigin = 0;
      let cumulativeSharedDuration = 0;
      let cumulativeSharedDistance = 0;

      const evaluations: PermutationMemberEvaluation[] = [];

      for (let step = 0; step < k; step++) {
        const destIdx = perm[step]; // 1-indexed destination in matrix
        const member = members[destIdx - 1];

        const legDuration = matrix.durations[currentLegOrigin]?.[destIdx];
        const legDistance = matrix.distances?.[currentLegOrigin]?.[destIdx] ?? 0;
        const directDuration = matrix.durations[0]?.[destIdx];
        const directDistance = matrix.distances?.[0]?.[destIdx] ?? 0;

        if (
          legDuration === undefined ||
          legDuration < 0 ||
          directDuration === undefined ||
          directDuration <= 0
        ) {
          isFeasible = false;
          break;
        }

        cumulativeSharedDuration += legDuration;
        cumulativeSharedDistance += legDistance;

        // Individual detour calculation: (Shared - Direct) / Direct * 100%
        const detourPercent =
          ((cumulativeSharedDuration - directDuration) / directDuration) * 100;

        // Strict 25.00% detour constraint check
        if (detourPercent > MAX_ALLOWED_DETOUR_PERCENT + EPSILON) {
          isFeasible = false;
          break;
        }

        const normalizedDetour = Math.max(0, detourPercent);
        if (normalizedDetour > maxDetourPercent) {
          maxDetourPercent = normalizedDetour;
        }

        evaluations[step] = {
          bookingId: member.bookingId,
          dropoffSequenceOrder: step + 1,
          directDistanceMeters: Math.round(directDistance),
          directDurationSec: Math.round(directDuration),
          sharedDistanceMeters: Math.round(cumulativeSharedDistance),
          sharedDurationSec: Math.round(cumulativeSharedDuration),
          calculatedDetourPercent: Number(normalizedDetour.toFixed(2)),
        };

        currentLegOrigin = destIdx;
      }

      if (!isFeasible) {
        continue;
      }

      totalRouteDurationSec = cumulativeSharedDuration;
      totalRouteDistanceMeters = cumulativeSharedDistance;

      const candidateResult: FeasiblePermutationResult = {
        members,
        orderedEvaluations: evaluations,
        totalRouteDurationSec: Math.round(totalRouteDurationSec),
        totalRouteDistanceMeters: Math.round(totalRouteDistanceMeters),
        maxDetourPercent: Number(maxDetourPercent.toFixed(2)),
        oldestBookingCreatedAt,
        groupSize: k,
      };

      if (!bestResult) {
        bestResult = candidateResult;
      } else {
        // Compare with existing best sequence for this specific candidate group
        if (this.compareSequences(candidateResult, bestResult) < 0) {
          bestResult = candidateResult;
        }
      }
    }

    return bestResult;
  }

  /**
   * Compares two feasible candidate group results according to the approved hierarchical rules:
   * 1. Group Size (higher is better: 4-pax > 3-pax > 2-pax).
   * 2. Lowest total vehicle travel time (totalRouteDurationSec ascending).
   * 3. Lowest maximum individual detour (maxDetourPercent ascending).
   * 4. Oldest booking timestamp (oldestBookingCreatedAt ascending).
   * 5. Deterministic tie-breaking (lexicographical comparison of sorted booking IDs).
   *
   * Returns:
   * < 0 if A is better than B
   * > 0 if B is better than A
   * 0 if completely tied
   */
  compareCandidates(
    a: FeasiblePermutationResult,
    b: FeasiblePermutationResult,
  ): number {
    // 1. Group Size (larger is preferred)
    if (a.groupSize !== b.groupSize) {
      return b.groupSize - a.groupSize;
    }

    return this.compareSequences(a, b);
  }

  /**
   * Compares two candidate sequences of the SAME group size:
   * 1. Lowest total vehicle travel time.
   * 2. Lowest maximum individual detour.
   * 3. Oldest booking timestamp.
   * 4. Deterministic tie-break.
   */
  private compareSequences(
    a: FeasiblePermutationResult,
    b: FeasiblePermutationResult,
  ): number {
    // 1. Total Route Duration
    if (a.totalRouteDurationSec !== b.totalRouteDurationSec) {
      return a.totalRouteDurationSec - b.totalRouteDurationSec;
    }

    // 2. Maximum Individual Detour
    if (Math.abs(a.maxDetourPercent - b.maxDetourPercent) > EPSILON) {
      return a.maxDetourPercent - b.maxDetourPercent;
    }

    // 3. Oldest Booking Created At
    const timeDiff =
      a.oldestBookingCreatedAt.getTime() - b.oldestBookingCreatedAt.getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }

    // 4. Deterministic tie-break: sorted member booking IDs
    const aIds = a.orderedEvaluations.map((e) => e.bookingId).sort().join(',');
    const bIds = b.orderedEvaluations.map((e) => e.bookingId).sort().join(',');
    return aIds.localeCompare(bIds);
  }

  private getPermutations(k: number): ReadonlyArray<ReadonlyArray<number>> | null {
    switch (k) {
      case 2:
        return PERMUTATIONS_2;
      case 3:
        return PERMUTATIONS_3;
      case 4:
        return PERMUTATIONS_4;
      default:
        return null;
    }
  }
}
