import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { FaresService } from './fares.service.js';
import { CreateQuoteDto } from './dto/create-quote.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';

@Controller('fares')
export class FaresController {
  constructor(private readonly faresService: FaresService) {}

  @Roles('PASSENGER')
  @Post('quotes')
  @HttpCode(HttpStatus.OK)
  async generateQuote(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateQuoteDto,
  ) {
    const quote = await this.faresService.generateQuote(user.id, dto);
    return {
      success: true,
      data: quote,
    };
  }
}
