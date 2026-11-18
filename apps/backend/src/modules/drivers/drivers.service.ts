import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { DriverOnboardDto } from './dto/driver-onboard.dto.js';
import { DriverDocumentDto } from './dto/driver-document.dto.js';
import { VehicleDto } from './dto/vehicle.dto.js';

@Injectable()
export class DriversService {
  constructor(private readonly prisma: PrismaService) {}

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
}
