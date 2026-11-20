import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { RoutingService } from '../routing/routing.service.js';
import { CreateQuoteDto } from './dto/create-quote.dto.js';

export interface FareAllocationMember {
  id: string;
  soloFarePaise: number;
  ceilingPaise: number;
}

export interface AllocatedFareResult {
  id: string;
  allocatedFarePaise: number;
}

@Injectable()
export class FaresService {
  private readonly logger = new Logger(FaresService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locationsService: LocationsService,
    private readonly routingService: RoutingService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Calculates the individual solo reference fare S_i in paise
   * S_i = max(minFare, baseFare + round((distanceMeters / 1000) * perKmRate))
   */
  calculateSoloFarePaise(
    distanceMeters: number,
    baseFarePaise = 2000,
    perKmRatePaise = 1000,
    minFarePaise = 2000,
  ): number {
    const distanceCost = Math.round((distanceMeters / 1000) * perKmRatePaise);
    return Math.max(minFarePaise, baseFarePaise + distanceCost);
  }

  /**
   * Generates a 2-minute binding fare quote for a passenger
   */
  async generateQuote(userId: string, dto: CreateQuoteDto) {
    // 1. Validate destination resides inside Gandhinagar service region
    const destValidation = await this.locationsService.validateDestination(
      dto.destination.latitude,
      dto.destination.longitude,
    );

    if (!destValidation.isInsideServiceRegion) {
      throw new BadRequestException({
        errorCode: 'DESTINATION_OUTSIDE_SERVICE_AREA',
        message:
          'Destination coordinates are outside the authorized Gandhinagar service region.',
      });
    }

    // 2. Fetch pickup point coordinates
    const pickupPoints = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        latitude: number;
        longitude: number;
      }>
    >`
      SELECT
        id,
        name,
        ST_Y(center_point::geometry) as latitude,
        ST_X(center_point::geometry) as longitude
      FROM pickup_points
      WHERE id = ${dto.pickupPointId}::uuid AND is_active = true;
    `;

    if (!pickupPoints || pickupPoints.length === 0) {
      throw new NotFoundException({
        errorCode: 'PICKUP_POINT_NOT_FOUND',
        message: 'Selected pickup point not found or is currently inactive.',
      });
    }

    const pickupPoint = pickupPoints[0];

    // 3. Compute direct solo route and distance via RoutingService (OSRM / Fallback)
    const route = await this.routingService.getRoute(
      {
        latitude: Number(pickupPoint.latitude),
        longitude: Number(pickupPoint.longitude),
      },
      dto.destination,
    );

    this.routingService.assertAuthoritativeRoute(
      route,
      'Fare quote generation',
    );

    if (route.isFallback) {
      this.logger.warn(
        'Binding quote generated using geodesic fallback in demo/test mode.',
      );
    }

    // 4. Retrieve active tariff configuration
    const activeTariff = await this.prisma.fareConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    });

    const baseFarePaise = activeTariff?.baseFarePaise ?? 2000;
    const perKmRatePaise = activeTariff?.perKmRatePaise ?? 1000;
    const minFarePaise = activeTariff?.minFarePaise ?? 2000;
    const tariffVersion = activeTariff?.version ?? 1;

    // 5. Compute solo reference fare and ceiling
    const privateEstimatedFarePaise = this.calculateSoloFarePaise(
      route.distanceMeters,
      baseFarePaise,
      perKmRatePaise,
      minFarePaise,
    );

    const sharedMinFarePaise = minFarePaise;
    const sharedMaxFarePaise = privateEstimatedFarePaise;
    const agreedFareCeilingPaise = privateEstimatedFarePaise;
    const expiresAt = new Date(Date.now() + 120 * 1000); // Exactly 2 minutes

    // 6. Persist to fare_quotes table
    const [quote] = await this.prisma.$queryRaw<
      Array<{ id: string; expires_at: Date }>
    >`
      INSERT INTO fare_quotes (
        id,
        passenger_id,
        pickup_point_id,
        destination_location,
        direct_distance_meters,
        direct_duration_sec,
        private_estimated_fare_paise,
        shared_min_fare_paise,
        shared_max_fare_paise,
        agreed_fare_ceiling_paise,
        tariff_version,
        expires_at
      ) VALUES (
        gen_random_uuid(),
        ${userId}::uuid,
        ${pickupPoint.id}::uuid,
        ST_SetSRID(ST_MakePoint(${dto.destination.longitude}, ${dto.destination.latitude}), 4326),
        ${route.distanceMeters},
        ${route.durationSec},
        ${privateEstimatedFarePaise},
        ${sharedMinFarePaise},
        ${sharedMaxFarePaise},
        ${agreedFareCeilingPaise},
        ${tariffVersion},
        ${expiresAt}
      ) RETURNING id, expires_at;
    `;

    return {
      quoteId: quote.id,
      pickupPointId: pickupPoint.id,
      pickupPointName: pickupPoint.name,
      directDistanceMeters: route.distanceMeters,
      directDurationSec: route.durationSec,
      privateEstimatedFare: (privateEstimatedFarePaise / 100).toFixed(2),
      privateEstimatedFarePaise,
      sharedEstimatedRange: {
        minFare: (sharedMinFarePaise / 100).toFixed(2),
        maxFare: (sharedMaxFarePaise / 100).toFixed(2),
      },
      sharedEstimatedRangePaise: {
        minFarePaise: sharedMinFarePaise,
        maxFarePaise: sharedMaxFarePaise,
      },
      agreedFareCeiling: (agreedFareCeilingPaise / 100).toFixed(2),
      agreedFareCeilingPaise,
      tariffVersion,
      expiresAt: quote.expires_at.toISOString(),
    };
  }

  /**
   * Implements the approved Proportional Solo-Fare Allocation Formula
   * with deterministic whole-rupee rounding and remainder reconciliation
   */
  allocateSharedFares(
    members: FareAllocationMember[],
    totalSharedDistanceMeters: number,
    baseFarePaise = 2000,
    perKmRatePaise = 1000,
  ): AllocatedFareResult[] {
    const k = members.length;
    if (k < 2 || k > 4) {
      throw new BadRequestException({
        errorCode: 'INVALID_GROUP_SIZE',
        message: `Group size must be between 2 and 4 (received ${k}).`,
      });
    }

    // 1. Group Fare G
    const groupFarePaise =
      baseFarePaise +
      Math.round((totalSharedDistanceMeters / 1000) * perKmRatePaise);

    // 2. Sum of solo fares
    const sumSoloFares = members.reduce(
      (acc, m) => acc + m.soloFarePaise,
      0,
    );

    if (sumSoloFares === 0) {
      throw new BadRequestException({
        errorCode: 'INVALID_SOLO_FARES',
        message: 'Sum of solo reference fares cannot be zero.',
      });
    }

    // 3. Raw proportional allocations and whole-rupee rounding
    // Round to nearest 100 paise (whole rupee) with 50 paise rounding upward
    const allocations = members.map((m) => {
      const rawPaise = (groupFarePaise * m.soloFarePaise) / sumSoloFares;
      const roundedRupees = Math.floor((rawPaise + 50) / 100);
      const roundedPaise = Math.max(2000, roundedRupees * 100); // Minimum 2000 paise
      return {
        id: m.id,
        soloFarePaise: m.soloFarePaise,
        ceilingPaise: m.ceilingPaise,
        allocatedFarePaise: Math.min(m.ceilingPaise, roundedPaise),
      };
    });

    // 4. Compute remainder discrepancy Delta
    const sumRounded = allocations.reduce(
      (acc, m) => acc + m.allocatedFarePaise,
      0,
    );
    let delta = groupFarePaise - sumRounded; // In paise (multiples of 100)

    // 5. Deterministic Remainder Allocation (sorted descending by solo reference fare, then ascending by ID for secondary tie-breaker)
    allocations.sort((a, b) => {
      if (b.soloFarePaise !== a.soloFarePaise) {
        return b.soloFarePaise - a.soloFarePaise;
      }
      return a.id.localeCompare(b.id);
    });

    let safety = 0;
    while (delta !== 0 && safety < 20) {
      safety++;
      if (delta > 0) {
        // Driver earnings short: add 100 paise (₹1) to passenger with headroom
        let adjusted = false;
        for (const alloc of allocations) {
          if (alloc.allocatedFarePaise + 100 <= alloc.ceilingPaise) {
            alloc.allocatedFarePaise += 100;
            delta -= 100;
            adjusted = true;
            break;
          }
        }
        if (!adjusted) break; // Cannot reconcile without exceeding ceilings
      } else if (delta < 0) {
        // Driver earnings exceeded: deduct 100 paise (₹1) from passenger above floor
        let adjusted = false;
        for (const alloc of allocations) {
          if (alloc.allocatedFarePaise - 100 >= 2000) {
            alloc.allocatedFarePaise -= 100;
            delta += 100;
            adjusted = true;
            break;
          }
        }
        if (!adjusted) break;
      }
    }

    // 6. Invariant verification: Delta must be 0 and no commuter fare ceiling breached
    const finalSum = allocations.reduce(
      (acc, m) => acc + m.allocatedFarePaise,
      0,
    );

    if (finalSum !== groupFarePaise || delta !== 0) {
      throw new UnprocessableEntityException({
        errorCode: 'FARE_ALLOCATION_INFEASIBLE',
        message:
          'Shared fare allocation discrepancy cannot be reconciled without violating commuter fare ceilings. Group is infeasible.',
      });
    }

    for (const alloc of allocations) {
      if (alloc.allocatedFarePaise > alloc.ceilingPaise) {
        throw new UnprocessableEntityException({
          errorCode: 'FARE_ALLOCATION_INFEASIBLE',
          message: `Allocated fare for member ${alloc.id} (${alloc.allocatedFarePaise} paise) exceeds binding ceiling (${alloc.ceilingPaise} paise).`,
        });
      }
    }

    return allocations.map((a) => ({
      id: a.id,
      allocatedFarePaise: a.allocatedFarePaise,
    }));
  }
}
