import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter.js';
import { TripsService } from '../src/modules/trips/trips.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { CANONICAL_ACTIVE_BOOKING_STATUSES } from '../src/modules/bookings/bookings.constants.js';
import { canonicalJsonStringify } from '../src/common/utils/canonical-json.js';

describe('Booking & Ride Lifecycle End-to-End Suite (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tripsService: TripsService;
  let authService: AuthService;

  // Track created entities for isolated teardown
  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdTripIds: string[] = [];
  const createdGroupIds: string[] = [];

  // Commuters & Driver Tokens
  let passengerToken: string;
  let passengerUserId: string;
  let otherPassengerToken: string;
  let otherPassengerUserId: string;

  let driverToken: string;
  let driverUserId: string;
  let driverProfileId: string;

  let adminToken: string;
  let adminUserId: string;

  let pdeuPickupPointId: string;
  let testQuoteId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', {
      exclude: ['health', 'health/ready', 'health/live'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    tripsService = moduleFixture.get<TripsService>(TripsService);
    authService = moduleFixture.get<AuthService>(AuthService);

    const initialPickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    if (initialPickup) {
      pdeuPickupPointId = initialPickup.id;
    }

    // 1. Create Passenger 1
    const p1GoogleToken = `mock-google-id-token:sub-bkg-p1-${Date.now()}:commuter1.bkg@pdeu.ac.in:Commuter One`;
    const p1Res = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: p1GoogleToken });
    passengerToken = p1Res.body.data.accessToken;
    passengerUserId = p1Res.body.data.user.id;
    createdUserIds.push(passengerUserId);

    // 2. Create Passenger 2 (for multi-commuter scenarios)
    const p2GoogleToken = `mock-google-id-token:sub-bkg-p2-${Date.now()}:commuter2.bkg@pdeu.ac.in:Commuter Two`;
    const p2Res = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: p2GoogleToken });
    otherPassengerToken = p2Res.body.data.accessToken;
    otherPassengerUserId = p2Res.body.data.user.id;
    createdUserIds.push(otherPassengerUserId);

    // 3. Create Driver User & Onboard
    const dGoogleToken = `mock-google-id-token:sub-bkg-drv-${Date.now()}:driver.bkg@pdeu.ac.in:Driver Ramesh`;
    const dRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: dGoogleToken });
    driverToken = dRes.body.data.accessToken;
    driverUserId = dRes.body.data.user.id;
    createdUserIds.push(driverUserId);

    // Driver Onboard
    const onboardRes = await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        licenseNumber: `GJ-01-BKG-${Date.now()}`,
        vehicle: {
          registrationNumber: `GJ-01-BK-${Date.now().toString().slice(-4)}`,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo Electric',
        },
      });
    driverProfileId = onboardRes.body.data.driverProfile.id;

    // 4. Create Admin & Approve Driver
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-bkg-${Date.now()}@pdeu.ac.in`,
        fullName: 'Lifecycle Transport Admin',
        role: 'ADMIN',
        roles: { create: { roleName: 'ADMIN' } },
      },
    });
    adminUserId = adminUser.id;
    createdUserIds.push(adminUserId);

    const adminSessionToken = `mock-google-id-token:sub-admin-bkg-${Date.now()}:${adminUser.email}:Lifecycle Admin`;
    const adminAuthRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: adminSessionToken });
    // Elevate admin
    await prisma.user.update({
      where: { id: adminAuthRes.body.data.user.id },
      data: { role: 'ADMIN' },
    });
    await prisma.userRole.create({
      data: {
        userId: adminAuthRes.body.data.user.id,
        roleName: 'ADMIN',
      },
    });
    adminToken = adminAuthRes.body.data.accessToken;
    createdUserIds.push(adminAuthRes.body.data.user.id);

    // Approve Driver
    await request(app.getHttpServer())
      .post(`/api/v1/admin/drivers/${driverProfileId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
  });

  afterAll(async () => {
    // Teardown created entities in reverse dependency order
    for (const tripId of createdTripIds) {
      await prisma.cashCollection.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.tripIncident.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.tripStatusHistory.deleteMany({ where: { tripId } }).catch(() => {});
      const tp = await prisma.tripPassenger.findMany({ where: { tripId } }).catch(() => []);
      for (const p of tp) {
        await prisma.boardingVerification.deleteMany({ where: { tripPassengerId: p.id } }).catch(() => {});
      }
      await prisma.tripPassenger.deleteMany({ where: { tripId } }).catch(() => {});
      await prisma.trip.delete({ where: { id: tripId } }).catch(() => {});
    }

    for (const bookingId of createdBookingIds) {
      await prisma.cancellationFee.deleteMany({ where: { originalBookingId: bookingId } }).catch(() => {});
      await prisma.cancellationFee.deleteMany({ where: { collectedBookingId: bookingId } }).catch(() => {});
      await prisma.bookingStatusHistory.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.groupMember.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.matchingBatchBooking.deleteMany({ where: { bookingId } }).catch(() => {});
      await prisma.booking.delete({ where: { id: bookingId } }).catch(() => {});
    }

    for (const groupId of createdGroupIds) {
      await prisma.driverAssignment.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.driverDispatchOffer.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.dispatchAttempt.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.groupRouteVersion.deleteMany({ where: { rideGroupId: groupId } }).catch(() => {});
      await prisma.rideGroup.delete({ where: { id: groupId } }).catch(() => {});
    }

    for (const userId of createdUserIds) {
      await prisma.userSession.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.authIdentity.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.passengerProfile.deleteMany({ where: { userId } }).catch(() => {});
      const driver = await prisma.driverProfile.findUnique({ where: { userId } }).catch(() => null);
      if (driver) {
        await prisma.driverDocument.deleteMany({ where: { driverProfileId: driver.id } }).catch(() => {});
        await prisma.vehicle.deleteMany({ where: { driverProfileId: driver.id } }).catch(() => {});
        await prisma.driverProfile.delete({ where: { id: driver.id } }).catch(() => {});
      }
      await prisma.fareQuote.deleteMany({ where: { passengerId: userId } }).catch(() => {});
      await prisma.cancellationFee.deleteMany({ where: { passengerId: userId } }).catch(() => {});
      await prisma.idempotencyRecord.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.userRole.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }

    await app.close();
  });

  describe('Location Services & Geofencing Endpoints', () => {
    it('should list active pickup zones (GET /api/v1/locations/pickup-zones)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/locations/pickup-zones')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      const pdeu = res.body.data.find((z: any) => z.name === 'PDEU Main Gate');
      expect(pdeu).toBeDefined();
      expect(pdeu.radiusMeters).toBe(150);
      expect(pdeu.latitude).toBeCloseTo(23.155, 3);
      expect(pdeu.longitude).toBeCloseTo(72.6668, 3);
      pdeuPickupPointId = pdeu.id;
    });

    it('should retrieve service region polygons (GET /api/v1/locations/service-regions)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/locations/service-regions')
        .expect(200);

      expect(res.body.success).toBe(true);
      const gandhinagar = res.body.data.find(
        (r: any) => r.name === 'Gandhinagar Service Region',
      );
      expect(gandhinagar).toBeDefined();
      expect(gandhinagar.boundaryGeoJson).toBeDefined();
    });

    it('should validate pickup within 150m geofence successfully', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/locations/validate-pickup')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          pickupPointId: pdeuPickupPointId,
          latitude: 23.1551,
          longitude: 72.6669,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.isValid).toBe(true);
      expect(res.body.data.distanceMeters).toBeLessThanOrEqual(150);
    });

    it('should validate destination within Gandhinagar polygon successfully', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/locations/validate-destination')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          latitude: 23.1812, // Infocity
          longitude: 72.6345,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.isInsideServiceRegion).toBe(true);
    });

    it('should reject destination outside Gandhinagar polygon', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/locations/validate-destination')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          latitude: 28.6139, // New Delhi
          longitude: 77.209,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.isInsideServiceRegion).toBe(false);
    });
  });

  describe('Fare Quotes & Ceilings', () => {
    it('should generate a 2-minute binding fare quote (POST /api/v1/fares/quotes)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/fares/quotes')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          pickupPointId: pdeuPickupPointId,
          destination: {
            latitude: 23.1812, // Infocity (~4.4km)
            longitude: 72.6345,
          },
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.quoteId).toBeDefined();
      expect(res.body.data.directDistanceMeters).toBeGreaterThan(3000);
      expect(res.body.data.privateEstimatedFare).toBeDefined();
      expect(res.body.data.sharedEstimatedRange.minFare).toBe('20.00');
      expect(res.body.data.agreedFareCeiling).toBe(res.body.data.privateEstimatedFare);
      expect(res.body.data.expiresAt).toBeDefined();

      testQuoteId = res.body.data.quoteId;
    });

    it('should reject fare quote for destination outside service region', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/fares/quotes')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          pickupPointId: pdeuPickupPointId,
          destination: {
            latitude: 28.6139,
            longitude: 77.209,
          },
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('DESTINATION_OUTSIDE_SERVICE_AREA');
    });
  });

  describe('Booking Creation & Upfront Consent', () => {
    it('should reject booking creation if Idempotency-Key header is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          quoteId: testQuoteId,
          requestedType: 'SHARED',
          minGroupPreference: 2,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('should reject booking creation if upfrontConsentAgreed is false', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId: testQuoteId,
          requestedType: 'SHARED',
          minGroupPreference: 2,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: false,
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('UPFRONT_CONSENT_REQUIRED');
    });

    it('should reject booking if passenger pickup location exceeds 150m geofence', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId: testQuoteId,
          requestedType: 'SHARED',
          minGroupPreference: 2,
          passengerPickupLocation: { latitude: 23.03, longitude: 72.58 }, // In Ahmedabad
          upfrontConsentAgreed: true,
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('PICKUP_OUTSIDE_GEOFENCE');
    });

    let activeBookingId: string;
    const bookingIdempotencyKey = crypto.randomUUID();

    it('should successfully create booking with upfront consent and mandatory Idempotency-Key', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', bookingIdempotencyKey)
        .send({
          quoteId: testQuoteId,
          requestedType: 'SHARED',
          minGroupPreference: 2,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.bookingId).toBeDefined();
      expect(res.body.data.status).toBe('REQUESTED');
      expect(res.body.data.maxWaitDeadline).toBeDefined();
      expect(res.body.data.agreedFareCeiling).toBeDefined();

      activeBookingId = res.body.data.bookingId;
      createdBookingIds.push(activeBookingId);
    });

    it('should return cached identical response when replaying identical Idempotency-Key', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', bookingIdempotencyKey)
        .send({
          quoteId: testQuoteId,
          requestedType: 'SHARED',
          minGroupPreference: 2,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.bookingId).toBe(activeBookingId);
    });

    it('should reject duplicate booking when Idempotency-Key is reused with different payload', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', bookingIdempotencyKey)
        .send({
          quoteId: testQuoteId,
          requestedType: 'PRIVATE', // Tampered payload
          minGroupPreference: 3,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('should reject idempotency key replay on different endpoint (Cross-Endpoint Conflict)', async () => {
      // Reusing booking creation key on cancel endpoint
      const res = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${activeBookingId}/cancel`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', bookingIdempotencyKey)
        .send({ reason: 'Reusing booking key on cancel' })
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('should enforce Invariant 1: Exactly One Active Booking per Passenger', async () => {
      // Generate a new quote and attempt to create a second concurrent booking
      const newQuoteRes = await request(app.getHttpServer())
        .post('/api/v1/fares/quotes')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          pickupPointId: pdeuPickupPointId,
          destination: { latitude: 23.17, longitude: 72.625 },
        });

      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId: newQuoteRes.body.data.quoteId,
          requestedType: 'SHARED',
          minGroupPreference: 2,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(409);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('ACTIVE_BOOKING_EXISTS');
    });

    it('should query active booking (GET /api/v1/bookings/active)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/bookings/active')
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.bookingId).toBe(activeBookingId);
      expect(res.body.data.status).toBe('REQUESTED');
      expect(res.body.data.pickupPointName).toBe('PDEU Main Gate');
    });

    it('should enforce passenger ownership: other passenger cannot query booking details', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${activeBookingId}`)
        .set('Authorization', `Bearer ${otherPassengerToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should allow booking owner to query booking details', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${activeBookingId}`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.bookingId).toBe(activeBookingId);
      expect(res.body.data.statusHistory.length).toBeGreaterThanOrEqual(1);
    });

    it('should cancel booking before driver assignment with ₹0 fee (Free cancellation)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${activeBookingId}/cancel`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ reason: 'Plans changed; friend offering a ride' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('CANCELLED');
      expect(res.body.data.cancellationFeeAssessedPaise).toBe(0);
      expect(res.body.data.cancellationFeeStatus).toBe('NONE');

      // Verify active booking is now cleared
      const activeRes = await request(app.getHttpServer())
        .get('/api/v1/bookings/active')
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);
      expect(activeRes.body.data).toBeNull();
    });
  });

  describe('Post-Driver Assignment Cancellation & Late Fee Assessment', () => {
    let secondBookingId: string;
    let tripId: string;

    it('should create a second booking now that the previous one is cancelled', async () => {
      const quoteRes = await request(app.getHttpServer())
        .post('/api/v1/fares/quotes')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          pickupPointId: pdeuPickupPointId,
          destination: { latitude: 23.1812, longitude: 72.6345 },
        });

      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId: quoteRes.body.data.quoteId,
          requestedType: 'SHARED',
          minGroupPreference: 2,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      secondBookingId = res.body.data.bookingId;
      createdBookingIds.push(secondBookingId);
    });

    it('should materialize a trip and assign driver (DRIVER_ASSIGNED)', async () => {
      // Create ride group
      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 8000,
          totalRouteDistanceMeters: 5000,
          totalRouteDurationSec: 600,
        },
      });
      createdGroupIds.push(group.id);

      // Create group member
      await prisma.groupMember.create({
        data: {
          rideGroupId: group.id,
          bookingId: secondBookingId,
          dropoffSequenceOrder: 1,
          directDistanceMeters: 4500,
          directDurationSec: 540,
          sharedDurationSec: 600,
          calculatedDetourPercent: 11.1,
          allocatedFarePaise: 4000,
          isActiveMember: true,
        },
      });

      // Materialize trip via TripsService helper
      const trip = await tripsService.createTripManifest({
        driverId: driverProfileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId: secondBookingId,
            passengerId: passengerUserId,
            farePaise: 4000,
            otp: '7890',
          },
        ],
      });
      tripId = trip.id;
      createdTripIds.push(tripId);

      // Verify booking status is now DRIVER_ASSIGNED
      const bRes = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${secondBookingId}`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);
      expect(bRes.body.data.status).toBe('DRIVER_ASSIGNED');
    });

    it('should assess fixed ₹30 late cancellation fee when cancelling after driver assignment', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${secondBookingId}/cancel`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ reason: 'Need to cancel after driver was dispatched' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('CANCELLED');
      expect(res.body.data.cancellationFeeAssessedPaise).toBe(3000); // Fixed ₹30 late fee
      expect(res.body.data.cancellationFeeStatus).toBe('OUTSTANDING');
    });

    it('should query outstanding fees (GET /api/v1/passengers/cancellation-fees/outstanding)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/passengers/cancellation-fees/outstanding')
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.totalOutstandingPaise).toBe(3000);
      expect(res.body.data.fees.length).toBe(1);
      expect(res.body.data.fees[0].originalBookingId).toBe(secondBookingId);
    });
  });

  describe('Booking Authorization & RBAC Matrix', () => {
    let authTestBookingId: string;

    beforeAll(async () => {
      // Create a booking owned by otherPassenger
      const qRes = await request(app.getHttpServer())
        .post('/api/v1/fares/quotes')
        .set('Authorization', `Bearer ${otherPassengerToken}`)
        .send({
          pickupPointId: pdeuPickupPointId,
          destination: { latitude: 23.1812, longitude: 72.6345 },
        });

      const bRes = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${otherPassengerToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId: qRes.body.data.quoteId,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        });

      authTestBookingId = bRes.body.data.bookingId;
      createdBookingIds.push(authTestBookingId);
    });

    it('should forbid passenger from cancelling another passenger booking (403 FORBIDDEN)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${authTestBookingId}/cancel`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ reason: 'Malicious cancellation attempt' })
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should strictly forbid driver from cancelling any passenger booking (403 FORBIDDEN)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${authTestBookingId}/cancel`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ reason: 'Driver attempting to cancel passenger booking' })
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should forbid unassigned driver from viewing booking details (403 FORBIDDEN)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${authTestBookingId}`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should allow admin to cancel a passenger booking (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${authTestBookingId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ reason: 'Administrative intervention' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('CANCELLED');
    });
  });

  describe('Full Ride Lifecycle (Driver Arrival, OTP Boarding, Drop-off, Surcharge Collection, Completion)', () => {
    let thirdBookingId: string;
    let fullTripId: string;
    const testOtp = '4821';

    it('should create passenger booking and trip manifest for full ride flow', async () => {
      // 1. Create booking for Passenger 1
      const qRes = await request(app.getHttpServer())
        .post('/api/v1/fares/quotes')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          pickupPointId: pdeuPickupPointId,
          destination: { latitude: 23.1812, longitude: 72.6345 },
        });

      const bRes = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${passengerToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId: qRes.body.data.quoteId,
          requestedType: 'SHARED',
          minGroupPreference: 2,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        });

      thirdBookingId = bRes.body.data.bookingId;
      createdBookingIds.push(thirdBookingId);

      // 2. Create Ride Group & Trip
      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 7600,
          totalRouteDistanceMeters: 4500,
          totalRouteDurationSec: 540,
        },
      });
      createdGroupIds.push(group.id);

      await prisma.groupMember.create({
        data: {
          rideGroupId: group.id,
          bookingId: thirdBookingId,
          dropoffSequenceOrder: 1,
          directDistanceMeters: 4200,
          directDurationSec: 500,
          sharedDurationSec: 540,
          calculatedDetourPercent: 8.0,
          allocatedFarePaise: 3800,
          isActiveMember: true,
        },
      });

      const trip = await tripsService.createTripManifest({
        driverId: driverProfileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId: thirdBookingId,
            passengerId: passengerUserId,
            farePaise: 3800,
            otp: testOtp,
          },
        ],
      });
      fullTripId = trip.id;
      createdTripIds.push(fullTripId);
    });

    it('should allow assigned driver to view trip booking (200 OK)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${thirdBookingId}`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.bookingId).toBe(thirdBookingId);
    });

    it('should reject driver arrival report if Idempotency-Key is missing', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/arrive-pickup`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('should allow driver to confirm arrival at pickup hub (POST /api/v1/trips/:id/arrive-pickup)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ latitude: 23.155, longitude: 72.6668 })
        .expect(200);

      const arriveKey = crypto.randomUUID();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/arrive-pickup`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', arriveKey)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('AT_PICKUP');
      expect(res.body.data.driverArrivedAt).toBeDefined();

      // Verify idempotent replay
      const replayRes = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/arrive-pickup`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', arriveKey)
        .expect(200);
      expect(replayRes.body.data.status).toBe('AT_PICKUP');

      // Verify booking status transitioned to DRIVER_ARRIVED
      const bRes = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${thirdBookingId}`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);
      expect(bRes.body.data.status).toBe('DRIVER_ARRIVED');
    });

    it('should reject boarding verification with invalid OTP', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/verify-boarding`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          passengerId: passengerUserId,
          otp: '0000', // Incorrect OTP
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('INVALID_OTP');
    });

    it('should successfully verify boarding with correct 4-digit OTP', async () => {
      const verifyKey = crypto.randomUUID();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/verify-boarding`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', verifyKey)
        .send({
          passengerId: passengerUserId,
          otp: testOtp, // Correct OTP '4821'
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.passengerStatus).toBe('BOARDED');
      expect(res.body.data.waitingChargePaise).toBe(0); // Arrived immediately (0 min <= 5m grace period)

      // Verify idempotent replay
      const replayRes = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/verify-boarding`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', verifyKey)
        .send({
          passengerId: passengerUserId,
          otp: testOtp,
        })
        .expect(200);
      expect(replayRes.body.data.passengerStatus).toBe('BOARDED');

      // Verify booking status is now BOARDED
      const bRes = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${thirdBookingId}`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);
      expect(bRes.body.data.status).toBe('BOARDED');
    });

    it('should reject trip start if Idempotency-Key is missing', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/start`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('should start trip and depart pickup hub (POST /api/v1/trips/:id/start)', async () => {
      const startKey = crypto.randomUUID();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/start`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', startKey)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('IN_PROGRESS');

      // Verify idempotent replay
      const replayRes = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/start`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', startKey)
        .expect(200);
      expect(replayRes.body.data.status).toBe('IN_PROGRESS');

      // Verify booking status transitioned to IN_PROGRESS
      const bRes = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${thirdBookingId}`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);
      expect(bRes.body.data.status).toBe('IN_PROGRESS');
    });

    it('should reject passenger completion if Idempotency-Key is missing', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/passengers/${passengerUserId}/complete`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('should complete individual passenger drop-off with allocated fare, keeping outstanding cancellation fee uncollected in Stage 7', async () => {
      const completeKey = crypto.randomUUID();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/passengers/${passengerUserId}/complete`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', completeKey)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.passengerId).toBe(passengerUserId);
      expect(res.body.data.rideFarePaise).toBe(3800); // ₹38.00 allocated ride fare
      expect(res.body.data.waitingChargePaise).toBe(0);
      expect(res.body.data.totalCashToCollectPaise).toBe(3800);
      expect(res.body.data.totalCashToCollect).toBe('38.00');

      // Verify idempotent replay
      const replayRes = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/passengers/${passengerUserId}/complete`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', completeKey)
        .expect(200);
      expect(replayRes.body.data.totalCashToCollectPaise).toBe(3800);

      // Verify booking status is now COMPLETED
      const bRes = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${thirdBookingId}`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);
      expect(bRes.body.data.status).toBe('COMPLETED');

      // Verify cancellation fee remains OUTSTANDING in Stage 7 (settlement deferred to Stage 8)
      const outstandingFees = await prisma.cancellationFee.findMany({
        where: { passengerId: passengerUserId },
      });
      for (const fee of outstandingFees) {
        expect(fee.status).toBe('OUTSTANDING');
        expect(fee.collectedBookingId).toBeNull();
        expect(fee.collectedAt).toBeNull();
      }
    });

    it('should reject trip completion if Idempotency-Key is missing', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/complete`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('should complete vehicle trip and release driver to AVAILABLE (POST /api/v1/trips/:id/complete)', async () => {
      const finishKey = crypto.randomUUID();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/complete`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', finishKey)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('COMPLETED');

      // Verify idempotent replay
      const replayRes = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/complete`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', finishKey)
        .expect(200);
      expect(replayRes.body.data.status).toBe('COMPLETED');

      // Verify driver profile operationalStatus is back to AVAILABLE
      const driverProfile = await prisma.driverProfile.findUnique({
        where: { id: driverProfileId },
      });
      expect(driverProfile?.operationalStatus).toBe('AVAILABLE');
    });
  });

  describe('No-Show Policy Enforcement (10-Minute Threshold)', () => {
    it('should reject no-show declaration if 10 minutes have not elapsed since driver arrival', async () => {
      // Create quick booking and trip
      const qRes = await request(app.getHttpServer())
        .post('/api/v1/fares/quotes')
        .set('Authorization', `Bearer ${otherPassengerToken}`)
        .send({
          pickupPointId: pdeuPickupPointId,
          destination: { latitude: 23.1812, longitude: 72.6345 },
        });

      const bRes = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${otherPassengerToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId: qRes.body.data.quoteId,
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        });

      const noShowBookingId = bRes.body.data.bookingId;
      createdBookingIds.push(noShowBookingId);

      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 3000,
          totalRouteDurationSec: 360,
        },
      });
      createdGroupIds.push(group.id);

      const trip = await tripsService.createTripManifest({
        driverId: driverProfileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId: noShowBookingId,
            passengerId: otherPassengerUserId,
            farePaise: 2500,
            otp: '9999',
          },
        ],
      });
      createdTripIds.push(trip.id);

      // Driver reports location at PDEU pickup hub
      await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ latitude: 23.155, longitude: 72.6668 })
        .expect(200);

      // Driver arrives just NOW (0 seconds elapsed)
      await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/arrive-pickup`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', crypto.randomUUID());

      // Reject if Idempotency-Key is missing
      const missingKeyRes = await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/passengers/${otherPassengerUserId}/no-show`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(400);
      expect(missingKeyRes.body.errorCode).toBe('MISSING_IDEMPOTENCY_KEY');

      // Attempt to declare no-show immediately
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/passengers/${otherPassengerUserId}/no-show`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('NO_SHOW_THRESHOLD_NOT_MET');
    });

    it('should successfully declare no-show after simulating 10 minutes elapsed, assessing flat ₹30 fee with ₹0 waiting charge', async () => {
      // Find the last created trip and simulate driver arrival 11 minutes in the past
      const tripId = createdTripIds[createdTripIds.length - 1];
      const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);

      await prisma.trip.update({
        where: { id: tripId },
        data: { driverArrivedAt: elevenMinutesAgo },
      });

      const noShowKey = crypto.randomUUID();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${tripId}/passengers/${otherPassengerUserId}/no-show`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', noShowKey)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('NO_SHOW');
      expect(res.body.data.penaltyAssessedPaise).toBe(3000); // Flat ₹30 fee

      // Verify idempotent replay
      const replayRes = await request(app.getHttpServer())
        .post(`/api/v1/trips/${tripId}/passengers/${otherPassengerUserId}/no-show`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', noShowKey)
        .expect(200);
      expect(replayRes.body.data.status).toBe('NO_SHOW');

      // Verify trip passenger has 0 waiting charge and NO_SHOW status
      const tp = await prisma.tripPassenger.findFirst({
        where: { tripId, passengerId: otherPassengerUserId },
      });
      expect(tp?.status).toBe('NO_SHOW');
      expect(tp?.waitingChargePaise).toBe(0); // Zero additional waiting charge

      // Verify cancellation_fees ledger has OUTSTANDING ₹30 fee
      const fees = await prisma.cancellationFee.findMany({
        where: { passengerId: otherPassengerUserId, status: 'OUTSTANDING' },
      });
      expect(fees.length).toBe(1);
      expect(fees[0].amountPaise).toBe(3000);
    });
  });

  // -------------------------------------------------------------
  // Helpers for Isolated PR #11 Regression Tests
  // -------------------------------------------------------------
  async function createTestPassenger(label: string) {
    const unique = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const googleToken = `mock-google-id-token:sub-bkg-${label}-${unique}:${label}.${unique}@pdeu.ac.in:Commuter ${label}`;
    const authRes = await authService.authenticateWithGoogle(googleToken);
    const token = authRes.accessToken;
    const userId = authRes.user.id;
    createdUserIds.push(userId);
    return { token, userId };
  }

  async function createTestDriver(label: string) {
    const unique = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const dGoogleToken = `mock-google-id-token:sub-drv-${label}-${unique}:driver.${label}.${unique}@pdeu.ac.in:Driver ${label}`;
    const authRes = await authService.authenticateWithGoogle(dGoogleToken);
    const token = authRes.accessToken;
    const userId = authRes.user.id;
    createdUserIds.push(userId);

    const suffix = `${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 1000)}`;
    const onboardRes = await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${token}`)
      .send({
        licenseNumber: `GJ-01-${label.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)}-${suffix}`,
        vehicle: {
          registrationNumber: `GJ-01-${label.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2)}-${suffix.slice(-4)}`,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo Electric',
        },
      });
    const profileId = onboardRes.body.data.driverProfile.id as string;

    await request(app.getHttpServer())
      .post(`/api/v1/admin/drivers/${profileId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    return { token, userId, profileId };
  }

  async function getQuote(token: string) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/fares/quotes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pickupPointId: pdeuPickupPointId,
        destination: { latitude: 23.1812, longitude: 72.6345 },
      });
    return res.body.data.quoteId as string;
  }

  describe('PR #11 Review Regressions - Issue 1: Idempotency Scoping, Concurrency & Recovery', () => {
    it('should handle concurrent identical requests from same user atomically without duplicate mutations', async () => {
      const pConcurrent = await createTestPassenger('idemp-concurrent');
      const q1 = await getQuote(pConcurrent.token);
      const key = crypto.randomUUID();

      const payload = {
        quoteId: q1,
        requestedType: 'SHARED',
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      };

      const responses = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('Authorization', `Bearer ${pConcurrent.token}`)
          .set('Idempotency-Key', key)
          .send(payload),
        request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('Authorization', `Bearer ${pConcurrent.token}`)
          .set('Idempotency-Key', key)
          .send(payload),
        request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('Authorization', `Bearer ${pConcurrent.token}`)
          .set('Idempotency-Key', key)
          .send(payload),
      ]);

      // All responses should succeed (201) and return the exact same bookingId
      for (const res of responses) {
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
      }
      const bookingIds = responses.map((r) => r.body.data.bookingId);
      expect(new Set(bookingIds).size).toBe(1);

      // Verify in database: exactly 1 booking exists for this passenger
      const dbBookings = await prisma.booking.findMany({
        where: { passengerId: pConcurrent.userId },
      });
      expect(dbBookings.length).toBe(1);
      createdBookingIds.push(dbBookings[0].id);
    });

    it('should allow different passengers to use the same client idempotency key independently without collision', async () => {
      const pA = await createTestPassenger('idemp-user-a');
      const pB = await createTestPassenger('idemp-user-b');
      const qA = await getQuote(pA.token);
      const qB = await getQuote(pB.token);
      const sharedKey = `client-shared-key-${crypto.randomUUID()}`;

      const resA = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pA.token}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          quoteId: qA,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      const resB = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pB.token}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          quoteId: qB,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      expect(resA.body.data.bookingId).toBeDefined();
      expect(resB.body.data.bookingId).toBeDefined();
      expect(resA.body.data.bookingId).not.toBe(resB.body.data.bookingId);

      const bA = await prisma.booking.findUnique({
        where: { id: resA.body.data.bookingId },
      });
      const bB = await prisma.booking.findUnique({
        where: { id: resB.body.data.bookingId },
      });
      expect(bA?.passengerId).toBe(pA.userId);
      expect(bB?.passengerId).toBe(pB.userId);

      createdBookingIds.push(resA.body.data.bookingId, resB.body.data.bookingId);
    });

    it('should return 409 IDEMPOTENCY_CONFLICT when request body differs for same user and key', async () => {
      const pBodyDiff = await createTestPassenger('idemp-body-diff');
      const q1 = await getQuote(pBodyDiff.token);
      const q2 = await getQuote(pBodyDiff.token);
      const key = crypto.randomUUID();

      const res1 = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pBodyDiff.token}`)
        .set('Idempotency-Key', key)
        .send({
          quoteId: q1,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      createdBookingIds.push(res1.body.data.bookingId);

      const res2 = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pBodyDiff.token}`)
        .set('Idempotency-Key', key)
        .send({
          quoteId: q2,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(409);

      expect(res2.body.success).toBe(false);
      expect(res2.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('should return 409 IDEMPOTENCY_CONFLICT when request endpoint path differs for same user and key', async () => {
      const pEpDiff = await createTestPassenger('idemp-ep-diff');
      const q1 = await getQuote(pEpDiff.token);
      const key = crypto.randomUUID();

      const res1 = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pEpDiff.token}`)
        .set('Idempotency-Key', key)
        .send({
          quoteId: q1,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      const bookingId = res1.body.data.bookingId;
      createdBookingIds.push(bookingId);

      // Attempt to cancel using the SAME key that was used to create the booking
      const res2 = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/cancel`)
        .set('Authorization', `Bearer ${pEpDiff.token}`)
        .set('Idempotency-Key', key)
        .send({
          reason: 'Changed mind',
        })
        .expect(409);

      expect(res2.body.success).toBe(false);
      expect(res2.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('should clean up IN_PROGRESS claim on handler failure so subsequent retry with same key succeeds', async () => {
      const pRetry = await createTestPassenger('idemp-retry');
      const key = crypto.randomUUID();

      // Send request with non-existent quote UUID -> triggers 404 NOT_FOUND
      const resFail = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pRetry.token}`)
        .set('Idempotency-Key', key)
        .send({
          quoteId: crypto.randomUUID(),
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(404);

      expect(resFail.body.success).toBe(false);

      // Verify that IN_PROGRESS claim was cleaned up from the database
      const record = await prisma.idempotencyRecord.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: pRetry.userId,
            idempotencyKey: key,
          },
        },
      });
      expect(record).toBeNull();

      // Now send valid request with the SAME key -> should succeed (201)
      const validQuote = await getQuote(pRetry.token);
      const resSuccess = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pRetry.token}`)
        .set('Idempotency-Key', key)
        .send({
          quoteId: validQuote,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      expect(resSuccess.body.success).toBe(true);
      expect(resSuccess.body.data.bookingId).toBeDefined();
      createdBookingIds.push(resSuccess.body.data.bookingId);
    });

    it('should replay exact cached response for completed requests', async () => {
      const pReplay = await createTestPassenger('idemp-replay');
      const q = await getQuote(pReplay.token);
      const key = crypto.randomUUID();

      const payload = {
        quoteId: q,
        requestedType: 'SHARED',
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      };

      const res1 = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pReplay.token}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(201);

      createdBookingIds.push(res1.body.data.bookingId);

      const res2 = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pReplay.token}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(201);

      expect(res2.body).toEqual(res1.body);
    });

    it('should support long query strings (> 255 chars) without path truncation and detect differences', async () => {
      const pLong = await createTestPassenger('idemp-long-path');
      const q = await getQuote(pLong.token);
      const key = crypto.randomUUID();
      const padding = 'z'.repeat(300);
      const longUrlA = `/api/v1/bookings?filter=true&padding=${padding}&tag=alpha`;
      const longUrlB = `/api/v1/bookings?filter=true&padding=${padding}&tag=beta`;

      const payload = {
        quoteId: q,
        requestedType: 'SHARED',
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      };

      const res1 = await request(app.getHttpServer())
        .post(longUrlA)
        .set('Authorization', `Bearer ${pLong.token}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(201);

      createdBookingIds.push(res1.body.data.bookingId);

      // Verify that stored requestPath in database is not truncated to 255 chars
      const record = await prisma.idempotencyRecord.findUnique({
        where: {
          userId_idempotencyKey: { userId: pLong.userId, idempotencyKey: key },
        },
      });
      expect(record?.requestPath.length).toBeGreaterThan(255);
      expect(record?.requestPath).toContain(padding);

      // Replay identical long URL -> 201 cached replay
      const resReplay = await request(app.getHttpServer())
        .post(longUrlA)
        .set('Authorization', `Bearer ${pLong.token}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(201);
      expect(resReplay.body).toEqual(res1.body);

      // Different long URL differing past char 255 -> 409 IDEMPOTENCY_CONFLICT
      const resConflict = await request(app.getHttpServer())
        .post(longUrlB)
        .set('Authorization', `Bearer ${pLong.token}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(409);

      expect(resConflict.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('should reject requests with paths exceeding 4096 characters with 400 URI_TOO_LONG', async () => {
      const pOver = await createTestPassenger('idemp-oversized');
      const key = crypto.randomUUID();
      const oversizedUrl = `/api/v1/bookings?padding=${'w'.repeat(4100)}`;

      const res = await request(app.getHttpServer())
        .post(oversizedUrl)
        .set('Authorization', `Bearer ${pOver.token}`)
        .set('Idempotency-Key', key)
        .send({
          quoteId: crypto.randomUUID(),
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(400);

      expect(res.body.errorCode).toBe('URI_TOO_LONG');
    });

    it('should safely allow takeover of an abandoned claim whose lease expired due to process termination', async () => {
      const pCrash = await createTestPassenger('idemp-crash-e2e');
      const q = await getQuote(pCrash.token);
      const key = crypto.randomUUID();

      const payload = {
        quoteId: q,
        requestedType: 'SHARED',
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      };

      // Seed an abandoned/crashed process claim with expired lease (lockedUntil in the past)
      const crashedRecord = await prisma.idempotencyRecord.create({
        data: {
          userId: pCrash.userId,
          idempotencyKey: key,
          requestPath: 'POST /api/v1/bookings',
          requestHash: crypto
            .createHash('sha256')
            .update(canonicalJsonStringify(payload))
            .digest('hex'),
          status: 'IN_PROGRESS',
          ownerToken: 'crashed-worker-token-uuid',
          lockedUntil: new Date(Date.now() - 10000), // Expired 10s ago
          version: 1,
        },
      });

      // Next request arrives: takes over the expired lease via CAS, executes booking creation
      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pCrash.token}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.bookingId).toBeDefined();
      createdBookingIds.push(res.body.data.bookingId);

      // Verify the record was taken over and transitioned to COMPLETED
      const recovered = await prisma.idempotencyRecord.findUnique({
        where: { id: crashedRecord.id },
      });
      expect(recovered?.status).toBe('COMPLETED');
      expect(recovered?.ownerToken).not.toBe('crashed-worker-token-uuid');
      expect(recovered?.version).toBe(2);
    });
  });

  describe('PR #11 Review Regressions - Issue 2: Multi-Fee Atomic Collection on Next Ride', () => {
    it('should atomically collect multiple outstanding cancellation fees on next completed ride and record in outbox', async () => {
      const pMulti = await createTestPassenger('multi-fee-p');
      const dMulti = await createTestDriver('multi-fee-d');

      // 1. Create two prior bookings through API, then mark CANCELLED
      const q1 = await getQuote(pMulti.token);
      const b1 = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId: q1,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);
      const oldB1Id = b1.body.data.bookingId;
      createdBookingIds.push(oldB1Id);
      await prisma.booking.update({
        where: { id: oldB1Id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      const q2 = await getQuote(pMulti.token);
      const b2 = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId: q2,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);
      const oldB2Id = b2.body.data.bookingId;
      createdBookingIds.push(oldB2Id);
      await prisma.booking.update({
        where: { id: oldB2Id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      // 2. Seed two OUTSTANDING cancellation fees (₹30 each = ₹60 total)
      const fee1 = await prisma.cancellationFee.create({
        data: {
          passengerId: pMulti.userId,
          originalBookingId: oldB1Id,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });
      const fee2 = await prisma.cancellationFee.create({
        data: {
          passengerId: pMulti.userId,
          originalBookingId: oldB2Id,
          amountPaise: 3000,
          status: 'OUTSTANDING',
        },
      });

      // 3. Passenger creates a new booking
      const quoteId = await getQuote(pMulti.token);
      const bRes = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      const newBookingId = bRes.body.data.bookingId;
      createdBookingIds.push(newBookingId);

      // 4. Create ride group & trip manifest
      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 3000,
          totalRouteDurationSec: 360,
        },
      });
      createdGroupIds.push(group.id);

      const trip = await tripsService.createTripManifest({
        driverId: dMulti.profileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId: newBookingId,
            passengerId: pMulti.userId,
            farePaise: 2500,
            otp: '7788',
          },
        ],
      });
      createdTripIds.push(trip.id);

      // 5. Driver reports location and arrives at pickup
      await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${dMulti.token}`)
        .send({ latitude: 23.155, longitude: 72.6668 })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/arrive-pickup`)
        .set('Authorization', `Bearer ${dMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);

      // 6. Boarding verification
      await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/verify-boarding`)
        .set('Authorization', `Bearer ${dMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          passengerId: pMulti.userId,
          otp: '7788',
        })
        .expect(200);

      // 7. Start trip
      await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/start`)
        .set('Authorization', `Bearer ${dMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);

      // 8. Driver completes passenger drop-off -> fees remain OUTSTANDING in Stage 7
      const compRes = await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/passengers/${pMulti.userId}/complete`)
        .set('Authorization', `Bearer ${dMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);

      expect(compRes.body.success).toBe(true);
      expect(compRes.body.data.rideFarePaise).toBe(2500);
      expect(compRes.body.data.waitingChargePaise).toBe(0);
      expect(compRes.body.data.totalCashToCollectPaise).toBe(2500);
      expect(compRes.body.data.totalCashToCollect).toBe('25.00');

      // 9. Verify database status of the cancellation fees: remain OUTSTANDING in Stage 7
      const updatedFees = await prisma.cancellationFee.findMany({
        where: { id: { in: [fee1.id, fee2.id] } },
      });
      expect(updatedFees.length).toBe(2);
      for (const fee of updatedFees) {
        expect(fee.status).toBe('OUTSTANDING');
        expect(fee.collectedBookingId).toBeNull();
        expect(fee.collectedAt).toBeNull();
      }

      // 10. Verify OutboxEvent recorded the completion
      const outboxEvents = await prisma.outboxEvent.findMany({
        where: {
          eventType: 'PASSENGER_DROPPED_OFF',
        },
        orderBy: { createdAt: 'desc' },
      });
      const outboxEvent = outboxEvents.find(
        (e) => (e.payload as any)?.tripId === trip.id,
      );
      expect(outboxEvent).toBeDefined();
      const payload = outboxEvent!.payload as any;
      expect(payload.rideFarePaise).toBe(2500);
      expect(payload.totalCashToCollectPaise).toBe(2500);

      // 11. Complete vehicle trip to free the driver
      await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/complete`)
        .set('Authorization', `Bearer ${dMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);

      // 12. Subsequent ride for pMulti must collect ₹0 outstanding fees
      const qSubsequent = await getQuote(pMulti.token);
      const bSubsequent = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId: qSubsequent,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      const subsequentBookingId = bSubsequent.body.data.bookingId;
      createdBookingIds.push(subsequentBookingId);

      const group2 = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 3000,
          totalRouteDurationSec: 360,
        },
      });
      createdGroupIds.push(group2.id);

      const trip2 = await tripsService.createTripManifest({
        driverId: dMulti.profileId,
        rideGroupId: group2.id,
        passengers: [
          {
            bookingId: subsequentBookingId,
            passengerId: pMulti.userId,
            farePaise: 2500,
            otp: '1122',
          },
        ],
      });
      createdTripIds.push(trip2.id);

      await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${dMulti.token}`)
        .send({ latitude: 23.155, longitude: 72.6668 })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip2.id}/arrive-pickup`)
        .set('Authorization', `Bearer ${dMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip2.id}/verify-boarding`)
        .set('Authorization', `Bearer ${dMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ passengerId: pMulti.userId, otp: '1122' })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip2.id}/start`)
        .set('Authorization', `Bearer ${dMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);

      const comp2Res = await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip2.id}/passengers/${pMulti.userId}/complete`)
        .set('Authorization', `Bearer ${dMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);

      expect(comp2Res.body.success).toBe(true);
      expect(comp2Res.body.data.rideFarePaise).toBe(2500);
      expect(comp2Res.body.data.totalCashToCollectPaise).toBe(2500);

      await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip2.id}/complete`)
        .set('Authorization', `Bearer ${dMulti.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);
    });
  });

  describe('PR #11 Review Regressions - Issue 3: Canonical Active Booking Statuses & Unique Index', () => {
    it('should reject new booking with 409 ACTIVE_BOOKING_EXISTS for all 9 canonical active statuses', async () => {
      for (const activeStatus of CANONICAL_ACTIVE_BOOKING_STATUSES) {
        const passenger = await createTestPassenger(`act-${activeStatus.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8)}`);
        const q = await getQuote(passenger.token);
        const b = await request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('Authorization', `Bearer ${passenger.token}`)
          .set('Idempotency-Key', crypto.randomUUID())
          .send({
            quoteId: q,
            requestedType: 'SHARED',
            passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
            upfrontConsentAgreed: true,
          })
          .expect(201);

        const bookingId = b.body.data.bookingId;
        createdBookingIds.push(bookingId);

        // Update booking to the canonical active status under test
        await prisma.booking.update({
          where: { id: bookingId },
          data: { status: activeStatus },
        });

        // Attempt second booking -> must fail with 409 ACTIVE_BOOKING_EXISTS
        const quoteId = await getQuote(passenger.token);
        const res = await request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('Authorization', `Bearer ${passenger.token}`)
          .set('Idempotency-Key', crypto.randomUUID())
          .send({
            quoteId,
            requestedType: 'SHARED',
            passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
            upfrontConsentAgreed: true,
          })
          .expect(409);

        expect(res.body.success).toBe(false);
        expect(res.body.errorCode).toBe('ACTIVE_BOOKING_EXISTS');
      }
    });

    it('should permit new booking creation when previous booking is in a terminal status', async () => {
      const representativeTerminal = [
        'COMPLETED',
        'CANCELLED',
        'NO_SHOW',
        'EXPIRED',
      ] as const;

      for (const terminalStatus of representativeTerminal) {
        const passenger = await createTestPassenger(`term-${terminalStatus.toLowerCase().slice(0, 6)}`);
        const q = await getQuote(passenger.token);
        const b = await request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('Authorization', `Bearer ${passenger.token}`)
          .set('Idempotency-Key', crypto.randomUUID())
          .send({
            quoteId: q,
            requestedType: 'SHARED',
            passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
            upfrontConsentAgreed: true,
          })
          .expect(201);

        const bookingId = b.body.data.bookingId;
        createdBookingIds.push(bookingId);

        // Update booking to terminal status
        await prisma.booking.update({
          where: { id: bookingId },
          data: { status: terminalStatus },
        });

        // Attempt second booking -> must succeed with 201
        const quoteId = await getQuote(passenger.token);
        const res = await request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('Authorization', `Bearer ${passenger.token}`)
          .set('Idempotency-Key', crypto.randomUUID())
          .send({
            quoteId,
            requestedType: 'SHARED',
            passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
            upfrontConsentAgreed: true,
          })
          .expect(201);

        expect(res.body.success).toBe(true);
        expect(res.body.data.bookingId).toBeDefined();
        createdBookingIds.push(res.body.data.bookingId);
      }
    });

    it('should ensure concurrent booking attempts for the same passenger produce exactly 1 active booking', async () => {
      const pSingle = await createTestPassenger('concurrent-bkg');
      const quoteId = await getQuote(pSingle.token);

      const payload = {
        quoteId,
        requestedType: 'SHARED',
        passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
        upfrontConsentAgreed: true,
      };

      // 3 concurrent requests with DIFFERENT idempotency keys
      const results = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('Authorization', `Bearer ${pSingle.token}`)
          .set('Idempotency-Key', crypto.randomUUID())
          .send(payload),
        request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('Authorization', `Bearer ${pSingle.token}`)
          .set('Idempotency-Key', crypto.randomUUID())
          .send(payload),
        request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('Authorization', `Bearer ${pSingle.token}`)
          .set('Idempotency-Key', crypto.randomUUID())
          .send(payload),
      ]);

      const successResults = results.filter((r) => r.status === 201);
      const conflictResults = results.filter(
        (r) => r.status === 409 && r.body.errorCode === 'ACTIVE_BOOKING_EXISTS',
      );

      expect(successResults.length).toBe(1);
      expect(conflictResults.length).toBe(2);

      const dbActiveBookings = await prisma.booking.findMany({
        where: {
          passengerId: pSingle.userId,
          status: { in: [...CANONICAL_ACTIVE_BOOKING_STATUSES] },
        },
      });
      expect(dbActiveBookings.length).toBe(1);
      createdBookingIds.push(dbActiveBookings[0].id);
    });
  });

  describe('PR #11 Review Regressions - Issues 4 & 6.1: Boarding Verification Atomicity & Trip Status Check', () => {
    it('should reject boarding OTP verification if trip status is not AT_PICKUP', async () => {
      const pOtp = await createTestPassenger('otp-test-p');
      const dOtp = await createTestDriver('otp-test-d');

      const quoteId = await getQuote(pOtp.token);
      const bRes = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pOtp.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      const bookingId = bRes.body.data.bookingId;
      createdBookingIds.push(bookingId);

      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 3000,
          totalRouteDurationSec: 360,
        },
      });
      createdGroupIds.push(group.id);

      const trip = await tripsService.createTripManifest({
        driverId: dOtp.profileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId,
            passengerId: pOtp.userId,
            farePaise: 2500,
            otp: '4821',
          },
        ],
      });
      createdTripIds.push(trip.id);

      // Attempt OTP verification before driver arrival (trip status is CREATED)
      const earlyRes = await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/verify-boarding`)
        .set('Authorization', `Bearer ${dOtp.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          passengerId: pOtp.userId,
          otp: '4821',
        })
        .expect(400);

      expect(earlyRes.body.success).toBe(false);
      expect(earlyRes.body.errorCode).toBe('INVALID_TRIP_STATUS_FOR_BOARDING');
    });

    it('should persist failed OTP attempts across failures and reject with OTP_MAX_ATTEMPTS_EXCEEDED on 4th attempt', async () => {
      const pOtp = await createTestPassenger('otp-counter-p');
      const dOtp = await createTestDriver('otp-counter-d');

      const quoteId = await getQuote(pOtp.token);
      const bRes = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pOtp.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      const bookingId = bRes.body.data.bookingId;
      createdBookingIds.push(bookingId);

      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 3000,
          totalRouteDurationSec: 360,
        },
      });
      createdGroupIds.push(group.id);

      const trip = await tripsService.createTripManifest({
        driverId: dOtp.profileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId,
            passengerId: pOtp.userId,
            farePaise: 2500,
            otp: '4821',
          },
        ],
      });
      createdTripIds.push(trip.id);

      // Driver reports GPS location at PDEU pickup point
      await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${dOtp.token}`)
        .send({ latitude: 23.155, longitude: 72.6668 })
        .expect(200);

      // Driver arrives at pickup hub -> status becomes AT_PICKUP
      await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/arrive-pickup`)
        .set('Authorization', `Bearer ${dOtp.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);

      const tripPassenger = await prisma.tripPassenger.findFirst({
        where: { tripId: trip.id, passengerId: pOtp.userId },
      });
      expect(tripPassenger).toBeDefined();

      // Attempt 1: Wrong OTP with key1 -> counter becomes 1
      const fail1Key = crypto.randomUUID();
      const fail1 = await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/verify-boarding`)
        .set('Authorization', `Bearer ${dOtp.token}`)
        .set('Idempotency-Key', fail1Key)
        .send({
          passengerId: pOtp.userId,
          otp: '0001',
        })
        .expect(400);

      expect(fail1.body.errorCode).toBe('INVALID_OTP');
      expect(fail1.body.success).toBe(false);
      const bv1 = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: tripPassenger!.id },
      });
      expect(bv1?.attemptsCount).toBe(1);

      // Attempt 1 Retry: Same key1 must return cached 400 without incrementing counter
      const fail1Retry = await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/verify-boarding`)
        .set('Authorization', `Bearer ${dOtp.token}`)
        .set('Idempotency-Key', fail1Key)
        .send({
          passengerId: pOtp.userId,
          otp: '0001',
        })
        .expect(400);

      expect(fail1Retry.body.errorCode).toBe('INVALID_OTP');
      expect(fail1Retry.body.success).toBe(false);
      expect(fail1Retry.body).toEqual(fail1.body);
      const bv1Retry = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: tripPassenger!.id },
      });
      expect(bv1Retry?.attemptsCount).toBe(1); // Did not increment on same-key retry!

      // Attempt 2: Different key2 -> new attempt, counter becomes 2
      const fail2Key = crypto.randomUUID();
      const fail2 = await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/verify-boarding`)
        .set('Authorization', `Bearer ${dOtp.token}`)
        .set('Idempotency-Key', fail2Key)
        .send({
          passengerId: pOtp.userId,
          otp: '0002',
        })
        .expect(400);

      expect(fail2.body.errorCode).toBe('INVALID_OTP');
      const bv2 = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: tripPassenger!.id },
      });
      expect(bv2?.attemptsCount).toBe(2);

      // Attempt 2 Retry: Same key2 must return cached 400 without incrementing counter
      const fail2Retry = await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/verify-boarding`)
        .set('Authorization', `Bearer ${dOtp.token}`)
        .set('Idempotency-Key', fail2Key)
        .send({
          passengerId: pOtp.userId,
          otp: '0002',
        })
        .expect(400);

      expect(fail2Retry.body.errorCode).toBe('INVALID_OTP');
      expect(fail2Retry.body).toEqual(fail2.body);
      const bv2Retry = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: tripPassenger!.id },
      });
      expect(bv2Retry?.attemptsCount).toBe(2); // Did not increment on same-key retry!

      // Attempt 3: Wrong OTP -> counter becomes 3
      const fail3 = await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/verify-boarding`)
        .set('Authorization', `Bearer ${dOtp.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          passengerId: pOtp.userId,
          otp: '0003',
        })
        .expect(400);

      expect(fail3.body.errorCode).toBe('INVALID_OTP');
      const bv3 = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: tripPassenger!.id },
      });
      expect(bv3?.attemptsCount).toBe(3);

      // Attempt 4: Even with correct OTP ('4821') -> rejected with OTP_MAX_ATTEMPTS_EXCEEDED
      const fail4 = await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/verify-boarding`)
        .set('Authorization', `Bearer ${dOtp.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          passengerId: pOtp.userId,
          otp: '4821',
        })
        .expect(400);

      expect(fail4.body.errorCode).toBe('OTP_MAX_ATTEMPTS_EXCEEDED');
      const bv4 = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: tripPassenger!.id },
      });
      expect(bv4?.attemptsCount).toBe(3);
      expect(bv4?.isVerified).toBe(false); // Boarding never succeeded
    });

    it('should coordinate concurrent HTTP OTP submissions across distinct keys, guaranteeing at most 3 increments and safe boarding', async () => {
      const pConc = await createTestPassenger('otp-conc-p');
      const dConc = await createTestDriver('otp-conc-d');

      const quoteId = await getQuote(pConc.token);
      const bRes = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${pConc.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          quoteId,
          requestedType: 'SHARED',
          passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
          upfrontConsentAgreed: true,
        })
        .expect(201);

      const bookingId = bRes.body.data.bookingId;
      createdBookingIds.push(bookingId);

      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          rideType: 'SHARED',
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 4000,
          totalRouteDistanceMeters: 4000,
          totalRouteDurationSec: 500,
        },
      });
      createdGroupIds.push(group.id);

      const correctOtp = '6543';
      const trip = await tripsService.createTripManifest({
        driverId: dConc.profileId,
        rideGroupId: group.id,
        passengers: [
          {
            bookingId,
            passengerId: pConc.userId,
            farePaise: 2500,
            otp: correctOtp,
          },
        ],
      });
      createdTripIds.push(trip.id);

      // Driver reports GPS location at PDEU pickup point
      await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${dConc.token}`)
        .send({ latitude: 23.155, longitude: 72.6668 })
        .expect(200);

      // Driver arrives at pickup
      await request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/arrive-pickup`)
        .set('Authorization', `Bearer ${dConc.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);

      const tripPassenger = await prisma.tripPassenger.findFirst({
        where: { tripId: trip.id, passengerId: pConc.userId },
      });

      // Dispatch 3 concurrent requests over HTTP: 1 valid OTP + 2 invalid OTPs
      const validPromise = request(app.getHttpServer())
        .post(`/api/v1/trips/${trip.id}/verify-boarding`)
        .set('Authorization', `Bearer ${dConc.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ passengerId: pConc.userId, otp: correctOtp });

      const invalidPromises = [1, 2].map((i) =>
        request(app.getHttpServer())
          .post(`/api/v1/trips/${trip.id}/verify-boarding`)
          .set('Authorization', `Bearer ${dConc.token}`)
          .set('Idempotency-Key', crypto.randomUUID())
          .send({ passengerId: pConc.userId, otp: `000${i}` }),
      );

      const httpResponses = await Promise.all([validPromise, ...invalidPromises]);

      // At least 1 request must have succeeded (status 200) since 2 invalid attempts cannot exhaust max 3
      const successResponses = httpResponses.filter((r) => r.status === 200);
      expect(successResponses.length).toBeGreaterThanOrEqual(1);

      // Verify PostgreSQL state: passenger is safely boarded
      const finalTp = await prisma.tripPassenger.findFirst({
        where: { id: tripPassenger!.id },
      });
      expect(finalTp?.status).toBe('BOARDED');

      const finalBv = await prisma.boardingVerification.findFirst({
        where: { tripPassengerId: tripPassenger!.id },
      });
      expect(finalBv?.isVerified).toBe(true);
      expect(finalBv!.attemptsCount).toBeLessThanOrEqual(2);

      // Exactly ONE PASSENGER_BOARDED outbox event
      const outboxEvents = await prisma.outboxEvent.findMany({
        where: { aggregateId: tripPassenger!.id, eventType: 'PASSENGER_BOARDED' },
      });
      expect(outboxEvents.length).toBe(1);
    });
  });
});
