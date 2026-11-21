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
import { BookingsService } from './bookings.service.js';
import { CreateBookingDto } from './dto/create-booking.dto.js';
import { CancelBookingDto } from './dto/cancel-booking.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Idempotent } from '../../common/decorators/idempotent.decorator.js';
import { CurrentIdempotencyClaim } from '../../common/decorators/idempotency-claim.decorator.js';
import type { IdempotencyClaimContext } from '../../common/interceptors/idempotency.interceptor.js';

@Controller()
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Roles('PASSENGER')
  @Idempotent()
  @Post('bookings')
  @HttpCode(HttpStatus.CREATED)
  async createBooking(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateBookingDto,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const booking = await this.bookingsService.createBooking(
      user.id,
      dto,
      claim,
    );
    return {
      success: true,
      data: booking,
    };
  }

  @Roles('PASSENGER')
  @Get('bookings/active')
  async getActiveBooking(@CurrentUser() user: { id: string }) {
    const booking = await this.bookingsService.getActiveBooking(user.id);
    return {
      success: true,
      data: booking,
    };
  }

  @Get('bookings/:id')
  async getBookingById(
    @CurrentUser() user: { id: string; role: string },
    @Param('id', new ParseUUIDPipe()) bookingId: string,
  ) {
    const booking = await this.bookingsService.getBookingById(user, bookingId);
    return {
      success: true,
      data: booking,
    };
  }

  @Roles('PASSENGER')
  @Get('bookings/:id/boarding-pass')
  async getBoardingPass(
    @CurrentUser() user: { id: string; role: string },
    @Param('id', new ParseUUIDPipe()) bookingId: string,
  ) {
    const boardingPass = await this.bookingsService.getBoardingPass(
      user,
      bookingId,
    );
    return {
      success: true,
      data: boardingPass,
    };
  }

  @Idempotent()
  @Post('bookings/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelBooking(
    @CurrentUser() user: { id: string; role: string },
    @Param('id', new ParseUUIDPipe()) bookingId: string,
    @Body() dto: CancelBookingDto,
    @CurrentIdempotencyClaim() claim?: IdempotencyClaimContext,
  ) {
    const result = await this.bookingsService.cancelBooking(
      user,
      bookingId,
      dto,
      claim,
    );
    return {
      success: true,
      data: result,
    };
  }

  @Roles('PASSENGER')
  @Get('passengers/cancellation-fees/outstanding')
  async getOutstandingCancellationFees(@CurrentUser() user: { id: string }) {
    const result = await this.bookingsService.getOutstandingFees(user.id);
    return {
      success: true,
      data: result,
    };
  }
}
