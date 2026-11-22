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

    // Report initial GPS fix at PDEU Main Gate
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
   * Creates 2 shared commuter bookings from PDEU Demo Station (or Main Gate) along the corridor.
   */
  async createDemoBookings() {
    this.checkEnvironmentSafety();

    const agents = await this.provisionAgents();

    // Prefer dedicated demo pickup station for strict pooling isolation; fall back to Main Gate
    let pickup = await this.prisma.pickupPoint.findFirst({
      where: { name: 'PDEU Demo Station', isActive: true },
    });

    if (!pickup) {
      pickup = await this.prisma.pickupPoint.findFirst({
        where: { name: 'PDEU Main Gate', isActive: true },
      });
    }

    if (!pickup) {
      throw new NotFoundException('Pickup hub for simulation bookings not found in database');
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
   * Immediately executes matching cycle for PDEU Demo Station (or designated pickup hub).
   * If a group is formed, triggers dispatch immediately.
   */
  async triggerMatching(pickupPointName?: string) {
    this.checkEnvironmentSafety();

    let targetName = pickupPointName;
    if (!targetName) {
      const demoPoint = await this.prisma.pickupPoint.findFirst({
        where: { name: 'PDEU Demo Station', isActive: true },
      });
      targetName = demoPoint ? 'PDEU Demo Station' : 'PDEU Main Gate';
    }

    const leaseKey =
      targetName === 'PDEU Demo Station'
        ? 'lease:matching:pdeu-demo'
        : 'lease:matching:pdeu';

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
   */
  async getActiveJourney() {
    this.checkEnvironmentSafety();

    // 1. Check for active trip
    const activeTrip = await this.prisma.trip.findFirst({
      where: {
        status: { in: ['ASSIGNED', 'AT_PICKUP', 'IN_PROGRESS'] },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        passengers: {
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

      // Fetch boarding passes / OTPs
      const passengersWithOtp = await Promise.all(
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
          };
        }),
      );

      const latestRouteVersion = activeTrip.rideGroup.routeVersions[0];

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
        passengers: passengersWithOtp,
        route: {
          distanceMeters: latestRouteVersion?.totalDistanceMeters || 0,
          durationSec: latestRouteVersion?.totalDurationSec || 0,
          geometry: latestRouteVersion?.routeGeometry || null,
        },
      };
    }

    // 2. Check for active RideGroup in dispatch
    const activeGroup = await this.prisma.rideGroup.findFirst({
      where: {
        status: { in: ['READY_FOR_DISPATCH', 'DISPATCHING'] },
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
          where: { status: 'PENDING' },
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
          members: activeGroup.members.map((m) => ({
            bookingId: m.bookingId,
            passengerName: m.booking.passenger.fullName,
            allocatedFarePaise: m.allocatedFarePaise,
          })),
        },
      };
    }

    // 3. Check for waiting bookings
    const bookings = await this.prisma.booking.findMany({
      where: {
        status: { in: ['REQUESTED', 'MATCHING'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 4,
      include: {
        passenger: { select: { id: true, fullName: true } },
      },
    });

    if (bookings.length > 0) {
      return {
        journeyState: 'WAITING_FOR_MATCH',
        bookings: bookings.map((b) => ({
          id: b.id,
          passengerName: b.passenger.fullName,
          status: b.status,
          createdAt: b.createdAt,
        })),
      };
    }

    return {
      journeyState: 'IDLE',
      message: 'No active simulation journey. Click "Prepare Demo Agents" or "Create Bookings".',
    };
  }

  /**
   * Advances the simulation to the next logical state.
   */
  async progressStep() {
    this.checkEnvironmentSafety();

    // 1. Check for pending offer -> Driver Accepts
    const pendingOffer = await this.prisma.driverDispatchOffer.findFirst({
      where: { status: 'PENDING' },
      include: { driver: true },
    });

    if (pendingOffer) {
      const acceptResult = await this.dispatchService.acceptOffer(
        pendingOffer.driver.userId,
        pendingOffer.id,
      );
      return {
        stepExecuted: 'OFFER_ACCEPTED',
        message: 'Driver accepted dispatch offer; Trip created',
        tripId: acceptResult.tripId,
      };
    }

    // 2. Check for Trip in ASSIGNED -> Driver Arrives at Pickup
    const assignedTrip = await this.prisma.trip.findFirst({
      where: { status: 'ASSIGNED' },
      include: { activeDriver: true },
    });

    if (assignedTrip) {
      const arriveResult = await this.tripsService.reportArrival(
        assignedTrip.activeDriver.userId,
        assignedTrip.id,
      );
      return {
        stepExecuted: 'DRIVER_ARRIVED',
        message: 'Driver arrived at PDEU Main Gate Hub',
        data: arriveResult,
      };
    }

    // 3. Check for Trip in AT_PICKUP -> Board Passengers and Start Trip
    const pickupTrip = await this.prisma.trip.findFirst({
      where: { status: 'AT_PICKUP' },
      include: {
        activeDriver: true,
        passengers: { where: { status: 'WAITING' } },
      },
    });

    if (pickupTrip) {
      // Verify boarding for all waiting passengers
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
          pickupTrip.activeDriver.userId,
          pickupTrip.id,
          { passengerId: p.passengerId, otp: otp! },
        );
      }

      // Start the trip
      const startResult = await this.tripsService.startTrip(
        pickupTrip.activeDriver.userId,
        pickupTrip.id,
      );

      return {
        stepExecuted: 'TRIP_STARTED',
        message: 'All passengers boarded via OTP; Trip departs PDEU Main Gate',
        data: startResult,
      };
    }

    // 4. Check for Trip in IN_PROGRESS -> Step GPS, drop off, and complete
    const inProgressTrip = await this.prisma.trip.findFirst({
      where: { status: 'IN_PROGRESS' },
      include: {
        activeDriver: true,
        passengers: true,
        rideGroup: {
          include: {
            routeVersions: { orderBy: { versionNumber: 'desc' }, take: 1 },
          },
        },
      },
    });

    if (inProgressTrip) {
      // Find uncompleted passengers
      const uncompleted = inProgressTrip.passengers.filter((p) => p.status === 'BOARDED');

      if (uncompleted.length > 0) {
        const nextPassenger = uncompleted[0];

        // 1. Drop off passenger
        await this.tripsService.completePassenger(
          inProgressTrip.activeDriver.userId,
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
        inProgressTrip.activeDriver.userId,
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
      message: 'No pending action in current journey state.',
    };
  }

  /**
   * Updates driver location and broadcasts to the admin socket room.
   */
  async updateDriverLocation(driverUserId: string, latitude: number, longitude: number) {
    this.checkEnvironmentSafety();

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

    return { success: true, latitude, longitude };
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
