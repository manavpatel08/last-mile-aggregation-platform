import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { RequireDriverApproval } from '../../common/decorators/driver-approval.decorator.js';
import { DriversService } from './drivers.service.js';
import { DriverOnboardDto } from './dto/driver-onboard.dto.js';
import { DriverDocumentDto } from './dto/driver-document.dto.js';
import { VehicleDto } from './dto/vehicle.dto.js';

@Controller('drivers')
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Post('onboard')
  async onboard(
    @CurrentUser('id') userId: string,
    @Body() dto: DriverOnboardDto,
  ) {
    const data = await this.driversService.onboardDriver(userId, dto);
    return {
      success: true,
      message: 'Driver onboarding application submitted successfully',
      data,
    };
  }

  @Roles('DRIVER')
  @Post('documents')
  async uploadDocument(
    @CurrentUser('id') userId: string,
    @Body() dto: DriverDocumentDto,
  ) {
    const document = await this.driversService.uploadDocument(userId, dto);
    return {
      success: true,
      message: 'Document uploaded successfully',
      data: document,
    };
  }

  @Roles('DRIVER')
  @Post('vehicles')
  async registerVehicle(
    @CurrentUser('id') userId: string,
    @Body() dto: VehicleDto,
  ) {
    const vehicle = await this.driversService.registerVehicle(userId, dto);
    return {
      success: true,
      message: 'Vehicle registered successfully',
      data: vehicle,
    };
  }

  @Roles('DRIVER')
  @Get('vehicles')
  async listVehicles(@CurrentUser('id') userId: string) {
    const vehicles = await this.driversService.listVehicles(userId);
    return {
      success: true,
      data: vehicles,
    };
  }

  @Roles('DRIVER')
  @RequireDriverApproval()
  @Get('status')
  async getStatus(@CurrentUser('id') userId: string) {
    const status = await this.driversService.getDriverOperationalStatus(userId);
    return {
      success: true,
      data: status,
    };
  }
}
