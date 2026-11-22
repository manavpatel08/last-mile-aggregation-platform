import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { QUEUES } from '../../common/constants/index.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { MatchingService } from '../matching/matching.service.js';
import { DispatchService } from '../dispatch/dispatch.service.js';
import { TripsService } from '../trips/trips.service.js';
import { DriversService } from '../drivers/drivers.service.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { FaresService } from '../fares/fares.service.js';
import { AuthService } from '../auth/auth.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';

@Injectable()
export class SimulationService {
  private readonly logger = new Logger(SimulationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly matchingService: MatchingService,
    private readonly dispatchService: DispatchService,
    private readonly tripsService: TripsService,
    private readonly driversService: DriversService,
    private readonly bookingsService: BookingsService,
    private readonly faresService: FaresService,
    private readonly authService: AuthService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly realtimeGateway: RealtimeGateway,
    @Optional()
    @InjectQueue(QUEUES.DISPATCH)
    private readonly dispatchQueue?: Queue,
  ) {}

  private checkEnvironmentSafety(): void {
    const env =
      this.configService.get<string>('environment') ||
      process.env.NODE_ENV ||
      'development';
    const isProd = env === 'production' || process.env.NODE_ENV === 'production';
    const isDemo =
      !isProd &&
      (this.configService.get<boolean>('demoMode', false) ||
        this.configService.get<boolean>('DEMO_MODE', false) ||
        process.env.DEMO_MODE === 'true' ||
        process.env.DEMO_MODE === '1');

    if (isProd || !isDemo) {
      throw new ForbiddenException(
        'Simulation operations are only permitted in non-production environments with DEMO_MODE enabled',
      );
    }
  }

  private async getDemoEntities() {
    const demoUsers = await this.prisma.user.findMany({
      where: {
        email: {
          in: [
            'demo.passenger1@pdeu.ac.in',
            'demo.passenger2@pdeu.ac.in',
            'demo.driver@pdeu.ac.in',
          ],
        },
      },
      select: { id: true, email: true },
    });

    const demoPassengerIds = demoUsers
      .filter((u) => u.email.startsWith('demo.passenger'))
      .map((u) => u.id);

    const demoDriverUser = demoUsers.find(
      (u) => u.email === 'demo.driver@pdeu.ac.in',
    );

    let demoDriverProfileId: string | null = null;
    if (demoDriverUser) {
      const driverProfile = await this.prisma.driverProfile.findUnique({
        where: { userId: demoDriverUser.id },
        select: { id: true },
      });
      demoDriverProfileId = driverProfile?.id ?? null;
    }

    return {
      demoUsers,
      demoPassengerIds,
      demoDriverUserId: demoDriverUser?.id ?? null,
      demoDriverProfileId,
    };
  }

  private getDestinationName(lat: number, lng: number): string {
    return `Drop-off (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
  }

  /**
   * Provisions or refreshes virtual passengers and a virtual driver.
   * Ensures driver has vehicle registered, approved, online, available, and initial GPS set.
   */
  async provisionAgents() {
    this.checkEnvironmentSafety();

    // 1. Provision Passenger 1
    const p1Auth = await this.authService.authenticateWithGoogle(
      'demo-google-token:pax-sub-001:demo.passenger1@pdeu.ac.in:Commuter A',
    );

    // 2. Provision Passenger 2
    const p2Auth = await this.authService.authenticateWithGoogle(
      'demo-google-token:pax-sub-002:demo.passenger2@pdeu.ac.in:Commuter B',
    );

    // 3. Provision Driver
    const drvAuth = await this.authService.authenticateWithGoogle(
      'demo-google-token:drv-sub-001:demo.driver@pdeu.ac.in:Driver Ramesh',
    );

    // Check or create Driver Profile & Vehicle
    let driverProfile = await this.prisma.driverProfile.findUnique({
      where: { userId: drvAuth.user.id },
      include: { vehicles: true },
    });

    if (!driverProfile) {
      await this.driversService.onboardDriver(drvAuth.user.id, {
        licenseNumber: 'GJ-01-DEMO-001',
        vehicle: {
          registrationNumber: 'GJ-01-DM-0001',
          vehicleType: 'E_RICKSHAW',
          passengerCapacity: 4,
          makeModel: 'Mahindra Treo Electric',
        },
      });

      driverProfile = await this.prisma.driverProfile.findUnique({
        where: { userId: drvAuth.user.id },
        include: { vehicles: true },
      });
    }

    if (!driverProfile) {
      throw new Error('Failed to find or create driver profile');
    }

    // Ensure driver is approved
    if (driverProfile.verificationStatus !== 'APPROVED') {
      await this.driversService.approveDriver(driverProfile.id, '00000000-0000-0000-0000-000000000001');
    }

    // Put driver online & available
    await this.driversService.updateDriverOperationalStatus(drvAuth.user.id, {
      isOnline: true,
    });

    // Report initial GPS fix at PDEU Demo Station
    await this.driversService.recordDriverLocation(drvAuth.user.id, {
      latitude: 23.155,
      longitude: 72.6668,
      heading: 0,
      speed: 0,
    });

    return {
      passenger1: {
        userId: p1Auth.user.id,
        email: p1Auth.user.email,
        token: p1Auth.accessToken,
      },
      passenger2: {
        userId: p2Auth.user.id,
        email: p2Auth.user.email,
        token: p2Auth.accessToken,
      },
      driver: {
        driverProfileId: driverProfile.id,
        userId: drvAuth.user.id,
        email: drvAuth.user.email,
        token: drvAuth.accessToken,
        vehicleRegistration: 'GJ-01-DM-0001',
      },
    };
  }

  /**
   * Creates 2 shared commuter bookings from PDEU Demo Station along the corridor.
   * Strictly requires PDEU Demo Station and fails clearly if it does not exist.
   */
  async createDemoBookings() {
    this.checkEnvironmentSafety();

    const agents = await this.provisionAgents();

    // Strictly require PDEU Demo Station (NO fallback to PDEU Main Gate)
    const pickup = await this.prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Demo Station', isActive: true },
    });

    if (!pickup) {
      throw new NotFoundException(
        'PDEU Demo Station pickup hub not found in database. Simulation strictly requires PDEU Demo Station.',
      );
    }

    // Passenger 1 -> Bhaijipura Circle (23.1678, 72.6450)
    const quote1 = await this.faresService.generateQuote(agents.passenger1.userId, {
      pickupPointId: pickup.id,
      destination: { latitude: 23.1678, longitude: 72.645 },
    });

    const booking1 = await this.bookingsService.createBooking(agents.passenger1.userId, {
      quoteId: quote1.quoteId,
      passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
      requestedType: 'SHARED',
      upfrontConsentAgreed: true,
      minGroupPreference: 2,
    });

    // Passenger 2 -> Kudasan Cross Road (23.1885, 72.6288)
    const quote2 = await this.faresService.generateQuote(agents.passenger2.userId, {
      pickupPointId: pickup.id,
      destination: { latitude: 23.1885, longitude: 72.6288 },
    });

    const booking2 = await this.bookingsService.createBooking(agents.passenger2.userId, {
      quoteId: quote2.quoteId,
      passengerPickupLocation: { latitude: 23.155, longitude: 72.6668 },
      requestedType: 'SHARED',
      upfrontConsentAgreed: true,
      minGroupPreference: 2,
    });

    return {
      pickupPointId: pickup.id,
      pickupPointName: pickup.name,
      booking1: {
        id: booking1.bookingId,
        status: booking1.status,
      },
      booking2: {
        id: booking2.bookingId,
        status: booking2.status,
      },
    };
  }

  /**
   * Immediately executes matching cycle strictly for PDEU Demo Station.
   * Strictly requires PDEU Demo Station and fails clearly if it does not exist.
   */
  async triggerMatching(pickupPointName: string = 'PDEU Demo Station') {
    this.checkEnvironmentSafety();

    const targetName = pickupPointName || 'PDEU Demo Station';

    const pickup = await this.prisma.pickupPoint.findFirst({
      where: { name: targetName, isActive: true },
    });

    if (!pickup) {
      throw new NotFoundException(
        `Pickup hub [${targetName}] not found in database. Simulation strictly requires PDEU Demo Station.`,
      );
    }

    const leaseKey = `lease:matching:${targetName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    const summary = await this.matchingService.processMatchingCycle(targetName, leaseKey);

    // Trigger dispatch for formed groups immediately
    if (summary && summary.groupsFormedCount > 0 && summary.formedGroupIds.length > 0) {
      for (const groupId of summary.formedGroupIds) {
        try {
          await this.dispatchService.initiateDispatchForGroup(groupId);
        } catch (err: any) {
          this.logger.warn(`Immediate dispatch initiation for group ${groupId}: ${err?.message}`);
        }
      }
    }

    return summary;
  }

  /**
   * Authoritative snapshot of the active simulation journey.
   * Strictly scoped to verified demo driver and demo passengers.
   */
  async getActiveJourney() {
    this.checkEnvironmentSafety();

    const demoEntities = await this.getDemoEntities();
    if (
      !demoEntities.demoDriverProfileId &&
      demoEntities.demoPassengerIds.length === 0
    ) {
      return {
        journeyState: 'IDLE',
        message: 'No simulation agents provisioned. Click "Setup Agents".',
      };
    }

    // 1. Check for active trip strictly scoped to demo driver or demo passengers
    const activeTrip = await this.prisma.trip.findFirst({
      where: {
        status: { in: ['ASSIGNED', 'AT_PICKUP', 'IN_PROGRESS'] },
        OR: [
          demoEntities.demoDriverProfileId
            ? { activeDriverId: demoEntities.demoDriverProfileId }
            : undefined,
          demoEntities.demoPassengerIds.length > 0
            ? {
                passengers: {
                  some: { passengerId: { in: demoEntities.demoPassengerIds } },
                },
              }
            : undefined,
        ].filter(Boolean) as any,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        passengers: {
          where: {
            passengerId: { in: demoEntities.demoPassengerIds },
          },
          include: {
            passenger: { select: { id: true, fullName: true, email: true } },
            booking: { select: { id: true } },
          },
        },
        activeDriver: {
          include: {
            user: { select: { id: true, fullName: true, email: true } },
            vehicles: { where: { isActive: true }, take: 1 },
          },
        },
        rideGroup: {
          include: {
            routeVersions: { orderBy: { versionNumber: 'desc' }, take: 1 },
            stops: { orderBy: { stopOrder: 'asc' } },
          },
        },
      },
    });

    if (activeTrip) {
      // Get driver GPS fix from Redis
      const gpsFix = await this.driversService.getDriverGpsFix(activeTrip.activeDriverId);

      // Query destination coordinates from bookings table
      const bookingIds = activeTrip.passengers.map((p) => p.bookingId);
      const bookingCoords = await this.prisma.$queryRaw<
        Array<{
          id: string;
          dest_lat: number;
          dest_lng: number;
        }>
      >`
        SELECT
          b.id,
          ST_Y(b.destination_location) as dest_lat,
          ST_X(b.destination_location) as dest_lng
        FROM bookings b
        WHERE b.id = ANY(${bookingIds}::uuid[])
      `;

      const coordMap = new Map(
        bookingCoords.map((c) => [
          c.id,
          { lat: Number(c.dest_lat), lng: Number(c.dest_lng) },
        ]),
      );

      // Fetch boarding passes / OTPs
      const passengersWithOtpAndDest = await Promise.all(
        activeTrip.passengers.map(async (p) => {
          let otp: string | null = null;
          try {
            const bp = await this.bookingsService.getBoardingPass(
              { id: p.passengerId, role: 'PASSENGER', roles: ['PASSENGER'] },
              p.bookingId,
            );
            otp = bp.boardingOtp;
          } catch {
            otp = await this.redisService.getPassengerBoardingOtp(p.bookingId);
          }

          const coords = coordMap.get(p.bookingId);
          const hasValidCoords =
            coords &&
            typeof coords.lat === 'number' &&
            !isNaN(coords.lat) &&
            typeof coords.lng === 'number' &&
            !isNaN(coords.lng);

          const destination = hasValidCoords
            ? {
                latitude: coords.lat,
                longitude: coords.lng,
                name: this.getDestinationName(coords.lat, coords.lng),
              }
            : null;

          return {
            id: p.id,
            passengerId: p.passengerId,
            fullName: p.passenger.fullName,
            email: p.passenger.email,
            bookingId: p.bookingId,
            status: p.status,
            finalRideFarePaise: p.finalRideFarePaise,
            boardedAt: p.boardedAt,
            droppedOffAt: p.droppedOffAt,
            boardingOtp: otp,
            destination,
          };
        }),
      );

      const latestRouteVersion = activeTrip.rideGroup?.routeVersions?.[0];

      return {
        journeyState: activeTrip.status,
        trip: {
          id: activeTrip.id,
          status: activeTrip.status,
          driverArrivedAt: activeTrip.driverArrivedAt,
          startedAt: activeTrip.startedAt,
          completedAt: activeTrip.completedAt,
        },
        driver: {
          driverId: activeTrip.activeDriverId,
          userId: activeTrip.activeDriver.userId,
          fullName: activeTrip.activeDriver.user.fullName,
          licenseNumber: activeTrip.activeDriver.licenseNumber,
          vehicle: activeTrip.activeDriver.vehicles[0]?.makeModel || 'E-Rickshaw',
          currentGps: gpsFix,
        },
        passengers: passengersWithOtpAndDest,
        route: {
          distanceMeters: latestRouteVersion?.totalDistanceMeters || 0,
          durationSec: latestRouteVersion?.totalDurationSec || 0,
          geometry: latestRouteVersion?.routeGeometry || null,
        },
      };
    }

    // 2. Check for active RideGroup in dispatch strictly scoped to demo passengers
    const activeGroup = await this.prisma.rideGroup.findFirst({
      where: {
        status: { in: ['READY_FOR_DISPATCH', 'DISPATCHING'] },
        members: {
          some: {
            booking: {
              passengerId: { in: demoEntities.demoPassengerIds },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        members: {
          include: {
            booking: {
              include: {
                passenger: { select: { id: true, fullName: true, email: true } },
              },
            },
          },
        },
        dispatchOffers: {
          where: {
            status: 'PENDING',
            ...(demoEntities.demoDriverProfileId
              ? { driverId: demoEntities.demoDriverProfileId }
              : {}),
          },
          take: 1,
          include: {
            driver: {
              include: { user: { select: { id: true, fullName: true } } },
            },
          },
        },
        routeVersions: { orderBy: { versionNumber: 'desc' }, take: 1 },
      },
    });

    if (activeGroup) {
      const pendingOffer =
        activeGroup.dispatchOffers && activeGroup.dispatchOffers.length > 0
          ? activeGroup.dispatchOffers[0]
          : null;

      const latestRouteVersion = activeGroup.routeVersions?.[0];

      const groupBookingIds = activeGroup.members.map((m) => m.bookingId);
      const groupCoords = await this.prisma.$queryRaw<
        Array<{
          id: string;
          dest_lat: number;
          dest_lng: number;
        }>
      >`
        SELECT
          b.id,
          ST_Y(b.destination_location) as dest_lat,
          ST_X(b.destination_location) as dest_lng
        FROM bookings b
        WHERE b.id = ANY(${groupBookingIds}::uuid[])
      `;

      const groupCoordMap = new Map(
        groupCoords.map((c) => [
          c.id,
          { lat: Number(c.dest_lat), lng: Number(c.dest_lng) },
        ]),
      );

      return {
        journeyState: 'DISPATCHING',
        rideGroup: {
          id: activeGroup.id,
          status: activeGroup.status,
          pendingOffer: pendingOffer
            ? {
                offerId: pendingOffer.id,
                driverId: pendingOffer.driverId,
                driverName: pendingOffer.driver.user.fullName,
                expiresAt: pendingOffer.expiresAt,
              }
            : null,
          members: activeGroup.members.map((m) => {
            const coords = groupCoordMap.get(m.bookingId);
            const hasValidCoords =
              coords &&
              typeof coords.lat === 'number' &&
              !isNaN(coords.lat) &&
              typeof coords.lng === 'number' &&
              !isNaN(coords.lng);

            return {
              bookingId: m.bookingId,
              passengerName: m.booking.passenger.fullName,
              allocatedFarePaise: m.allocatedFarePaise,
              destination: hasValidCoords
                ? {
                    latitude: coords.lat,
                    longitude: coords.lng,
                    name: this.getDestinationName(coords.lat, coords.lng),
                  }
                : null,
            };
          }),
        },
        route: {
          distanceMeters: latestRouteVersion?.totalDistanceMeters || 0,
          durationSec: latestRouteVersion?.totalDurationSec || 0,
          geometry: latestRouteVersion?.routeGeometry || null,
        },
      };
    }

    // 3. Check for waiting bookings strictly belonging to demo passengers
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ['REQUESTED', 'MATCHING'] },
        passengerId: { in: demoEntities.demoPassengerIds },
      },
      orderBy: { createdAt: 'desc' },
      take: 4,
      include: {
        passenger: { select: { id: true, fullName: true } },
      },
    });

    if (bookings.length > 0) {
      const waitingBookingIds = bookings.map((b) => b.id);
      const waitingCoords = await this.prisma.$queryRaw<
        Array<{
          id: string;
          dest_lat: number;
          dest_lng: number;
        }>
      >`
        SELECT
          b.id,
          ST_Y(b.destination_location) as dest_lat,
          ST_X(b.destination_location) as dest_lng
        FROM bookings b
        WHERE b.id = ANY(${waitingBookingIds}::uuid[])
      `;

      const waitingCoordMap = new Map(
        waitingCoords.map((c) => [
          c.id,
          { lat: Number(c.dest_lat), lng: Number(c.dest_lng) },
        ]),
      );

      return {
        journeyState: 'WAITING_FOR_MATCH',
        bookings: bookings.map((b) => {
          const coords = waitingCoordMap.get(b.id);
          const hasValidCoords =
            coords &&
            typeof coords.lat === 'number' &&
            !isNaN(coords.lat) &&
            typeof coords.lng === 'number' &&
            !isNaN(coords.lng);

          return {
            id: b.id,
            passengerName: b.passenger.fullName,
            status: b.status,
            createdAt: b.createdAt,
            destination: hasValidCoords
              ? {
                  latitude: coords.lat,
                  longitude: coords.lng,
                  name: this.getDestinationName(coords.lat, coords.lng),
                }
              : null,
          };
        }),
      };
    }

    return {
      journeyState: 'IDLE',
      message: 'No active simulation journey. Click "Setup Agents" or "Book Rides".',
    };
  }

  /**
   * Advances the simulation to the next logical state.
   * Strictly scoped to demo driver, demo passengers, and their groups/trips.
   * Never selects or advances unrelated commuter journeys.
   */
  async progressStep() {
    this.checkEnvironmentSafety();

    const demoEntities = await this.getDemoEntities();
    if (
      !demoEntities.demoDriverProfileId &&
      demoEntities.demoPassengerIds.length === 0
    ) {
      return {
        stepExecuted: 'NO_ACTION',
        message: 'No simulation agents provisioned.',
      };
    }

    // 1. Check for pending offer strictly for demo driver or demo group -> Driver Accepts
    const pendingOffer = await this.prisma.driverDispatchOffer.findFirst({
      where: {
        status: 'PENDING',
        OR: [
          demoEntities.demoDriverProfileId
            ? { driverId: demoEntities.demoDriverProfileId }
            : undefined,
          {
            rideGroup: {
              members: {
                some: {
                  booking: {
                    passengerId: { in: demoEntities.demoPassengerIds },
                  },
                },
              },
            },
          },
        ].filter(Boolean) as any,
      },
      include: {
        driver: true,
        rideGroup: {
          include: {
            routeVersions: { orderBy: { versionNumber: 'desc' }, take: 1 },
          },
        },
      },
    });

    if (pendingOffer && demoEntities.demoDriverUserId) {
      // Validate route availability on the group before accepting offer and advancing trip lifecycle
      const latestRoute = pendingOffer.rideGroup?.routeVersions?.[0];
      const hasValidGeometry =
        latestRoute?.routeGeometry &&
        Array.isArray((latestRoute.routeGeometry as any)?.coordinates) &&
        (latestRoute.routeGeometry as any).coordinates.length > 0;

      if (!hasValidGeometry) {
        return {
          stepExecuted: 'ROUTE_GEOMETRY_MISSING',
          message:
            'Cannot advance trip lifecycle: Required route geometry is missing or invalid for ride group.',
        };
      }

      const acceptResult = await this.dispatchService.acceptOffer(
        demoEntities.demoDriverUserId,
        pendingOffer.id,
      );
      return {
        stepExecuted: 'OFFER_ACCEPTED',
        message: 'Driver Ramesh accepted dispatch offer; Trip created',
        tripId: acceptResult.tripId,
      };
    }

    // 2. Check for Trip in ASSIGNED strictly for demo driver / demo passengers -> Driver Arrives
    const assignedTrip = await this.prisma.trip.findFirst({
      where: {
        status: 'ASSIGNED',
        ...(demoEntities.demoDriverProfileId
          ? { activeDriverId: demoEntities.demoDriverProfileId }
          : {}),
        passengers: {
          some: { passengerId: { in: demoEntities.demoPassengerIds } },
        },
      },
      include: { activeDriver: true },
    });

    if (assignedTrip && demoEntities.demoDriverUserId) {
      const arriveResult = await this.tripsService.reportArrival(
        demoEntities.demoDriverUserId,
        assignedTrip.id,
      );
      return {
        stepExecuted: 'DRIVER_ARRIVED',
        message: 'Driver arrived at PDEU Demo Station Hub',
        data: arriveResult,
      };
    }

    // 3. Check for Trip in AT_PICKUP strictly for demo driver / passengers -> Board and Start
    const pickupTrip = await this.prisma.trip.findFirst({
      where: {
        status: 'AT_PICKUP',
        ...(demoEntities.demoDriverProfileId
          ? { activeDriverId: demoEntities.demoDriverProfileId }
          : {}),
        passengers: {
          some: { passengerId: { in: demoEntities.demoPassengerIds } },
        },
      },
      include: {
        activeDriver: true,
        passengers: {
          where: {
            status: 'WAITING',
            passengerId: { in: demoEntities.demoPassengerIds },
          },
        },
      },
    });

    if (pickupTrip && demoEntities.demoDriverUserId) {
      // Verify boarding strictly for waiting demo passengers
      for (const p of pickupTrip.passengers) {
        let otp = await this.redisService.getPassengerBoardingOtp(p.bookingId);
        if (!otp) {
          const bp = await this.bookingsService.getBoardingPass(
            { id: p.passengerId, role: 'PASSENGER', roles: ['PASSENGER'] },
            p.bookingId,
          );
          otp = bp.boardingOtp;
        }

        await this.tripsService.verifyBoarding(
          demoEntities.demoDriverUserId,
          pickupTrip.id,
          { passengerId: p.passengerId, otp: otp! },
        );
      }

      // Start the trip
      const startResult = await this.tripsService.startTrip(
        demoEntities.demoDriverUserId,
        pickupTrip.id,
      );

      return {
        stepExecuted: 'TRIP_STARTED',
        message: 'All passengers boarded via OTP; Trip departs PDEU Demo Station',
        data: startResult,
      };
    }

    // 4. Check for Trip in IN_PROGRESS strictly for demo driver / passengers -> Step GPS, drop off
    const inProgressTrip = await this.prisma.trip.findFirst({
      where: {
        status: 'IN_PROGRESS',
        ...(demoEntities.demoDriverProfileId
          ? { activeDriverId: demoEntities.demoDriverProfileId }
          : {}),
        passengers: {
          some: { passengerId: { in: demoEntities.demoPassengerIds } },
        },
      },
      include: {
        activeDriver: true,
        passengers: {
          where: { passengerId: { in: demoEntities.demoPassengerIds } },
        },
        rideGroup: {
          include: {
            routeVersions: { orderBy: { versionNumber: 'desc' }, take: 1 },
          },
        },
      },
    });

    if (inProgressTrip && demoEntities.demoDriverUserId) {
      // Find uncompleted demo passengers
      const uncompleted = inProgressTrip.passengers.filter((p) => p.status === 'BOARDED');

      if (uncompleted.length > 0) {
        const nextPassenger = uncompleted[0];

        // 1. Drop off passenger
        await this.tripsService.completePassenger(
          demoEntities.demoDriverUserId,
          inProgressTrip.id,
          nextPassenger.passengerId,
        );

        // 2. Confirm cash collection
        const totalPaise = nextPassenger.finalRideFarePaise + nextPassenger.waitingChargePaise;
        await this.prisma.cashCollection.create({
          data: {
            tripId: inProgressTrip.id,
            driverId: inProgressTrip.activeDriverId,
            tripPassengerId: nextPassenger.id,
            totalCashCollectedPaise: totalPaise,
            paymentStatus: 'PAID',
            paymentAllocations: {
              create: {
                obligationType: 'RIDE_FARE',
                obligationEntityId: nextPassenger.bookingId,
                allocatedAmountPaise: nextPassenger.finalRideFarePaise,
              },
            },
          },
        });

        return {
          stepExecuted: 'PASSENGER_DROPPED_OFF',
          message: `Passenger dropped off at destination and cash (₹${(totalPaise / 100).toFixed(2)}) confirmed`,
          remainingPassengers: uncompleted.length - 1,
        };
      }

      // All passengers dropped off -> Complete Trip
      const completeResult = await this.tripsService.completeTrip(
        demoEntities.demoDriverUserId,
        inProgressTrip.id,
      );

      return {
        stepExecuted: 'TRIP_COMPLETED',
        message: 'Trip completed successfully; Driver freed back to AVAILABLE',
        data: completeResult,
      };
    }

    return {
      stepExecuted: 'NO_ACTION',
      message: 'No pending simulation action in current journey state.',
    };
  }

  /**
   * Updates demo driver location and broadcasts to the admin socket room.
   * Resolves the provisioned demo driver server-side and updates only that driver.
   */
  async updateDriverLocation(latitude: number, longitude: number) {
    this.checkEnvironmentSafety();

    const demoEntities = await this.getDemoEntities();
    if (!demoEntities.demoDriverUserId) {
      throw new ForbiddenException(
        'GPS simulation rejected: Provisioned demo driver not found. Setup agents before updating location.',
      );
    }

    const driverUserId = demoEntities.demoDriverUserId;

    await this.driversService.recordDriverLocation(driverUserId, {
      latitude,
      longitude,
      heading: 45,
      speed: 25,
    });

    const driver = await this.prisma.driverProfile.findUnique({
      where: { userId: driverUserId },
    });

    if (driver) {
      this.realtimeGateway.server.to('admin').emit('driver.location.updated', {
        driverId: driver.id,
        latitude,
        longitude,
        speed: 25,
        updatedAt: new Date().toISOString(),
      });
    }

    return { success: true, driverUserId, latitude, longitude };
  }

  /**
   * Safely resets demo simulation state in reverse foreign-key order.
   * Strictly scoped to verified simulation agents and isolated safe groups.
   */
  async resetSimulation() {
    this.checkEnvironmentSafety();

    const demoUsers = await this.prisma.user.findMany({
      where: {
        email: {
          in: [
            'demo.passenger1@pdeu.ac.in',
            'demo.passenger2@pdeu.ac.in',
            'demo.driver@pdeu.ac.in',
          ],
        },
      },
      select: { id: true, email: true },
    });

    if (demoUsers.length === 0) {
      return {
        success: true,
        message: 'No demo users found; nothing to reset',
      };
    }

    const demoPassengerIds = demoUsers
      .filter((u) => u.email.startsWith('demo.passenger'))
      .map((u) => u.id);
    const demoDriverUserIds = demoUsers
      .filter((u) => u.email === 'demo.driver@pdeu.ac.in')
      .map((u) => u.id);

    const demoDriverProfiles = await this.prisma.driverProfile.findMany({
      where: { userId: { in: demoDriverUserIds } },
      select: { id: true },
    });
    const demoDriverProfileIds = demoDriverProfiles.map((d) => d.id);

    const demoBookings = await this.prisma.booking.findMany({
      where: { passengerId: { in: demoPassengerIds } },
      select: { id: true },
    });
    const demoBookingIds = demoBookings.map((b) => b.id);

    // Identify candidate groups linked to demo bookings
    const demoGroupMembers = await this.prisma.groupMember.findMany({
      where: { bookingId: { in: demoBookingIds } },
      select: { rideGroupId: true },
    });
    const candidateGroupIds = [
      ...new Set(demoGroupMembers.map((m) => m.rideGroupId)),
    ];

    // INVARIANT: Never delete a group if it contains ANY non-demo passenger!
    const allMembersInCandidates = await this.prisma.groupMember.findMany({
      where: { rideGroupId: { in: candidateGroupIds } },
      include: { booking: { select: { passengerId: true } } },
    });

    const safeDemoGroupIds: string[] = [];
    for (const gId of candidateGroupIds) {
      const members = allMembersInCandidates.filter((m) => m.rideGroupId === gId);
      const hasUnrelatedPassenger = members.some(
        (m) => !demoPassengerIds.includes(m.booking.passengerId),
      );
      if (!hasUnrelatedPassenger) {
        safeDemoGroupIds.push(gId);
      } else {
        this.logger.warn(
          `Ride group ${gId} contains unrelated non-demo passengers; preserving group and its structure.`,
        );
      }
    }

    // Identify candidate trips
    const candidateTrips = await this.prisma.trip.findMany({
      where: {
        OR: [
          { activeDriverId: { in: demoDriverProfileIds } },
          { rideGroupId: { in: safeDemoGroupIds } },
        ],
      },
      include: { passengers: true },
    });

    // INVARIANT: Never delete a trip if it contains ANY non-demo passenger!
    const safeDemoTripIds = candidateTrips
      .filter(
        (t) =>
          !t.passengers.some(
            (tp) => !demoPassengerIds.includes(tp.passengerId),
          ),
      )
      .map((t) => t.id);

    // Query pending/active dispatch offers for safe groups or demo driver to remove BullMQ jobs
    const demoOffers = await this.prisma.driverDispatchOffer.findMany({
      where: {
        OR: [
          { driverId: { in: demoDriverProfileIds } },
          { rideGroupId: { in: safeDemoGroupIds } },
        ],
      },
      select: { id: true },
    });
    const demoOfferIds = demoOffers.map((o) => o.id);

    // 1. Transactional Database Deletion strictly scoped to safe IDs
    await this.prisma.$transaction(async (tx) => {
      if (safeDemoTripIds.length > 0) {
        // 1. Payment allocations
        await tx.$executeRaw`
          DELETE FROM payment_allocations
          WHERE cash_collection_id IN (
            SELECT id FROM cash_collections
            WHERE trip_id = ANY(${safeDemoTripIds}::uuid[])
          );
        `;

        // 2. Cash collections
        await tx.$executeRaw`
          DELETE FROM cash_collections
          WHERE trip_id = ANY(${safeDemoTripIds}::uuid[]);
        `;

        // 3. Boarding verifications
        await tx.$executeRaw`
          DELETE FROM boarding_verifications
          WHERE trip_passenger_id IN (
            SELECT id FROM trip_passengers
            WHERE trip_id = ANY(${safeDemoTripIds}::uuid[])
          );
        `;

        // 4. Trip passengers
        await tx.$executeRaw`
          DELETE FROM trip_passengers
          WHERE trip_id = ANY(${safeDemoTripIds}::uuid[]);
        `;

        // 5. Trip status history
        await tx.$executeRaw`
          DELETE FROM trip_status_history
          WHERE trip_id = ANY(${safeDemoTripIds}::uuid[]);
        `;

        // 6. Trips
        await tx.$executeRaw`
          DELETE FROM trips
          WHERE id = ANY(${safeDemoTripIds}::uuid[]);
        `;
      }

      // 7. Cancellation fees for demo passengers
      if (demoPassengerIds.length > 0) {
        await tx.$executeRaw`
          DELETE FROM cancellation_fees
          WHERE passenger_id = ANY(${demoPassengerIds}::uuid[]);
        `;
      }

      // 8. Driver assignments
      if (demoDriverProfileIds.length > 0 || safeDemoGroupIds.length > 0) {
        await tx.$executeRaw`
          DELETE FROM driver_assignments
          WHERE driver_id = ANY(${demoDriverProfileIds}::uuid[])
             OR ride_group_id = ANY(${safeDemoGroupIds}::uuid[]);
        `;

        // 9. Dispatch offers
        await tx.$executeRaw`
          DELETE FROM driver_dispatch_offers
          WHERE driver_id = ANY(${demoDriverProfileIds}::uuid[])
             OR ride_group_id = ANY(${safeDemoGroupIds}::uuid[]);
        `;
      }

      // 10. Group routes, versions, members, and strictly scoped ride_groups
      if (safeDemoGroupIds.length > 0) {
        await tx.$executeRaw`
          DELETE FROM group_route_stops
          WHERE group_member_id IN (
            SELECT id FROM group_members
            WHERE ride_group_id = ANY(${safeDemoGroupIds}::uuid[])
          );
        `;

        await tx.$executeRaw`
          DELETE FROM group_route_versions
          WHERE ride_group_id = ANY(${safeDemoGroupIds}::uuid[]);
        `;

        await tx.$executeRaw`
          DELETE FROM group_members
          WHERE ride_group_id = ANY(${safeDemoGroupIds}::uuid[]);
        `;

        // Strictly delete ONLY the verified safe demo groups!
        // Never delete unrelated groups by "WHERE id NOT IN (SELECT ...)"!
        await tx.$executeRaw`
          DELETE FROM ride_groups
          WHERE id = ANY(${safeDemoGroupIds}::uuid[]);
        `;
      }

      // 11. Bookings & booking status history for demo bookings
      if (demoBookingIds.length > 0) {
        await tx.$executeRaw`
          DELETE FROM booking_status_history
          WHERE booking_id = ANY(${demoBookingIds}::uuid[]);
        `;

        await tx.$executeRaw`
          DELETE FROM bookings
          WHERE id = ANY(${demoBookingIds}::uuid[]);
        `;
      }

      // 12. Fare quotes for demo passengers
      if (demoPassengerIds.length > 0) {
        await tx.$executeRaw`
          DELETE FROM fare_quotes
          WHERE passenger_id = ANY(${demoPassengerIds}::uuid[]);
        `;
      }

      // 13. Free demo driver back to AVAILABLE
      if (demoDriverProfileIds.length > 0) {
        await tx.$executeRaw`
          UPDATE driver_profiles
          SET operational_status = 'AVAILABLE', is_online = true
          WHERE id = ANY(${demoDriverProfileIds}::uuid[]);
        `;
      }
    });

    // 2. Exact Redis and BullMQ cleanup for demo records
    try {
      // Clean ephemeral OTPs for demo bookings
      for (const bookingId of demoBookingIds) {
        await this.redisService.deletePassengerBoardingOtp(bookingId).catch(() => {});
      }

      // Clean ephemeral GPS for demo drivers
      const redisClient = this.redisService.getClient();
      for (const driverProfileId of demoDriverProfileIds) {
        await redisClient.del(`driver:gps:${driverProfileId}`).catch(() => {});
      }

      // Clean delayed BullMQ timeout jobs for demo dispatch offers
      if (this.dispatchQueue) {
        for (const offerId of demoOfferIds) {
          try {
            const job = await this.dispatchQueue.getJob(`dispatch-timeout-${offerId}`);
            if (job) {
              await job.remove();
            }
          } catch {
            // Ignore if already completed or expired
          }
        }
      }
    } catch (cleanupErr: any) {
      this.logger.warn(`Redis/BullMQ cleanup warning during reset: ${cleanupErr?.message}`);
    }

    return {
      success: true,
      message: 'Demo simulation state reset cleanly with strict isolation',
      deletedGroupsCount: safeDemoGroupIds.length,
      deletedTripsCount: safeDemoTripIds.length,
      deletedBookingsCount: demoBookingIds.length,
    };
  }
}
