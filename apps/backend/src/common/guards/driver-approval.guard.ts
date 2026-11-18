import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_DRIVER_APPROVAL_KEY } from '../decorators/driver-approval.decorator.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

@Injectable()
export class DriverApprovalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiresApproval = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_DRIVER_APPROVAL_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiresApproval) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      throw new ForbiddenException('User context missing');
    }

    // Role check: User must possess DRIVER role
    const userRoles: string[] = Array.isArray(user.roles) ? user.roles : [];
    if (user.role !== 'DRIVER' && !userRoles.includes('DRIVER')) {
      throw new ForbiddenException('Operation restricted to driver accounts only');
    }

    // Authoritative check against PostgreSQL driver_profiles table
    const driverProfile = await this.prisma.driverProfile.findUnique({
      where: { userId: user.id },
    });

    if (!driverProfile) {
      throw new ForbiddenException('Driver profile does not exist');
    }

    if (driverProfile.verificationStatus !== 'APPROVED') {
      throw new ForbiddenException(
        `Driver operational status is not approved (current status: ${driverProfile.verificationStatus})`,
      );
    }

    if (driverProfile.operationalStatus === 'SUSPENDED') {
      throw new ForbiddenException('Driver operational status is suspended');
    }

    return true;
  }
}
