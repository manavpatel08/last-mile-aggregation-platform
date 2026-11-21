import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { FaresService } from './fares.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { RoutingService } from '../routing/routing.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

describe('Stage 8 — Phase 3: Fare Quote Surcharge Disclosure', () => {
  const prisma = new PrismaClient();
  let faresService: FaresService;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdQuoteIds: string[] = [];
  let testPickupPointId: string;

  beforeAll(async () => {
    const prismaService = new PrismaService();
    await prismaService.onModuleInit();
    const configMock = {
      get: (key: string, def?: any) => {
        if (key === 'routing.osrmBackendUrl') return 'http://127.0.0.1:5000';
        if (key === 'demoMode') return true;
        return def;
      },
    } as any;

    const routingService = new RoutingService(configMock);
    const locationsService = new LocationsService(prismaService);
    faresService = new FaresService(
      prismaService,
      locationsService,
      routingService,
      configMock,
    );

    // Fetch or create pickup point
    let pickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    if (!pickup) {
      const [newPickup] = await prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO pickup_points (id, service_zone_id, name, center_point, is_active)
        VALUES (
          gen_random_uuid(),
          (SELECT id FROM service_zones LIMIT 1),
          'PDEU Main Gate',
          ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
          true
        ) RETURNING id;
      `;
      testPickupPointId = newPickup.id;
    } else {
      testPickupPointId = pickup.id;
    }
  });

  afterAll(async () => {
    for (const bookingId of createdBookingIds) {
      await prisma.cancellationFee
        .deleteMany({
          where: {
            OR: [
              { originalBookingId: bookingId },
              { collectedBookingId: bookingId },
            ],
          },
        })
        .catch(() => {});
      await prisma.bookingStatusHistory
        .deleteMany({ where: { bookingId } })
        .catch(() => {});
      await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    }

    for (const quoteId of createdQuoteIds) {
      await prisma.fareQuote.deleteMany({ where: { id: quoteId } }).catch(() => {});
    }

    for (const userId of createdUserIds) {
      await prisma.cancellationFee.deleteMany({ where: { passengerId: userId } }).catch(() => {});
      await prisma.fareQuote.deleteMany({ where: { passengerId: userId } }).catch(() => {});
      await prisma.passengerProfile.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }

    await prisma.$disconnect();
  });

  async function createTestUser(emailPrefix: string) {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const user = await prisma.user.create({
      data: {
        email: `${emailPrefix}-${suffix}@pdeu.ac.in`,
        fullName: `Surcharge Test Commuter ${suffix}`,
        role: 'PASSENGER',
      },
    });
    createdUserIds.push(user.id);

    await prisma.passengerProfile.create({
      data: {
        userId: user.id,
      },
    });

    return user;
  }

  async function createPriorCancelledBookingWithFee(
    userId: string,
    status: 'OUTSTANDING' | 'COLLECTED' | 'WAIVED',
    amountPaise = 3000,
  ) {
    const [quote] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO fare_quotes (
        id, passenger_id, pickup_point_id, destination_location,
        direct_distance_meters, direct_duration_sec,
        private_estimated_fare_paise, shared_min_fare_paise, shared_max_fare_paise,
        agreed_fare_ceiling_paise, tariff_version, expires_at
      ) VALUES (
        gen_random_uuid(), ${userId}::uuid, ${testPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6700, 23.1600), 4326),
        4000, 600, 6000, 2000, 6000, 6000, 1, NOW() + INTERVAL '2 minutes'
      ) RETURNING id;
    `;
    createdQuoteIds.push(quote.id);

    const [booking] = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO bookings (
        id, passenger_id, fare_quote_id, pickup_point_id,
        passenger_pickup_location, destination_location,
        requested_type, min_group_preference, status,
        agreed_fare_ceiling_paise, max_wait_deadline, created_at
      ) VALUES (
        gen_random_uuid(), ${userId}::uuid, ${quote.id}::uuid, ${testPickupPointId}::uuid,
        ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
        ST_SetSRID(ST_MakePoint(72.6700, 23.1600), 4326),
        'SHARED', 2, 'CANCELLED', 6000, NOW() + INTERVAL '2 minutes', NOW()
      ) RETURNING id;
    `;
    createdBookingIds.push(booking.id);

    const fee = await prisma.cancellationFee.create({
      data: {
        passengerId: userId,
        originalBookingId: booking.id,
        amountPaise,
        status,
        ...(status === 'COLLECTED'
          ? { collectedBookingId: booking.id, collectedAt: new Date() }
          : {}),
        ...(status === 'WAIVED'
          ? { waiverReason: 'Admin verified medical emergency', waivedAt: new Date() }
          : {}),
      },
    });

    return { booking, fee };
  }

  it('1. Passenger with zero outstanding fees receives 0.00 surcharge and cash equals ride estimate', async () => {
    const user = await createTestUser('clean-pax');

    const quote = await faresService.generateQuote(user.id, {
      pickupPointId: testPickupPointId,
      destination: { latitude: 23.1600, longitude: 72.6700 },
    });
    createdQuoteIds.push(quote.quoteId);

    expect(quote.outstandingLateFeeSurcharge).toBe('0.00');
    expect(quote.outstandingLateFeeSurchargePaise).toBe(0);

    // Private total cash equals private estimated fare
    expect(quote.totalCashToCollect.private).toBe(quote.privateEstimatedFare);
    expect(quote.totalCashToCollectPaise.privatePaise).toBe(
      quote.privateEstimatedFarePaise,
    );

    // Shared range total cash equals shared estimated range
    expect(quote.totalCashToCollect.sharedRange.minFare).toBe(
      quote.sharedEstimatedRange.minFare,
    );
    expect(quote.totalCashToCollect.sharedRange.maxFare).toBe(
      quote.sharedEstimatedRange.maxFare,
    );
  });

  it('2. Passenger with one outstanding fee has ₹30.00 surcharge separately disclosed', async () => {
    const user = await createTestUser('single-fee-pax');
    await createPriorCancelledBookingWithFee(user.id, 'OUTSTANDING', 3000);

    const quote = await faresService.generateQuote(user.id, {
      pickupPointId: testPickupPointId,
      destination: { latitude: 23.1600, longitude: 72.6700 },
    });
    createdQuoteIds.push(quote.quoteId);

    expect(quote.outstandingLateFeeSurcharge).toBe('30.00');
    expect(quote.outstandingLateFeeSurchargePaise).toBe(3000);

    // Ceiling is NOT inflated by surcharge
    expect(quote.agreedFareCeilingPaise).toBe(quote.privateEstimatedFarePaise);
    expect(quote.agreedFareCeiling).toBe(quote.privateEstimatedFare);

    // Private total cash reflects private fare + ₹30
    expect(quote.totalCashToCollectPaise.privatePaise).toBe(
      quote.privateEstimatedFarePaise + 3000,
    );
    expect(quote.totalCashToCollect.private).toBe(
      ((quote.privateEstimatedFarePaise + 3000) / 100).toFixed(2),
    );

    // Shared range total cash reflects shared range + ₹30
    expect(quote.totalCashToCollectPaise.sharedRangePaise.minFarePaise).toBe(
      quote.sharedEstimatedRangePaise.minFarePaise + 3000,
    );
    expect(quote.totalCashToCollectPaise.sharedRangePaise.maxFarePaise).toBe(
      quote.sharedEstimatedRangePaise.maxFarePaise + 3000,
    );
  });

  it('3. Passenger with multiple outstanding fees aggregates all outstanding penalties', async () => {
    const user = await createTestUser('multi-fee-pax');
    // Incur two separate ₹30 fees from two prior cancellations
    await createPriorCancelledBookingWithFee(user.id, 'OUTSTANDING', 3000);
    await createPriorCancelledBookingWithFee(user.id, 'OUTSTANDING', 3000);

    const quote = await faresService.generateQuote(user.id, {
      pickupPointId: testPickupPointId,
      destination: { latitude: 23.1600, longitude: 72.6700 },
    });
    createdQuoteIds.push(quote.quoteId);

    // Surcharge must be 6000 paise (₹60.00)
    expect(quote.outstandingLateFeeSurcharge).toBe('60.00');
    expect(quote.outstandingLateFeeSurchargePaise).toBe(6000);

    expect(quote.totalCashToCollectPaise.privatePaise).toBe(
      quote.privateEstimatedFarePaise + 6000,
    );
  });

  it('4. Already COLLECTED and WAIVED fees are strictly excluded from surcharge', async () => {
    const user = await createTestUser('settled-fee-pax');
    // One collected fee, one waived fee, one outstanding fee
    await createPriorCancelledBookingWithFee(user.id, 'COLLECTED', 3000);
    await createPriorCancelledBookingWithFee(user.id, 'WAIVED', 3000);
    await createPriorCancelledBookingWithFee(user.id, 'OUTSTANDING', 3000);

    const quote = await faresService.generateQuote(user.id, {
      pickupPointId: testPickupPointId,
      destination: { latitude: 23.1600, longitude: 72.6700 },
    });
    createdQuoteIds.push(quote.quoteId);

    // Only the 1 OUTSTANDING fee is surcharged
    expect(quote.outstandingLateFeeSurcharge).toBe('30.00');
    expect(quote.outstandingLateFeeSurchargePaise).toBe(3000);
  });

  it('5. Outstanding fees are strictly passenger-isolated (other passengers fees not included)', async () => {
    const userA = await createTestUser('pax-a');
    const userB = await createTestUser('pax-b');

    // User A owes ₹30
    await createPriorCancelledBookingWithFee(userA.id, 'OUTSTANDING', 3000);

    // User B requests a quote
    const quoteB = await faresService.generateQuote(userB.id, {
      pickupPointId: testPickupPointId,
      destination: { latitude: 23.1600, longitude: 72.6700 },
    });
    createdQuoteIds.push(quoteB.quoteId);

    // User B must owe ₹0
    expect(quoteB.outstandingLateFeeSurcharge).toBe('0.00');
    expect(quoteB.outstandingLateFeeSurchargePaise).toBe(0);
  });

  it('6. Quote expiry remains exactly two minutes and agreed fare ceiling is not inflated', async () => {
    const user = await createTestUser('expiry-pax');
    await createPriorCancelledBookingWithFee(user.id, 'OUTSTANDING', 3000);

    const quote = await faresService.generateQuote(user.id, {
      pickupPointId: testPickupPointId,
      destination: { latitude: 23.1600, longitude: 72.6700 },
    });
    createdQuoteIds.push(quote.quoteId);

    const expiresAt = new Date(quote.expiresAt).getTime();
    const now = Date.now();
    const diffSec = Math.round((expiresAt - now) / 1000);

    expect(diffSec).toBeGreaterThanOrEqual(118);
    expect(diffSec).toBeLessThanOrEqual(122);

    // Agreed fare ceiling strictly matches solo reference fare without surcharge
    expect(quote.agreedFareCeilingPaise).toBe(quote.privateEstimatedFarePaise);
  });
});
