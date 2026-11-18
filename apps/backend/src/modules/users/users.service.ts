import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { UpdateUserDto } from './dto/update-user.dto.js';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: true,
        passengerProfile: true,
        driverProfile: {
          include: {
            vehicles: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User profile not found');
    }

    // Query outstanding cancellation fees for passenger
    const outstandingFees = await this.prisma.cancellationFee.findMany({
      where: {
        passengerId: userId,
        status: 'OUTSTANDING',
      },
    });

    const outstandingFeesTotalPaise = outstandingFees.reduce(
      (sum, fee) => sum + fee.amountPaise,
      0,
    );

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      avatarUrl: user.avatarUrl,
      role: user.role,
      roles: user.roles.map((r) => r.roleName),
      passengerProfile: user.passengerProfile
        ? {
            id: user.passengerProfile.id,
            defaultMinGroupPreference: user.passengerProfile.defaultMinGroupPreference,
            totalRidesCompleted: user.passengerProfile.totalRidesCompleted,
          }
        : null,
      driverProfile: user.driverProfile
        ? {
            id: user.driverProfile.id,
            licenseNumber: user.driverProfile.licenseNumber,
            verificationStatus: user.driverProfile.verificationStatus,
            operationalStatus: user.driverProfile.operationalStatus,
            isOnline: user.driverProfile.isOnline,
            vehicles: user.driverProfile.vehicles,
          }
        : null,
      outstandingCancellationFees: {
        count: outstandingFees.length,
        totalPaise: outstandingFeesTotalPaise,
        formattedRupees: (outstandingFeesTotalPaise / 100).toFixed(2),
      },
    };
  }

  async updateProfile(userId: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { passengerProfile: true },
    });

    if (!user) {
      throw new NotFoundException('User profile not found');
    }

    if (dto.defaultMinGroupPreference !== undefined) {
      if (user.passengerProfile) {
        await this.prisma.passengerProfile.update({
          where: { userId },
          data: {
            defaultMinGroupPreference: dto.defaultMinGroupPreference,
          },
        });
      } else {
        await this.prisma.passengerProfile.create({
          data: {
            userId,
            defaultMinGroupPreference: dto.defaultMinGroupPreference,
          },
        });
      }
    }

    return this.getProfile(userId);
  }
}
