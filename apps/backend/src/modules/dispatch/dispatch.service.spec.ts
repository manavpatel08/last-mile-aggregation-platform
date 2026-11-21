import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { DispatchService } from './dispatch.service.js';
import { DRIVER_OFFER_TIMEOUT_MS } from './dispatch.interfaces.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { RoutingModule } from '../routing/routing.module.js';
import { RoutingService } from '../routing/routing.service.js';
import { DriversModule } from '../drivers/drivers.module.js';
import { DriversService } from '../drivers/drivers.service.js';
import { CACHE_KEYS } from '../../common/constants/index.js';
import configuration from '../../config/configuration.js';
import { validate } from '../../config/env.validation.js';

// ============================================================================
// PART 1: UNIT TESTS WITH MOCKS
// ============================================================================
describe('DispatchService - Unit Tests', () => {
  let service: DispatchService;
  let prismaMock: any;
  let driversServiceMock: any;
  let routingServiceMock: any;

  const mockPickupPointId = '00000000-0000-0000-0000-000000000001';
  const mockGroupId = '00000000-0000-0000-0000-000000000010';

  beforeEach(() => {
    prismaMock = {
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(prismaMock)),
      $queryRaw: vi.fn().mockImplementation((query: any) => {
        const text = Array.isArray(query)
          ? query.join(' ')
          : typeof query === 'string'
            ? query
            : (query?.strings?.join(' ') ?? '');

        if (text.includes('FROM ride_groups')) {
          return Promise.resolve([
            {
              id: mockGroupId,
              status: 'READY_FOR_DISPATCH',
              group_version: 1,
              pickup_point_id: mockPickupPointId,
            },
          ]);
        }
        return Promise.resolve([
          {
            id: mockPickupPointId,
            latitude: 23.155,
            longitude: 72.6668,
          },
        ]);
      }),
      rideGroup: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      driverProfile: {
        findMany: vi.fn(),
      },
      dispatchAttempt: {
        findFirst: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn(),
      },
      driverDispatchOffer: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };

    driversServiceMock = {
      getDriverGpsFix: vi.fn(),
    };

    routingServiceMock = {
      getTravelTimeMatrix: vi.fn(),
    };

    service = new DispatchService(
      prismaMock as unknown as PrismaService,
      driversServiceMock as unknown as DriversService,
      routingServiceMock as unknown as RoutingService,
    );
  });

  describe('findEligibleCandidateDrivers', () => {
    it('should query Prisma with correct eligibility filters', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        groupVersion: 1,
      });
      prismaMock.driverProfile.findMany.mockResolvedValue([]);

      await service.findEligibleCandidateDrivers(
        mockGroupId,
        mockPickupPointId,
        3,
      );

      expect(prismaMock.driverProfile.findMany).toHaveBeenCalledWith({
        where: {
          verificationStatus: 'APPROVED',
          isOnline: true,
          operationalStatus: 'AVAILABLE',
          vehicles: {
            some: {
              isActive: true,
              passengerCapacity: { gte: 3 },
            },
          },
          assignments: {
            none: {
              status: { in: ['RESERVED', 'ACTIVE'] },
            },
          },
          dispatchOffers: {
            none: {
              rideGroupId: mockGroupId,
              groupVersion: 1,
            },
          },
        },
        include: {
          vehicles: {
            where: { isActive: true },
            select: { passengerCapacity: true },
          },
        },
      });
    });

    it('should include attemptId in exclusion filter when provided', async () => {
      const mockAttemptId = '00000000-0000-0000-0000-000000000099';
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        groupVersion: 2,
      });
      prismaMock.driverProfile.findMany.mockResolvedValue([]);

      await service.findEligibleCandidateDrivers(
        mockGroupId,
        mockPickupPointId,
        2,
        mockAttemptId,
      );

      expect(prismaMock.driverProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            dispatchOffers: {
              none: {
                OR: [
                  { rideGroupId: mockGroupId, groupVersion: 2 },
                  { dispatchAttemptId: mockAttemptId },
                ],
              },
            },
          }),
        }),
      );
    });

    it('should exclude drivers without a fresh GPS fix in Redis', async () => {
      prismaMock.driverProfile.findMany.mockResolvedValue([
        {
          id: 'driver-no-gps',
          userId: 'user-1',
          licenseNumber: 'GJ01-1111',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
        {
          id: 'driver-with-gps',
          userId: 'user-2',
          licenseNumber: 'GJ01-2222',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
      ]);

      driversServiceMock.getDriverGpsFix
        .mockResolvedValueOnce(null) // driver-no-gps has expired/missing GPS
        .mockResolvedValueOnce({
          latitude: 23.15,
          longitude: 72.66,
          heading: null,
          speed: null,
          updatedAt: new Date().toISOString(),
        });

      routingServiceMock.getTravelTimeMatrix.mockResolvedValue({
        durations: [
          [0, 180],
          [180, 0],
        ],
        distances: [
          [0, 1200],
          [1200, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      });

      const candidates = await service.findEligibleCandidateDrivers(
        mockGroupId,
        mockPickupPointId,
        2,
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0].driverId).toBe('driver-with-gps');
      expect(candidates[0].etaSec).toBe(180);
    });

    it('should exclude drivers with malformed or out-of-bounds GPS fixes', async () => {
      prismaMock.driverProfile.findMany.mockResolvedValue([
        {
          id: 'driver-invalid-lat',
          userId: 'user-1',
          licenseNumber: 'GJ01-1111',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
        {
          id: 'driver-nan-coord',
          userId: 'user-2',
          licenseNumber: 'GJ01-2222',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
      ]);

      driversServiceMock.getDriverGpsFix
        .mockResolvedValueOnce({
          latitude: 95.0, // Invalid: > 90
          longitude: 72.66,
        })
        .mockResolvedValueOnce({
          latitude: Number.NaN,
          longitude: 72.66,
        });

      const candidates = await service.findEligibleCandidateDrivers(
        mockGroupId,
        mockPickupPointId,
        2,
      );

      expect(candidates).toHaveLength(0);
      expect(routingServiceMock.getTravelTimeMatrix).not.toHaveBeenCalled();
    });

    it('should accept valid boundary coordinates (-90, 90, -180, 180)', async () => {
      prismaMock.driverProfile.findMany.mockResolvedValue([
        {
          id: 'driver-bound-1',
          userId: 'user-b1',
          licenseNumber: 'GJ01-B1',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
        {
          id: 'driver-bound-2',
          userId: 'user-b2',
          licenseNumber: 'GJ01-B2',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
      ]);

      driversServiceMock.getDriverGpsFix
        .mockResolvedValueOnce({ latitude: -90, longitude: -180 })
        .mockResolvedValueOnce({ latitude: 90, longitude: 180 });

      routingServiceMock.getTravelTimeMatrix.mockResolvedValue({
        durations: [
          [0, 50, 100],
          [50, 0, 200],
          [100, 200, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      });

      const candidates = await service.findEligibleCandidateDrivers(
        mockGroupId,
        mockPickupPointId,
        2,
      );

      expect(candidates).toHaveLength(2);
      expect(candidates[0].driverId).toBe('driver-bound-1');
      expect(candidates[1].driverId).toBe('driver-bound-2');
    });

    it('should rank candidates strictly by OSRM ETA ascending', async () => {
      prismaMock.driverProfile.findMany.mockResolvedValue([
        {
          id: 'driver-far',
          userId: 'user-far',
          licenseNumber: 'GJ01-FAR',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
        {
          id: 'driver-close',
          userId: 'user-close',
          licenseNumber: 'GJ01-CLOSE',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
        {
          id: 'driver-mid',
          userId: 'user-mid',
          licenseNumber: 'GJ01-MID',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
      ]);

      driversServiceMock.getDriverGpsFix
        .mockResolvedValueOnce({ latitude: 23.14, longitude: 72.65 }) // far
        .mockResolvedValueOnce({ latitude: 23.154, longitude: 72.666 }) // close
        .mockResolvedValueOnce({ latitude: 23.15, longitude: 72.66 }); // mid

      // Pickup point is at index 3
      routingServiceMock.getTravelTimeMatrix.mockResolvedValue({
        durations: [
          [0, 50, 80, 500], // driver-far -> pickup: 500s
          [50, 0, 40, 90], // driver-close -> pickup: 90s
          [80, 40, 0, 240], // driver-mid -> pickup: 240s
          [500, 90, 240, 0], // pickup
        ],
        source: 'OSRM',
        isFallback: false,
      });

      const ranked = await service.findEligibleCandidateDrivers(
        mockGroupId,
        mockPickupPointId,
        2,
      );

      expect(ranked).toHaveLength(3);
      expect(ranked[0].driverId).toBe('driver-close');
      expect(ranked[0].etaSec).toBe(90);
      expect(ranked[1].driverId).toBe('driver-mid');
      expect(ranked[1].etaSec).toBe(240);
      expect(ranked[2].driverId).toBe('driver-far');
      expect(ranked[2].etaSec).toBe(500);
    });

    it('should break ties deterministically on equal ETAs using driverId ascending', async () => {
      prismaMock.driverProfile.findMany.mockResolvedValue([
        {
          id: 'driver-z-id',
          userId: 'user-z',
          licenseNumber: 'GJ01-ZZZ',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
        {
          id: 'driver-a-id',
          userId: 'user-a',
          licenseNumber: 'GJ01-AAA',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
        {
          id: 'driver-m-id',
          userId: 'user-m',
          licenseNumber: 'GJ01-MMM',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
      ]);

      driversServiceMock.getDriverGpsFix
        .mockResolvedValueOnce({ latitude: 23.151, longitude: 72.661 })
        .mockResolvedValueOnce({ latitude: 23.152, longitude: 72.662 })
        .mockResolvedValueOnce({ latitude: 23.153, longitude: 72.663 });

      // All drivers have identical ETA to pickup hub (index 3) = 150s
      routingServiceMock.getTravelTimeMatrix.mockResolvedValue({
        durations: [
          [0, 20, 20, 150],
          [20, 0, 20, 150],
          [20, 20, 0, 150],
          [150, 150, 150, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      });

      const ranked = await service.findEligibleCandidateDrivers(
        mockGroupId,
        mockPickupPointId,
        2,
      );

      expect(ranked).toHaveLength(3);
      // All have etaSec = 150, should be sorted alphabetically by driverId: a < m < z
      expect(ranked[0].driverId).toBe('driver-a-id');
      expect(ranked[1].driverId).toBe('driver-m-id');
      expect(ranked[2].driverId).toBe('driver-z-id');
    });

    it('should reject fallback and non-OSRM source, returning empty array', async () => {
      prismaMock.driverProfile.findMany.mockResolvedValue([
        {
          id: 'driver-1',
          userId: 'user-1',
          licenseNumber: 'GJ01-1111',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
      ]);

      driversServiceMock.getDriverGpsFix.mockResolvedValue({
        latitude: 23.15,
        longitude: 72.66,
      });

      // OSRM down -> circuit breaker returned fallback
      routingServiceMock.getTravelTimeMatrix.mockResolvedValue({
        durations: [[0, 200], [200, 0]],
        source: 'FALLBACK',
        isFallback: true,
      });

      const ranked = await service.findEligibleCandidateDrivers(
        mockGroupId,
        mockPickupPointId,
        2,
      );

      expect(ranked).toHaveLength(0);
    });

    it('should handle OSRM matrix exception gracefully and return empty array', async () => {
      prismaMock.driverProfile.findMany.mockResolvedValue([
        {
          id: 'driver-1',
          userId: 'user-1',
          licenseNumber: 'GJ01-1111',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
      ]);

      driversServiceMock.getDriverGpsFix.mockResolvedValue({
        latitude: 23.15,
        longitude: 72.66,
      });

      routingServiceMock.getTravelTimeMatrix.mockRejectedValue(
        new Error('Network connection refused'),
      );

      const ranked = await service.findEligibleCandidateDrivers(
        mockGroupId,
        mockPickupPointId,
        2,
      );

      expect(ranked).toHaveLength(0);
    });
  });

  describe('initiateDispatchForGroup', () => {
    it('should throw NotFoundException if ride group does not exist', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue(null);

      await expect(
        service.initiateDispatchForGroup('non-existent-group'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return error if ride group is not in eligible dispatch status', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        status: 'COMPLETED',
        members: [{ isActiveMember: true }],
      });

      const result = await service.initiateDispatchForGroup(mockGroupId);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('INVALID_GROUP_STATUS');
    });

    it('should return existing pending offer if already active (idempotency)', async () => {
      const mockExpiresAt = new Date(Date.now() + 15000);
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        status: 'READY_FOR_DISPATCH',
        members: [{ isActiveMember: true }],
      });

      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue({
        id: 'existing-offer-1',
        dispatchAttemptId: 'attempt-1',
        driverId: 'driver-1',
        expiresAt: mockExpiresAt,
        status: 'PENDING',
      });

      const result = await service.initiateDispatchForGroup(mockGroupId);

      expect(result.success).toBe(true);
      expect(result.offerId).toBe('existing-offer-1');
      expect(result.isExistingOffer).toBe(true);
      expect(prismaMock.driverDispatchOffer.create).not.toHaveBeenCalled();
    });

    it('should return NO_ELIGIBLE_DRIVERS if no candidates found', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        status: 'READY_FOR_DISPATCH',
        groupVersion: 1,
        pickupPointId: mockPickupPointId,
        members: [{ isActiveMember: true }, { isActiveMember: true }],
      });

      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);
      prismaMock.driverProfile.findMany.mockResolvedValue([]); // No drivers in DB

      const result = await service.initiateDispatchForGroup(mockGroupId);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('NO_ELIGIBLE_DRIVERS');
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('should atomically create attempt and offer for Rank #1 candidate with 20s timeout', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        status: 'READY_FOR_DISPATCH',
        groupVersion: 1,
        pickupPointId: mockPickupPointId,
        members: [{ isActiveMember: true }, { isActiveMember: true }],
      });

      // Quick pending offer check returns null
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);

      // Candidates available
      prismaMock.driverProfile.findMany.mockResolvedValue([
        {
          id: 'driver-rank1',
          userId: 'user-r1',
          licenseNumber: 'GJ01-R1',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
        {
          id: 'driver-rank2',
          userId: 'user-r2',
          licenseNumber: 'GJ01-R2',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
      ]);

      driversServiceMock.getDriverGpsFix
        .mockResolvedValueOnce({ latitude: 23.153, longitude: 72.665 })
        .mockResolvedValueOnce({ latitude: 23.15, longitude: 72.66 });

      routingServiceMock.getTravelTimeMatrix.mockResolvedValue({
        durations: [
          [0, 50, 110], // driver-rank1 -> pickup: 110s
          [50, 0, 290], // driver-rank2 -> pickup: 290s
          [110, 290, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      });

      prismaMock.dispatchAttempt.create.mockResolvedValue({
        id: 'attempt-created-1',
        rideGroupId: mockGroupId,
        groupVersion: 1,
        attemptNumber: 1,
        status: 'ACTIVE',
      });

      prismaMock.driverDispatchOffer.create.mockImplementation(({ data }: any) => {
        return Promise.resolve({
          id: 'offer-created-1',
          ...data,
        });
      });

      const beforeTime = Date.now();
      const result = await service.initiateDispatchForGroup(mockGroupId);
      const afterTime = Date.now();

      expect(result.success).toBe(true);
      expect(result.attemptId).toBe('attempt-created-1');
      expect(result.offerId).toBe('offer-created-1');
      expect(result.driverId).toBe('driver-rank1');
      expect(result.etaSec).toBe(110);
      expect(result.expiresAt).toBeDefined();

      // Verify 20-second timeout window
      const offerExpiry = result.expiresAt!.getTime();
      expect(offerExpiry).toBeGreaterThanOrEqual(beforeTime + DRIVER_OFFER_TIMEOUT_MS);
      expect(offerExpiry).toBeLessThanOrEqual(afterTime + DRIVER_OFFER_TIMEOUT_MS + 100);

      // Verify ride group transition to DISPATCHING
      expect(prismaMock.rideGroup.update).toHaveBeenCalledWith({
        where: { id: mockGroupId },
        data: { status: 'DISPATCHING' },
      });
    });
  });
});

// ============================================================================
// PART 2: DATABASE & INVARIANT INTEGRATION TESTS (PostgreSQL + PostGIS + Redis)
// ============================================================================
describe('DispatchService - Database & Invariant Integration Tests', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let redisService: RedisService;
  let routingService: RoutingService;
  let dispatchService: DispatchService;

  let pdeuPickupPointId: string;
  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdDriverIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
          validate,
          envFilePath: ['.env.local', '.env'],
        }),
        PrismaModule,
        RedisModule,
        RoutingModule,
        DriversModule,
      ],
      providers: [DispatchService],
    }).compile();

    await module.init();

    prisma = module.get<PrismaService>(PrismaService);
    redisService = module.get<RedisService>(RedisService);
    routingService = module.get<RoutingService>(RoutingService);
    dispatchService = module.get<DispatchService>(DispatchService);

    const pickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    expect(pickup).toBeDefined();
    pdeuPickupPointId = pickup!.id;
  });

  afterAll(async () => {
    await cleanupTestData();
    await module.close();
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  async function cleanupTestData() {
    try {
      // Clean up redis keys
      const redisClient = redisService.getClient();
      for (const dId of createdDriverIds) {
        await redisClient.del(`${CACHE_KEYS.DRIVER_GPS_PREFIX}${dId}`);
      }

      if (createdGroupIds.length > 0) {
        await prisma.driverDispatchOffer.deleteMany({
          where: { rideGroupId: { in: createdGroupIds } },
        });
        await prisma.driverAssignment.deleteMany({
          where: { rideGroupId: { in: createdGroupIds } },
        });
        await prisma.dispatchAttempt.deleteMany({
          where: { rideGroupId: { in: createdGroupIds } },
        });
        await prisma.groupRouteStop.deleteMany({
          where: { groupMember: { rideGroupId: { in: createdGroupIds } } },
        });
        await prisma.groupRouteVersion.deleteMany({
          where: { rideGroupId: { in: createdGroupIds } },
        });
        await prisma.groupMember.deleteMany({
          where: { rideGroupId: { in: createdGroupIds } },
        });
        await prisma.rideGroup.deleteMany({
          where: { id: { in: createdGroupIds } },
        });
      }

      if (createdBookingIds.length > 0) {
        await prisma.bookingStatusHistory.deleteMany({
          where: { bookingId: { in: createdBookingIds } },
        });
        await prisma.booking.deleteMany({
          where: { id: { in: createdBookingIds } },
        });
      }

      if (createdDriverIds.length > 0) {
        await prisma.vehicle.deleteMany({
          where: { driverProfileId: { in: createdDriverIds } },
        });
        await prisma.driverProfile.deleteMany({
          where: { id: { in: createdDriverIds } },
        });
      }

      if (createdUserIds.length > 0) {
        await prisma.fareQuote.deleteMany({
          where: { passengerId: { in: createdUserIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: createdUserIds } },
        });
      }
    } catch {
      // ignore errors during cleanup
    }
  }

  it('should successfully execute initial dispatch and transition group to DISPATCHING while bookings remain MATCHED', async () => {
    const testSuffix = randomUUID().substring(0, 8);

    // 1. Create Passenger & Booking in MATCHED status
    const passenger = await prisma.user.create({
      data: {
        email: `dispatch-pass-${testSuffix}@pdeu.ac.in`,
        fullName: 'Dispatch Test Passenger',
        role: 'PASSENGER',
      },
    });
    createdUserIds.push(passenger.id);

    const [quote] = await prisma.$queryRaw<Array<{ id: string }>>`
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
        ${passenger.id}::uuid,
        ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326),
        4000,
        600,
        6000,
        2000,
        3500,
        3500,
        1,
        NOW() + INTERVAL '5 minutes'
      ) RETURNING id;
    `;

    const [booking] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id,
        passenger_id,
        fare_quote_id,
        pickup_point_id,
        passenger_pickup_location,
        destination_location,
        requested_type,
        min_group_preference,
        status,
        agreed_fare_ceiling_paise,
        final_allocated_fare_paise,
        max_wait_deadline
      ) VALUES (
        gen_random_uuid(),
        ${passenger.id}::uuid,
        ${quote.id}::uuid,
        ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326),
        'SHARED',
        2,
        'MATCHED',
        3500,
        3000,
        NOW() + INTERVAL '5 minutes'
      ) RETURNING id;
    `;
    createdBookingIds.push(booking.id);

    // 2. Create RideGroup in READY_FOR_DISPATCH status
    const group = await prisma.rideGroup.create({
      data: {
        pickupPointId: pdeuPickupPointId,
        rideType: 'SHARED',
        groupVersion: 1,
        status: 'READY_FOR_DISPATCH',
        totalSharedFarePaise: 3000,
        totalRouteDistanceMeters: 4000,
        totalRouteDurationSec: 600,
      },
    });
    createdGroupIds.push(group.id);

    await prisma.groupMember.create({
      data: {
        rideGroupId: group.id,
        bookingId: booking.id,
        dropoffSequenceOrder: 1,
        directDistanceMeters: 4000,
        directDurationSec: 600,
        sharedDurationSec: 600,
        calculatedDetourPercent: 0,
        allocatedFarePaise: 3000,
        isActiveMember: true,
      },
    });

    // 3. Create Eligible Driver & Vehicle
    const driverUser = await prisma.user.create({
      data: {
        email: `dispatch-drv-${testSuffix}@pdeu.ac.in`,
        fullName: 'Dispatch Test Driver',
        role: 'DRIVER',
      },
    });
    createdUserIds.push(driverUser.id);

    const driverProfile = await prisma.driverProfile.create({
      data: {
        userId: driverUser.id,
        licenseNumber: `DL-${testSuffix}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });
    createdDriverIds.push(driverProfile.id);

    await prisma.vehicle.create({
      data: {
        driverProfileId: driverProfile.id,
        registrationNumber: `GJ-18-${testSuffix}`,
        passengerCapacity: 4,
        makeModel: 'Mahindra Treo',
        isActive: true,
      },
    });

    // Seed driver GPS into Redis
    const redisClient = redisService.getClient();
    await redisClient.set(
      `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driverProfile.id}`,
      JSON.stringify({
        latitude: 23.156,
        longitude: 72.667,
        heading: 90,
        speed: 15,
        updatedAt: new Date().toISOString(),
      }),
      'EX',
      30,
    );

    // Mock RoutingService to return valid OSRM response
    const travelTimeSpy = vi.spyOn(routingService, 'getTravelTimeMatrix');
    travelTimeSpy.mockResolvedValueOnce({
      durations: [
        [0, 120],
        [120, 0],
      ],
      distances: [
        [0, 800],
        [800, 0],
      ],
      source: 'OSRM',
      isFallback: false,
    });

    // 4. Initiate Dispatch
    const result = await dispatchService.initiateDispatchForGroup(group.id);

    expect(result.success).toBe(true);
    expect(result.driverId).toBe(driverProfile.id);
    expect(result.etaSec).toBe(120);
    expect(result.offerId).toBeDefined();
    expect(result.attemptId).toBeDefined();

    // 5. Verify PostgreSQL database state:
    // a. RideGroup status changed to DISPATCHING
    const updatedGroup = await prisma.rideGroup.findUnique({
      where: { id: group.id },
    });
    expect(updatedGroup!.status).toBe('DISPATCHING');

    // b. Booking status remains MATCHED
    const checkBooking = await prisma.booking.findUnique({
      where: { id: booking.id },
    });
    expect(checkBooking!.status).toBe('MATCHED');

    // c. DispatchAttempt record created
    const attempt = await prisma.dispatchAttempt.findUnique({
      where: { id: result.attemptId },
    });
    expect(attempt).toBeDefined();
    expect(attempt!.attemptNumber).toBe(1);
    expect(attempt!.status).toBe('ACTIVE');

    // d. DriverDispatchOffer record created with PENDING status and 20s expiry
    const offer = await prisma.driverDispatchOffer.findUnique({
      where: { id: result.offerId },
    });
    expect(offer).toBeDefined();
    expect(offer!.status).toBe('PENDING');
    expect(offer!.driverId).toBe(driverProfile.id);
    expect(offer!.expiresAt.getTime()).toBeGreaterThan(offer!.offeredAt.getTime() + 19000);

    // 6. Test Idempotency / Single Pending Offer per Group (Invariant 5)
    // Calling initiateDispatchForGroup again should return the existing offer cleanly
    const repeatResult = await dispatchService.initiateDispatchForGroup(group.id);
    expect(repeatResult.success).toBe(true);
    expect(repeatResult.offerId).toBe(offer!.id);
    expect(repeatResult.isExistingOffer).toBe(true);

    // 7. Verify Invariant 5 directly in PostgreSQL:
    // Trying to insert another PENDING offer directly should violate the partial unique index
    await expect(
      prisma.driverDispatchOffer.create({
        data: {
          dispatchAttemptId: attempt!.id,
          rideGroupId: group.id,
          groupVersion: 1,
          driverId: driverProfile.id,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 20000),
        },
      }),
    ).rejects.toThrow();

    // 8. Verify Invariant 6 directly in PostgreSQL:
    // Trying to insert another offer for same driver, group_version, and dispatch_attempt_id violates unique index
    await expect(
      prisma.driverDispatchOffer.create({
        data: {
          dispatchAttemptId: attempt!.id,
          rideGroupId: group.id,
          groupVersion: 1,
          driverId: driverProfile.id,
          status: 'EXPIRED',
          expiresAt: new Date(Date.now() + 20000),
        },
      }),
    ).rejects.toThrow();

    travelTimeSpy.mockRestore();
  });

  it('should cascade to next ranked eligible driver when previous offer is rejected/expired', async () => {
    const testSuffix = randomUUID().substring(0, 8);

    // 1. Create Passenger & Booking
    const passenger = await prisma.user.create({
      data: {
        email: `cascade-pass-${testSuffix}@pdeu.ac.in`,
        fullName: 'Cascade Passenger',
        role: 'PASSENGER',
      },
    });
    createdUserIds.push(passenger.id);

    const [quote] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id, passenger_id, pickup_point_id, destination_location,
        direct_distance_meters, direct_duration_sec,
        private_estimated_fare_paise, shared_min_fare_paise,
        shared_max_fare_paise, agreed_fare_ceiling_paise,
        tariff_version, expires_at
      ) VALUES (
        gen_random_uuid(), ${passenger.id}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326),
        4000, 600, 6000, 2000, 3500, 3500, 1,
        NOW() + INTERVAL '5 minutes'
      ) RETURNING id;
    `;

    const [booking] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id, passenger_id, fare_quote_id, pickup_point_id,
        passenger_pickup_location, destination_location,
        requested_type, min_group_preference, status,
        agreed_fare_ceiling_paise, final_allocated_fare_paise,
        max_wait_deadline
      ) VALUES (
        gen_random_uuid(), ${passenger.id}::uuid, ${quote.id}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326),
        'SHARED', 2, 'MATCHED',
        3500, 3000, NOW() + INTERVAL '5 minutes'
      ) RETURNING id;
    `;
    createdBookingIds.push(booking.id);

    const group = await prisma.rideGroup.create({
      data: {
        pickupPointId: pdeuPickupPointId,
        rideType: 'SHARED',
        groupVersion: 1,
        status: 'READY_FOR_DISPATCH',
        totalSharedFarePaise: 3000,
        totalRouteDistanceMeters: 4000,
        totalRouteDurationSec: 600,
      },
    });
    createdGroupIds.push(group.id);

    await prisma.groupMember.create({
      data: {
        rideGroupId: group.id,
        bookingId: booking.id,
        dropoffSequenceOrder: 1,
        directDistanceMeters: 4000,
        directDurationSec: 600,
        sharedDurationSec: 600,
        calculatedDetourPercent: 0,
        allocatedFarePaise: 3000,
        isActiveMember: true,
      },
    });

    // 2. Create Driver 1 and Driver 2
    const driverUser1 = await prisma.user.create({
      data: {
        email: `casc-drv1-${testSuffix}@pdeu.ac.in`,
        fullName: 'Cascade Driver 1',
        role: 'DRIVER',
      },
    });
    createdUserIds.push(driverUser1.id);

    const driverProfile1 = await prisma.driverProfile.create({
      data: {
        userId: driverUser1.id,
        licenseNumber: `DL-C1-${testSuffix}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });
    createdDriverIds.push(driverProfile1.id);

    await prisma.vehicle.create({
      data: {
        driverProfileId: driverProfile1.id,
        registrationNumber: `GJ-18-C1-${testSuffix}`,
        passengerCapacity: 4,
        makeModel: 'Mahindra Treo',
        isActive: true,
      },
    });

    const driverUser2 = await prisma.user.create({
      data: {
        email: `casc-drv2-${testSuffix}@pdeu.ac.in`,
        fullName: 'Cascade Driver 2',
        role: 'DRIVER',
      },
    });
    createdUserIds.push(driverUser2.id);

    const driverProfile2 = await prisma.driverProfile.create({
      data: {
        userId: driverUser2.id,
        licenseNumber: `DL-C2-${testSuffix}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });
    createdDriverIds.push(driverProfile2.id);

    await prisma.vehicle.create({
      data: {
        driverProfileId: driverProfile2.id,
        registrationNumber: `GJ-18-C2-${testSuffix}`,
        passengerCapacity: 4,
        makeModel: 'Mahindra Treo',
        isActive: true,
      },
    });

    // Seed GPS for both drivers
    const redisClient = redisService.getClient();
    await redisClient.set(
      `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driverProfile1.id}`,
      JSON.stringify({ latitude: 23.155, longitude: 72.666 }),
      'EX',
      30,
    );
    await redisClient.set(
      `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driverProfile2.id}`,
      JSON.stringify({ latitude: 23.158, longitude: 72.669 }),
      'EX',
      30,
    );

    // Mock OSRM to rank Driver 1 (100s) ahead of Driver 2 (200s)
    const travelSpy = vi.spyOn(routingService, 'getTravelTimeMatrix');
    travelSpy.mockResolvedValue({
      durations: [
        [0, 50, 100], // driver 1 -> pickup: 100s
        [50, 0, 200], // driver 2 -> pickup: 200s
        [100, 200, 0],
      ],
      distances: [
        [0, 500, 1000],
        [500, 0, 2000],
        [1000, 2000, 0],
      ],
      source: 'OSRM',
      isFallback: false,
    });

    // Offer 1 sent to Driver 1
    const result1 = await dispatchService.initiateDispatchForGroup(group.id);
    expect(result1.success).toBe(true);
    expect(result1.driverId).toBe(driverProfile1.id);

    // Driver 1 rejects / times out -> mark offer REJECTED
    await prisma.driverDispatchOffer.update({
      where: { id: result1.offerId },
      data: { status: 'REJECTED', respondedAt: new Date() },
    });

    // Mock OSRM for cascade: Driver 1 is now excluded, Driver 2 remains
    travelSpy.mockResolvedValueOnce({
      durations: [
        [0, 200], // driver 2 -> pickup: 200s
        [200, 0],
      ],
      source: 'OSRM',
      isFallback: false,
    });

    // Call initiateDispatchForGroup again -> cascades to Driver 2!
    const result2 = await dispatchService.initiateDispatchForGroup(group.id);
    expect(result2.success).toBe(true);
    expect(result2.driverId).toBe(driverProfile2.id);
    expect(result2.attemptId).toBe(result1.attemptId); // Same attempt preserved
    expect(result2.offerId).not.toBe(result1.offerId);

    // Verify Driver 2's offer is PENDING
    const offer2 = await prisma.driverDispatchOffer.findUnique({
      where: { id: result2.offerId },
    });
    expect(offer2!.status).toBe('PENDING');
    expect(offer2!.driverId).toBe(driverProfile2.id);

    travelSpy.mockRestore();
  });
});
