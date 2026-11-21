import {
  Controller,
  Post,
  Param,
  Body,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { PaymentsService } from './payments.service.js';
import { WaiveCancellationFeeDto } from './dto/waive-cancellation-fee.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';

@Controller('admin/cancellation-fees')
@Roles('ADMIN')
export class AdminCancellationFeesController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post(':id/waive')
  @HttpCode(HttpStatus.OK)
  async waiveCancellationFee(
    @CurrentUser('id') adminId: string,
    @Param('id', new ParseUUIDPipe()) feeId: string,
    @Body() dto: WaiveCancellationFeeDto,
  ) {
    const result = await this.paymentsService.waiveCancellationFee(
      adminId,
      feeId,
      dto,
    );
    return {
      success: true,
      message: 'Cancellation fee waived successfully',
      data: result,
    };
  }
}
