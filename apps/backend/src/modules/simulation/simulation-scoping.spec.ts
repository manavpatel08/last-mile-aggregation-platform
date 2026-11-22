import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulationService } from './simulation.service.js';

describe('Simulation Scoping & Dynamic Route Geometry (PR #53 Review Fixes)', () => {
  let service: SimulationService;
  let prismaMock: any;
  let matchingServiceMock: any;
  let dispatchServiceMock: any;
  let tripsServiceMock: any;
  let driversServiceMock: any;
  let bookingsServiceMock: any;
  let faresServiceMock: any;
  let authServiceMock: any;
  let redisServiceMock: any;
  let configService: ConfigService;

  const DEMO_PAX_1_ID = '00000000-0000-0000-0000-000000000001';
  const DEMO_PAX_2_ID = '00000000-0000-0000-0000-000000000002';
  const DEMO_DRIVER_USER_ID = '00000000-0000-0000-0000-000000000003';
  const DEMO_DRIVER_PROFILE_ID = '00000000-0000-0000-0000-000000000004';

  const REAL_COMMUTER_PAX_ID = '11111111-1111-1111-1111-111111111111';
  const REAL_COMMUTER_DRIVER_ID = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    configService = new ConfigService({
      environment: 'development',
      DEMO_MODE: true,
      demoMode: true,
    });

    prismaMock = {
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: DEMO_PAX_1_ID,
            email: 'demo.passenger1@pdeu.ac.in',
            fullName: 'Demo Passenger 1',
            driverProfile: null,
          },
          {
            id: DEMO_PAX_2_ID,
            email: 'demo.passenger2@pdeu.ac.in',
            fullName: 'Demo Passenger 2',
            driverProfile: null,
          },
          {
            id: DEMO_DRIVER_USER_ID,
            email: 'demo.driver@pdeu.ac.in',
            fullName: 'Ramesh Patel',
            driverProfile: {
              id: DEMO_DRIVER_PROFILE_ID,
              userId: DEMO_DRIVER_USER_ID,
            },
          },
        ]),
      },
      driverProfile: {
        findUnique: vi.fn().mockResolvedValue({
          id: DEMO_DRIVER_PROFILE_ID,
          userId: DEMO_DRIVER_USER_ID,
        }),
      },
      trip: {
        findFirst: vi.fn(),
      },
      rideGroup: {
        findFirst: vi.fn(),
      },
      booking: {
        findMany: vi.fn(),
      },
      driverDispatchOffer: {
        findFirst: vi.fn(),
      },
      $queryRaw: vi.fn(),
    };

    matchingServiceMock = {
      processMatchingCycle: vi.fn(),
    };

    dispatchServiceMock = {
      acceptOffer: vi.fn(),
    };

    tripsServiceMock = {
      reportArrival: vi.fn(),
      boardPassenger: vi.fn(),
      completePassengerJourney: vi.fn(),
      completeTrip: vi.fn(),
    };

    driversServiceMock = {
      getDriverGpsFix: vi.fn().mockResolvedValue({
        latitude: 23.1555,
        longitude: 72.6669,
      }),
      recordDriverLocation: vi.fn(),
    };

    bookingsServiceMock = {
      getBoardingPass: vi.fn().mockResolvedValue({ boardingOtp: '1234' }),
    };

    faresServiceMock = {
      generateQuote: vi.fn(),
    };

    authServiceMock = {
      authenticateWithGoogle: vi.fn(),
    };

    redisServiceMock = {
      getPassengerBoardingOtp: vi.fn().mockResolvedValue('1234'),
    };

    const realtimeGatewayMock = {
      server: {
        to: vi.fn().mockReturnValue({
          emit: vi.fn(),
        }),
      },
    };

    service = new SimulationService(
      prismaMock,
      matchingServiceMock,
      dispatchServiceMock,
      tripsServiceMock,
      driversServiceMock,
      bookingsServiceMock,
      faresServiceMock,
      authServiceMock,
      redisServiceMock,
      configService,
      realtimeGatewayMock as any,
    );
  });

  describe('1. Authoritative Scoping: Never select or advance unrelated commuter journeys', () => {
    it('getActiveJourney returns IDLE when only non-demo commuter bookings or trips exist', async () => {
      // Prisma findFirst for trip, rideGroup, booking return null because the where clause filters by demo entities
      prismaMock.trip.findFirst.mockImplementation(({ where }: any) => {
        // Verify where clause restricts to demo entities
        expect(where.OR).toBeDefined();
        return Promise.resolve(null);
      });

      prismaMock.rideGroup.findFirst.mockImplementation(({ where }: any) => {
        expect(where.members.some.booking.passengerId.in).toEqual([
          DEMO_PAX_1_ID,
          DEMO_PAX_2_ID,
        ]);
        return Promise.resolve(null);
      });

      prismaMock.booking.findMany.mockImplementation(({ where }: any) => {
        expect(where.passengerId.in).toEqual([DEMO_PAX_1_ID, DEMO_PAX_2_ID]);
        return Promise.resolve([]);
      });

      const journey = await service.getActiveJourney();

      expect(journey.journeyState).toBe('IDLE');
      expect(journey.message).toContain('No active simulation journey');
    });

    it('progressStep returns NO_ACTION when only non-demo commuter entities exist', async () => {
      prismaMock.driverDispatchOffer.findFirst.mockImplementation(({ where }: any) => {
        expect(where.OR).toBeDefined();
        return Promise.resolve(null);
      });

      prismaMock.trip.findFirst.mockImplementation(({ where }: any) => {
        expect(where.passengers.some.passengerId.in).toEqual([
          DEMO_PAX_1_ID,
          DEMO_PAX_2_ID,
        ]);
        return Promise.resolve(null);
      });

      const res = await service.progressStep();

      expect(res.stepExecuted).toBe('NO_ACTION');
      expect(dispatchServiceMock.acceptOffer).not.toHaveBeenCalled();
      expect(tripsServiceMock.reportArrival).not.toHaveBeenCalled();
      expect(tripsServiceMock.boardPassenger).not.toHaveBeenCalled();
      expect(tripsServiceMock.completePassengerJourney).not.toHaveBeenCalled();
    });
  });

  describe('2. Dynamic Route Geometry & Passenger Booking Destinations', () => {
    it('getActiveJourney extracts dynamic PostGIS coordinates, stop names and route geometry', async () => {
      const mockRouteGeometry = {
        type: 'LineString',
        coordinates: [
          [72.6668, 23.155],
          [72.6612, 23.158],
          [72.6455, 23.1678],
        ],
      };

      prismaMock.trip.findFirst.mockResolvedValue({
        id: 'trip-demo-1',
        status: 'IN_PROGRESS',
        activeDriverId: DEMO_DRIVER_PROFILE_ID,
        driverArrivedAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        activeDriver: {
          userId: DEMO_DRIVER_USER_ID,
          licenseNumber: 'GJ-01-DEMO-2026',
          user: { fullName: 'Ramesh Patel' },
          vehicles: [{ makeModel: 'Mahindra Treo' }],
        },
        passengers: [
          {
            id: 'trip-pax-1',
            passengerId: DEMO_PAX_1_ID,
            bookingId: 'booking-pax-1',
            status: 'BOARDED',
            finalRideFarePaise: 2500,
            boardedAt: new Date(),
            droppedOffAt: null,
            passenger: { fullName: 'Aarav Sharma', email: 'demo.passenger1@pdeu.ac.in' },
          },
          {
            id: 'trip-pax-2',
            passengerId: DEMO_PAX_2_ID,
            bookingId: 'booking-pax-2',
            status: 'BOARDED',
            finalRideFarePaise: 3000,
            boardedAt: new Date(),
            droppedOffAt: null,
            passenger: { fullName: 'Diya Patel', email: 'demo.passenger2@pdeu.ac.in' },
          },
        ],
        rideGroup: {
          routeVersions: [
            {
              totalDistanceMeters: 4200,
              totalDurationSec: 540,
              routeGeometry: mockRouteGeometry,
            },
          ],
        },
      });

      // PostGIS coordinate extraction query mock
      prismaMock.$queryRaw.mockResolvedValue([
        { id: 'booking-pax-1', dest_lat: 23.1678, dest_lng: 72.645 }, // Bhaijipura Circle
        { id: 'booking-pax-2', dest_lat: 23.1885, dest_lng: 72.6288 }, // Kudasan Cross Road
      ]);

      const journey = await service.getActiveJourney();

      expect(journey.journeyState).toBe('IN_PROGRESS');
      expect(journey.passengers).toHaveLength(2);

      // Verify neutral coordinate-based label (no proximity guessing)
      expect(journey.passengers[0].destination).toEqual({
        latitude: 23.1678,
        longitude: 72.645,
        name: 'Drop-off (23.1678, 72.6450)',
      });
      expect(journey.passengers[1].destination).toEqual({
        latitude: 23.1885,
        longitude: 72.6288,
        name: 'Drop-off (23.1885, 72.6288)',
      });

      // Verify dynamic route geometry extracted from route version
      expect(journey.route.geometry).toEqual(mockRouteGeometry);
      expect(journey.route.distanceMeters).toBe(4200);
      expect(journey.route.durationSec).toBe(540);
    });

    it('getActiveJourney returns null route geometry when routeVersions is empty or routeGeometry is null', async () => {
      prismaMock.trip.findFirst.mockResolvedValue({
        id: 'trip-demo-1',
        status: 'IN_PROGRESS',
        activeDriverId: DEMO_DRIVER_PROFILE_ID,
        driverArrivedAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        activeDriver: {
          userId: DEMO_DRIVER_USER_ID,
          licenseNumber: 'GJ-01-DEMO-2026',
          user: { fullName: 'Ramesh Patel' },
          vehicles: [{ makeModel: 'Mahindra Treo' }],
        },
        passengers: [],
        rideGroup: {
          routeVersions: [],
        },
      });

      prismaMock.$queryRaw.mockResolvedValue([]);

      const journey = await service.getActiveJourney();

      expect(journey.journeyState).toBe('IN_PROGRESS');
      expect(journey.route.geometry).toBeNull();
      expect(journey.route.distanceMeters).toBe(0);
      expect(journey.route.durationSec).toBe(0);
    });

    it('getActiveJourney returns null destination when PostGIS returns no coordinates for a booking', async () => {
      prismaMock.trip.findFirst.mockResolvedValue({
        id: 'trip-demo-1',
        status: 'IN_PROGRESS',
        activeDriverId: DEMO_DRIVER_PROFILE_ID,
        driverArrivedAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        activeDriver: {
          userId: DEMO_DRIVER_USER_ID,
          licenseNumber: 'GJ-01-DEMO-2026',
          user: { fullName: 'Ramesh Patel' },
          vehicles: [{ makeModel: 'Mahindra Treo' }],
        },
        passengers: [
          {
            id: 'trip-pax-1',
            passengerId: DEMO_PAX_1_ID,
            bookingId: 'booking-pax-without-coords',
            status: 'BOARDED',
            finalRideFarePaise: 2500,
            boardedAt: new Date(),
            droppedOffAt: null,
            passenger: { fullName: 'Aarav Sharma', email: 'demo.passenger1@pdeu.ac.in' },
          },
        ],
        rideGroup: {
          routeVersions: [
            {
              totalDistanceMeters: 2000,
              totalDurationSec: 300,
              routeGeometry: { type: 'LineString', coordinates: [[72.66, 23.15]] },
            },
          ],
        },
      });

      // Query returns empty array -> No PostGIS coordinates found
      prismaMock.$queryRaw.mockResolvedValue([]);

      const journey = await service.getActiveJourney();

      expect(journey.passengers).toHaveLength(1);
      // Destination must be null without falling back to Bhaijipura or fabricated coordinates
      expect(journey.passengers[0].destination).toBeNull();
    });

    it('getActiveJourney returns authoritative route geometry in DISPATCHING state', async () => {
      const mockRouteGeometry = {
        type: 'LineString',
        coordinates: [
          [72.6668, 23.155],
          [72.6455, 23.1678],
        ],
      };

      prismaMock.trip.findFirst.mockResolvedValue(null);
      prismaMock.rideGroup.findFirst.mockResolvedValue({
        id: 'group-demo-dispatching',
        status: 'DISPATCHING',
        members: [
          {
            bookingId: 'booking-pax-1',
            allocatedFarePaise: 2500,
            booking: {
              passenger: { fullName: 'Aarav Sharma' },
            },
          },
        ],
        dispatchOffers: [
          {
            id: 'offer-1',
            driverId: DEMO_DRIVER_PROFILE_ID,
            expiresAt: new Date(),
            driver: {
              user: { fullName: 'Ramesh Patel' },
            },
          },
        ],
        routeVersions: [
          {
            totalDistanceMeters: 3500,
            totalDurationSec: 420,
            routeGeometry: mockRouteGeometry,
          },
        ],
      });

      prismaMock.$queryRaw.mockResolvedValue([
        { id: 'booking-pax-1', dest_lat: 23.1678, dest_lng: 72.645 },
      ]);

      const journey = await service.getActiveJourney();

      expect(journey.journeyState).toBe('DISPATCHING');
      expect(journey.route.geometry).toEqual(mockRouteGeometry);
      expect(journey.route.distanceMeters).toBe(3500);
      expect(journey.route.durationSec).toBe(420);
    });

    it('progressStep halts with ROUTE_GEOMETRY_MISSING and does not advance trip lifecycle if group route geometry is missing', async () => {
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue({
        id: 'offer-no-route',
        driverId: DEMO_DRIVER_PROFILE_ID,
        rideGroup: {
          id: 'group-no-route',
          routeVersions: [], // No route version generated
        },
      });

      const res = await service.progressStep();

      expect(res.stepExecuted).toBe('ROUTE_GEOMETRY_MISSING');
      expect(res.message).toContain('Required route geometry is missing or invalid');
      // acceptOffer must NOT be called; trip must NOT be created
      expect(dispatchServiceMock.acceptOffer).not.toHaveBeenCalled();
    });
  });

  describe('3. GPS Simulation Driver Protection: Server-side resolution without frontend driverUserId', () => {
    it('updateDriverLocation throws ForbiddenException if demo driver is not provisioned', async () => {
      // User query returns no demo driver
      prismaMock.user.findMany.mockResolvedValueOnce([
        {
          id: DEMO_PAX_1_ID,
          email: 'demo.passenger1@pdeu.ac.in',
          driverProfile: null,
        },
      ]);

      await expect(service.updateDriverLocation(23.1678, 72.645)).rejects.toThrowError(
        ForbiddenException,
      );

      expect(driversServiceMock.recordDriverLocation).not.toHaveBeenCalled();
    });

    it('updateDriverLocation server-side resolves the provisioned demo driver and updates only that driver', async () => {
      prismaMock.driverProfile.findUnique.mockResolvedValue({
        id: DEMO_DRIVER_PROFILE_ID,
        userId: DEMO_DRIVER_USER_ID,
      });

      // Endpoint does not accept driverUserId; server automatically resolves DEMO_DRIVER_USER_ID
      const res = await service.updateDriverLocation(23.1678, 72.645);

      expect(res.success).toBe(true);
      expect(res.driverUserId).toBe(DEMO_DRIVER_USER_ID);
      expect(res.latitude).toBe(23.1678);
      expect(res.longitude).toBe(72.645);
      expect(driversServiceMock.recordDriverLocation).toHaveBeenCalledWith(
        DEMO_DRIVER_USER_ID,
        expect.objectContaining({ latitude: 23.1678, longitude: 72.645 }),
      );
    });
  });

  describe('4. Trip Lifecycle CREATED Status Recognition & Driver Arrival Advancements', () => {
    const mockRouteGeometry = {
      type: 'LineString',
      coordinates: [
        [72.6668, 23.155],
        [72.6455, 23.1678],
      ],
    };

    it('1. A Trip created with status CREATED is returned by getActiveJourney(), including route geometry', async () => {
      prismaMock.trip.findFirst.mockImplementation(({ where }: any) => {
        expect(where.status.in).toContain('CREATED');
        return Promise.resolve({
          id: 'trip-demo-created',
          status: 'CREATED',
          activeDriverId: DEMO_DRIVER_PROFILE_ID,
          driverArrivedAt: null,
          startedAt: null,
          completedAt: null,
          activeDriver: {
            userId: DEMO_DRIVER_USER_ID,
            licenseNumber: 'GJ-01-DEMO-2026',
            user: { fullName: 'Ramesh Patel' },
            vehicles: [{ makeModel: 'Mahindra Treo' }],
          },
          passengers: [
            {
              id: 'tp-1',
              passengerId: DEMO_PAX_1_ID,
              bookingId: 'booking-pax-1',
              status: 'ASSIGNED',
              finalRideFarePaise: 2500,
              boardedAt: null,
              droppedOffAt: null,
              passenger: { fullName: 'Aarav Sharma', email: 'demo.passenger1@pdeu.ac.in' },
            },
          ],
          rideGroup: {
            routeVersions: [
              {
                totalDistanceMeters: 7625,
                totalDurationSec: 720,
                routeGeometry: mockRouteGeometry,
              },
            ],
          },
        });
      });

      prismaMock.$queryRaw.mockResolvedValue([
        { id: 'booking-pax-1', dest_lat: 23.1678, dest_lng: 72.645 },
      ]);

      const journey = await service.getActiveJourney();

      expect(journey.journeyState).toBe('ASSIGNED');
      expect(journey.trip.status).toBe('CREATED');
      expect(journey.route.geometry).toEqual(mockRouteGeometry);
      expect(journey.route.distanceMeters).toBe(7625);
    });

    it('2. The driver-arrival step correctly finds and advances a Trip in CREATED status', async () => {
      // No pending dispatch offer
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);

      // findFirst for Trip in CREATED / DRIVER_EN_ROUTE / ASSIGNED
      prismaMock.trip.findFirst.mockImplementation(({ where }: any) => {
        if (where.status && (where.status.in || Array.isArray(where.status))) {
          const statuses = where.status.in || where.status;
          expect(statuses).toContain('CREATED');
        }
        return Promise.resolve({
          id: 'trip-demo-created',
          status: 'CREATED',
          activeDriverId: DEMO_DRIVER_PROFILE_ID,
          activeDriver: {
            userId: DEMO_DRIVER_USER_ID,
          },
        });
      });

      tripsServiceMock.reportArrival.mockResolvedValue({
        tripId: 'trip-demo-created',
        status: 'AT_PICKUP',
        driverArrivedAt: new Date().toISOString(),
      });

      const res = await service.progressStep();

      expect(res.stepExecuted).toBe('DRIVER_ARRIVED');
      expect(res.message).toContain('Driver arrived at PDEU Demo Station');
      expect(tripsServiceMock.reportArrival).toHaveBeenCalledWith(
        DEMO_DRIVER_USER_ID,
        'trip-demo-created',
      );
    });

    it('3. Missing or stale GPS telemetry produces a clear error rather than silently returning NO_ACTION', async () => {
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);

      prismaMock.trip.findFirst.mockResolvedValue({
        id: 'trip-demo-created',
        status: 'CREATED',
        activeDriverId: DEMO_DRIVER_PROFILE_ID,
        activeDriver: {
          userId: DEMO_DRIVER_USER_ID,
        },
      });

      tripsServiceMock.reportArrival.mockRejectedValue(
        new Error('Driver GPS fix is stale (>30s old). Recent telemetry required to verify pickup arrival.'),
      );

      // Must reject with the telemetry error and NOT silently return NO_ACTION
      await expect(service.progressStep()).rejects.toThrowError(
        'Driver GPS fix is stale (>30s old)',
      );
      expect(tripsServiceMock.reportArrival).toHaveBeenCalled();
    });

    it('4. The complete simulation lifecycle progresses through all states', async () => {
      // Step 1: Offer Acceptance
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValueOnce({
        id: 'offer-1',
        driverId: DEMO_DRIVER_PROFILE_ID,
        rideGroup: {
          id: 'group-1',
          routeVersions: [{ routeGeometry: mockRouteGeometry }],
        },
      });
      dispatchServiceMock.acceptOffer.mockResolvedValueOnce({ tripId: 'trip-1' });

      const step1 = await service.progressStep();
      expect(step1.stepExecuted).toBe('OFFER_ACCEPTED');

      // Step 2: Driver Arrives
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);
      prismaMock.trip.findFirst.mockResolvedValueOnce({
        id: 'trip-1',
        status: 'CREATED',
        activeDriverId: DEMO_DRIVER_PROFILE_ID,
        activeDriver: { userId: DEMO_DRIVER_USER_ID },
      });
      tripsServiceMock.reportArrival.mockResolvedValueOnce({ tripId: 'trip-1', status: 'AT_PICKUP' });

      const step2 = await service.progressStep();
      expect(step2.stepExecuted).toBe('DRIVER_ARRIVED');

      // Step 3: Board & Start Trip
      prismaMock.trip.findFirst
        .mockResolvedValueOnce(null) // for ASSIGNED / CREATED
        .mockResolvedValueOnce({
          id: 'trip-1',
          status: 'AT_PICKUP',
          activeDriverId: DEMO_DRIVER_PROFILE_ID,
          activeDriver: { userId: DEMO_DRIVER_USER_ID },
          passengers: [
            {
              id: 'tp-1',
              passengerId: DEMO_PAX_1_ID,
              bookingId: 'b-1',
              status: 'WAITING',
            },
          ],
        });
      tripsServiceMock.verifyBoarding = vi.fn().mockResolvedValue({});
      tripsServiceMock.startTrip = vi.fn().mockResolvedValue({ tripId: 'trip-1', status: 'IN_PROGRESS' });

      const step3 = await service.progressStep();
      expect(step3.stepExecuted).toBe('TRIP_STARTED');

      // Step 4: Drop-off
      prismaMock.trip.findFirst
        .mockResolvedValueOnce(null) // for ASSIGNED
        .mockResolvedValueOnce(null) // for AT_PICKUP
        .mockResolvedValueOnce({
          id: 'trip-1',
          status: 'IN_PROGRESS',
          activeDriverId: DEMO_DRIVER_PROFILE_ID,
          activeDriver: { userId: DEMO_DRIVER_USER_ID },
          passengers: [
            {
              id: 'tp-1',
              passengerId: DEMO_PAX_1_ID,
              status: 'BOARDED',
              finalRideFarePaise: 2500,
              waitingChargePaise: 0,
            },
          ],
          rideGroup: { routeVersions: [{ routeGeometry: mockRouteGeometry }] },
        });
      tripsServiceMock.completePassenger = vi.fn().mockResolvedValue({});
      prismaMock.cashCollection = { create: vi.fn().mockResolvedValue({}) };

      const step4 = await service.progressStep();
      expect(step4.stepExecuted).toBe('PASSENGER_DROPPED_OFF');

      // Step 5: Complete Trip
      prismaMock.trip.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'trip-1',
          status: 'IN_PROGRESS',
          activeDriverId: DEMO_DRIVER_PROFILE_ID,
          activeDriver: { userId: DEMO_DRIVER_USER_ID },
          passengers: [
            {
              id: 'tp-1',
              passengerId: DEMO_PAX_1_ID,
              status: 'COMPLETED',
            },
          ],
        });
      tripsServiceMock.completeTrip = vi.fn().mockResolvedValue({ tripId: 'trip-1', status: 'COMPLETED' });

      const step5 = await service.progressStep();
      expect(step5.stepExecuted).toBe('TRIP_COMPLETED');
    });
  });
});
