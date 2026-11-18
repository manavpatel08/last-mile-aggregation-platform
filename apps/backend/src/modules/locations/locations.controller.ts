import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { LocationsService } from './locations.service.js';
import { ValidatePickupDto } from './dto/validate-pickup.dto.js';
import { ValidateDestinationDto } from './dto/validate-destination.dto.js';
import { Public } from '../../common/decorators/public.decorator.js';

@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Public()
  @Get('pickup-zones')
  async listPickupZones() {
    const zones = await this.locationsService.listPickupZones();
    return {
      success: true,
      data: zones,
    };
  }

  @Public()
  @Get('service-regions')
  async getServiceRegions() {
    const regions = await this.locationsService.getServiceRegions();
    return {
      success: true,
      data: regions,
    };
  }

  @Post('validate-pickup')
  @HttpCode(HttpStatus.OK)
  async validatePickup(@Body() dto: ValidatePickupDto) {
    const result = await this.locationsService.validatePickup(
      dto.pickupPointId,
      dto.latitude,
      dto.longitude,
    );
    return {
      success: true,
      data: result,
    };
  }

  @Post('validate-destination')
  @HttpCode(HttpStatus.OK)
  async validateDestination(@Body() dto: ValidateDestinationDto) {
    const result = await this.locationsService.validateDestination(
      dto.latitude,
      dto.longitude,
    );
    return {
      success: true,
      data: result,
    };
  }
}
