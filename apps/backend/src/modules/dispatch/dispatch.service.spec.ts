import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DispatchService } from './dispatch.service.js';
import {
  DRIVER_OFFER_TIMEOUT_MS,
  DISPATCH_TIMEOUT_JOB_NAME,
} from './dispatch.interfaces.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { QueueModule } from '../../infrastructure/queues/queue.module.js';
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
  let dispatchQueueMock: any;

  const mockPickupPointId = '00000000-0000-0000-0000-000000000001';
  const mockGroupId = '00000000-0000-0000-0000-000000000010';
  const mockDriverId = '00000000-0000-0000-0000-000000000020';
  const mockUserId = '00000000-0000-0000-0000-000000000030';
  const mockOfferId = '00000000-0000-0000-0000-000000000040';

  beforeEach(() => {
    prismaMock = {
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(prismaMock)),
      $executeRaw: vi.fn().mockResolvedValue(1),
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
              total_shared_fare_paise: 3000,
            },
          ]);
        }
        if (text.includes('FROM driver_profiles')) {
          return Promise.resolve([
            {
              id: mockDriverId,
              operational_status: 'AVAILABLE',
              is_online: true,
              verification_status: 'APPROVED',
            },
          ]);
        }
        if (text.includes('FROM driver_dispatch_offers')) {
          return Promise.resolve([
            {
              id: mockOfferId,
              status: 'PENDING',
              group_version: 1,
              dispatch_attempt_id: 'attempt-1',
              expires_at: new Date(Date.now() + 20000),
              driver_id: mockDriverId,
              ride_group_id: mockGroupId,
            },
          ]);
        }
        if (text.includes('FROM group_route_stops')) {
          return Promise.resolve([
            {
              id: 'stop-1',
              stop_order: 1,
              stop_type: 'DROPOFF',
              latitude: 23.18,
              longitude: 72.68,
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
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
      dispatchAttempt: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn(),
        update: vi.fn(),
      },
      driverDispatchOffer: {
        findUnique: vi.fn().mockResolvedValue({
          id: mockOfferId,
          rideGroupId: mockGroupId,
          driverId: mockDriverId,
          status: 'PENDING',
          groupVersion: 1,
          dispatchAttemptId: 'attempt-1',
          expiresAt: new Date(Date.now() + 20000),
        }),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      driverAssignment: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'assign-1' }),
      },
      groupMember: {
        findMany: vi.fn(),
      },
      groupRouteVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'rv-1',
          versionNumber: 1,
          routeGeometry: { type: 'LineString', coordinates: [] },
        }),
      },
      trip: {
        create: vi.fn().mockResolvedValue({ id: 'trip-1' }),
      },
      tripStatusHistory: {
        create: vi.fn(),
      },
      tripPassenger: {
        create: vi.fn().mockResolvedValue({ id: 'tp-1' }),
      },
      boardingVerification: {
        create: vi.fn(),
      },
      booking: {
        update: vi.fn(),
      },
      bookingStatusHistory: {
        create: vi.fn(),
      },
      outboxEvent: {
        create: vi.fn(),
      },
    };

    driversServiceMock = {
      getDriverGpsFix: vi.fn(),
    };

    routingServiceMock = {
      getTravelTimeMatrix: vi.fn(),
    };

    dispatchQueueMock = {
      add: vi.fn().mockResolvedValue({ id: 'job-1' }),
      getJob: vi.fn(),
    };

    service = new DispatchService(
      prismaMock as unknown as PrismaService,
      driversServiceMock as unknown as DriversService,
      routingServiceMock as unknown as RoutingService,
      dispatchQueueMock as any,
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
        .mockResolvedValueOnce(null)
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
          latitude: 95.0,
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
        .mockResolvedValueOnce({ latitude: 23.14, longitude: 72.65 })
        .mockResolvedValueOnce({ latitude: 23.154, longitude: 72.666 })
        .mockResolvedValueOnce({ latitude: 23.15, longitude: 72.66 });

      routingServiceMock.getTravelTimeMatrix.mockResolvedValue({
        durations: [
          [0, 50, 80, 500],
          [50, 0, 40, 90],
          [80, 40, 0, 240],
          [500, 90, 240, 0],
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
      expect(ranked[0].driverId).toBe('driver-a-id');
      expect(ranked[1].driverId).toBe('driver-m-id');
      expect(ranked[2].driverId).toBe('driver-z-id');
    });

    it('should reject fallback and non-OSRM source by throwing ServiceUnavailableException', async () => {
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

      routingServiceMock.getTravelTimeMatrix.mockResolvedValue({
        durations: [[0, 200], [200, 0]],
        source: 'FALLBACK',
        isFallback: true,
      });

      await expect(
        service.findEligibleCandidateDrivers(
          mockGroupId,
          mockPickupPointId,
          2,
        ),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('should handle OSRM matrix exception by throwing ServiceUnavailableException', async () => {
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

      await expect(
        service.findEligibleCandidateDrivers(
          mockGroupId,
          mockPickupPointId,
          2,
        ),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('initiateDispatchForGroup & Timeout Scheduling', () => {
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

    it('should mark attempt EXHAUSTED when fleet has no eligible drivers', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        status: 'READY_FOR_DISPATCH',
        groupVersion: 1,
        pickupPointId: mockPickupPointId,
        members: [{ isActiveMember: true }, { isActiveMember: true }],
      });

      prismaMock.dispatchAttempt.findFirst.mockResolvedValue({
        id: 'active-attempt-1',
        status: 'ACTIVE',
      });

      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);
      prismaMock.driverProfile.findMany.mockResolvedValue([]);

      const result = await service.initiateDispatchForGroup(mockGroupId);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('FLEET_EXHAUSTED');
      expect(prismaMock.dispatchAttempt.update).toHaveBeenCalledWith({
        where: { id: 'active-attempt-1' },
        data: { status: 'EXHAUSTED' },
      });
      expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: 'DISPATCH_ATTEMPT_EXHAUSTED',
          }),
        }),
      );
    });

    it('should create attempt with status EXHAUSTED and outbox event when initial dispatch has no candidate drivers', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        status: 'READY_FOR_DISPATCH',
        groupVersion: 1,
        pickupPointId: mockPickupPointId,
        members: [{ isActiveMember: true }, { isActiveMember: true }],
      });

      // No active attempt initially
      prismaMock.dispatchAttempt.findFirst.mockResolvedValue(null);
      prismaMock.dispatchAttempt.create.mockResolvedValue({
        id: 'initial-exhausted-attempt',
        rideGroupId: mockGroupId,
        groupVersion: 1,
        attemptNumber: 1,
        status: 'EXHAUSTED',
      });

      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);
      prismaMock.driverProfile.findMany.mockResolvedValue([]);

      const result = await service.initiateDispatchForGroup(mockGroupId);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('FLEET_EXHAUSTED');
      expect(result.retryable).toBe(true);
      expect(prismaMock.dispatchAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rideGroupId: mockGroupId,
          groupVersion: 1,
          attemptNumber: 1,
          status: 'EXHAUSTED',
        }),
      });
      expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: 'DISPATCH_ATTEMPT_EXHAUSTED',
          }),
        }),
      );
    });

    it('Scenario 1: repeated retries with zero drivers should reuse exhausted attempt and not recreate attempt 1 or duplicate attempts', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        status: 'READY_FOR_DISPATCH',
        groupVersion: 1,
        pickupPointId: mockPickupPointId,
        members: [{ isActiveMember: true }, { isActiveMember: true }],
      });

      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);
      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.driverProfile.findMany.mockResolvedValue([]);

      // Attempt 1 already exists and is EXHAUSTED
      const existingExhaustedAttempt = {
        id: 'attempt-exhausted-1',
        rideGroupId: mockGroupId,
        groupVersion: 1,
        attemptNumber: 1,
        status: 'EXHAUSTED',
      };

      // activeAttempt query returns null (since status is EXHAUSTED), latestAttempt returns attempt 1
      prismaMock.dispatchAttempt.findFirst.mockResolvedValue(existingExhaustedAttempt);

      const result = await service.initiateDispatchForGroup(mockGroupId);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('FLEET_EXHAUSTED');
      expect(result.retryable).toBe(true);
      expect(result.attemptId).toBe(existingExhaustedAttempt.id);

      // Must NOT create a new attempt or duplicate attemptNumber: 1
      expect(prismaMock.dispatchAttempt.create).not.toHaveBeenCalled();
      // Must NOT update or emit duplicate event for already EXHAUSTED attempt
      expect(prismaMock.dispatchAttempt.update).not.toHaveBeenCalled();
    });

    it('Scenario 1: zero drivers -> exhausted attempt 1 -> retry -> driver becomes available -> successful offer creation on attempt 2', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        status: 'READY_FOR_DISPATCH',
        groupVersion: 1,
        pickupPointId: mockPickupPointId,
        members: [{ isActiveMember: true }, { isActiveMember: true }],
      });

      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);
      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);

      // In initial dispatch: activeAttempt is null
      prismaMock.dispatchAttempt.findFirst.mockResolvedValue(null);

      // Driver becomes eligible on retry
      prismaMock.driverProfile.findMany.mockResolvedValue([
        {
          id: 'driver-rank1',
          userId: 'user-r1',
          licenseNumber: 'GJ01-R1',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
      ]);

      driversServiceMock.getDriverGpsFix.mockResolvedValue({
        latitude: 23.153,
        longitude: 72.665,
      });

      routingServiceMock.getTravelTimeMatrix.mockResolvedValue({
        durations: [
          [0, 60],
          [60, 0],
        ],
        distances: [
          [0, 500],
          [500, 0],
        ],
        source: 'OSRM',
        isFallback: false,
      });

      const attempt2Mock = {
        id: 'attempt-uuid-2',
        rideGroupId: mockGroupId,
        groupVersion: 1,
        attemptNumber: 2,
        status: 'ACTIVE',
      };

      const offerMock = {
        id: 'offer-uuid-2',
        dispatchAttemptId: attempt2Mock.id,
        rideGroupId: mockGroupId,
        groupVersion: 1,
        driverId: 'driver-rank1',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 20000),
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([
            {
              id: mockGroupId,
              status: 'READY_FOR_DISPATCH',
              group_version: 1,
              pickup_point_id: mockPickupPointId,
            },
          ]),
          driverDispatchOffer: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue(offerMock),
          },
          dispatchAttempt: {
            findFirst: vi.fn().mockResolvedValue(null), // no active attempt in tx
            count: vi.fn().mockResolvedValue(1), // 1 previous exhausted attempt exists!
            create: vi.fn().mockResolvedValue(attempt2Mock),
          },
          rideGroup: {
            update: vi.fn().mockResolvedValue({}),
          },
          outboxEvent: {
            create: vi.fn().mockResolvedValue({}),
          },
        };
        return cb(txMock);
      });

      const result = await service.initiateDispatchForGroup(mockGroupId);

      expect(result.success).toBe(true);
      expect(result.attemptId).toBe(attempt2Mock.id);
      expect(result.offerId).toBe(offerMock.id);
      expect(result.driverId).toBe('driver-rank1');
    });

    it('Scenario 2: fast-path idempotency should immediately return success when driver is already assigned to the group', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        status: 'DRIVER_ASSIGNED',
        groupVersion: 1,
        pickupPointId: mockPickupPointId,
        members: [{ isActiveMember: true }, { isActiveMember: true }],
      });

      prismaMock.driverAssignment.findFirst.mockResolvedValue({
        id: 'assignment-uuid-1',
        rideGroupId: mockGroupId,
        driverId: 'driver-assigned-1',
        dispatchAttemptId: 'attempt-uuid-1',
        status: 'RESERVED',
      });

      const result = await service.initiateDispatchForGroup(mockGroupId);

      expect(result.success).toBe(true);
      expect(result.isExistingAssignment).toBe(true);
      expect(result.attemptId).toBe('attempt-uuid-1');
      expect(result.driverId).toBe('driver-assigned-1');
      // Candidate search and transaction must NOT be triggered
      expect(prismaMock.driverProfile.findMany).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('should return retryable ROUTING_UNAVAILABLE when OSRM routing fails during candidate ranking', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        status: 'READY_FOR_DISPATCH',
        groupVersion: 1,
        pickupPointId: mockPickupPointId,
        members: [{ isActiveMember: true }, { isActiveMember: true }],
      });

      prismaMock.dispatchAttempt.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);

      prismaMock.driverProfile.findMany.mockResolvedValue([
        {
          id: 'driver-r1',
          userId: 'user-r1',
          licenseNumber: 'GJ01-R1',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
      ]);

      driversServiceMock.getDriverGpsFix.mockResolvedValue({
        latitude: 23.153,
        longitude: 72.665,
      });

      routingServiceMock.getTravelTimeMatrix.mockRejectedValue(
        new Error('OSRM connection refused'),
      );

      const result = await service.initiateDispatchForGroup(mockGroupId);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('ROUTING_UNAVAILABLE');
      expect(result.retryable).toBe(true);
      // Attempt should NOT be marked EXHAUSTED on OSRM error
      expect(prismaMock.dispatchAttempt.update).not.toHaveBeenCalled();
      expect(prismaMock.driverDispatchOffer.create).not.toHaveBeenCalled();
    });

    it('should atomically create attempt, offer, outbox event and schedule 20s delayed timeout job', async () => {
      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: mockGroupId,
        status: 'READY_FOR_DISPATCH',
        groupVersion: 1,
        pickupPointId: mockPickupPointId,
        members: [{ isActiveMember: true }, { isActiveMember: true }],
      });

      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);

      prismaMock.driverProfile.findMany.mockResolvedValue([
        {
          id: 'driver-rank1',
          userId: 'user-r1',
          licenseNumber: 'GJ01-R1',
          operationalStatus: 'AVAILABLE',
          vehicles: [{ passengerCapacity: 4 }],
        },
      ]);

      driversServiceMock.getDriverGpsFix.mockResolvedValue({
        latitude: 23.153,
        longitude: 72.665,
      });

      routingServiceMock.getTravelTimeMatrix.mockResolvedValue({
        durations: [
          [0, 110],
          [110, 0],
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
        const created = {
          id: 'offer-created-1',
          ...data,
        };
        prismaMock.driverDispatchOffer.findUnique.mockResolvedValueOnce(created);
        return Promise.resolve(created);
      });

      const result = await service.initiateDispatchForGroup(mockGroupId);

      expect(result.success).toBe(true);
      expect(result.attemptId).toBe('attempt-created-1');
      expect(result.offerId).toBe('offer-created-1');

      // Verify atomic outbox event creation inside transaction
      expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: 'DISPATCH_OFFER_CREATED',
            aggregateId: 'offer-created-1',
          }),
        }),
      );

      // Verify BullMQ delayed job scheduled with 20s delay and deterministic jobId
      expect(dispatchQueueMock.add).toHaveBeenCalledWith(
        DISPATCH_TIMEOUT_JOB_NAME,
        {
          offerId: 'offer-created-1',
          rideGroupId: mockGroupId,
          driverId: 'driver-rank1',
          groupVersion: 1,
          dispatchAttemptId: 'attempt-created-1',
        },
        expect.objectContaining({
          delay: DRIVER_OFFER_TIMEOUT_MS,
          jobId: 'dispatch-timeout-offer-created-1',
        }),
      );
    });
  });

  describe('handleOfferTimeout', () => {
    it('should skip timeout if offer is already ACCEPTED (no-op)', async () => {
      prismaMock.$queryRaw.mockImplementation((query: any) => {
        const text = Array.isArray(query) ? query.join(' ') : String(query);
        if (text.includes('FROM ride_groups')) {
          return Promise.resolve([{ id: mockGroupId, status: 'DISPATCHING', group_version: 1 }]);
        }
        if (text.includes('FROM driver_dispatch_offers')) {
          return Promise.resolve([
            {
              id: mockOfferId,
              status: 'ACCEPTED', // Already accepted
              group_version: 1,
              dispatch_attempt_id: 'attempt-1',
              driver_id: mockDriverId,
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.handleOfferTimeout({
        offerId: mockOfferId,
        rideGroupId: mockGroupId,
        driverId: mockDriverId,
        groupVersion: 1,
        dispatchAttemptId: 'attempt-1',
      });

      expect(result.expired).toBe(false);
      expect(result.cascaded).toBe(false);
      expect(result.reason).toBe('OFFER_STATUS_ACCEPTED');
      expect(prismaMock.driverDispatchOffer.update).not.toHaveBeenCalled();
    });

    it('should skip timeout if group version has changed (stale job no-op)', async () => {
      prismaMock.$queryRaw.mockImplementation((query: any) => {
        const text = Array.isArray(query) ? query.join(' ') : String(query);
        if (text.includes('FROM ride_groups')) {
          return Promise.resolve([
            { id: mockGroupId, status: 'DISPATCHING', group_version: 2 }, // Version 2 now
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.handleOfferTimeout({
        offerId: mockOfferId,
        rideGroupId: mockGroupId,
        driverId: mockDriverId,
        groupVersion: 1, // Stale job from version 1
        dispatchAttemptId: 'attempt-1',
      });

      expect(result.expired).toBe(false);
      expect(result.cascaded).toBe(false);
      expect(result.reason).toBe('STALE_GROUP_VERSION');
    });

    it('should expire valid PENDING offer and cascade to next driver', async () => {
      prismaMock.$queryRaw.mockImplementation((query: any) => {
        const text = Array.isArray(query) ? query.join(' ') : String(query);
        if (text.includes('FROM ride_groups')) {
          return Promise.resolve([{ id: mockGroupId, status: 'DISPATCHING', group_version: 1 }]);
        }
        if (text.includes('FROM driver_dispatch_offers')) {
          return Promise.resolve([
            {
              id: mockOfferId,
              status: 'PENDING',
              group_version: 1,
              dispatch_attempt_id: 'attempt-1',
              driver_id: mockDriverId,
              expires_at: new Date(Date.now() - 5000),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      prismaMock.dispatchAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        status: 'ACTIVE',
      });

      // Mock cascade initiation
      const initiateSpy = vi.spyOn(service, 'initiateDispatchForGroup').mockResolvedValueOnce({
        success: true,
        offerId: 'offer-next-2',
        driverId: 'driver-2',
      });

      const result = await service.handleOfferTimeout({
        offerId: mockOfferId,
        rideGroupId: mockGroupId,
        driverId: mockDriverId,
        groupVersion: 1,
        dispatchAttemptId: 'attempt-1',
      });

      expect(result.expired).toBe(true);
      expect(result.cascaded).toBe(true);
      expect(result.nextOfferId).toBe('offer-next-2');

      // Verify status set to EXPIRED
      expect(prismaMock.driverDispatchOffer.update).toHaveBeenCalledWith({
        where: { id: mockOfferId },
        data: expect.objectContaining({ status: 'EXPIRED' }),
      });

      // Verify outbox event DISPATCH_OFFER_EXPIRED
      expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'DISPATCH_OFFER_EXPIRED' }),
        }),
      );

      initiateSpy.mockRestore();
    });

    it('should NOT expire offer when timeout job runs prematurely before expiresAt (rescheduling with remaining time)', async () => {
      const prematureExpiresAt = new Date(Date.now() + 15000); // 15 seconds in future

      prismaMock.$queryRaw.mockImplementation((query: any) => {
        const text = Array.isArray(query) ? query.join(' ') : String(query);
        if (text.includes('FROM ride_groups')) {
          return Promise.resolve([{ id: mockGroupId, status: 'DISPATCHING', group_version: 1 }]);
        }
        if (text.includes('FROM driver_dispatch_offers')) {
          return Promise.resolve([
            {
              id: mockOfferId,
              status: 'PENDING',
              group_version: 1,
              dispatch_attempt_id: 'attempt-1',
              driver_id: mockDriverId,
              expires_at: prematureExpiresAt,
            },
          ]);
        }
        return Promise.resolve([]);
      });

      prismaMock.dispatchAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        status: 'ACTIVE',
      });

      const result = await service.handleOfferTimeout({
        offerId: mockOfferId,
        rideGroupId: mockGroupId,
        driverId: mockDriverId,
        groupVersion: 1,
        dispatchAttemptId: 'attempt-1',
      });

      // Must NOT expire and must NOT cascade
      expect(result.expired).toBe(false);
      expect(result.cascaded).toBe(false);
      expect(result.reason).toBe('RESCHEDULED_EARLY_TIMEOUT');
      expect(prismaMock.driverDispatchOffer.update).not.toHaveBeenCalled();

      // Must reschedule with remaining delay
      expect(dispatchQueueMock.add).toHaveBeenCalledWith(
        DISPATCH_TIMEOUT_JOB_NAME,
        expect.objectContaining({ offerId: mockOfferId }),
        expect.objectContaining({
          delay: expect.any(Number),
        }),
      );
    });

    it('should skip timeout if dispatch attempt id does not match (stale attempt no-op)', async () => {
      prismaMock.$queryRaw.mockImplementation((query: any) => {
        const text = Array.isArray(query) ? query.join(' ') : String(query);
        if (text.includes('FROM ride_groups')) {
          return Promise.resolve([{ id: mockGroupId, status: 'DISPATCHING', group_version: 1 }]);
        }
        if (text.includes('FROM driver_dispatch_offers')) {
          return Promise.resolve([
            {
              id: mockOfferId,
              status: 'PENDING',
              group_version: 1,
              dispatch_attempt_id: 'attempt-2', // Offer belongs to attempt-2
              driver_id: mockDriverId,
              expires_at: new Date(Date.now() - 1000),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      prismaMock.dispatchAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1', // Job was for attempt-1
        status: 'ACTIVE',
      });

      const result = await service.handleOfferTimeout({
        offerId: mockOfferId,
        rideGroupId: mockGroupId,
        driverId: mockDriverId,
        groupVersion: 1,
        dispatchAttemptId: 'attempt-1',
      });

      expect(result.expired).toBe(false);
      expect(result.cascaded).toBe(false);
      expect(result.reason).toBe('STALE_DISPATCH_ATTEMPT');
      expect(prismaMock.driverDispatchOffer.update).not.toHaveBeenCalled();
    });
  });

  describe('scheduleOfferTimeout', () => {
    it('should throw NotFoundException if offer does not exist in database', async () => {
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue(null);

      await expect(
        service.scheduleOfferTimeout('non-existent-offer'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should skip queueing if offer is already terminal (ACCEPTED)', async () => {
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: mockOfferId,
        status: 'ACCEPTED',
      });

      const result = await service.scheduleOfferTimeout(mockOfferId);

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe('OFFER_STATUS_ACCEPTED');
      expect(dispatchQueueMock.add).not.toHaveBeenCalled();
    });

    it('should successfully enqueue BullMQ job with deterministic ID and remaining delay when offer is PENDING', async () => {
      const expiresAt = new Date(Date.now() + 18000);
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: mockOfferId,
        rideGroupId: mockGroupId,
        driverId: mockDriverId,
        groupVersion: 1,
        dispatchAttemptId: 'attempt-1',
        status: 'PENDING',
        expiresAt,
      });

      const result = await service.scheduleOfferTimeout(mockOfferId);

      expect(result.scheduled).toBe(true);
      expect(dispatchQueueMock.add).toHaveBeenCalledWith(
        DISPATCH_TIMEOUT_JOB_NAME,
        {
          offerId: mockOfferId,
          rideGroupId: mockGroupId,
          driverId: mockDriverId,
          groupVersion: 1,
          dispatchAttemptId: 'attempt-1',
        },
        expect.objectContaining({
          delay: expect.any(Number),
          jobId: `dispatch-timeout-${mockOfferId}`,
        }),
      );
    });

    it('should propagate error when dispatchQueue.add throws (leaves outbox event retryable)', async () => {
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: mockOfferId,
        rideGroupId: mockGroupId,
        driverId: mockDriverId,
        groupVersion: 1,
        dispatchAttemptId: 'attempt-1',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 20000),
      });

      dispatchQueueMock.add.mockRejectedValueOnce(new Error('Redis connection severed'));

      await expect(
        service.scheduleOfferTimeout(mockOfferId),
      ).rejects.toThrow('Redis connection severed');
    });
  });

  describe('getPendingOffersForDriver', () => {
    it('should throw ForbiddenException if driver is not approved', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: mockDriverId,
        verificationStatus: 'PENDING',
      });

      await expect(
        service.getPendingOffersForDriver(mockUserId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return pending unexpired offers with formatted countdown and fare', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: mockDriverId,
        verificationStatus: 'APPROVED',
      });

      const futureDate = new Date(Date.now() + 15000);
      prismaMock.driverDispatchOffer.findMany.mockResolvedValue([
        {
          id: 'offer-1',
          dispatchAttemptId: 'attempt-1',
          rideGroupId: mockGroupId,
          groupVersion: 1,
          offeredAt: new Date(),
          expiresAt: futureDate,
          rideGroup: {
            totalSharedFarePaise: 11400,
            totalRouteDistanceMeters: 4500,
            totalRouteDurationSec: 600,
            pickupPoint: { id: mockPickupPointId, name: 'PDEU Main Gate' },
            members: [{ id: 'm1' }, { id: 'm2' }],
            routeVersions: [{ totalDistanceMeters: 4500, totalDurationSec: 600 }],
          },
        },
      ]);

      const offers = await service.getPendingOffersForDriver(mockUserId);

      expect(offers).toHaveLength(1);
      expect(offers[0].offerId).toBe('offer-1');
      expect(offers[0].passengerCount).toBe(2);
      expect(offers[0].totalEstimatedFare).toBe('114.00');
      expect(offers[0].remainingSeconds).toBeGreaterThanOrEqual(14);
      expect(offers[0].pickupPoint.name).toBe('PDEU Main Gate');
    });
  });

  describe('rejectOffer', () => {
    it('should throw ForbiddenException if offer belongs to another driver', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: mockDriverId,
        verificationStatus: 'APPROVED',
      });

      prismaMock.$queryRaw.mockResolvedValue([
        {
          id: mockOfferId,
          status: 'PENDING',
          driver_id: 'other-driver-id', // Different driver
        },
      ]);

      await expect(
        service.rejectOffer(mockUserId, mockOfferId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return success without error if offer is already REJECTED (idempotent)', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: mockDriverId,
        verificationStatus: 'APPROVED',
      });

      prismaMock.$queryRaw.mockResolvedValue([
        {
          id: mockOfferId,
          status: 'REJECTED',
          driver_id: mockDriverId,
        },
      ]);

      const res = await service.rejectOffer(mockUserId, mockOfferId);
      expect(res.success).toBe(true);
      expect(prismaMock.driverDispatchOffer.update).not.toHaveBeenCalled();
    });

    it('should reject pending offer, record outbox event, and trigger cascade', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: mockDriverId,
        verificationStatus: 'APPROVED',
      });

      prismaMock.$queryRaw.mockResolvedValue([
        {
          id: mockOfferId,
          status: 'PENDING',
          driver_id: mockDriverId,
          ride_group_id: mockGroupId,
          group_version: 1,
          dispatch_attempt_id: 'attempt-1',
          expires_at: new Date(Date.now() + 15000),
        },
      ]);

      const initiateSpy = vi.spyOn(service, 'initiateDispatchForGroup').mockResolvedValue({
        success: true,
      });

      const res = await service.rejectOffer(mockUserId, mockOfferId, {
        reason: 'Vehicle low battery',
      });

      expect(res.success).toBe(true);
      expect(prismaMock.driverDispatchOffer.update).toHaveBeenCalledWith({
        where: { id: mockOfferId },
        data: expect.objectContaining({ status: 'REJECTED' }),
      });

      expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'DISPATCH_OFFER_REJECTED' }),
        }),
      );

      expect(initiateSpy).toHaveBeenCalledWith(mockGroupId);
      initiateSpy.mockRestore();
    });

    it('should NOT expire offer when timeout job runs prematurely before expiresAt (rescheduling with remaining time)', async () => {
      const prematureExpiresAt = new Date(Date.now() + 15000); // 15 seconds in future

      prismaMock.$queryRaw.mockImplementation((query: any) => {
        const text = Array.isArray(query) ? query.join(' ') : String(query);
        if (text.includes('FROM ride_groups')) {
          return Promise.resolve([{ id: mockGroupId, status: 'DISPATCHING', group_version: 1 }]);
        }
        if (text.includes('FROM driver_dispatch_offers')) {
          return Promise.resolve([
            {
              id: mockOfferId,
              status: 'PENDING',
              group_version: 1,
              dispatch_attempt_id: 'attempt-1',
              driver_id: mockDriverId,
              expires_at: prematureExpiresAt,
            },
          ]);
        }
        return Promise.resolve([]);
      });

      prismaMock.dispatchAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1',
        status: 'ACTIVE',
      });

      const result = await service.handleOfferTimeout({
        offerId: mockOfferId,
        rideGroupId: mockGroupId,
        driverId: mockDriverId,
        groupVersion: 1,
        dispatchAttemptId: 'attempt-1',
      });

      // Must NOT expire and must NOT cascade
      expect(result.expired).toBe(false);
      expect(result.cascaded).toBe(false);
      expect(result.reason).toBe('RESCHEDULED_EARLY_TIMEOUT');
      expect(prismaMock.driverDispatchOffer.update).not.toHaveBeenCalled();

      // Must reschedule with remaining delay
      expect(dispatchQueueMock.add).toHaveBeenCalledWith(
        DISPATCH_TIMEOUT_JOB_NAME,
        expect.objectContaining({ offerId: mockOfferId }),
        expect.objectContaining({
          delay: expect.any(Number),
        }),
      );
    });

    it('should skip timeout if dispatch attempt id does not match (stale attempt no-op)', async () => {
      prismaMock.$queryRaw.mockImplementation((query: any) => {
        const text = Array.isArray(query) ? query.join(' ') : String(query);
        if (text.includes('FROM ride_groups')) {
          return Promise.resolve([{ id: mockGroupId, status: 'DISPATCHING', group_version: 1 }]);
        }
        if (text.includes('FROM driver_dispatch_offers')) {
          return Promise.resolve([
            {
              id: mockOfferId,
              status: 'PENDING',
              group_version: 1,
              dispatch_attempt_id: 'attempt-2', // Offer belongs to attempt-2
              driver_id: mockDriverId,
              expires_at: new Date(Date.now() - 1000),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      prismaMock.dispatchAttempt.findUnique.mockResolvedValue({
        id: 'attempt-1', // Job was for attempt-1
        status: 'ACTIVE',
      });

      const result = await service.handleOfferTimeout({
        offerId: mockOfferId,
        rideGroupId: mockGroupId,
        driverId: mockDriverId,
        groupVersion: 1,
        dispatchAttemptId: 'attempt-1',
      });

      expect(result.expired).toBe(false);
      expect(result.cascaded).toBe(false);
      expect(result.reason).toBe('STALE_DISPATCH_ATTEMPT');
      expect(prismaMock.driverDispatchOffer.update).not.toHaveBeenCalled();
    });
  });

  describe('scheduleOfferTimeout', () => {
    it('should throw NotFoundException if offer does not exist in database', async () => {
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue(null);

      await expect(
        service.scheduleOfferTimeout('non-existent-offer'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should skip queueing if offer is already terminal (ACCEPTED)', async () => {
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: mockOfferId,
        status: 'ACCEPTED',
      });

      const result = await service.scheduleOfferTimeout(mockOfferId);

      expect(result.scheduled).toBe(false);
      expect(result.reason).toBe('OFFER_STATUS_ACCEPTED');
      expect(dispatchQueueMock.add).not.toHaveBeenCalled();
    });

    it('should successfully enqueue BullMQ job with deterministic ID and remaining delay when offer is PENDING', async () => {
      const expiresAt = new Date(Date.now() + 18000);
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: mockOfferId,
        rideGroupId: mockGroupId,
        driverId: mockDriverId,
        groupVersion: 1,
        dispatchAttemptId: 'attempt-1',
        status: 'PENDING',
        expiresAt,
      });

      const result = await service.scheduleOfferTimeout(mockOfferId);

      expect(result.scheduled).toBe(true);
      expect(dispatchQueueMock.add).toHaveBeenCalledWith(
        DISPATCH_TIMEOUT_JOB_NAME,
        {
          offerId: mockOfferId,
          rideGroupId: mockGroupId,
          driverId: mockDriverId,
          groupVersion: 1,
          dispatchAttemptId: 'attempt-1',
        },
        expect.objectContaining({
          delay: expect.any(Number),
          jobId: `dispatch-timeout-${mockOfferId}`,
        }),
      );
    });

    it('should propagate error when dispatchQueue.add throws (leaves outbox event retryable)', async () => {
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: mockOfferId,
        rideGroupId: mockGroupId,
        driverId: mockDriverId,
        groupVersion: 1,
        dispatchAttemptId: 'attempt-1',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 20000),
      });

      dispatchQueueMock.add.mockRejectedValueOnce(new Error('Redis connection severed'));

      await expect(
        service.scheduleOfferTimeout(mockOfferId),
      ).rejects.toThrow('Redis connection severed');
    });
  });

  describe('acceptOffer - Atomic Reservation', () => {
    it('should abort acceptance with 409 if driver CAS fails (zero rows updated)', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: mockDriverId,
        verificationStatus: 'APPROVED',
        vehicles: [{ passengerCapacity: 4 }],
      });

      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);

      // CAS update returns 0 affected rows (e.g. driver concurrent went offline or reserved)
      prismaMock.$executeRaw.mockResolvedValue(0);

      await expect(
        service.acceptOffer(mockUserId, mockOfferId),
      ).rejects.toThrow(ConflictException);
    });

    it('should abort acceptance with OFFER_EXPIRED if offer has passed its deadline', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: mockDriverId,
        verificationStatus: 'APPROVED',
        vehicles: [{ passengerCapacity: 4 }],
      });

      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.$executeRaw.mockResolvedValue(1);

      prismaMock.$queryRaw.mockImplementation((query: any) => {
        const text = Array.isArray(query) ? query.join(' ') : String(query);
        if (text.includes('FROM ride_groups')) {
          return Promise.resolve([{ id: mockGroupId, status: 'DISPATCHING', group_version: 1 }]);
        }
        if (text.includes('FROM driver_profiles')) {
          return Promise.resolve([{ id: mockDriverId, operational_status: 'AVAILABLE', is_online: true }]);
        }
        if (text.includes('FROM driver_dispatch_offers')) {
          return Promise.resolve([
            {
              id: mockOfferId,
              status: 'PENDING',
              group_version: 1,
              dispatch_attempt_id: 'attempt-1',
              expires_at: new Date(Date.now() - 1000), // Expired 1 second ago!
            },
          ]);
        }
        return Promise.resolve([]);
      });

      await expect(
        service.acceptOffer(mockUserId, mockOfferId),
      ).rejects.toThrow(ConflictException);
    });

    it('should successfully accept offer, reserve driver, materialize trip, OTPs, and withdraw competing offers', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: mockDriverId,
        verificationStatus: 'APPROVED',
        vehicles: [{ passengerCapacity: 4 }],
      });

      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.$executeRaw.mockResolvedValue(1);

      prismaMock.groupMember.findMany.mockResolvedValue([
        {
          id: 'gm-1',
          allocatedFarePaise: 1500,
          booking: { id: 'booking-1', passengerId: 'pass-1', status: 'MATCHED' },
        },
        {
          id: 'gm-2',
          allocatedFarePaise: 1500,
          booking: { id: 'booking-2', passengerId: 'pass-2', status: 'MATCHED' },
        },
      ]);

      const res = await service.acceptOffer(mockUserId, mockOfferId);

      expect(res.assignmentId).toBe('assign-1');
      expect(res.tripId).toBe('trip-1');
      expect(res.passengerCount).toBe(2);
      expect(res.totalEstimatedFare).toBe('30.00');

      // Verify winning offer marked ACCEPTED
      expect(prismaMock.driverDispatchOffer.update).toHaveBeenCalledWith({
        where: { id: mockOfferId },
        data: expect.objectContaining({ status: 'ACCEPTED' }),
      });

      // Verify group transitioned to DRIVER_ASSIGNED
      expect(prismaMock.rideGroup.update).toHaveBeenCalledWith({
        where: { id: mockGroupId },
        data: { status: 'DRIVER_ASSIGNED' },
      });

      // Verify bookings transitioned to DRIVER_ASSIGNED
      expect(prismaMock.booking.update).toHaveBeenCalledTimes(2);

      // Verify boarding verification OTPs created with 4 digits and sha-256 hash
      expect(prismaMock.boardingVerification.create).toHaveBeenCalledTimes(2);

      // Verify multi-offer withdrawal (ADR-018)
      expect(prismaMock.driverDispatchOffer.updateMany).toHaveBeenCalledWith({
        where: {
          rideGroupId: mockGroupId,
          status: 'PENDING',
          id: { not: mockOfferId },
        },
        data: expect.objectContaining({ status: 'WITHDRAWN' }),
      });

      // Verify outbox events DISPATCH_OFFER_ACCEPTED and TRIP_CREATED
      expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'DISPATCH_OFFER_ACCEPTED' }),
        }),
      );
      expect(prismaMock.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'TRIP_CREATED' }),
        }),
      );
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
        QueueModule,
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
      const redisClient = redisService.getClient();
      for (const dId of createdDriverIds) {
        await redisClient.del(`${CACHE_KEYS.DRIVER_GPS_PREFIX}${dId}`);
      }

      if (createdGroupIds.length > 0) {
        await prisma.driverDispatchOffer.deleteMany({
          where: { rideGroupId: { in: createdGroupIds } },
        });
        await prisma.tripPassenger.deleteMany({
          where: { trip: { rideGroupId: { in: createdGroupIds } } },
        });
        await prisma.tripStatusHistory.deleteMany({
          where: { trip: { rideGroupId: { in: createdGroupIds } } },
        });
        await prisma.trip.deleteMany({
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
        await prisma.boardingVerification.deleteMany({
          where: { tripPassenger: { bookingId: { in: createdBookingIds } } },
        });
        await prisma.tripPassenger.deleteMany({
          where: { bookingId: { in: createdBookingIds } },
        });
        await prisma.bookingStatusHistory.deleteMany({
          where: { bookingId: { in: createdBookingIds } },
        });
        await prisma.booking.deleteMany({
          where: { id: { in: createdBookingIds } },
        });
      }

      if (createdDriverIds.length > 0) {
        await prisma.driverDispatchOffer.deleteMany({
          where: { driverId: { in: createdDriverIds } },
        });
        await prisma.driverAssignment.deleteMany({
          where: { driverId: { in: createdDriverIds } },
        });
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

    const result = await dispatchService.initiateDispatchForGroup(group.id);

    expect(result.success).toBe(true);
    expect(result.driverId).toBe(driverProfile.id);
    expect(result.etaSec).toBe(120);

    const updatedGroup = await prisma.rideGroup.findUnique({
      where: { id: group.id },
    });
    expect(updatedGroup!.status).toBe('DISPATCHING');

    const checkBooking = await prisma.booking.findUnique({
      where: { id: booking.id },
    });
    expect(checkBooking!.status).toBe('MATCHED');

    const offer = await prisma.driverDispatchOffer.findUnique({
      where: { id: result.offerId },
    });
    expect(offer).toBeDefined();
    expect(offer!.status).toBe('PENDING');

    travelTimeSpy.mockRestore();
  });

  it('should cascade to next ranked eligible driver when previous offer is rejected/expired', async () => {
    const testSuffix = randomUUID().substring(0, 8);

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

    const travelSpy = vi.spyOn(routingService, 'getTravelTimeMatrix');
    travelSpy.mockResolvedValue({
      durations: [
        [0, 50, 100],
        [50, 0, 200],
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

    // 1. Initial offer sent to Driver 1
    const result1 = await dispatchService.initiateDispatchForGroup(group.id);
    expect(result1.success).toBe(true);
    expect(result1.driverId).toBe(driverProfile1.id);

    // 2. Reject offer via service
    await dispatchService.rejectOffer(driverUser1.id, result1.offerId!);

    // 3. Verify offer is marked REJECTED
    const rejectedOffer = await prisma.driverDispatchOffer.findUnique({
      where: { id: result1.offerId },
    });
    expect(rejectedOffer!.status).toBe('REJECTED');

    // 4. Verify cascade automatically triggered to Driver 2!
    const pendingOffers = await prisma.driverDispatchOffer.findMany({
      where: { rideGroupId: group.id, status: 'PENDING' },
    });
    expect(pendingOffers).toHaveLength(1);
    expect(pendingOffers[0].driverId).toBe(driverProfile2.id);

    travelSpy.mockRestore();
  });

  it('should support multi-offer acceptance (ADR-018): accepting one group withdraws offers for other groups', async () => {
    const testSuffix = randomUUID().substring(0, 8);

    // Create 1 Driver
    const driverUser = await prisma.user.create({
      data: {
        email: `multi-drv-${testSuffix}@pdeu.ac.in`,
        fullName: 'Multi Offer Driver',
        role: 'DRIVER',
      },
    });
    createdUserIds.push(driverUser.id);

    const driverProfile = await prisma.driverProfile.create({
      data: {
        userId: driverUser.id,
        licenseNumber: `DL-M-${testSuffix}`,
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });
    createdDriverIds.push(driverProfile.id);

    await prisma.vehicle.create({
      data: {
        driverProfileId: driverProfile.id,
        registrationNumber: `GJ-18-M-${testSuffix}`,
        passengerCapacity: 4,
        makeModel: 'Mahindra Treo',
        isActive: true,
      },
    });

    // Create Group A and Group B
    const groupA = await prisma.rideGroup.create({
      data: {
        pickupPointId: pdeuPickupPointId,
        rideType: 'SHARED',
        groupVersion: 1,
        status: 'DISPATCHING',
        totalSharedFarePaise: 3000,
        totalRouteDistanceMeters: 4000,
        totalRouteDurationSec: 600,
      },
    });
    createdGroupIds.push(groupA.id);

    const groupB = await prisma.rideGroup.create({
      data: {
        pickupPointId: pdeuPickupPointId,
        rideType: 'SHARED',
        groupVersion: 1,
        status: 'DISPATCHING',
        totalSharedFarePaise: 4000,
        totalRouteDistanceMeters: 5000,
        totalRouteDurationSec: 700,
      },
    });
    createdGroupIds.push(groupB.id);

    // Create passenger & member for Group A
    const passengerA = await prisma.user.create({
      data: { email: `passA-${testSuffix}@pdeu.ac.in`, fullName: 'Passenger A' },
    });
    createdUserIds.push(passengerA.id);

    const [quoteA] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id, passenger_id, pickup_point_id, destination_location,
        direct_distance_meters, direct_duration_sec,
        private_estimated_fare_paise, shared_min_fare_paise,
        shared_max_fare_paise, agreed_fare_ceiling_paise,
        tariff_version, expires_at
      ) VALUES (
        gen_random_uuid(), ${passengerA.id}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326),
        4000, 600, 6000, 2000, 3500, 3500, 1,
        NOW() + INTERVAL '5 minutes'
      ) RETURNING id;
    `;

    const [bookingA] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id, passenger_id, fare_quote_id, pickup_point_id,
        passenger_pickup_location, destination_location,
        requested_type, min_group_preference, status,
        agreed_fare_ceiling_paise, final_allocated_fare_paise,
        max_wait_deadline
      ) VALUES (
        gen_random_uuid(), ${passengerA.id}::uuid, ${quoteA.id}::uuid, ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
        ST_SetSRID(ST_MakePoint(72.6800, 23.1800), 4326),
        'SHARED', 2, 'MATCHED', 3500, 3000, NOW() + INTERVAL '5 minutes'
      ) RETURNING id;
    `;
    createdBookingIds.push(bookingA.id);

    await prisma.groupMember.create({
      data: {
        rideGroupId: groupA.id,
        bookingId: bookingA.id,
        dropoffSequenceOrder: 1,
        directDistanceMeters: 4000,
        directDurationSec: 600,
        sharedDurationSec: 600,
        calculatedDetourPercent: 0,
        allocatedFarePaise: 3000,
        isActiveMember: true,
      },
    });

    // Create Dispatch Attempts
    const attemptA = await prisma.dispatchAttempt.create({
      data: { rideGroupId: groupA.id, groupVersion: 1, attemptNumber: 1, status: 'ACTIVE' },
    });
    const attemptB = await prisma.dispatchAttempt.create({
      data: { rideGroupId: groupB.id, groupVersion: 1, attemptNumber: 1, status: 'ACTIVE' },
    });

    // Driver holds 2 pending offers simultaneously (ADR-018)
    const offerA = await prisma.driverDispatchOffer.create({
      data: {
        dispatchAttemptId: attemptA.id,
        rideGroupId: groupA.id,
        groupVersion: 1,
        driverId: driverProfile.id,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 20000),
      },
    });

    const offerB = await prisma.driverDispatchOffer.create({
      data: {
        dispatchAttemptId: attemptB.id,
        rideGroupId: groupB.id,
        groupVersion: 1,
        driverId: driverProfile.id,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 20000),
      },
    });

    // Driver queries pending offers -> sees both offers!
    const pendingList = await dispatchService.getPendingOffersForDriver(driverUser.id);
    expect(pendingList).toHaveLength(2);

    // Driver accepts offer for Group A
    const acceptRes = await dispatchService.acceptOffer(driverUser.id, offerA.id);
    expect(acceptRes.assignmentId).toBeDefined();

    // Verify Driver is RESERVED
    const checkDriver = await prisma.driverProfile.findUnique({
      where: { id: driverProfile.id },
    });
    expect(checkDriver!.operationalStatus).toBe('RESERVED');

    // Verify Offer A is ACCEPTED
    const checkOfferA = await prisma.driverDispatchOffer.findUnique({
      where: { id: offerA.id },
    });
    expect(checkOfferA!.status).toBe('ACCEPTED');

    // Verify Offer B was atomically WITHDRAWN
    const checkOfferB = await prisma.driverDispatchOffer.findUnique({
      where: { id: offerB.id },
    });
    expect(checkOfferB!.status).toBe('WITHDRAWN');

    // Attempting to accept Offer B fails with OFFER_ALREADY_TAKEN
    await expect(
      dispatchService.acceptOffer(driverUser.id, offerB.id),
    ).rejects.toThrow(ConflictException);
  });
});
