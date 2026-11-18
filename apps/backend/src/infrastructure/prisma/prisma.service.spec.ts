import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaService } from './prisma.service.js';

describe('PrismaService (Database & PostGIS Integration)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('should successfully connect to PostgreSQL (isHealthy)', async () => {
    const healthy = await prisma.isHealthy();
    expect(healthy).toBe(true);
  });

  it('should verify PostGIS extension availability and return version', async () => {
    const version = await prisma.verifyPostGIS();
    expect(version).toBeDefined();
    expect(version).toContain('3.');
  });

  it('should confirm all migration tables exist in the public schema', async () => {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename ASC;
    `;

    const tableNames = tables.map((t) => t.tablename);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('bookings');
    expect(tableNames).toContain('ride_groups');
    expect(tableNames).toContain('group_members');
    expect(tableNames).toContain('driver_profiles');
    expect(tableNames).toContain('driver_assignments');
    expect(tableNames).toContain('driver_dispatch_offers');
    expect(tableNames).toContain('trips');
    expect(tableNames).toContain('trip_passengers');
    expect(tableNames).toContain('cancellation_fees');
    expect(tableNames).toContain('cash_collections');
    expect(tableNames).toContain('outbox_events');
    expect(tableNames).toContain('idempotency_records');
    expect(tableNames).toContain('service_zones');
    expect(tableNames).toContain('pickup_points');
  });

  it('should confirm critical invariant partial indexes and GiST spatial indexes exist', async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname 
      FROM pg_indexes 
      WHERE schemaname = 'public';
    `;

    const indexNames = indexes.map((i) => i.indexname);
    // Invariants
    expect(indexNames).toContain('idx_unique_active_passenger_booking');
    expect(indexNames).toContain('idx_unique_active_booking_in_group');
    expect(indexNames).toContain('idx_unique_active_driver_assignment');
    expect(indexNames).toContain('idx_unique_active_group_assignment');
    expect(indexNames).toContain('idx_unique_single_pending_offer_per_group');
    expect(indexNames).toContain('idx_unique_driver_offer_per_group_version');
    expect(indexNames).toContain('idx_unique_collected_booking_fee');
    // Spatial GiST
    expect(indexNames).toContain('idx_pickup_points_center_gist');
    expect(indexNames).toContain('idx_service_zones_boundary_gist');
    expect(indexNames).toContain('idx_bookings_pickup_loc_gist');
    expect(indexNames).toContain('idx_bookings_dest_loc_gist');
    expect(indexNames).toContain('idx_trips_vehicle_loc_gist');
    expect(indexNames).toContain('idx_trip_incidents_loc_gist');
    // Operational
    expect(indexNames).toContain('idx_outbox_events_pending');
    expect(indexNames).toContain('idx_unique_verified_passenger_boarding');
    expect(indexNames).toContain('idx_idempotency_created_at');
  });

  it('should enforce check constraint on vehicle passenger capacity', async () => {
    const testEmail = `driver-check-test-${Date.now()}@example.com`;
    const user = await prisma.user.create({
      data: {
        email: testEmail,
        fullName: 'Driver Check Test',
        role: 'DRIVER',
      },
    });

    const driver = await prisma.driverProfile.create({
      data: {
        userId: user.id,
        licenseNumber: `LIC-CHECK-${Date.now()}`,
      },
    });

    try {
      // Violate check constraint: passenger_capacity must be between 1 and 8
      await expect(
        prisma.vehicle.create({
          data: {
            driverProfileId: driver.id,
            registrationNumber: `GJ-01-CHECK-${Date.now()}`,
            passengerCapacity: 15, // Invalid capacity > 8
            makeModel: 'Invalid Bus',
          },
        }),
      ).rejects.toThrow();
    } finally {
      // Isolated test cleanup
      await prisma.driverProfile.delete({ where: { id: driver.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it('should insert and retrieve isolated test data with complete cleanup', async () => {
    const testEmail = `isolated-test-${Date.now()}@example.com`;
    const createdUser = await prisma.user.create({
      data: {
        email: testEmail,
        fullName: 'Isolated Integration Commuter',
        role: 'PASSENGER',
      },
    });

    expect(createdUser.id).toBeDefined();
    expect(createdUser.email).toBe(testEmail);

    const fetchedUser = await prisma.user.findUnique({
      where: { id: createdUser.id },
    });
    expect(fetchedUser).not.toBeNull();
    expect(fetchedUser?.fullName).toBe('Isolated Integration Commuter');

    // Clean up
    await prisma.user.delete({
      where: { id: createdUser.id },
    });

    const verifyDeleted = await prisma.user.findUnique({
      where: { id: createdUser.id },
    });
    expect(verifyDeleted).toBeNull();
  });
});
