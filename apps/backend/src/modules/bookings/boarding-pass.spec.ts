import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { BookingsService } from './bookings.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { deriveBoardingOtp, hashBoardingOtp } from '../../common/utils/otp.util.js';

describe('BookingsService - getBoardingPass', () => {
  let service: BookingsService;
  let prismaMock: any;
  let redisMock: any;
  let locationsMock: any;

  const passengerId = 'pax-user-uuid-1111';
  const otherPassengerId = 'pax-user-uuid-2222';
  const driverUserId = 'drv-user-uuid-3333';
  const bookingId = 'booking-uuid-4444';
  const assignmentId = 'assign-uuid-5555';
  const tripId = 'trip-uuid-6666';
  const tripPassengerId = 'tp-uuid-7777';

  const expectedOtp = deriveBoardingOtp(bookingId, assignmentId);
  const validOtpHash = hashBoardingOtp(expectedOtp);

  const baseBooking = {
    id: bookingId,
    passengerId,
    status: 'DRIVER_ASSIGNED',
  };

  const createTripPassengerMock = (overrides: Record<string, any> = {}) => ({
    id: tripPassengerId,
    bookingId,
    passengerId,
    tripId,
    trip: {
      id: tripId,
      driverAssignmentId: assignmentId,
      activeDriver: {
        id: 'driver-profile-uuid',
        user: {
          fullName: 'Ramesh Patel',
          phoneNumber: '+919876543210',
        },
        vehicles: [
          {
            registrationNumber: 'GJ01AB1234',
            makeModel: 'Mahindra Treo',
            vehicleType: 'E_RICKSHAW',
            isActive: true,
          },
        ],
      },
    },
    boardingVerification: {
      id: 'bv-uuid-8888',
      tripPassengerId,
      otpHash: validOtpHash,
      attemptsCount: 0,
      maxAttempts: 3,
      isVerified: false,
      expiresAt: new Date(Date.now() + 25 * 60 * 1000), // 25 mins in future
      ...overrides,
    },
  });

  beforeEach(() => {
    prismaMock = {
      booking: {
        findUnique: vi.fn().mockResolvedValue({ ...baseBooking }),
      },
      tripPassenger: {
        findFirst: vi.fn().mockResolvedValue(createTripPassengerMock()),
      },
    };

    redisMock = {
      getPassengerBoardingOtp: vi.fn().mockResolvedValue(expectedOtp),
      setPassengerBoardingOtp: vi.fn().mockResolvedValue(undefined),
    };

    locationsMock = {};

    service = new BookingsService(
      prismaMock as unknown as PrismaService,
      locationsMock as unknown as LocationsService,
      redisMock as unknown as RedisService,
    );
  });

  describe('Happy Path & Redis Caching', () => {
    it('should return boarding pass successfully on Redis cache hit', async () => {
      const user = { id: passengerId, role: 'PASSENGER' };

      const result = await service.getBoardingPass(user, bookingId);

      expect(result).toBeDefined();
      expect(result.bookingId).toBe(bookingId);
      expect(result.passengerId).toBe(passengerId);
      expect(result.tripId).toBe(tripId);
      expect(result.boardingOtp).toBe(expectedOtp);
      expect(result.bookingStatus).toBe('DRIVER_ASSIGNED');
      expect(result.driver.name).toBe('Ramesh Patel');
      expect(result.driver.phoneNumber).toBe('+919876543210');
      expect(result.driver.vehicle).toEqual({
        registrationNumber: 'GJ01AB1234',
        makeModel: 'Mahindra Treo',
        vehicleType: 'E_RICKSHAW',
      });
      expect(redisMock.getPassengerBoardingOtp).toHaveBeenCalledWith(bookingId);
      expect(redisMock.setPassengerBoardingOtp).not.toHaveBeenCalled();
    });

    it('should fall back to deterministic derivation on Redis cache miss and repopulate Redis', async () => {
      redisMock.getPassengerBoardingOtp.mockResolvedValue(null);
      const user = { id: passengerId, role: 'PASSENGER' };

      const result = await service.getBoardingPass(user, bookingId);

      expect(result.boardingOtp).toBe(expectedOtp);
      expect(redisMock.setPassengerBoardingOtp).toHaveBeenCalledWith(
        bookingId,
        expectedOtp,
        expect.any(Number),
      );
    });

    it('should fall back to deterministic derivation when Redis throws an error', async () => {
      redisMock.getPassengerBoardingOtp.mockRejectedValue(new Error('ECONNREFUSED'));
      const user = { id: passengerId, role: 'PASSENGER' };

      const result = await service.getBoardingPass(user, bookingId);

      expect(result.boardingOtp).toBe(expectedOtp);
    });

    it('should re-derive and repopulate if Redis returns a mismatched OTP', async () => {
      redisMock.getPassengerBoardingOtp.mockResolvedValue('0000'); // Corrupted cache
      const user = { id: passengerId, role: 'PASSENGER' };

      const result = await service.getBoardingPass(user, bookingId);

      expect(result.boardingOtp).toBe(expectedOtp);
      expect(redisMock.setPassengerBoardingOtp).toHaveBeenCalledWith(
        bookingId,
        expectedOtp,
        expect.any(Number),
      );
    });

    it('should work seamlessly if RedisService is not provided (null/undefined)', async () => {
      const serviceWithoutRedis = new BookingsService(
        prismaMock as unknown as PrismaService,
        locationsMock as unknown as LocationsService,
        undefined,
      );

      const user = { id: passengerId, role: 'PASSENGER' };
      const result = await serviceWithoutRedis.getBoardingPass(user, bookingId);

      expect(result.boardingOtp).toBe(expectedOtp);
    });

    it('should allow retrieval when booking status is DRIVER_ARRIVED', async () => {
      prismaMock.booking.findUnique.mockResolvedValue({
        ...baseBooking,
        status: 'DRIVER_ARRIVED',
      });
      const user = { id: passengerId, role: 'PASSENGER' };

      const result = await service.getBoardingPass(user, bookingId);
      expect(result.bookingStatus).toBe('DRIVER_ARRIVED');
      expect(result.boardingOtp).toBe(expectedOtp);
    });
  });

  describe('Authorization and Access Control', () => {
    it('should reject access if user does not have PASSENGER role', async () => {
      const user = { id: driverUserId, role: 'DRIVER' };

      await expect(service.getBoardingPass(user, bookingId)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should reject access if another passenger requests the boarding pass', async () => {
      const user = { id: otherPassengerId, role: 'PASSENGER' };

      await expect(service.getBoardingPass(user, bookingId)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('Lifecycle State Gating', () => {
    it.each(['REQUESTED', 'MATCHING', 'MATCHED', 'DISPATCHING', 'CONFIRMED'])(
      'should reject with BOOKING_NOT_ASSIGNED if booking status is %s',
      async (status) => {
        prismaMock.booking.findUnique.mockResolvedValue({
          ...baseBooking,
          status,
        });
        const user = { id: passengerId, role: 'PASSENGER' };

        await expect(service.getBoardingPass(user, bookingId)).rejects.toThrow(
          BadRequestException,
        );
      },
    );

    it.each(['BOARDED', 'IN_PROGRESS', 'COMPLETED'])(
      'should reject with OTP_ALREADY_CONSUMED if booking status is %s',
      async (status) => {
        prismaMock.booking.findUnique.mockResolvedValue({
          ...baseBooking,
          status,
        });
        const user = { id: passengerId, role: 'PASSENGER' };

        await expect(service.getBoardingPass(user, bookingId)).rejects.toThrow(
          BadRequestException,
        );
      },
    );

    it.each(['CANCELLED', 'EXPIRED', 'NO_SHOW'])(
      'should reject with BOOKING_NOT_ACTIVE if booking status is %s',
      async (status) => {
        prismaMock.booking.findUnique.mockResolvedValue({
          ...baseBooking,
          status,
        });
        const user = { id: passengerId, role: 'PASSENGER' };

        await expect(service.getBoardingPass(user, bookingId)).rejects.toThrow(
          BadRequestException,
        );
      },
    );
  });

  describe('Verification Record and Cryptographic Integrity', () => {
    it('should throw NotFoundException if booking does not exist', async () => {
      prismaMock.booking.findUnique.mockResolvedValue(null);
      const user = { id: passengerId, role: 'PASSENGER' };

      await expect(service.getBoardingPass(user, bookingId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if TripPassenger or boardingVerification does not exist', async () => {
      prismaMock.tripPassenger.findFirst.mockResolvedValue(null);
      const user = { id: passengerId, role: 'PASSENGER' };

      await expect(service.getBoardingPass(user, bookingId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if OTP is already verified', async () => {
      prismaMock.tripPassenger.findFirst.mockResolvedValue(
        createTripPassengerMock({ isVerified: true }),
      );
      const user = { id: passengerId, role: 'PASSENGER' };

      await expect(service.getBoardingPass(user, bookingId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if maximum verification attempts exceeded', async () => {
      prismaMock.tripPassenger.findFirst.mockResolvedValue(
        createTripPassengerMock({ attemptsCount: 3, maxAttempts: 3 }),
      );
      const user = { id: passengerId, role: 'PASSENGER' };

      await expect(service.getBoardingPass(user, bookingId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if OTP has expired', async () => {
      prismaMock.tripPassenger.findFirst.mockResolvedValue(
        createTripPassengerMock({ expiresAt: new Date(Date.now() - 60 * 1000) }),
      );
      const user = { id: passengerId, role: 'PASSENGER' };

      await expect(service.getBoardingPass(user, bookingId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw InternalServerErrorException if derived hash does not match stored hash', async () => {
      redisMock.getPassengerBoardingOtp.mockResolvedValue(null);
      prismaMock.tripPassenger.findFirst.mockResolvedValue(
        createTripPassengerMock({ otpHash: 'corrupted_hash_value' }),
      );
      const user = { id: passengerId, role: 'PASSENGER' };

      await expect(service.getBoardingPass(user, bookingId)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
