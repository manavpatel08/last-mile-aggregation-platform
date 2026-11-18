import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { DriversService } from './drivers.service.js';
import { RejectDriverDto } from './dto/reject-driver.dto.js';

@Controller('admin/drivers')
@Roles('ADMIN')
export class AdminDriversController {
  constructor(private readonly driversService: DriversService) {}

  @Get('pending')
  async listPendingDrivers() {
    const drivers = await this.driversService.listPendingDrivers();
    return {
      success: true,
      data: drivers,
    };
  }

  @Post(':id/approve')
  async approveDriver(
    @Param('id') driverId: string,
    @CurrentUser('id') adminId: string,
  ) {
    const approved = await this.driversService.approveDriver(driverId, adminId);
    return {
      success: true,
      message: 'Driver profile approved successfully',
      data: approved,
    };
  }

  @Post(':id/reject')
  async rejectDriver(
    @Param('id') driverId: string,
    @Body() dto: RejectDriverDto,
  ) {
    const rejected = await this.driversService.rejectDriver(
      driverId,
      dto.rejectionReason,
    );
    return {
      success: true,
      message: 'Driver profile rejected',
      data: rejected,
    };
  }
}
