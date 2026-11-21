import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { RequireDriverApproval } from '../../common/decorators/driver-approval.decorator.js';
import { Idempotent } from '../../common/decorators/idempotent.decorator.js';
import { CurrentIdempotencyClaim } from '../../common/decorators/idempotency-claim.decorator.js';
import type { IdempotencyClaimContext } from '../../common/interceptors/idempotency.interceptor.js';
import { DispatchService } from './dispatch.service.js';
import { RejectOfferDto } from './dto/reject-offer.dto.js';

@Controller('drivers/offers')
export class DriverOffersController {
  constructor(private readonly dispatchService: DispatchService) {}

  /**
   * GET /api/v1/drivers/offers/pending
   * Lists all pending, unexpired offers for the authenticated driver.
   * Multi-offer compliant (ADR-018): returns all valid offers for different groups.
   */
  @Roles('DRIVER')
  @RequireDriverApproval()
  @Get('pending')
  async getPendingOffers(@CurrentUser('id') userId: string) {
    const data = await this.dispatchService.getPendingOffersForDriver(userId);
    return {
      success: true,
      data,
    };
  }

  /**
   * POST /api/v1/drivers/offers/:id/accept
   * Driver accepts a dispatch offer with mandatory Idempotency-Key.
   * Atomically reserves driver, assigns group, materializes trip, and withdraws other offers.
   */
  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  async acceptOffer(
    @CurrentUser('id') userId: string,
    @Param('id') offerId: string,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const data = await this.dispatchService.acceptOffer(userId, offerId, claim);
    return {
      success: true,
      data,
    };
  }

  /**
   * POST /api/v1/drivers/offers/:id/reject
   * Driver explicitly rejects a dispatch offer.
   * Marks offer REJECTED and immediately cascades to the next ranked driver.
   */
  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectOffer(
    @CurrentUser('id') userId: string,
    @Param('id') offerId: string,
    @Body() dto?: RejectOfferDto,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    await this.dispatchService.rejectOffer(userId, offerId, dto, claim);
    return {
      success: true,
      message: 'Offer rejected successfully',
    };
  }
}
