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
import { PaymentsService } from './payments.service.js';
import { ConfirmCashDto } from './dto/confirm-cash.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireDriverApproval } from '../../common/decorators/driver-approval.decorator.js';
import { Idempotent } from '../../common/decorators/idempotent.decorator.js';
import { CurrentIdempotencyClaim } from '../../common/decorators/idempotency-claim.decorator.js';
import type { IdempotencyClaimContext } from '../../common/interceptors/idempotency.interceptor.js';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Roles('DRIVER')
  @RequireDriverApproval()
  @Get(['receipts/:tripPassengerId', 'cash-receipts/:tripPassengerId'])
  async getCashReceipt(
    @CurrentUser() user: { id: string },
    @Param('tripPassengerId', new ParseUUIDPipe()) tripPassengerId: string,
  ) {
    const result = await this.paymentsService.getCashReceipt(
      user.id,
      tripPassengerId,
    );
    return {
      success: true,
      message: 'Cash collection receipt retrieved successfully',
      data: result,
    };
  }

  @Roles('DRIVER')
  @RequireDriverApproval()
  @Idempotent()
  @Post('confirm-cash')
  @HttpCode(HttpStatus.OK)
  async confirmCash(
    @CurrentUser() user: { id: string },
    @Body() dto: ConfirmCashDto,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.paymentsService.confirmCash(user.id, dto, claim);
    return {
      success: true,
      message: 'Cash payment confirmed successfully',
      data: result,
    };
  }
}
