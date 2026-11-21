import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter.js';
import { deriveBoardingOtp, hashBoardingOtp } from '../src/common/utils/otp.util.js';

describe('Passenger Boarding Pass Access (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redisService: RedisService;

  const createdUserIds: string[] = [];
  const createdBookingIds: string[] = [];
  const createdTripIds: string[] = [];
  const createdGroupIds: string[] = [];

  let passengerAToken: string;
  let passengerAUserId: string;

  let passengerBToken: string;
  let passengerBUserId: string;

  let driverToken: string;
  let driverUserId: string;
  let driverProfileId: string;

  let pdeuPickupPointId: string;
  let testBookingId: string;
  let testAssignmentId: string;
  let testTripId: string;
  let expectedDerivedOtp: string;

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
    redisService = moduleFixture.get<RedisService>(RedisService);

    const initialPickup = await prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Main Gate' },
    });
    if (initialPickup) {
      pdeuPickupPointId = initialPickup.id;
    }

    // 1. Create Passenger A
    const pAGoogleToken = `mock-google-id-token:sub-otp-pa-${Date.now()}:passengerA.otp@pdeu.ac.in:Passenger Alpha`;
    const pARes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: pAGoogleToken });
    passengerAToken = pARes.body.data.accessToken;
    passengerAUserId = pARes.body.data.user.id;
    createdUserIds.push(passengerAUserId);

    // 2. Create Passenger B
    const pBGoogleToken = `mock-google-id-token:sub-otp-pb-${Date.now()}:passengerB.otp@pdeu.ac.in:Passenger Beta`;
    const pBRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: pBGoogleToken });
    passengerBToken = pBRes.body.data.accessToken;
    passengerBUserId = pBRes.body.data.user.id;
    createdUserIds.push(passengerBUserId);

    // 3. Create Driver User & Onboard
    const dGoogleToken = `mock-google-id-token:sub-otp-drv-${Date.now()}:driver.otp@pdeu.ac.in:Driver Suresh`;
    const dRes = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: dGoogleToken });
    driverToken = dRes.body.data.accessToken;
    driverUserId = dRes.body.data.user.id;
    createdUserIds.push(driverUserId);

    const onboardRes = await request(app.getHttpServer())
      .post('/api/v1/drivers/onboard')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        licenseNumber: `GJ-01-OTP-${Date.now()}`,
        vehicle: {
          registrationNumber: `GJ-01-OP-${Date.now().toString().slice(-4)}`,
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo Electric',
        },
      });
    driverProfileId = onboardRes.body.data.driverProfile.id;

    // Approve driver
    await prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: {
        verificationStatus: 'APPROVED',
        operationalStatus: 'AVAILABLE',
        isOnline: true,
      },
    });

    // 4. Create an initial booking for Passenger A
    const quoteRes = await request(app.getHttpServer())
      .post('/api/v1/fares/quotes')
      .set('Authorization', `Bearer ${passengerAToken}`)
      .send({
        pickupPointId: pdeuPickupPointId,
        destination: { latitude: 23.1812, longitude: 72.6345 },
      });
    const quoteId = quoteRes.body.data.quoteId;

    const bookingRes = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${passengerAToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        quoteId,
        requestedType: 'SHARED',
        minGroupPreference: 2,
        passengerPickupLocation: { latitude: 23.155, longitude: 72.667 },
        upfrontConsentAgreed: true,
      });
    testBookingId = bookingRes.body.data.bookingId;
    createdBookingIds.push(testBookingId);
  });

  afterAll(async () => {
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

  describe('Pre-assignment access control', () => {
    it('should return 400 BOOKING_NOT_ASSIGNED when booking is in REQUESTED status', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${testBookingId}/boarding-pass`)
        .set('Authorization', `Bearer ${passengerAToken}`)
        .expect(400);

      expect(res.body.errorCode).toBe('BOOKING_NOT_ASSIGNED');
    });
  });

  describe('Post-assignment OTP access and retrieval', () => {
    beforeAll(async () => {
      // Create ride group and driver assignment
      const group = await prisma.rideGroup.create({
        data: {
          pickupPointId: pdeuPickupPointId,
          status: 'READY_FOR_DISPATCH',
          totalSharedFarePaise: 3000,
          totalRouteDistanceMeters: 4000,
          totalRouteDurationSec: 600,
        },
      });
      createdGroupIds.push(group.id);

      const attempt = await prisma.dispatchAttempt.create({
        data: {
          rideGroupId: group.id,
          groupVersion: 1,
          status: 'ACTIVE',
        },
      });

      const assignment = await prisma.driverAssignment.create({
        data: {
          dispatchAttemptId: attempt.id,
          rideGroupId: group.id,
          driverId: driverProfileId,
          status: 'RESERVED',
        },
      });
      testAssignmentId = assignment.id;

      // Materialize trip
      const trip = await prisma.trip.create({
        data: {
          rideGroupId: group.id,
          driverAssignmentId: assignment.id,
          activeDriverId: driverProfileId,
          status: 'CREATED',
        },
      });
      testTripId = trip.id;
      createdTripIds.push(trip.id);

      // Transition booking to DRIVER_ASSIGNED
      await prisma.booking.update({
        where: { id: testBookingId },
        data: { status: 'DRIVER_ASSIGNED' },
      });

      // Derive deterministic OTP & hash
      expectedDerivedOtp = deriveBoardingOtp(testBookingId, testAssignmentId);
      const otpHash = hashBoardingOtp(expectedDerivedOtp);

      const tripPassenger = await prisma.tripPassenger.create({
        data: {
          tripId: trip.id,
          bookingId: testBookingId,
          passengerId: passengerAUserId,
          status: 'WAITING',
          finalRideFarePaise: 3000,
          waitingChargePaise: 0,
        },
      });

      await prisma.boardingVerification.create({
        data: {
          tripPassengerId: tripPassenger.id,
          otpHash,
          maxAttempts: 3,
          attemptsCount: 0,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });

      // Seed Redis cache
      await redisService.setPassengerBoardingOtp(testBookingId, expectedDerivedOtp, 1800);
    });

    it('should allow authorized booking owner to retrieve boarding pass with OTP', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${testBookingId}/boarding-pass`)
        .set('Authorization', `Bearer ${passengerAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.bookingId).toBe(testBookingId);
      expect(res.body.data.passengerId).toBe(passengerAUserId);
      expect(res.body.data.tripId).toBe(testTripId);
      expect(res.body.data.boardingOtp).toBe(expectedDerivedOtp);
      expect(res.body.data.boardingOtp).toMatch(/^\d{4}$/);
      expect(res.body.data.bookingStatus).toBe('DRIVER_ASSIGNED');
      expect(res.body.data.driver.name).toBe('Driver Suresh');
      expect(res.body.data.driver.vehicle).toBeDefined();
      expect(res.body.data.driver.vehicle.makeModel).toBe('Mahindra Treo Electric');
    });

    it('should reject access by a different passenger with 403 FORBIDDEN', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${testBookingId}/boarding-pass`)
        .set('Authorization', `Bearer ${passengerBToken}`)
        .expect(403);

      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should reject access by a driver token with 403 FORBIDDEN', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${testBookingId}/boarding-pass`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(403);

      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should seamlessly recover and return OTP if Redis cache is flushed or missing', async () => {
      // Simulate cache eviction / flush
      await redisService.deletePassengerBoardingOtp(testBookingId);
      const cached = await redisService.getPassengerBoardingOtp(testBookingId);
      expect(cached).toBeNull();

      // Passenger requests boarding pass
      const res = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${testBookingId}/boarding-pass`)
        .set('Authorization', `Bearer ${passengerAToken}`)
        .expect(200);

      expect(res.body.data.boardingOtp).toBe(expectedDerivedOtp);

      // Verify that Redis was repopulated
      const repopulated = await redisService.getPassengerBoardingOtp(testBookingId);
      expect(repopulated).toBe(expectedDerivedOtp);
    });

    it('should reject boarding pass access after OTP verification and trip boarding', async () => {
      // 0. Driver reports location at PDEU pickup point
      await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ latitude: 23.155, longitude: 72.6668 })
        .expect(200);

      // 1. Driver arrives at pickup
      await request(app.getHttpServer())
        .post(`/api/v1/trips/${testTripId}/arrive-pickup`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .expect(200);

      // Booking status is now DRIVER_ARRIVED
      const arrivePass = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${testBookingId}/boarding-pass`)
        .set('Authorization', `Bearer ${passengerAToken}`)
        .expect(200);
      expect(arrivePass.body.data.bookingStatus).toBe('DRIVER_ARRIVED');

      // 2. Driver verifies boarding with OTP
      await request(app.getHttpServer())
        .post(`/api/v1/trips/${testTripId}/verify-boarding`)
        .set('Authorization', `Bearer ${driverToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          passengerId: passengerAUserId,
          otp: expectedDerivedOtp,
        })
        .expect(200);

      // 3. Passenger attempts to access boarding pass again
      const postBoardingRes = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${testBookingId}/boarding-pass`)
        .set('Authorization', `Bearer ${passengerAToken}`)
        .expect(400);

      expect(['OTP_ALREADY_VERIFIED', 'OTP_ALREADY_CONSUMED']).toContain(
        postBoardingRes.body.errorCode,
      );

      // Redis key must have been invalidated/deleted upon verification
      const redisOtpAfterBoarding = await redisService.getPassengerBoardingOtp(testBookingId);
      expect(redisOtpAfterBoarding).toBeNull();
    });
  });
});
