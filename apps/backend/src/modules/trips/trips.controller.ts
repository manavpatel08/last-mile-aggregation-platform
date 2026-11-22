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
import { ArrivePickupDto } from './dto/arrive-pickup.dto.js';
import { ReportBreakdownDto } from './dto/report-breakdown.dto.js';
import { AbortTripDto } from './dto/abort-trip.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireDriverApproval } from '../../common/decorators/driver-approval.decorator.js';
import { Idempotent } from '../../common/decorators/idempotent.decorator.js';
import { CurrentIdempotencyClaim } from '../../common/decorators/idempotency-claim.decorator.js';
import type { IdempotencyClaimContext } from '../../common/interceptors/idempotency.interceptor.js';

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
    @Body() _dto?: ArrivePickupDto,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.reportArrival(
      user.id,
      tripId,
      claim,
    );
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
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.verifyBoarding(
      user.id,
      tripId,
      dto,
      claim,
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
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.startTrip(user.id, tripId, claim);
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
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.completePassenger(
      user.id,
      tripId,
      passengerId,
      claim,
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
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.declareNoShow(
      user.id,
      tripId,
      passengerId,
      claim,
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
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.completeTrip(
      user.id,
      tripId,
      claim,
    );
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

  /**
   * POST /api/v1/trips/:id/report-breakdown
   * Active driver reports vehicle breakdown.
   * Transitions trip to INTERRUPTED, captures immutable onboard manifest snapshot,
   * searches and ranks replacement drivers via OSRM.
   */
  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/report-breakdown')
  @HttpCode(HttpStatus.OK)
  async reportBreakdown(
    @CurrentUser() user: { id: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
    @Body() dto: ReportBreakdownDto,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.reportBreakdown(
      user.id,
      tripId,
      dto,
      claim,
    );
    return {
      success: true,
      message: 'Vehicle breakdown reported successfully',
      data: result,
    };
  }

  /**
   * POST /api/v1/trips/:id/accept-replacement
   * Replacement driver accepts handover for an interrupted trip.
   * Atomically reserves replacement driver, resumes trip to IN_PROGRESS,
   * and applies 10% compensation discount to remaining onboard passengers.
   */
  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/accept-replacement')
  @HttpCode(HttpStatus.OK)
  async acceptReplacement(
    @CurrentUser() user: { id: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.acceptReplacementTrip(
      user.id,
      tripId,
      undefined,
      claim,
    );
    return {
      success: true,
      message: 'Replacement accepted; trip resumed with 10% passenger discount',
      data: result,
    };
  }

  /**
   * POST /api/v1/trips/:id/replacement-offers/:attemptId/accept
   * Alternative endpoint supporting attemptId parameter.
   */
  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/replacement-offers/:attemptId/accept')
  @HttpCode(HttpStatus.OK)
  async acceptReplacementOffer(
    @CurrentUser() user: { id: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.acceptReplacementTrip(
      user.id,
      tripId,
      attemptId,
      claim,
    );
    return {
      success: true,
      message: 'Replacement accepted; trip resumed with 10% passenger discount',
      data: result,
    };
  }

  /**
   * POST /api/v1/trips/:id/reject-replacement
   * Replacement driver explicitly rejects handover offer.
   * Cascades to next candidate driver.
   */
  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/reject-replacement')
  @HttpCode(HttpStatus.OK)
  async rejectReplacement(
    @CurrentUser() user: { id: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.rejectReplacementOffer(
      user.id,
      tripId,
      undefined,
      claim,
    );
    return {
      success: true,
      message: 'Replacement offer rejected; cascading to next candidate',
      data: result,
    };
  }

  /**
   * POST /api/v1/trips/:id/replacement-offers/:attemptId/reject
   * Alternative endpoint supporting attemptId parameter.
   */
  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/replacement-offers/:attemptId/reject')
  @HttpCode(HttpStatus.OK)
  async rejectReplacementOffer(
    @CurrentUser() user: { id: string },
    @Param('id', new ParseUUIDPipe()) tripId: string,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.rejectReplacementOffer(
      user.id,
      tripId,
      attemptId,
      claim,
    );
    return {
      success: true,
      message: 'Replacement offer rejected; cascading to next candidate',
      data: result,
    };
  }

  /**
   * POST /api/v1/trips/:id/abort-interrupted
   * Aborts interrupted trip if replacement is unavailable.
   * Sets all onboard passenger fares to ₹0 and audits refunds.
   */
  @Roles('DRIVER', 'ADMIN')
  @Idempotent()
  @Post(':id/abort-interrupted')
  @HttpCode(HttpStatus.OK)
  async abortInterruptedTrip(
    @Param('id', new ParseUUIDPipe()) tripId: string,
    @Body() dto: AbortTripDto,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.tripsService.abortInterruptedTrip(
      tripId,
      dto?.reason,
      claim,
    );
    return {
      success: true,
      message:
        'Trip aborted; onboard passenger fares set to ₹0.00 with refund audited',
      data: result,
    };
  }

  /**
   * GET /api/v1/trips/:id/incident
   * Retrieve active or latest incident details for a trip.
   */
  @Get(':id/incident')
  async getTripIncident(@Param('id', new ParseUUIDPipe()) tripId: string) {
    const result = await this.tripsService.getTripIncident(tripId);
    return {
      success: true,
      data: result,
    };
  }
}
