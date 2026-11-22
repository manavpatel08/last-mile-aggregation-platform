import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

export interface PickupPointRecord {
  id: string;
  name: string;
  serviceZoneId: string;
  radiusMeters: number;
  latitude: number;
  longitude: number;
  isActive: boolean;
}

export interface ServiceRegionRecord {
  id: string;
  name: string;
  isActive: boolean;
  boundaryGeoJson: unknown;
}

@Injectable()
export class LocationsService implements OnModuleInit {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    await this.bootstrapDefaults();
  }

  /**
   * Automatically bootstrap the default Gandhinagar Service Region,
   * PDEU Main Gate pickup point, and pilot tariff v1 if not present.
   * Admin account and dedicated demo pickup point are strictly gated by DEMO_MODE in non-prod.
   */
  async bootstrapDefaults(): Promise<void> {
    try {
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

      // 1. Authoritative production defaults
      await this.prisma.$executeRaw`
        DO $$
        DECLARE
          v_zone_id UUID;
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM service_zones WHERE name = 'Gandhinagar Service Region') THEN
            INSERT INTO service_zones (id, name, boundary_polygon, is_active)
            VALUES (
              gen_random_uuid(),
              'Gandhinagar Service Region',
              ST_SetSRID(ST_MakePolygon(ST_GeomFromText('LINESTRING(72.58 23.12, 72.72 23.12, 72.72 23.30, 72.58 23.30, 72.58 23.12)')), 4326),
              true
            )
            RETURNING id INTO v_zone_id;
          ELSE
            SELECT id INTO v_zone_id FROM service_zones WHERE name = 'Gandhinagar Service Region';
          END IF;

          IF NOT EXISTS (SELECT 1 FROM pickup_points WHERE name = 'PDEU Main Gate') THEN
            INSERT INTO pickup_points (id, service_zone_id, name, center_point, radius_meters, is_active)
            VALUES (
              gen_random_uuid(),
              v_zone_id,
              'PDEU Main Gate',
              ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
              150,
              true
            );
          END IF;

          IF NOT EXISTS (SELECT 1 FROM fare_configs WHERE version = 1) THEN
            INSERT INTO fare_configs (id, version, base_fare_paise, per_km_rate_paise, min_fare_paise, waiting_charge_per_min_paise, waiting_free_minutes, cancellation_fee_paise, is_active)
            VALUES (
              gen_random_uuid(),
              1,
              2000,
              1000,
              2000,
              500,
              5,
              3000,
              true
            );
          END IF;
        END $$;
      `;
      this.logger.log('Authoritative service zones, pickup hubs, and tariff v1 verified.');

      // 2. Demo Admin & Isolated Demo Station: STRICTLY in non-production with DEMO_MODE enabled
      if (isDemo) {
        await this.prisma.$executeRaw`
          DO $$
          DECLARE
            v_zone_id UUID;
          BEGIN
            SELECT id INTO v_zone_id FROM service_zones WHERE name = 'Gandhinagar Service Region';

            -- Dedicated Demo Station for isolated demo pooling
            IF NOT EXISTS (SELECT 1 FROM pickup_points WHERE name = 'PDEU Demo Station') THEN
              INSERT INTO pickup_points (id, service_zone_id, name, center_point, radius_meters, is_active)
              VALUES (
                gen_random_uuid(),
                v_zone_id,
                'PDEU Demo Station',
                ST_SetSRID(ST_MakePoint(72.6668, 23.1550), 4326),
                150,
                true
              );
            END IF;

            -- Demo Platform Administrator
            IF NOT EXISTS (SELECT 1 FROM users WHERE email = 'admin@pdeu.ac.in') THEN
              INSERT INTO users (id, email, full_name, role, is_active)
              VALUES (
                '00000000-0000-0000-0000-000000000001'::uuid,
                'admin@pdeu.ac.in',
                'Platform Administrator',
                'ADMIN',
                true
              );
              INSERT INTO user_roles (id, user_id, role_name)
              VALUES (
                gen_random_uuid(),
                '00000000-0000-0000-0000-000000000001'::uuid,
                'ADMIN'
              );
              INSERT INTO auth_identities (id, user_id, provider, provider_sub)
              VALUES (
                gen_random_uuid(),
                '00000000-0000-0000-0000-000000000001'::uuid,
                'GOOGLE',
                'admin-google-sub-001'
              );
            END IF;
          END $$;
        `;
        this.logger.log('Demo ADMIN account and PDEU Demo Station provisioned in demo mode.');
      }
    } catch (err) {
      this.logger.error(
        'Failed to bootstrap default location data',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * List all active transit pickup hubs with PostGIS coordinates and radii
   */
  async listPickupZones(): Promise<PickupPointRecord[]> {
    const points = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        serviceZoneId: string;
        radiusMeters: number;
        latitude: number;
        longitude: number;
        isActive: boolean;
      }>
    >`
      SELECT
        id,
        name,
        service_zone_id as "serviceZoneId",
        radius_meters as "radiusMeters",
        is_active as "isActive",
        ST_Y(center_point::geometry) as latitude,
        ST_X(center_point::geometry) as longitude
      FROM pickup_points
      WHERE is_active = true
      ORDER BY name ASC;
    `;

    return points.map((p) => ({
      id: p.id,
      name: p.name,
      serviceZoneId: p.serviceZoneId,
      radiusMeters: Number(p.radiusMeters),
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
      isActive: Boolean(p.isActive),
    }));
  }

  /**
   * Get active service region polygons as GeoJSON
   */
  async getServiceRegions(): Promise<ServiceRegionRecord[]> {
    const zones = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        isActive: boolean;
        boundaryGeoJson: unknown;
      }>
    >`
      SELECT
        id,
        name,
        is_active as "isActive",
        ST_AsGeoJSON(boundary_polygon)::json as "boundaryGeoJson"
      FROM service_zones
      WHERE is_active = true
      ORDER BY name ASC;
    `;

    return zones.map((z) => ({
      id: z.id,
      name: z.name,
      isActive: Boolean(z.isActive),
      boundaryGeoJson: z.boundaryGeoJson,
    }));
  }

  /**
   * Validate if a pickup coordinate is within the pickup hub geofence (150m)
   */
  async validatePickup(
    pickupPointId: string,
    latitude: number,
    longitude: number,
  ): Promise<{
    isValid: boolean;
    distanceMeters: number;
    allowedRadiusMeters: number;
    pickupPoint: { id: string; name: string };
  }> {
    const results = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        radius_meters: number;
        distance_meters: number;
        is_valid: boolean;
      }>
    >`
      SELECT
        id,
        name,
        radius_meters,
        ST_Distance(center_point::geography, ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography) as distance_meters,
        ST_DWithin(center_point::geography, ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography, radius_meters) as is_valid
      FROM pickup_points
      WHERE id = ${pickupPointId}::uuid AND is_active = true;
    `;

    if (!results || results.length === 0) {
      throw new NotFoundException({
        errorCode: 'PICKUP_POINT_NOT_FOUND',
        message: `Pickup point with ID ${pickupPointId} not found or inactive.`,
      });
    }

    const row = results[0];
    return {
      isValid: Boolean(row.is_valid),
      distanceMeters: Math.round(Number(row.distance_meters) * 10) / 10,
      allowedRadiusMeters: Number(row.radius_meters),
      pickupPoint: {
        id: row.id,
        name: row.name,
      },
    };
  }

  /**
   * Validate if destination coordinates reside within an authorized service polygon
   */
  async validateDestination(
    latitude: number,
    longitude: number,
  ): Promise<{
    isInsideServiceRegion: boolean;
    matchedZoneId?: string;
    matchedZoneName?: string;
  }> {
    const results = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        is_inside: boolean;
      }>
    >`
      SELECT
        id,
        name,
        ST_Contains(boundary_polygon, ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)) as is_inside
      FROM service_zones
      WHERE is_active = true
      ORDER BY is_inside DESC
      LIMIT 1;
    `;

    if (!results || results.length === 0 || !results[0].is_inside) {
      return {
        isInsideServiceRegion: false,
      };
    }

    return {
      isInsideServiceRegion: true,
      matchedZoneId: results[0].id,
      matchedZoneName: results[0].name,
    };
  }
}
