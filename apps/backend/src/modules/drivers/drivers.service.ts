import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { CACHE_KEYS } from '../../common/constants/index.js';
import { DriverOnboardDto } from './dto/driver-onboard.dto.js';
import { DriverDocumentDto } from './dto/driver-document.dto.js';
import { VehicleDto } from './dto/vehicle.dto.js';
import { UpdateDriverStatusDto } from './dto/update-driver-status.dto.js';
import { DriverLocationDto } from './dto/driver-location.dto.js';

@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  async onboardDriver(userId: string, dto: DriverOnboardDto) {
    const existingProfile = await this.prisma.driverProfile.findUnique({
      where: { userId },
    });

    if (existingProfile) {
      throw new ConflictException('Driver profile already registered for this user');
    }

    const existingLicense = await this.prisma.driverProfile.findUnique({
      where: { licenseNumber: dto.licenseNumber },
    });

    if (existingLicense) {
      throw new ConflictException('License number is already registered');
    }

    const existingVehicle = await this.prisma.vehicle.findUnique({
      where: { registrationNumber: dto.vehicle.registrationNumber },
    });

    if (existingVehicle) {
      throw new ConflictException('Vehicle registration number is already registered');
    }

    return this.prisma.$transaction(async (tx) => {
      const driverProfile = await tx.driverProfile.create({
        data: {
          userId,
          licenseNumber: dto.licenseNumber,
          verificationStatus: 'PENDING',
          operationalStatus: 'OFFLINE',
          isOnline: false,
        },
      });

      const vehicle = await tx.vehicle.create({
        data: {
          driverProfileId: driverProfile.id,
          registrationNumber: dto.vehicle.registrationNumber,
          vehicleType: dto.vehicle.vehicleType,
          passengerCapacity: dto.vehicle.passengerCapacity,
          makeModel: dto.vehicle.makeModel,
          isActive: true,
        },
      });

      // Grant DRIVER role to user
      const existingDriverRole = await tx.userRole.findFirst({
        where: { userId, roleName: 'DRIVER' },
      });

      if (!existingDriverRole) {
        await tx.userRole.create({
          data: {
            userId,
            roleName: 'DRIVER',
          },
        });
      }

      await tx.user.update({
        where: { id: userId },
        data: { role: 'DRIVER' },
      });

      return {
        driverProfile,
        vehicle,
      };
    });
  }

  async uploadDocument(userId: string, dto: DriverDocumentDto) {
    const driverProfile = await this.prisma.driverProfile.findUnique({
      where: { userId },
    });

    if (!driverProfile) {
      throw new NotFoundException('Driver profile not found');
    }

    return this.prisma.driverDocument.create({
      data: {
        driverProfileId: driverProfile.id,
        documentType: dto.documentType,
        documentUrl: dto.documentUrl,
        verificationStatus: 'PENDING',
      },
    });
  }

  async registerVehicle(userId: string, dto: VehicleDto) {
    const driverProfile = await this.prisma.driverProfile.findUnique({
      where: { userId },
    });

    if (!driverProfile) {
      throw new NotFoundException('Driver profile not found');
    }

    const existingReg = await this.prisma.vehicle.findUnique({
      where: { registrationNumber: dto.registrationNumber },
    });

    if (existingReg) {
      throw new ConflictException('Vehicle registration number already registered');
    }

    return this.prisma.vehicle.create({
      data: {
        driverProfileId: driverProfile.id,
        registrationNumber: dto.registrationNumber,
        vehicleType: dto.vehicleType,
        passengerCapacity: dto.passengerCapacity,
        makeModel: dto.makeModel,
        isActive: true,
      },
    });
  }

  async listVehicles(userId: string) {
    const driverProfile = await this.prisma.driverProfile.findUnique({
      where: { userId },
      include: { vehicles: true },
    });

    if (!driverProfile) {
      throw new NotFoundException('Driver profile not found');
    }

    return driverProfile.vehicles;
  }

  async listPendingDrivers() {
    return this.prisma.driverProfile.findMany({
      where: { verificationStatus: 'PENDING' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            phoneNumber: true,
            avatarUrl: true,
          },
        },
        vehicles: true,
        documents: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveDriver(driverProfileId: string, adminId: string) {
    const driver = await this.prisma.driverProfile.findUnique({
      where: { id: driverProfileId },
    });

    if (!driver) {
      throw new NotFoundException('Driver profile not found');
    }

    return this.prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: {
        verificationStatus: 'APPROVED',
        verifiedAt: new Date(),
        verifiedByUserId: adminId,
        rejectionReason: null,
      },
      include: {
        user: true,
        vehicles: true,
      },
    });
  }

  async rejectDriver(driverProfileId: string, rejectionReason: string) {
    const driver = await this.prisma.driverProfile.findUnique({
      where: { id: driverProfileId },
    });

    if (!driver) {
      throw new NotFoundException('Driver profile not found');
    }

    return this.prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: {
        verificationStatus: 'REJECTED',
        rejectionReason,
      },
    });
  }

  async getDriverOperationalStatus(userId: string) {
    const driver = await this.prisma.driverProfile.findUnique({
      where: { userId },
      include: { vehicles: true },
    });

    if (!driver) {
      throw new NotFoundException('Driver profile not found');
    }

    return {
      id: driver.id,
      verificationStatus: driver.verificationStatus,
      operationalStatus: driver.operationalStatus,
      isOnline: driver.isOnline,
      vehiclesCount: driver.vehicles.length,
    };
  }

  async updateDriverOperationalStatus(
    userId: string,
    dto: UpdateDriverStatusDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Pessimistic row locking on driver profile to coordinate state changes
      await tx.$executeRaw`
        SELECT id FROM driver_profiles
        WHERE user_id = ${userId}::uuid
        FOR UPDATE
      `;

      const driver = await tx.driverProfile.findUnique({
        where: { userId },
        include: {
          vehicles: true,
          assignments: {
            where: {
              status: { in: ['RESERVED', 'ACTIVE'] },
            },
          },
        },
      });

      if (!driver) {
        throw new NotFoundException('Driver profile not found');
      }

      if (driver.verificationStatus !== 'APPROVED') {
        throw new ForbiddenException(
          `Driver operational status is not approved (current status: ${driver.verificationStatus})`,
        );
      }

      if (driver.operationalStatus === 'SUSPENDED') {
        throw new ForbiddenException('Driver account is suspended');
      }

      if (dto.isOnline) {
        const hasActiveAssignment = driver.assignments.length > 0;
        const targetOperationalStatus = hasActiveAssignment
          ? driver.operationalStatus
          : 'AVAILABLE';

        const updated = await tx.driverProfile.update({
          where: { id: driver.id },
          data: {
            isOnline: true,
            operationalStatus: targetOperationalStatus,
          },
          include: { vehicles: true },
        });

        return {
          id: updated.id,
          verificationStatus: updated.verificationStatus,
          operationalStatus: updated.operationalStatus,
          isOnline: updated.isOnline,
          vehiclesCount: updated.vehicles.length,
        };
      } else {
        // When isOnline=false, transition to OFFLINE only when the driver has no active assignment or trip.
        if (driver.assignments.length > 0) {
          throw new ConflictException(
            'Cannot go offline while driver has an active or reserved assignment',
          );
        }

        const activeTrip = await tx.trip.findFirst({
          where: {
            activeDriverId: driver.id,
            status: {
              in: [
                'CREATED',
                'DRIVER_EN_ROUTE',
                'AT_PICKUP',
                'IN_PROGRESS',
                'INTERRUPTED',
              ],
            },
          },
        });

        if (activeTrip) {
          throw new ConflictException(
            'Cannot go offline while driver has an active trip',
          );
        }

        // Atomic conditional compare-and-swap under the row lock
        const updateResult = await tx.driverProfile.updateMany({
          where: {
            id: driver.id,
            operationalStatus: { notIn: ['RESERVED', 'ACTIVE', 'SUSPENDED'] },
          },
          data: {
            isOnline: false,
            operationalStatus: 'OFFLINE',
          },
        });

        if (updateResult.count === 0) {
          throw new ConflictException(
            'Cannot go offline while driver operational status is reserved, active or suspended',
          );
        }

        const updated = await tx.driverProfile.findUnique({
          where: { id: driver.id },
          include: { vehicles: true },
        });

        return {
          id: updated!.id,
          verificationStatus: updated!.verificationStatus,
          operationalStatus: updated!.operationalStatus,
          isOnline: updated!.isOnline,
          vehiclesCount: updated!.vehicles.length,
        };
      }
    });
  }

  async recordDriverLocation(userId: string, dto: DriverLocationDto) {
    const driver = await this.prisma.driverProfile.findUnique({
      where: { userId },
    });

    if (!driver) {
      throw new NotFoundException('Driver profile not found');
    }

    if (driver.verificationStatus !== 'APPROVED') {
      throw new ForbiddenException(
        `Driver operational status is not approved (current status: ${driver.verificationStatus})`,
      );
    }

    if (driver.operationalStatus === 'SUSPENDED') {
      throw new ForbiddenException('Driver account is suspended');
    }

    const updatedAt = new Date().toISOString();
    const gpsData = {
      latitude: dto.latitude,
      longitude: dto.longitude,
      heading: dto.heading ?? null,
      speed: dto.speed ?? null,
      updatedAt,
    };

    const redisKey = `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driver.id}`;
    try {
      const client = this.redisService.getClient();
      await client.set(redisKey, JSON.stringify(gpsData), 'EX', 30);
    } catch (err: any) {
      this.logger.error(
        `Failed to persist driver GPS fix to Redis for driver ${driver.id}: ${err?.message}`,
        err?.stack,
      );
      throw new ServiceUnavailableException(
        'Telemetry service temporarily unavailable',
      );
    }

    return {
      driverId: driver.id,
      ...gpsData,
    };
  }

  async getDriverGpsFix(driverId: string): Promise<{
    latitude: number;
    longitude: number;
    heading: number | null;
    speed: number | null;
    updatedAt: string;
  } | null> {
    const redisKey = `${CACHE_KEYS.DRIVER_GPS_PREFIX}${driverId}`;
    try {
      const client = this.redisService.getClient();
      const raw = await client.get(redisKey);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err: any) {
      this.logger.warn(
        `Failed to read driver GPS fix from Redis for ${driverId}: ${err?.message}`,
      );
      return null;
    }
  }
}
