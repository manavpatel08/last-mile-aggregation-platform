import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { TripsService } from './trips.service.js';
import { VerifyBoardingDto } from './dto/verify-boarding.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireDriverApproval } from '../../common/decorators/driver-approval.decorator.js';
import { Idempotent } from '../../common/decorators/idempotent.decorator.js';

@Controller('trips')
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/arrive-pickup')
  @HttpCode(HttpStatus.OK)
  async reportArrival(
    @CurrentUser() user: { id: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
  ) {
    const result = await this.tripsService.reportArrival(user.id, tripId);
    return {
      success: true,
      message: 'Driver arrival confirmed',
      data: result,
    };
  }

  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/verify-boarding')
  @HttpCode(HttpStatus.OK)
  async verifyBoarding(
    @CurrentUser() user: { id: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
    @Body() dto: VerifyBoardingDto,
  ) {
    const result = await this.tripsService.verifyBoarding(
      user.id,
      tripId,
      dto,
    );
    return {
      success: true,
      message: 'Passenger boarding verified',
      data: result,
    };
  }

  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  async startTrip(
    @CurrentUser() user: { id: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
  ) {
    const result = await this.tripsService.startTrip(user.id, tripId);
    return {
      success: true,
      message: 'Trip started successfully',
      data: result,
    };
  }

  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/passengers/:passengerId/complete')
  @HttpCode(HttpStatus.OK)
  async completePassenger(
    @CurrentUser() user: { id: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
    @Param('passengerId', new ParseUUIDPipe()) passengerId: string,
  ) {
    const result = await this.tripsService.completePassenger(
      user.id,
      tripId,
      passengerId,
    );
    return {
      success: true,
      data: result,
    };
  }

  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/passengers/:passengerId/no-show')
  @HttpCode(HttpStatus.OK)
  async declareNoShow(
    @CurrentUser() user: { id: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
    @Param('passengerId', new ParseUUIDPipe()) passengerId: string,
  ) {
    const result = await this.tripsService.declareNoShow(
      user.id,
      tripId,
      passengerId,
    );
    return {
      success: true,
      message: 'Passenger declared no-show',
      data: result,
    };
  }

  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  async completeTrip(
    @CurrentUser() user: { id: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
  ) {
    const result = await this.tripsService.completeTrip(user.id, tripId);
    return {
      success: true,
      message: 'Trip completed successfully',
      data: result,
    };
  }

  @Get(':id')
  async getTrip(
    @CurrentUser() user: { id: string; role: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
  ) {
    const trip = await this.tripsService.getTrip(user, tripId);
    return {
      success: true,
      data: trip,
    };
  }
}
