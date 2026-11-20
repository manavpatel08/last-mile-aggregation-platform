import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { BookingsService } from './bookings.service.js';
import { LocationsService } from '../locations/locations.service.js';
import {
  CANONICAL_ACTIVE_BOOKING_STATUSES,
  TERMINAL_BOOKING_STATUSES,
} from './bookings.constants.js';

describe('Active Booking Partial Unique Index & Migration Invariant 1', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let bookingsService: BookingsService;
  let locationsService: LocationsService;

  let testPassengerId: string;
  let pdeuPickupPointId: string;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [BookingsService, LocationsService],
    }).compile();

    await module.init();

    prisma = module.get<PrismaService>(PrismaService);
    bookingsService = module.get<BookingsService>(BookingsService);
    locationsService = module.get<LocationsService>(LocationsService);

    await locationsService.bootstrapDefaults();
    const pickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    pdeuPickupPointId = pickup!.id;

    // Create dedicated test passenger
    const user = await prisma.user.create({
      data: {
        email: `index-test-${Date.now()}@pdeu.ac.in`,
        fullName: 'Index Verification Commuter',
        role: 'PASSENGER',
      },
    });
    testPassengerId = user.id;
    createdUserIds.push(testPassengerId);

    await prisma.passengerProfile.create({
      data: { userId: testPassengerId },
    });
  });

  beforeEach(async () => {
    // Ensure clean slate before each test
    await prisma.groupMember.deleteMany({});
    await prisma.cancellationFee.deleteMany({ where: { passengerId: testPassengerId } });
    await prisma.tripPassenger.deleteMany({ where: { passengerId: testPassengerId } });
    await prisma.bookingStatusHistory.deleteMany({});
    await prisma.booking.deleteMany({ where: { passengerId: testPassengerId } });
  });

  afterAll(async () => {
    for (const bookingId of createdBookingIds) {
      await prisma.groupMember.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.cancellationFee.deleteMany({ where: { originalBookingId: bookingId } }).catch(() => {});
      await prisma.tripPassenger.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.bookingStatusHistory.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    }
    for (const userId of createdUserIds) {
      await prisma.fareQuote.deleteMany({ where: { passengerId: userId } }).catch(() => {});
      await prisma.passengerProfile.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    await module.close();
  });

  // Helper to create a valid fare quote
  async function createQuote(userId: string): Promise<string> {
    const [inserted] = await prisma.$queryRaw<Array<{ id: string }>>`
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
        ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
        4400,
        600,
        10000,
        2000,
        6000,
        6000,
        1,
        NOW() + INTERVAL '5 minutes'
      ) RETURNING id;
    `;
    return inserted.id;
  }

  // Direct raw SQL insert to test PostgreSQL engine index enforcement directly
  async function rawInsertBooking(userId: string, status: string): Promise<string> {
    const quoteId = await createQuote(userId);
    const [bkg] = await prisma.$queryRaw<Array<{ id: string }>>`
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
        max_wait_deadline
      ) VALUES (
        gen_random_uuid(),
        ${userId}::uuid,
        ${quoteId}::uuid,
        ${pdeuPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.155), 4326),
        ST_SetSRID(ST_MakePoint(72.6345, 23.1812), 4326),
        'SHARED',
        2,
        ${status},
        6000,
        NOW() + INTERVAL '2 minutes'
      ) RETURNING id;
    `;
    createdBookingIds.push(bkg.id);
    return bkg.id;
  }

  describe('PostgreSQL Partial Unique Index Definition', () => {
    it('should have idx_unique_active_passenger_booking matching all 9 canonical active statuses in pg_indexes', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ indexname: string; indexdef: string }>
      >`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'bookings'
          AND indexname = 'idx_unique_active_passenger_booking';
      `;

      expect(rows.length).toBe(1);
      const def = rows[0].indexdef;

      // Verify UNIQUE btree index on passenger_id
      expect(def).toContain('CREATE UNIQUE INDEX idx_unique_active_passenger_booking');
      expect(def).toContain('(passenger_id)');

      // Verify every canonical active status is in the WHERE clause
      for (const status of CANONICAL_ACTIVE_BOOKING_STATUSES) {
        expect(def).toContain(`'${status}'`);
      }

      // Verify terminal statuses are NOT in the index definition
      for (const terminal of TERMINAL_BOOKING_STATUSES) {
        expect(def).not.toContain(`'${terminal}'`);
      }
    });
  });

  describe('PostgreSQL Engine Uniqueness Enforcement', () => {
    it('should reject raw SQL insertion of a second active booking for every canonical active status with 23505', async () => {
      for (const activeStatus of CANONICAL_ACTIVE_BOOKING_STATUSES) {
        // Clean any previous booking
        await prisma.booking.deleteMany({ where: { passengerId: testPassengerId } });

        // Create an active booking in the status under test
        const bkgId = await rawInsertBooking(testPassengerId, activeStatus);

        // Attempting to directly insert another booking in REQUESTED must violate idx_unique_active_passenger_booking
        let rawError: any = null;
        try {
          await rawInsertBooking(testPassengerId, 'REQUESTED');
        } catch (err) {
          rawError = err;
        }

        // Verify PostgreSQL raised 23505 unique violation
        expect(rawError).toBeDefined();
        expect(rawError.meta?.code).toBe('23505');
        expect(rawError.meta?.message).toContain('already exists');

        // Clean up the active booking to allow testing the next status
        await prisma.booking.delete({ where: { id: bkgId } });
      }
    });

    it('should permit raw SQL insertion of a new active booking when prior bookings are in terminal statuses', async () => {
      for (const terminalStatus of TERMINAL_BOOKING_STATUSES) {
        // Clean any previous active booking
        await prisma.booking.deleteMany({ where: { passengerId: testPassengerId } });

        // Create terminal booking
        await rawInsertBooking(testPassengerId, terminalStatus);

        // A new active booking in REQUESTED must succeed without constraint error
        const newActiveId = await rawInsertBooking(testPassengerId, 'REQUESTED');
        expect(newActiveId).toBeDefined();

        // Clean up the active booking for the next loop iteration
        await prisma.booking.delete({ where: { id: newActiveId } });
      }
    });

    it('should permit multiple concurrent terminal bookings for the same passenger without conflict', async () => {
      // Commuter can accumulate multiple COMPLETED and CANCELLED historical bookings
      const bkg1 = await rawInsertBooking(testPassengerId, 'COMPLETED');
      const bkg2 = await rawInsertBooking(testPassengerId, 'COMPLETED');
      const bkg3 = await rawInsertBooking(testPassengerId, 'CANCELLED');
      const bkg4 = await rawInsertBooking(testPassengerId, 'NO_SHOW');
      const bkg5 = await rawInsertBooking(testPassengerId, 'EXPIRED');

      expect(bkg1).toBeDefined();
      expect(bkg2).toBeDefined();
      expect(bkg3).toBeDefined();
      expect(bkg4).toBeDefined();
      expect(bkg5).toBeDefined();

      // Commuter can still create an active booking
      const activeBkg = await rawInsertBooking(testPassengerId, 'REQUESTED');
      expect(activeBkg).toBeDefined();

      // Cleanup the active booking
      await prisma.booking.delete({ where: { id: activeBkg } });
    });
  });

  describe('Service-Level Validation & Catch Integration', () => {
    it('should throw ConflictException (ACTIVE_BOOKING_EXISTS) when passenger has an active booking', async () => {
      // 1. Create an initial active booking via service
      const q1 = await createQuote(testPassengerId);
      const bkg1 = await bookingsService.createBooking(testPassengerId, {
        quoteId: q1,
        requestedType: 'SHARED',
        minGroupPreference: 2,
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      });
      createdBookingIds.push(bkg1.bookingId);

      // 2. Attempt a second booking via service -> must fail with ConflictException
      const q2 = await createQuote(testPassengerId);
      await expect(
        bookingsService.createBooking(testPassengerId, {
          quoteId: q2,
          requestedType: 'SHARED',
          minGroupPreference: 2,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        }),
      ).rejects.toThrow(ConflictException);

      // 3. Complete the first booking
      await prisma.booking.update({
        where: { id: bkg1.bookingId },
        data: { status: 'COMPLETED' },
      });

      // 4. Now second booking must succeed
      const bkg2 = await bookingsService.createBooking(testPassengerId, {
        quoteId: q2,
        requestedType: 'SHARED',
        minGroupPreference: 2,
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      });
      expect(bkg2.bookingId).toBeDefined();
      createdBookingIds.push(bkg2.bookingId);

      // Clean up bkg2
      await prisma.booking.delete({ where: { id: bkg2.bookingId } });
    });
  });
});
