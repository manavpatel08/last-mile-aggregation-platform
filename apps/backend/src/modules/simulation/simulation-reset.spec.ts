import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulationService } from './simulation.service.js';

describe('SimulationService — Safe Reset & Isolation (Stage 11 Task 3)', () => {
  let service: SimulationService;
  let prismaMock: any;
  let configService: ConfigService;
  let redisServiceMock: any;
  let redisClientMock: any;
  let dispatchQueueMock: any;

  beforeEach(() => {
    configService = new ConfigService({
      environment: 'development',
      DEMO_MODE: true,
      demoMode: true,
    });

    redisClientMock = {
      del: vi.fn().mockResolvedValue(1),
    };

    redisServiceMock = {
      deletePassengerBoardingOtp: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockReturnValue(redisClientMock),
    };

    dispatchQueueMock = {
      getJob: vi.fn().mockResolvedValue({
        remove: vi.fn().mockResolvedValue(undefined),
      }),
    };

    prismaMock = {
      user: {
        findMany: vi.fn(),
      },
      driverProfile: {
        findMany: vi.fn(),
      },
      booking: {
        findMany: vi.fn(),
      },
      groupMember: {
        findMany: vi.fn(),
      },
      trip: {
        findMany: vi.fn(),
      },
      driverDispatchOffer: {
        findMany: vi.fn(),
      },
      $transaction: vi.fn(async (callback) => {
        return callback(prismaMock);
      }),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };

    service = new SimulationService(
      prismaMock,
      {} as any, // matchingService
      {} as any, // dispatchService
      {} as any, // tripsService
      {} as any, // driversService
      {} as any, // bookingsService
      {} as any, // faresService
      {} as any, // authService
      redisServiceMock,
      configService,
      {} as any, // realtimeGateway
      dispatchQueueMock,
    );
  });

  it('Reset is strictly forbidden in production', async () => {
    const prodConfig = new ConfigService({
      environment: 'production',
      DEMO_MODE: true,
    });
    (service as any).configService = prodConfig;

    await expect(service.resetSimulation()).rejects.toThrow(ForbiddenException);
    await expect(service.resetSimulation()).rejects.toThrow(
      'Simulation operations are only permitted in non-production environments with DEMO_MODE enabled',
    );
  });

  it('Reset is strictly forbidden when DEMO_MODE is false or undefined', async () => {
    const nonDemoConfig = new ConfigService({
      environment: 'development',
      DEMO_MODE: false,
      demoMode: false,
    });
    (service as any).configService = nonDemoConfig;

    await expect(service.resetSimulation()).rejects.toThrow(ForbiddenException);
  });

  it('6. Reset NEVER deletes unrelated empty ride groups', async () => {
    const demoPaxId = 'pax-demo-1-uuid';
    const demoDriverUserId = 'driver-demo-1-uuid';
    const demoDriverProfileId = 'driver-profile-demo-uuid';
    const demoBookingId = 'booking-demo-1-uuid';
    const demoGroupId = 'group-demo-uuid';

    // 1. Return demo users
    prismaMock.user.findMany.mockResolvedValue([
      { id: demoPaxId, email: 'demo.passenger1@pdeu.ac.in' },
      { id: demoDriverUserId, email: 'demo.driver@pdeu.ac.in' },
    ]);

    prismaMock.driverProfile.findMany.mockResolvedValue([
      { id: demoDriverProfileId },
    ]);

    prismaMock.booking.findMany.mockResolvedValue([{ id: demoBookingId }]);

    // Candidate group linked to demo booking
    prismaMock.groupMember.findMany
      .mockResolvedValueOnce([{ rideGroupId: demoGroupId }]) // candidate groups
      .mockResolvedValueOnce([
        {
          rideGroupId: demoGroupId,
          booking: { passengerId: demoPaxId }, // All members belong to demo pax
        },
      ]);

    prismaMock.trip.findMany.mockResolvedValue([]);
    prismaMock.driverDispatchOffer.findMany.mockResolvedValue([
      { id: 'offer-demo-1' },
    ]);

    const result = await service.resetSimulation();

    expect(result.success).toBe(true);
    expect(result.deletedGroupsCount).toBe(1);

    // Verify all executeRaw calls
    const executeRawCalls = prismaMock.$executeRaw.mock.calls;
    for (const call of executeRawCalls) {
      const sqlString = JSON.stringify(call);
      // INVARIANT: Must NEVER contain unfiltered "DELETE FROM ride_groups WHERE id NOT IN"
      expect(sqlString).not.toContain('NOT IN (SELECT DISTINCT ride_group_id FROM group_members)');
    }

    // Verify ride_groups deletion strictly deleted demoGroupId
    const rideGroupDeleteCall = executeRawCalls.find((c: any) =>
      JSON.stringify(c).includes('DELETE FROM ride_groups'),
    );
    expect(rideGroupDeleteCall).toBeDefined();

    // Verify Redis OTP and GPS cleanup
    expect(redisServiceMock.deletePassengerBoardingOtp).toHaveBeenCalledWith(demoBookingId);
    expect(redisClientMock.del).toHaveBeenCalledWith(`driver:gps:${demoDriverProfileId}`);

    // Verify BullMQ job removal
    expect(dispatchQueueMock.getJob).toHaveBeenCalledWith('dispatch-timeout-offer-demo-1');
  });

  it('7. Reset NEVER deletes a group containing an unrelated (non-demo) passenger', async () => {
    const demoPaxId = 'pax-demo-1-uuid';
    const unrelatedPaxId = 'pax-real-commuter-uuid';
    const mixedGroupId = 'group-mixed-with-real-commuter-uuid';

    prismaMock.user.findMany.mockResolvedValue([
      { id: demoPaxId, email: 'demo.passenger1@pdeu.ac.in' },
    ]);

    prismaMock.driverProfile.findMany.mockResolvedValue([]);
    prismaMock.booking.findMany.mockResolvedValue([{ id: 'booking-demo-1' }]);

    // Group members query shows group has BOTH demo passenger AND unrelated real commuter
    prismaMock.groupMember.findMany
      .mockResolvedValueOnce([{ rideGroupId: mixedGroupId }]) // candidate groups
      .mockResolvedValueOnce([
        { rideGroupId: mixedGroupId, booking: { passengerId: demoPaxId } },
        { rideGroupId: mixedGroupId, booking: { passengerId: unrelatedPaxId } },
      ]);

    prismaMock.trip.findMany.mockResolvedValue([]);
    prismaMock.driverDispatchOffer.findMany.mockResolvedValue([]);

    const result = await service.resetSimulation();

    expect(result.success).toBe(true);
    expect(result.deletedGroupsCount).toBe(0); // Mixed group was preserved!

    // Verify ride_groups deletion was NOT called for this group
    const executeRawCalls = prismaMock.$executeRaw.mock.calls;
    const rideGroupDeleteCall = executeRawCalls.find((c: any) =>
      JSON.stringify(c).includes('DELETE FROM ride_groups'),
    );
    expect(rideGroupDeleteCall).toBeUndefined();
  });

  it('8. Reset deletes matching_batch_bookings before deleting bookings to satisfy RESTRICT foreign key', async () => {
    const demoPaxId = 'pax-demo-1-uuid';
    const demoBookingId = 'booking-demo-1-uuid';

    prismaMock.user.findMany.mockResolvedValue([
      { id: demoPaxId, email: 'demo.passenger1@pdeu.ac.in' },
    ]);
    prismaMock.driverProfile.findMany.mockResolvedValue([]);
    prismaMock.booking.findMany.mockResolvedValue([{ id: demoBookingId }]);
    prismaMock.groupMember.findMany.mockResolvedValue([]);
    prismaMock.trip.findMany.mockResolvedValue([]);
    prismaMock.driverDispatchOffer.findMany.mockResolvedValue([]);

    const result = await service.resetSimulation();

    expect(result.success).toBe(true);

    const executeRawCalls = prismaMock.$executeRaw.mock.calls;

    // Find indices of matching_batch_bookings delete and bookings delete
    const batchBookingsDeleteIdx = executeRawCalls.findIndex((c: any) =>
      JSON.stringify(c).includes('DELETE FROM matching_batch_bookings'),
    );
    const bookingsDeleteIdx = executeRawCalls.findIndex((c: any) =>
      JSON.stringify(c).includes('DELETE FROM bookings'),
    );

    expect(batchBookingsDeleteIdx).toBeGreaterThanOrEqual(0);
    expect(bookingsDeleteIdx).toBeGreaterThanOrEqual(0);

    // INVARIANT: matching_batch_bookings must be deleted BEFORE parent bookings
    expect(batchBookingsDeleteIdx).toBeLessThan(bookingsDeleteIdx);

    // Verify it targets demoBookingIds strictly
    const batchBookingsCall = executeRawCalls[batchBookingsDeleteIdx];
    expect(JSON.stringify(batchBookingsCall)).toContain('booking_id = ANY');
  });
});
