import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LocationsService } from './locations.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

describe('LocationsService (PostGIS Geofencing & Service Zones)', () => {
  let prisma: PrismaService;
  let locationsService: LocationsService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    locationsService = new LocationsService(prisma);
    await locationsService.bootstrapDefaults();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('should list active pickup zones including PDEU Main Gate', async () => {
    const zones = await locationsService.listPickupZones();
    expect(zones.length).toBeGreaterThan(0);

    const pdeu = zones.find((z) => z.name === 'PDEU Main Gate');
    expect(pdeu).toBeDefined();
    expect(pdeu?.radiusMeters).toBe(150);
    expect(pdeu?.latitude).toBeCloseTo(23.155, 3);
    expect(pdeu?.longitude).toBeCloseTo(72.6668, 3);
  });

  it('should return active service regions with GeoJSON polygon', async () => {
    const regions = await locationsService.getServiceRegions();
    expect(regions.length).toBeGreaterThan(0);

    const gandhinagar = regions.find(
      (r) => r.name === 'Gandhinagar Service Region',
    );
    expect(gandhinagar).toBeDefined();
    expect(gandhinagar?.boundaryGeoJson).toBeDefined();
  });

  it('should validate pickup within 150m geofence successfully', async () => {
    const zones = await locationsService.listPickupZones();
    const pdeu = zones.find((z) => z.name === 'PDEU Main Gate')!;

    // 20 meters from PDEU center
    const validation = await locationsService.validatePickup(
      pdeu.id,
      23.1551,
      72.6669,
    );

    expect(validation.isValid).toBe(true);
    expect(validation.distanceMeters).toBeLessThanOrEqual(150);
  });

  it('should reject pickup outside 150m geofence', async () => {
    const zones = await locationsService.listPickupZones();
    const pdeu = zones.find((z) => z.name === 'PDEU Main Gate')!;

    // Point in Ahmedabad (~20km away)
    const validation = await locationsService.validatePickup(
      pdeu.id,
      23.03,
      72.58,
    );

    expect(validation.isValid).toBe(false);
    expect(validation.distanceMeters).toBeGreaterThan(150);
  });

  it('should validate destination inside Gandhinagar polygon successfully', async () => {
    // Infocity coordinates
    const validation = await locationsService.validateDestination(
      23.1812,
      72.6345,
    );
    expect(validation.isInsideServiceRegion).toBe(true);
    expect(validation.matchedZoneName).toBe('Gandhinagar Service Region');
  });

  it('should reject destination outside Gandhinagar polygon', async () => {
    // Coordinate far outside (Delhi or Mumbai)
    const validation = await locationsService.validateDestination(
      28.6139,
      77.209,
    );
    expect(validation.isInsideServiceRegion).toBe(false);
  });
});
