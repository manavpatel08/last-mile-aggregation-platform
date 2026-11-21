import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DriversService } from './drivers.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { CACHE_KEYS } from '../../common/constants/index.js';

describe('DriversService - Unit Tests', () => {
  let service: DriversService;
  let prismaMock: any;
  let redisMock: any;
  let redisClientMock: any;

  beforeEach(() => {
    prismaMock = {
      $transaction: vi.fn(async (cb) => cb(prismaMock)),
      $executeRaw: vi.fn().mockResolvedValue(1),
      driverProfile: {
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      driverAssignment: {
        findFirst: vi.fn(),
      },
      trip: {
        findFirst: vi.fn(),
      },
    };

    redisClientMock = {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
    };

    redisMock = {
      getClient: vi.fn().mockReturnValue(redisClientMock),
    };

    service = new DriversService(
      prismaMock as unknown as PrismaService,
      redisMock as unknown as RedisService,
    );
  });

  describe('updateDriverOperationalStatus', () => {
    it('should throw NotFoundException if driver profile does not exist', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.updateDriverOperationalStatus('user-1', { isOnline: true }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if driver is not approved', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-1',
        userId: 'user-1',
        verificationStatus: 'PENDING',
        operationalStatus: 'OFFLINE',
        isOnline: false,
        assignments: [],
      });

      await expect(
        service.updateDriverOperationalStatus('user-1', { isOnline: true }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException if driver is suspended', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-1',
        userId: 'user-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'SUSPENDED',
        isOnline: false,
        assignments: [],
      });

      await expect(
        service.updateDriverOperationalStatus('user-1', { isOnline: true }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should transition to AVAILABLE when an approved driver goes online without assignments', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-1',
        userId: 'user-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'OFFLINE',
        isOnline: false,
        assignments: [],
        vehicles: [{ id: 'veh-1' }],
      });

      prismaMock.driverProfile.update.mockResolvedValue({
        id: 'driver-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
        vehicles: [{ id: 'veh-1' }],
      });

      const result = await service.updateDriverOperationalStatus('user-1', {
        isOnline: true,
      });

      expect(prismaMock.driverProfile.update).toHaveBeenCalledWith({
        where: { id: 'driver-1' },
        data: {
          isOnline: true,
          operationalStatus: 'AVAILABLE',
        },
        include: { vehicles: true },
      });

      expect(result).toEqual({
        id: 'driver-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
        vehiclesCount: 1,
      });
    });

    it('should preserve existing operational_status when an already assigned driver sets isOnline=true', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-1',
        userId: 'user-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'RESERVED',
        isOnline: false,
        assignments: [{ id: 'assign-1', status: 'RESERVED' }],
        vehicles: [],
      });

      prismaMock.driverProfile.update.mockResolvedValue({
        id: 'driver-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'RESERVED',
        isOnline: true,
        vehicles: [],
      });

      const result = await service.updateDriverOperationalStatus('user-1', {
        isOnline: true,
      });

      expect(prismaMock.driverProfile.update).toHaveBeenCalledWith({
        where: { id: 'driver-1' },
        data: {
          isOnline: true,
          operationalStatus: 'RESERVED',
        },
        include: { vehicles: true },
      });
      expect(result.operationalStatus).toBe('RESERVED');
      expect(result.isOnline).toBe(true);
    });

    it('should transition to OFFLINE when unassigned approved driver goes offline', async () => {
      prismaMock.driverProfile.findUnique
        .mockResolvedValueOnce({
          id: 'driver-1',
          userId: 'user-1',
          verificationStatus: 'APPROVED',
          operationalStatus: 'AVAILABLE',
          isOnline: true,
          assignments: [],
          vehicles: [],
        })
        .mockResolvedValueOnce({
          id: 'driver-1',
          verificationStatus: 'APPROVED',
          operationalStatus: 'OFFLINE',
          isOnline: false,
          vehicles: [],
        });

      prismaMock.trip.findFirst.mockResolvedValue(null);
      prismaMock.driverProfile.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.updateDriverOperationalStatus('user-1', {
        isOnline: false,
      });

      expect(prismaMock.$executeRaw).toHaveBeenCalled();
      expect(prismaMock.driverProfile.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'driver-1',
          operationalStatus: { notIn: ['RESERVED', 'ACTIVE', 'SUSPENDED'] },
        },
        data: {
          isOnline: false,
          operationalStatus: 'OFFLINE',
        },
      });

      expect(result.operationalStatus).toBe('OFFLINE');
      expect(result.isOnline).toBe(false);
    });

    it('should throw ConflictException if concurrent CAS update sets 0 rows when going offline', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-1',
        userId: 'user-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
        assignments: [],
        vehicles: [],
      });

      prismaMock.trip.findFirst.mockResolvedValue(null);
      // Simulate concurrent CAS race where driver was reserved concurrently
      prismaMock.driverProfile.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.updateDriverOperationalStatus('user-1', { isOnline: false }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException if driver attempts to go offline with a RESERVED assignment', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-1',
        userId: 'user-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'RESERVED',
        isOnline: true,
        assignments: [{ id: 'assign-1', status: 'RESERVED' }],
        vehicles: [],
      });

      await expect(
        service.updateDriverOperationalStatus('user-1', { isOnline: false }),
      ).rejects.toThrow(ConflictException);

      expect(prismaMock.driverProfile.update).not.toHaveBeenCalled();
    });

    it('should throw ConflictException if driver attempts to go offline with an ACTIVE assignment', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-1',
        userId: 'user-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'ACTIVE',
        isOnline: true,
        assignments: [{ id: 'assign-2', status: 'ACTIVE' }],
        vehicles: [],
      });

      await expect(
        service.updateDriverOperationalStatus('user-1', { isOnline: false }),
      ).rejects.toThrow(ConflictException);

      expect(prismaMock.driverProfile.update).not.toHaveBeenCalled();
    });

    it('should throw ConflictException if driver attempts to go offline with an active trip', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-1',
        userId: 'user-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'ACTIVE',
        isOnline: true,
        assignments: [],
        vehicles: [],
      });

      prismaMock.trip.findFirst.mockResolvedValue({
        id: 'trip-1',
        status: 'IN_PROGRESS',
      });

      await expect(
        service.updateDriverOperationalStatus('user-1', { isOnline: false }),
      ).rejects.toThrow(ConflictException);

      expect(prismaMock.driverProfile.update).not.toHaveBeenCalled();
    });
  });

  describe('recordDriverLocation', () => {
    it('should throw NotFoundException if driver profile not found', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.recordDriverLocation('user-1', {
          latitude: 23.155,
          longitude: 72.667,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if driver is not approved', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-1',
        userId: 'user-1',
        verificationStatus: 'PENDING',
      });

      await expect(
        service.recordDriverLocation('user-1', {
          latitude: 23.155,
          longitude: 72.667,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException if driver is suspended', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-1',
        userId: 'user-1',
        verificationStatus: 'APPROVED',
        operationalStatus: 'SUSPENDED',
      });

      await expect(
        service.recordDriverLocation('user-1', {
          latitude: 23.155,
          longitude: 72.667,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should store location in Redis with driver:gps:{driverId} key and 30s TTL', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-123',
        userId: 'user-1',
        verificationStatus: 'APPROVED',
      });

      const result = await service.recordDriverLocation('user-1', {
        latitude: 23.155,
        longitude: 72.667,
        heading: 180,
        speed: 5.5,
      });

      const expectedKey = `${CACHE_KEYS.DRIVER_GPS_PREFIX}driver-123`;
      expect(redisClientMock.set).toHaveBeenCalledWith(
        expectedKey,
        expect.stringContaining('"latitude":23.155'),
        'EX',
        30,
      );

      expect(result.driverId).toBe('driver-123');
      expect(result.latitude).toBe(23.155);
      expect(result.longitude).toBe(72.667);
      expect(result.heading).toBe(180);
      expect(result.speed).toBe(5.5);
      expect(result.updatedAt).toBeDefined();
    });

    it('should set heading and speed to null when omitted', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-123',
        userId: 'user-1',
        verificationStatus: 'APPROVED',
      });

      const result = await service.recordDriverLocation('user-1', {
        latitude: 23.155,
        longitude: 72.667,
      });

      expect(result.heading).toBeNull();
      expect(result.speed).toBeNull();

      const lastPayload = JSON.parse(redisClientMock.set.mock.calls[0][1]);
      expect(lastPayload.heading).toBeNull();
      expect(lastPayload.speed).toBeNull();
    });

    it('should throw ServiceUnavailableException if Redis set throws', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: 'driver-123',
        userId: 'user-1',
        verificationStatus: 'APPROVED',
      });

      redisClientMock.set.mockRejectedValue(new Error('Redis connection lost'));

      await expect(
        service.recordDriverLocation('user-1', {
          latitude: 23.155,
          longitude: 72.667,
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('getDriverGpsFix', () => {
    it('should return parsed payload from Redis when present', async () => {
      const stored = {
        latitude: 23.155,
        longitude: 72.667,
        heading: 90,
        speed: 4.2,
        updatedAt: '2026-11-21T16:00:00.000Z',
      };
      redisClientMock.get.mockResolvedValue(JSON.stringify(stored));

      const result = await service.getDriverGpsFix('driver-123');
      expect(redisClientMock.get).toHaveBeenCalledWith(
        `${CACHE_KEYS.DRIVER_GPS_PREFIX}driver-123`,
      );
      expect(result).toEqual(stored);
    });

    it('should return null when key is absent in Redis', async () => {
      redisClientMock.get.mockResolvedValue(null);

      const result = await service.getDriverGpsFix('driver-nonexistent');
      expect(result).toBeNull();
    });

    it('should return null when Redis get fails', async () => {
      redisClientMock.get.mockRejectedValue(new Error('Redis error'));

      const result = await service.getDriverGpsFix('driver-err');
      expect(result).toBeNull();
    });
  });
});
