import { ConfigService } from '@nestjs/config';
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
      {} as any,
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

      // Verify dynamic destination mapping (not based on passenger name string matching)
      expect(journey.passengers[0].destination).toEqual({
        latitude: 23.1678,
        longitude: 72.645,
        name: 'Bhaijipura Circle',
      });
      expect(journey.passengers[1].destination).toEqual({
        latitude: 23.1885,
        longitude: 72.6288,
        name: 'Kudasan Cross Road',
      });

      // Verify dynamic route geometry extracted from route version
      expect(journey.route.geometry).toEqual(mockRouteGeometry);
      expect(journey.route.distanceMeters).toBe(4200);
      expect(journey.route.durationSec).toBe(540);
    });
  });
});
