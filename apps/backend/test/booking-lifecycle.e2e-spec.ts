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

describe('Booking & Ride Lifecycle End-to-End Suite (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tripsService: TripsService;

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

    it('should complete individual passenger drop-off and surcharge outstanding ₹30 late fee', async () => {
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
      // Outstanding late fee from earlier post-assignment cancellation
      expect(res.body.data.outstandingLateFeeSurchargePaise).toBe(3000); // ₹30.00
      expect(res.body.data.totalCashToCollectPaise).toBe(6800); // ₹38 + ₹30 = ₹68.00!
      expect(res.body.data.totalCashToCollect).toBe('68.00');

      // Verify idempotent replay
      const replayRes = await request(app.getHttpServer())
        .post(`/api/v1/trips/${fullTripId}/passengers/${passengerUserId}/complete`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', completeKey)
        .expect(200);
      expect(replayRes.body.data.totalCashToCollectPaise).toBe(6800);

      // Verify booking status is now COMPLETED
      const bRes = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${thirdBookingId}`)
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);
      expect(bRes.body.data.status).toBe('COMPLETED');
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
});
